/**
 * diagnose.ts — v2. STANDALONE, read-only. No auth, no funds, no orders.
 *
 * KEY CHANGE from v1: the strike ("Price to Beat") is NOT in gamma metadata.
 * It is the Chainlink price at the window-open instant. Polymarket exposes the
 * exact oracle stream it settles on over a WebSocket:
 *
 *     wss://ws-live-data.polymarket.com
 *     subscribe: crypto_prices_chainlink, filter btc/usd + eth/usd
 *     strike = first tick at/after the window boundary timestamp
 *
 * This one feed gives BOTH:
 *   - live price  -> Rule 4 current value
 *   - the strike  -> captured at each 300s / 900s boundary
 *
 * IMPORTANT: the stream has NO historical lookup. If we connect mid-window we
 * have already missed that window's open tick, so that window's strike is
 * unknown and must be SKIPPED until the next boundary. The bot must be
 * connected and capturing BEFORE a window opens. This diagnostic proves we can.
 *
 * Run:  npm install ws && npx tsx src/diagnose.ts
 */

import WebSocket from "ws";

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const RTDS = process.env.RTDS_URL || "wss://ws-live-data.polymarket.com";

type Asset = "BTC" | "ETH";
type Interval = "5m" | "15m";
interface Target { asset: Asset; interval: Interval; windowSec: number; }

const TARGETS: Target[] = [
  { asset: "BTC", interval: "5m", windowSec: 300 },
  { asset: "BTC", interval: "15m", windowSec: 900 },
  { asset: "ETH", interval: "5m", windowSec: 300 },
  { asset: "ETH", interval: "15m", windowSec: 900 },
];

// ---------- clock ----------
const nowSec = () => Math.floor(Date.now() / 1000);
const windowStart = (n: number, w: number) => n - (n % w);
const secsRemaining = (n: number, w: number) => windowStart(n, w) + w - n;
const slugFor = (t: Target, n: number) =>
  `${t.asset.toLowerCase()}-updown-${t.interval}-${windowStart(n, t.windowSec)}`;

// ---------- live price state (fed by WS) ----------
const livePrice: Record<Asset, number | undefined> = { BTC: undefined, ETH: undefined };

// strike capture: key = `${asset}:${windowSec}:${windowStartTs}` -> price at open
const strikes = new Map<string, number>();
const strikeKey = (a: Asset, w: number, ws: number) => `${a}:${w}:${ws}`;

// track which window boundary we've already captured, per (asset,windowSec)
const lastWindowSeen = new Map<string, number>(); // `${asset}:${windowSec}` -> windowStartTs

/**
 * Called on every incoming Chainlink tick. This is where the strike is born:
 * when we see the first tick whose time is >= a new window boundary, that tick
 * IS the strike for that window.
 */
function onTick(asset: Asset, price: number, tickSec: number) {
  livePrice[asset] = price;
  for (const w of [300, 900]) {
    const ws = windowStart(tickSec, w);
    const k = `${asset}:${w}`;
    if (lastWindowSeen.get(k) !== ws) {
      lastWindowSeen.set(k, ws);
      strikes.set(strikeKey(asset, w, ws), price);
    }
  }
}

// ---------- gamma metadata (still used: tokenIds for the book) ----------
async function fetchJson(url: string, ms = 6000): Promise<any> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" }, signal: ctrl.signal });
    if (!r.ok) return { __error: `http ${r.status}` };
    return await r.json();
  } catch (e: any) {
    return { __error: e?.name === "AbortError" ? "timeout" : String(e?.message || e) };
  } finally { clearTimeout(to); }
}
async function getTokenIds(slug: string): Promise<string[] | undefined> {
  const j = await fetchJson(`${GAMMA}/markets/slug/${slug}`);
  if (j?.__error) return undefined;
  const m = Array.isArray(j) ? j[0] : j;
  const raw = m?.clobTokenIds;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") { try { return JSON.parse(raw); } catch { return undefined; } }
  return undefined;
}

// ---------- order book ----------
async function getBook(tokenId: string) {
  const j = await fetchJson(`${CLOB}/book?token_id=${tokenId}`);
  if (j?.__error) return { err: j.__error as string };
  const bids = (j.bids || []).map((b: any) => ({ price: +b.price, size: +b.size }));
  const asks = (j.asks || []).map((a: any) => ({ price: +a.price, size: +a.size }));
  const bestBid = bids.length ? Math.max(...bids.map((b: any) => b.price)) : undefined;
  const bestAsk = asks.length ? Math.min(...asks.map((a: any) => a.price)) : undefined;
  const bidDepth = bids.slice(-5).reduce((s: number, b: any) => s + b.size, 0);
  const askDepth = asks.slice(0, 5).reduce((s: number, a: any) => s + a.size, 0);
  return { bestBid, bestAsk, skew: bidDepth - askDepth };
}

// ---------- Rule 4 ----------
function rule4(strike: number | undefined, live: number | undefined, secs: number) {
  if (strike == null || live == null) return { pass: false, diff: null as number | null };
  const diff = Math.abs(strike - live);
  return { pass: diff > secs, diff };
}

// ---------- WS connection ----------
/**
 * ONE socket per asset. The crypto_prices topic only supports a single symbol
 * per connection — subscribing to a second symbol REPLACES the first. So BTC
 * and ETH get separate sockets.
 *
 * Subscription schema (from Polymarket docs), with the documented gotcha:
 *   - `type` is required ("*" = all message types)
 *   - `filters` must be an ESCAPED JSON STRING, not an object:
 *        "filters": "{\"symbol\":\"btc/usd\"}"
 *     Sending it as an object yields zero data (silent).
 * Payload shape: { topic, type, timestamp, payload:{ symbol, timestamp, value } }
 * Must PING every 5s or the server drops the connection.
 */
let rawDumpsLeft = 4; // dump first few raw messages across both sockets

function connectAsset(asset: Asset, symbol: string) {
  console.log(`[ws:${asset}] connecting ${RTDS} (${symbol}) ...`);
  const ws = new WebSocket(RTDS);

  ws.on("open", () => {
    const sub = {
      action: "subscribe",
      subscriptions: [
        {
          topic: "crypto_prices_chainlink",
          type: "*",
          filters: JSON.stringify({ symbol }), // -> "{\"symbol\":\"btc/usd\"}"
        },
      ],
    };
    ws.send(JSON.stringify(sub));
    console.log(`[ws:${asset}] subscribed crypto_prices_chainlink ${symbol}`);
  });

  // keepalive: server requires a PING every ~5s
  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send("PING"); } catch { /* ignore */ }
    }
  }, 5000);

  ws.on("message", (buf: WebSocket.RawData) => {
    const text = buf.toString();
    if (text === "PONG") return;
    if (rawDumpsLeft > 0) {
      rawDumpsLeft--;
      console.log(`[ws raw ${asset}] ${text.slice(0, 400)}`);
    }
    let msg: any;
    try { msg = JSON.parse(text); } catch { return; }

    // Error frames look like {"message":"Invalid request body",...}
    if (msg?.message && !msg.payload && !msg.topic) {
      console.log(`[ws:${asset}] server says: ${msg.message}`);
      return;
    }

    // Normal frame: { topic, type, timestamp, payload:{symbol,timestamp,value} }
    const p = msg?.payload;
    if (!p) return;
    const sym = String(p.symbol ?? "").toLowerCase();
    const price = Number(p.value);
    const tsMs = Number(p.timestamp ?? msg.timestamp ?? Date.now());
    if (!Number.isFinite(price)) return;
    const tickSec = tsMs > 1e12 ? Math.floor(tsMs / 1000) : Math.floor(tsMs);
    if (sym.includes("btc")) onTick("BTC", price, tickSec);
    else if (sym.includes("eth")) onTick("ETH", price, tickSec);
  });

  ws.on("error", (e: Error) => console.log(`[ws:${asset}] error: ${e?.message || e}`));
  ws.on("close", (code: number) => {
    clearInterval(ping);
    console.log(`[ws:${asset}] closed (${code}) — reconnecting in 2s`);
    setTimeout(() => connectAsset(asset, symbol), 2000);
  });
}

function connectRTDS() {
  connectAsset("BTC", "btc/usd");
  connectAsset("ETH", "eth/usd");
}

// ---------- diagnostic print loop ----------
async function tick() {
  const n = nowSec();
  console.log(`\n=== ${new Date().toISOString()} (epoch ${n}) ===`);
  for (const t of TARGETS) {
    const secs = secsRemaining(n, t.windowSec);
    const ws = windowStart(n, t.windowSec);
    const strike = strikes.get(strikeKey(t.asset, t.windowSec, ws));
    const live = livePrice[t.asset];
    const r4 = rule4(strike, live, secs);

    const slug = slugFor(t, n);
    const tokenIds = await getTokenIds(slug);
    let bookStr = "book ?";
    if (tokenIds?.[0]) {
      const b = await getBook(tokenIds[0]);
      bookStr = b.err ? `book(${b.err})`
        : `bid=${b.bestBid ?? "-"} ask=${b.bestAsk ?? "-"} skew=${b.skew?.toFixed(0)}`;
    }

    const tag = `${t.asset}${t.interval}`.padEnd(6);
    const metaOk = tokenIds ? "OK" : "X";
    const strikeStr = strike != null ? strike.toFixed(2) : "?? (await boundary)";
    const liveStr = live != null ? live.toFixed(2) : "?? (await tick)";
    console.log(
      `${tag} | ${secs}s left | meta ${metaOk} | strike ${strikeStr} | live ${liveStr} | ` +
      `R4 diff=${r4.diff != null ? r4.diff.toFixed(2) : "?"} ${r4.pass ? "PASS" : "skip"} | ${bookStr}`
    );
  }
}

async function main() {
  console.log("diagnose.ts v2 — RTDS Chainlink feed. Read-only, no orders.");
  console.log(`   rtds=${RTDS}  gamma=${GAMMA}  clob=${CLOB}`);
  console.log("   Strike is captured at each window boundary from the live stream.");
  console.log("   Connect a few minutes before judging — first window's strike may be missed.\n");
  connectRTDS();
  for (;;) { await tick(); await new Promise((r) => setTimeout(r, 1000)); }
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });