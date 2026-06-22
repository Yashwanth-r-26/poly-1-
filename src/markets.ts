import { config, type Target } from "./config.js";
import { slugFor, nowSec, windowStart } from "./clock.js";

export interface MarketInfo {
  slug: string;
  conditionId?: string;
  upToken?: string; // outcome 0
  downToken?: string; // outcome 1
  outcomes?: string[];
}

export interface BookView {
  bestBid?: number;
  bestAsk?: number;
  skew: number; // bidDepth - askDepth (top 5)
}

async function fetchJson(url: string, ms = 5000): Promise<any> {
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

const parseArr = (v: any): string[] | undefined => {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return undefined; } }
  return undefined;
};

// cache market metadata by slug (window) so we don't refetch every loop
const metaCache = new Map<string, MarketInfo>();

export async function getActiveMarket(t: Target, n = nowSec()): Promise<MarketInfo | undefined> {
  const slug = slugFor(t.asset, t.interval, n, t.windowSec);
  const cached = metaCache.get(slug);
  if (cached) return cached;
  const j = await fetchJson(`${config.gamma}/markets/slug/${slug}`);
  if (j?.__error) return undefined;
  const m = Array.isArray(j) ? j[0] : j;
  if (!m) return undefined;
  const tokens = parseArr(m.clobTokenIds);
  const outcomes = parseArr(m.outcomes);
  const info: MarketInfo = {
    slug,
    conditionId: m.conditionId,
    upToken: tokens?.[0],
    downToken: tokens?.[1],
    outcomes,
  };
  metaCache.set(slug, info);
  return info;
}

/** which token corresponds to the side we want to buy */
export function tokenForSide(m: MarketInfo, side: "UP" | "DOWN"): string | undefined {
  // Outcomes are typically ["Up","Down"] -> token0=Up, token1=Down.
  // Guard against reversed labeling by checking outcomes text when present.
  if (m.outcomes && m.outcomes.length === 2) {
    const i = m.outcomes.findIndex((o) => o.toLowerCase().startsWith(side.toLowerCase().slice(0, 2)));
    if (i === 0) return m.upToken;
    if (i === 1) return m.downToken;
  }
  return side === "UP" ? m.upToken : m.downToken;
}

export async function getBook(tokenId: string): Promise<BookView | undefined> {
  const j = await fetchJson(`${config.clobHost}/book?token_id=${tokenId}`);
  if (j?.__error) return undefined;
  const bids = (j.bids || []).map((b: any) => ({ price: +b.price, size: +b.size }));
  const asks = (j.asks || []).map((a: any) => ({ price: +a.price, size: +a.size }));
  const bestBid = bids.length ? Math.max(...bids.map((b: any) => b.price)) : undefined;
  const bestAsk = asks.length ? Math.min(...asks.map((a: any) => a.price)) : undefined;
  const bidDepth = bids.slice(-5).reduce((s: number, b: any) => s + b.size, 0);
  const askDepth = asks.slice(0, 5).reduce((s: number, a: any) => s + a.size, 0);
  return { bestBid, bestAsk, skew: bidDepth - askDepth };
}

export interface SideQuote {
  side: "UP" | "DOWN";
  token: string;
  book?: BookView;
}

/** Fetch BOTH outcome books for a market in parallel. */
export async function getBothBooks(m: MarketInfo): Promise<SideQuote[]> {
  const out: SideQuote[] = [];
  const up = m.upToken, down = m.downToken;
  const [ub, db] = await Promise.all([
    up ? getBook(up) : Promise.resolve(undefined),
    down ? getBook(down) : Promise.resolve(undefined),
  ]);
  if (up) out.push({ side: "UP", token: up, book: ub });
  if (down) out.push({ side: "DOWN", token: down, book: db });
  return out;
}