import WebSocket from "ws";
import { config, type Asset } from "./config";
import { windowStart } from "./clock";

/**
 * Chainlink price feed via Polymarket RTDS.
 *
 * Schema (from docs):
 *   subscribe: { action, subscriptions:[{ topic:"crypto_prices_chainlink",
 *                type:"*", filters:"{\"symbol\":\"btc/usd\"}" }] }
 *   - filters MUST be an escaped JSON string (object => zero data, silent)
 *   - ONE symbol per connection (second sub replaces first) => socket per asset
 *   - PING every 5s or the server drops you
 *   - frames: single { payload:{symbol,timestamp,value} }
 *             OR burst { payload:{ data:[{timestamp,value},...] } }
 *
 * Strike = first tick at/after a window boundary. NO historical lookup, so if
 * we connect mid-window that window's strike is unknown => caller must skip it.
 * We track that via `joinedLate`.
 */
export class ChainlinkFeed {
  private live: Record<Asset, number | undefined> = { BTC: undefined };//ETH: undefined
  private liveTs: Record<Asset, number | undefined> = { BTC: undefined };//ETH: undefined
  private strikes = new Map<string, number>(); // `${asset}:${windowSec}:${windowStartSec}` -> price
  private lastWindow = new Map<string, number>(); // `${asset}:${windowSec}` -> windowStartSec
  // windows whose strike we captured AT the boundary (clean) vs mid-window (late)
  private clean = new Set<string>(); // strikeKey of clean captures
  private connectedAtSec = Math.floor(Date.now() / 1000);
  private sockets: WebSocket[] = [];
  private rawDumps = parseInt(process.env.RAW_DUMPS || "0", 10);

  start() {
    for (const [asset, symbol] of [
      ["BTC", "btc/usd"],
      ["ETH", "eth/usd"],
    ] as [Asset, string][]) {
      this.connect(asset, symbol);
    }
  }

  private connect(asset: Asset, symbol: string) {
    const ws = new WebSocket(config.rtdsUrl);
    this.sockets.push(ws);

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          action: "subscribe",
          subscriptions: [
            { topic: "crypto_prices_chainlink", type: "*", filters: JSON.stringify({ symbol }) },
          ],
        })
      );
    });

    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send("PING"); } catch { /* ignore */ }
      }
    }, 5000);

    ws.on("message", (buf: WebSocket.RawData) => {
      const text = buf.toString();
      if (text === "PONG") return;
      if (this.rawDumps > 0) { this.rawDumps--; console.log(`[feed raw ${asset}] ${text.slice(0, 300)}`); }
      let msg: any;
      try { msg = JSON.parse(text); } catch { return; }
      if (msg?.message && !msg.payload) {
        console.log(`[feed:${asset}] server says: ${msg.message}`);
        return;
      }
      const p = msg?.payload;
      if (!p) return;
      // burst form
      if (Array.isArray(p.data)) {
        for (const d of p.data) this.onTick(asset, Number(d.value), Number(d.timestamp));
        return;
      }
      // single form
      this.onTick(asset, Number(p.value), Number(p.timestamp ?? msg.timestamp));
    });

    ws.on("error", (e: Error) => console.log(`[feed:${asset}] error: ${e?.message || e}`));
    ws.on("close", (code: number) => {
      clearInterval(ping);
      console.log(`[feed:${asset}] closed (${code}); reconnecting in 2s`);
      setTimeout(() => this.connect(asset, symbol), 2000);
    });
  }

  private onTick(asset: Asset, price: number, tsMs: number) {
    if (!Number.isFinite(price)) return;
    const tickSec = tsMs > 1e12 ? Math.floor(tsMs / 1000) : Math.floor(tsMs || Date.now() / 1000);
    // only advance live price with the newest tick
    if ((this.liveTs[asset] ?? 0) <= tickSec) {
      this.live[asset] = price;
      this.liveTs[asset] = tickSec;
    }
    for (const w of [300, 900]) {
      const ws = windowStart(tickSec, w);
      const k = `${asset}:${w}`;
      if (this.lastWindow.get(k) !== ws) {
        this.lastWindow.set(k, ws);
        const sk = this.strikeKey(asset, w, ws);
        this.strikes.set(sk, price);
        // "clean" iff the tick lands within a couple seconds of the boundary
        // AND we were already connected before this window opened.
        const nearBoundary = tickSec - ws <= 2;
        const wasConnectedBefore = ws >= this.connectedAtSec;
        if (nearBoundary && wasConnectedBefore) this.clean.add(sk);
      }
    }
  }

  private strikeKey(a: Asset, w: number, ws: number) { return `${a}:${w}:${ws}`; }

  getLive(asset: Asset): number | undefined { return this.live[asset]; }

  getStrike(asset: Asset, windowSec: number, windowStartSec: number): number | undefined {
    return this.strikes.get(this.strikeKey(asset, windowSec, windowStartSec));
  }

  /** true only if we captured this window's strike cleanly at its boundary */
  isStrikeClean(asset: Asset, windowSec: number, windowStartSec: number): boolean {
    return this.clean.has(this.strikeKey(asset, windowSec, windowStartSec));
  }

  ready(asset: Asset): boolean { return this.live[asset] != null; }
}