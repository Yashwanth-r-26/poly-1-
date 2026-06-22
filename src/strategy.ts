import { config, TARGETS, type Target, type Asset } from "./config.js";
import { nowMs, nowSec, secsRemaining, windowStart, windowClose } from "./clock.js";
import { ChainlinkFeed } from "./feed.js";
import { BookFeed } from "./bookfeed.js";
import { rule1Timing, rule2Book, rule5Session, PriceGate } from "./rules.js";
import { RiskGate } from "./risk.js";
import { getActiveMarket, tokenForSide } from "./markets.js";
import { placeOrder } from "./executor.js";
import { PnlSim } from "./pnl.js";

/**
 * Option C strategy: entry is driven by the order book. When a side's best ask
 * sits at the ~$0.99 favorite (with the Rule 3 mark->leave->return + 2s
 * stability), we buy that side. Rule 4 (diff-vs-time) is gone. Strike is still
 * captured so the P&L sim can settle win/loss, but it is NOT a gate.
 *
 * One position at a time across all 4 markets.
 */
export class Strategy {
  private priceGate = new PriceGate();
  private risk = new RiskGate();
  private sim = new PnlSim();
  private busyToken: string | null = null;
  private busyUntilSec = 0;

  private trace = new Map<string, string>();
  private blockedGlobal: string | null = null;

  // last live price per window for sim settlement
  private windowFinal = new Map<string, number>();

  constructor(private feed: ChainlinkFeed, private book: BookFeed) {}

  private finalKey(a: Asset, w: number, ws: number) { return `${a}:${w}:${ws}`; }

  private recordWindowPrice(asset: Asset, windowSec: number) {
    const live = this.feed.getLive(asset);
    if (live == null) return;
    const ws = windowStart(nowSec(), windowSec);
    this.windowFinal.set(this.finalKey(asset, windowSec, ws), live);
  }

  private finalPriceFor = (a: Asset, w: number, ws: number): number | undefined => {
    return this.windowFinal.get(this.finalKey(a, w, ws)) ?? this.feed.getLive(a);
  };

  async tick(): Promise<void> {
    const tNowMs = nowMs();
    const tNowSec = nowSec();

    for (const t of TARGETS) this.recordWindowPrice(t.asset, t.windowSec);

    const settled = this.sim.settleClosed(tNowSec, this.finalPriceFor);
    for (const s of settled) this.risk.recordOutcome(!!s.won, tNowMs);
    if (this.busyToken && tNowSec > this.busyUntilSec + 5 && !this.sim.hasOpen()) {
      this.busyToken = null;
    }

    // ---- GATE ORDER ----

    // Rule 5: session
    // const r5 = rule5Session(tNowMs);
    // if (!r5.pass) { this.blockedGlobal = `R5 ${r5.reason}`; return; }

    // Rule 6: daily loss kill
    const r6 = this.risk.canTrade(tNowMs);
    if (!r6.ok) { this.blockedGlobal = `R6 ${r6.reason}`; return; }

    // one position at a time
    if (this.busyToken || this.sim.hasOpen()) {
      this.blockedGlobal = `busy (${this.sim.openCount()} open position)`;
      return;
    }
    this.blockedGlobal = null;

    // keep PriceGate memory bounded to live windows
    const liveKeys = new Set<string>();
    // --- subscription maintenance: resolve markets (cached) + ensure the
    //     book feed is subscribed to all active tokens. Network happens HERE,
    //     not in the per-side hot path. ---
    await this.ensureSubscriptions(tNowSec);

    for (const t of TARGETS) {
      if (!config.enabledIntervals.includes(t.interval)) continue;
      const tag = `${t.asset}${t.interval}`;
      const secs = secsRemaining(tNowSec, t.windowSec);
      const ws = windowStart(tNowSec, t.windowSec);

      // Rule 1: timing
      const r1 = rule1Timing(secs);
      if (!r1.pass) { this.trace.set(tag, `R1: ${r1.reason}`); continue; }

      const market = this.marketCache.get(this.mkKey(t, ws));
      if (!market) { this.trace.set(tag, `market meta pending…`); continue; }

      // Evaluate BOTH sides reading best ask from the in-memory book feed.
      let firedThisMarket = false;
      const sideMsgs: string[] = [];
      const sides: { side: "UP" | "DOWN"; token?: string }[] = [
        { side: "UP", token: tokenForSide(market, "UP") },
        { side: "DOWN", token: tokenForSide(market, "DOWN") },
      ];

      for (const s of sides) {
        const key = `${t.asset}:${t.windowSec}:${ws}:${s.side}`;
        liveKeys.add(key);
        const ask = this.book.bestAsk(s.token);
        const dataAge = this.book.age(s.token);
        this.priceGate.update(key, ask, tNowMs);
        const r3 = this.priceGate.evaluate(key, ask, tNowMs);
        sideMsgs.push(`${s.side} ask=${ask ?? "-"}${dataAge != null && dataAge > 3000 ? "(stale)" : ""} ${r3.pass ? "READY" : r3.reason}`);

        if (!r3.pass) continue;

        // Rule 2: book skew soft veto
        const r2 = rule2Book(this.book.skew(s.token), s.side);
        if (!r2.pass) { sideMsgs[sideMsgs.length - 1] += ` | R2 veto`; continue; }

        // ---- ALL GATES PASS -> FIRE ----
        const entryPrice = ask ?? config.priceBandHigh;
        const strike = this.feed.getStrike(t.asset, t.windowSec, ws);
        const liveAtEntry = this.feed.getLive(t.asset);
        const res = await placeOrder({
          tokenId: s.token!, side: s.side, amountUsd: config.stakeUsd, refPrice: entryPrice,
        });
        console.log(
          `[FIRE] ${tag} ${s.side} @${entryPrice} | R1:${r1.reason} R3:${r3.reason} R2:${r2.reason} | ` +
          `${res.dryRun ? res.reason : res.placed ? `LIVE ${res.status}` : `FAILED ${res.reason}`}`
        );
        this.sim.recordFill({
          id: `${t.asset}-${ws}-${Date.now()}`,
          asset: t.asset,
          windowSec: t.windowSec,
          windowStartSec: ws,
          closeSec: windowClose(tNowSec, t.windowSec),
          side: s.side,
          entryPrice,
          strike: strike ?? entryPrice,
          amountUsd: config.stakeUsd,
          secsLeftAtEntry: secs,
          liveAtEntry,
          diffAtEntry: strike != null && liveAtEntry != null ? Math.abs(strike - liveAtEntry) : undefined,
        });
        this.busyToken = s.token!;
        this.busyUntilSec = windowClose(tNowSec, t.windowSec);
        firedThisMarket = true;
        break;
      }

      this.trace.set(tag, sideMsgs.join("  ||  ") || "no book data yet");
      if (firedThisMarket) return;
    }

    this.priceGate.prune(liveKeys);
  }

  // ---- subscription maintenance (network, once per tick, outside hot path) ----
  private marketCache = new Map<string, Awaited<ReturnType<typeof getActiveMarket>>>();
  private lastEnsureSec = 0;
  private mkKey(t: Target, ws: number) { return `${t.asset}:${t.windowSec}:${ws}`; }

  private async ensureSubscriptions(tNowSec: number) {
    // Only do the network resolve at most once per second (cheap dedupe).
    if (tNowSec === this.lastEnsureSec) return;
    this.lastEnsureSec = tNowSec;

    const tokens: (string | undefined)[] = [];
    for (const t of TARGETS) {
      if (!config.enabledIntervals.includes(t.interval)) continue;
      const ws = windowStart(tNowSec, t.windowSec);
      const k = this.mkKey(t, ws);
      let market = this.marketCache.get(k);
      if (!market) {
        market = await getActiveMarket(t, tNowSec);
        if (market) this.marketCache.set(k, market);
      }
      if (market) { tokens.push(market.upToken, market.downToken); }
    }
    this.book.ensure(tokens);

    // bound cache: drop entries older than ~2 windows
    if (this.marketCache.size > 16) {
      const keep = new Set<string>();
      for (const t of TARGETS) {
        const ws = windowStart(tNowSec, t.windowSec);
        keep.add(this.mkKey(t, windowStart(tNowSec, t.windowSec)));
        keep.add(this.mkKey(t, ws - t.windowSec));
      }
      for (const k of this.marketCache.keys()) if (!keep.has(k)) this.marketCache.delete(k);
    }
  }

  printSummary() {
    const s = this.sim.summary();
    let line = `\n[summary] trades=${s.trades} wins=${s.wins} losses=${s.losses} ` +
      `winRate=${(s.winRate * 100).toFixed(1)}% pnl=$${s.pnl.toFixed(4)}`;
    const bands = Object.keys(s.byPrice).sort();
    if (bands.length) {
      const parts = bands.map((k) => {
        const b = s.byPrice[k];
        return `@${k}: ${b.wins}/${b.n} (${((b.wins / b.n) * 100).toFixed(0)}%) $${b.pnl.toFixed(3)}`;
      });
      line += `\n          by entry: ${parts.join("  |  ")}`;
    }
    console.log(line + "\n");
    this.sim.writeStats();
  }

  /** accessors for the status server */
  getSim() { return this.sim; }
  getMeta() {
    return {
      feedBTC: this.feed.getLive("BTC"),
      uptimeSec: process.uptime(),
      openPositions: this.sim.openCount(),
    };
  }

  heartbeat() {
    const tNowSec = nowSec();
    const btc = this.feed.getLive("BTC");
    const feedOk = btc != null ;
    console.log(`\n-- heartbeat ${new Date().toISOString()} --`);
    console.log(
      `feed: BTC=${btc != null ? btc.toFixed(2) : "NO TICKS"} ` 
    );
    if (this.blockedGlobal) console.log(`GLOBAL BLOCK: ${this.blockedGlobal}`);
    for (const t of TARGETS) {
      if (!config.enabledIntervals.includes(t.interval)) continue;
      const tag = `${t.asset}${t.interval}`;
      const secs = secsRemaining(tNowSec, t.windowSec);
      const why = this.blockedGlobal ? "(global block)" : (this.trace.get(tag) ?? "evaluating...");
      console.log(`  ${tag.padEnd(6)} ${String(secs).padStart(3)}s | ${why}`);
    }
    if (this.sim.hasOpen()) console.log(`  open positions: ${this.sim.openCount()}`);
  }
}