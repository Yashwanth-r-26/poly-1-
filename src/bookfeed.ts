import WebSocket from "ws";
import { config } from "./config.js";

/**
 * Real-time order book feed via Polymarket CLOB market channel.
 *   wss://ws-subscriptions-clob.polymarket.com/ws/market
 *   subscribe: { type:"market", assets_ids:[...], custom_feature_enabled:true }
 *   PING every 10s.
 *
 * Events we use:
 *   book          -> full snapshot (asset_id, bids[], asks[]) on subscribe + on trade
 *   price_change  -> price_changes[] each with asset_id, best_bid, best_ask
 *   best_bid_ask  -> top-of-book (best_bid, best_ask) [needs custom_feature_enabled]
 *
 * Result: best bid/ask for every subscribed token live in memory, so the
 * strategy loop reads them instantly — no blocking HTTP, true per-tick sampling.
 *
 * Subscriptions are dynamic: as windows roll, we add new tokens and (optionally)
 * drop old ones without reconnecting.
 */

interface Top { bestBid?: number; bestAsk?: number; bidDepth?: number; askDepth?: number; ts: number; }

export class BookFeed {
  private ws: WebSocket | null = null;
  private url = (process.env.CLOB_WS_URL || "wss://ws-subscriptions-clob.polymarket.com/ws/market");
  private tops = new Map<string, Top>(); // tokenId -> top of book
  private subscribed = new Set<string>();
  private pendingSub = new Set<string>(); // tokens to subscribe once open
  private open = false;
  private rawDumps = parseInt(process.env.BOOK_RAW_DUMPS || "0", 10);

  start() { this.connect(); }

  private connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.open = false;

    ws.on("open", () => {
      this.open = true;
      // (re)subscribe to everything we know about
      const all = new Set<string>([...this.subscribed, ...this.pendingSub]);
      this.subscribed.clear();
      this.pendingSub.clear();
      if (all.size) this.sendSubscribe([...all]);
      // dynamic-subscribe path also needs this initial frame even if empty-safe
    });

    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) { try { ws.send("PING"); } catch { /* */ } }
    }, 10000);

    ws.on("message", (buf: WebSocket.RawData) => {
      const text = buf.toString();
      if (text === "PONG") return;
      if (this.rawDumps > 0) { this.rawDumps--; console.log(`[book raw] ${text.slice(0, 300)}`); }
      let msg: any;
      try { msg = JSON.parse(text); } catch { return; }
      const arr = Array.isArray(msg) ? msg : [msg];
      for (const m of arr) this.handle(m);
    });

    ws.on("error", (e: Error) => console.log(`[book] error: ${e?.message || e}`));
    ws.on("close", (code: number) => {
      clearInterval(ping);
      this.open = false;
      console.log(`[book] closed (${code}); reconnecting in 2s`);
      // mark all as pending so we re-subscribe on reconnect
      for (const t of this.subscribed) this.pendingSub.add(t);
      this.subscribed.clear();
      setTimeout(() => this.connect(), 2000);
    });
  }

  private handle(m: any) {
    const et = m?.event_type;
    if (et === "book") {
      const token = m.asset_id;
      if (!token) return;
      const asks = (m.asks || []).map((a: any) => ({ price: +a.price, size: +a.size }));
      const bids = (m.bids || []).map((b: any) => ({ price: +b.price, size: +b.size }));
      const bestAsk = asks.length ? Math.min(...asks.map((a: any) => a.price)) : undefined;
      const bestBid = bids.length ? Math.max(...bids.map((b: any) => b.price)) : undefined;
      const askDepth = asks.length ? asks.filter((a: any)=>a.price<= (bestAsk??0)+0.02).reduce((s:number,a:any)=>s+a.size,0) : 0;
      const bidDepth = bids.length ? bids.filter((b: any)=>b.price>= (bestBid??0)-0.02).reduce((s:number,b:any)=>s+b.size,0) : 0;
      this.tops.set(token, { bestBid, bestAsk, bidDepth, askDepth, ts: Date.now() });
    } else if (et === "price_change") {
      for (const pc of m.price_changes || []) {
        const token = pc.asset_id;
        if (!token) continue;
        const prev = this.tops.get(token) || { ts: 0 };
        this.tops.set(token, {
          ...prev,
          bestBid: pc.best_bid != null ? +pc.best_bid : prev.bestBid,
          bestAsk: pc.best_ask != null ? +pc.best_ask : prev.bestAsk,
          ts: Date.now(),
        });
      }
    } else if (et === "best_bid_ask") {
      const token = m.asset_id;
      if (!token) return;
      const prev = this.tops.get(token) || { ts: 0 };
      this.tops.set(token, {
        ...prev,
        bestBid: m.best_bid != null ? +m.best_bid : prev.bestBid,
        bestAsk: m.best_ask != null ? +m.best_ask : prev.bestAsk,
        ts: Date.now(),
      });
    }
  }

  private sendSubscribe(tokens: string[]) {
    if (!tokens.length) return;
    const fresh = tokens.filter((t) => !this.subscribed.has(t));
    if (!fresh.length) return;
    if (!this.open || !this.ws) { for (const t of fresh) this.pendingSub.add(t); return; }
    // Use dynamic-subscribe operation; first frame also fine as full subscribe.
    this.ws.send(JSON.stringify({
      assets_ids: fresh, type: "market", operation: "subscribe", custom_feature_enabled: true,
    }));
    for (const t of fresh) this.subscribed.add(t);
  }

  /** ensure we're subscribed to these tokens (idempotent) */
  ensure(tokens: (string | undefined)[]) {
    const valid = tokens.filter((t): t is string => !!t);
    const need = valid.filter((t) => !this.subscribed.has(t) && !this.pendingSub.has(t));
    if (need.length) this.sendSubscribe(need);
  }

  bestAsk(token: string | undefined): number | undefined {
    if (!token) return undefined;
    return this.tops.get(token)?.bestAsk;
  }
  bestBid(token: string | undefined): number | undefined {
    if (!token) return undefined;
    return this.tops.get(token)?.bestBid;
  }
  skew(token: string | undefined): number | undefined {
    if (!token) return undefined;
    const t = this.tops.get(token);
    if (!t || t.bidDepth == null || t.askDepth == null) return undefined;
    return t.bidDepth - t.askDepth;
  }
  /** how stale is this token's data, in ms */
  age(token: string | undefined): number | undefined {
    if (!token) return undefined;
    const t = this.tops.get(token);
    return t ? Date.now() - t.ts : undefined;
  }
  hasData(token: string | undefined): boolean {
    return !!token && this.tops.has(token);
  }
}