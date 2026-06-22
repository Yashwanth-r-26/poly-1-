import fs from "fs";
import { config } from "./config.js";
import type { SimFill } from "./pnl.js";

/**
 * Durable off-box trade sink: POST each settled trade to a Google Apps Script
 * web app, which appends a row to a Google Sheet. Survives container restarts,
 * volume failures, and the whole VM being destroyed — the row is in the cloud
 * the instant the trade settles.
 *
 * Setup (no Google API keys needed):
 *   1. Create a Google Sheet.
 *   2. Extensions -> Apps Script, paste the script from GGSHEET_SETUP.md, Deploy
 *      as Web app (execute as you, access: Anyone). Copy the /exec URL.
 *   3. Put it in .env as SHEETS_WEBHOOK_URL=https://script.google.com/macros/s/.../exec
 *
 * If the POST fails (network blip), the row is buffered to a local file and
 * retried on the next settle, so nothing is lost even if the sheet is briefly
 * unreachable.
 */
export class SheetsSink {
  private url = process.env.SHEETS_WEBHOOK_URL || "";
  private bufferPath = process.env.SHEETS_BUFFER || "data/unsent_trades.jsonl";
  private enabled = false;

  constructor() {
    this.enabled = !!this.url;
    if (!this.enabled) {
      console.log("[sheets] SHEETS_WEBHOOK_URL not set — Google Sheets logging OFF (CSV only)");
    } else {
      console.log(`[sheets] logging trades to Google Sheet via webhook`);
    }
  }

  private row(f: SimFill): Record<string, any> {
    return {
      ts: new Date().toISOString(),
      asset: f.asset,
      window: f.windowSec === 300 ? "5m" : "15m",
      side: f.side,
      entryPrice: f.entryPrice,
      amountUsd: f.amountUsd,
      strike: f.strike,
      liveAtEntry: f.liveAtEntry ?? "",
      diffAtEntry: f.diffAtEntry != null ? +f.diffAtEntry.toFixed(2) : "",
      secsLeftAtEntry: f.secsLeftAtEntry ?? "",
      finalPrice: f.finalPrice ?? "",
      won: f.won,
      pnl: f.pnl != null ? +f.pnl.toFixed(6) : "",
    };
  }

  /** call on each settled trade */
  async record(f: SimFill): Promise<void> {
    if (!this.enabled) return;
    // first, try to flush any previously-buffered rows
    await this.flushBuffer();
    const ok = await this.post(this.row(f));
    if (!ok) this.buffer(this.row(f));
  }

  private async post(row: Record<string, any>): Promise<boolean> {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(row),
        signal: ctrl.signal,
      });
      clearTimeout(to);
      if (!res.ok) { console.log(`[sheets] POST http ${res.status}`); return false; }
      return true;
    } catch (e: any) {
      console.log(`[sheets] POST failed: ${e?.message || e} (buffered for retry)`);
      return false;
    }
  }

  private buffer(row: Record<string, any>) {
    try {
      const dir = this.bufferPath.includes("/") ? this.bufferPath.slice(0, this.bufferPath.lastIndexOf("/")) : "";
      if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(this.bufferPath, JSON.stringify(row) + "\n");
    } catch (e: any) {
      console.log(`[sheets] buffer write failed: ${e?.message}`);
    }
  }

  private async flushBuffer(): Promise<void> {
    if (!fs.existsSync(this.bufferPath)) return;
    let lines: string[];
    try { lines = fs.readFileSync(this.bufferPath, "utf8").split("\n").filter(Boolean); }
    catch { return; }
    if (!lines.length) return;
    const remaining: string[] = [];
    for (const line of lines) {
      let row: any;
      try { row = JSON.parse(line); } catch { continue; }
      const ok = await this.post(row);
      if (!ok) remaining.push(line);
    }
    try {
      if (remaining.length) fs.writeFileSync(this.bufferPath, remaining.join("\n") + "\n");
      else fs.unlinkSync(this.bufferPath);
    } catch { /* */ }
  }
}