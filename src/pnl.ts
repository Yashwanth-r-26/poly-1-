import fs from "fs";
import { config, type Asset } from "./config.js";
import { windowClose } from "./clock.js";

/**
 * Dry-run P&L simulation. When the strategy "WOULD BUY", we record a simulated
 * fill. After the window closes we determine the real outcome from the feed
 * (final live price vs strike) and score win/loss + dollar P&L.
 *
 * Win  => share pays $1.00 ; profit = (1 - entryPrice) * shares
 * Loss => share pays $0.00 ; loss   = entryPrice * shares
 * shares = amountUsd / entryPrice
 */

export interface SimFill {
  id: string;
  asset: Asset;
  windowSec: number;
  windowStartSec: number;
  closeSec: number;
  side: "UP" | "DOWN";
  entryPrice: number;
  amountUsd: number;
  strike: number;
  // entry context (for analysis: why did this win/lose?)
  secsLeftAtEntry?: number; // seconds remaining when we fired
  liveAtEntry?: number;     // chainlink price at entry
  diffAtEntry?: number;     // |strike - live| at entry
  settled: boolean;
  won?: boolean;
  finalPrice?: number;
  pnl?: number;
}

export class PnlSim {
  private open: SimFill[] = [];
  private closed: SimFill[] = [];
  private csvPath = process.env.SIM_CSV || "data/dryrun_trades.csv";
  private wroteHeader = false;

  recordFill(f: Omit<SimFill, "settled">): SimFill {
    const fill: SimFill = { ...f, settled: false };
    this.open.push(fill);
    console.log(
      `[sim] FILL ${fill.asset}${fill.windowSec === 300 ? "5m" : "15m"} ${fill.side} ` +
      `$${fill.amountUsd} @${fill.entryPrice} strike=${fill.strike} (close in ${fill.closeSec - Math.floor(Date.now()/1000)}s)`
    );
    return fill;
  }

  /**
   * Settle any open fills whose window has closed.
   * `finalPriceFor(asset, windowSec, windowStartSec)` returns the last live
   * price observed in that window (the de-facto close), and `strikeFor` returns
   * the strike. Outcome: UP wins iff final >= strike.
   * Returns the list of settlements (so caller can feed risk gate).
   */
  settleClosed(
    nowSecVal: number,
    finalPriceFor: (a: Asset, w: number, ws: number) => number | undefined
  ): SimFill[] {
    const justSettled: SimFill[] = [];
    const stillOpen: SimFill[] = [];
    for (const f of this.open) {
      if (nowSecVal < f.closeSec + 2) { stillOpen.push(f); continue; } // wait 2s past close for final tick
      const finalPrice = finalPriceFor(f.asset, f.windowSec, f.windowStartSec);
      if (finalPrice == null) {
        // can't settle yet (no final price) — keep, but don't wait forever
        if (nowSecVal < f.closeSec + 30) { stillOpen.push(f); continue; }
      }
      const fp = finalPrice ?? f.strike; // fallback: treat as push at strike
      const actualUp = fp >= f.strike;
      const won = (f.side === "UP" && actualUp) || (f.side === "DOWN" && !actualUp);
      const shares = f.amountUsd / f.entryPrice;
      const pnl = won ? (1 - f.entryPrice) * shares : -f.entryPrice * shares;
      f.settled = true; f.won = won; f.finalPrice = fp; f.pnl = pnl;
      this.closed.push(f);
      justSettled.push(f);
      this.appendCsv(f);
      console.log(
        `[sim] SETTLE ${f.asset}${f.windowSec === 300 ? "5m" : "15m"} ${f.side} ` +
        `final=${fp.toFixed(2)} strike=${f.strike.toFixed(2)} => ${won ? "WIN" : "LOSS"} ` +
        `pnl=$${pnl.toFixed(4)}`
      );
    }
    this.open = stillOpen;
    return justSettled;
  }

  hasOpen(): boolean { return this.open.length > 0; }
  openCount(): number { return this.open.length; }

  summary(): {
    trades: number; wins: number; losses: number; pnl: number; winRate: number;
    byPrice: Record<string, { n: number; wins: number; pnl: number }>;
  } {
    const wins = this.closed.filter((c) => c.won).length;
    const losses = this.closed.length - wins;
    const pnl = this.closed.reduce((s, c) => s + (c.pnl ?? 0), 0);
    // break down by entry price band (0.98 vs 0.99) so you can compare
    const byPrice: Record<string, { n: number; wins: number; pnl: number }> = {};
    for (const c of this.closed) {
      const k = c.entryPrice.toFixed(2);
      const b = (byPrice[k] ??= { n: 0, wins: 0, pnl: 0 });
      b.n++; if (c.won) b.wins++; b.pnl += c.pnl ?? 0;
    }
    return {
      trades: this.closed.length,
      wins, losses, pnl,
      winRate: this.closed.length ? wins / this.closed.length : 0,
      byPrice,
    };
  }

  private appendCsv(f: SimFill) {
    try {
      const dir = this.csvPath.includes("/") ? this.csvPath.slice(0, this.csvPath.lastIndexOf("/")) : "";
      if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (!this.wroteHeader && !fs.existsSync(this.csvPath)) {
        fs.writeFileSync(this.csvPath,
          "ts,asset,window,side,entryPrice,amountUsd,strike,liveAtEntry,diffAtEntry,secsLeftAtEntry,finalPrice,won,pnl\n");
      }
      this.wroteHeader = true;
      fs.appendFileSync(this.csvPath,
        `${new Date().toISOString()},${f.asset},${f.windowSec},${f.side},` +
        `${f.entryPrice},${f.amountUsd},${f.strike},${f.liveAtEntry ?? ""},` +
        `${f.diffAtEntry?.toFixed(2) ?? ""},${f.secsLeftAtEntry ?? ""},` +
        `${f.finalPrice},${f.won},${f.pnl?.toFixed(6)}\n`);
    } catch (e: any) {
      console.log(`[sim] csv write failed: ${e?.message}`);
    }
  }

  /** persist a recoverable stats snapshot to disk (survives a crash) */
  writeStats(path = process.env.SIM_STATS || "data/dryrun_stats.json") {
    try {
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const s = this.summary();
      fs.writeFileSync(path, JSON.stringify({ updated: new Date().toISOString(), ...s }, null, 2));
    } catch (e: any) {
      console.log(`[sim] stats write failed: ${e?.message}`);
    }
  }
}