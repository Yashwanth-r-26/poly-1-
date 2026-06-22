import "dotenv/config";

export type Asset = "BTC" ;
export type Interval = "5m" | "15m";

export interface Target {
  asset: Asset;
  interval: Interval;
  windowSec: number;
  symbol: string; // chainlink stream symbol, e.g. "btc/usd"
}

export const TARGETS: Target[] = [
  { asset: "BTC", interval: "5m", windowSec: 300, symbol: "btc/usd" },
  { asset: "BTC", interval: "15m", windowSec: 900, symbol: "btc/usd" },
  // { asset: "ETH", interval: "5m", windowSec: 300, symbol: "eth/usd" },
  // { asset: "ETH", interval: "15m", windowSec: 900, symbol: "eth/usd" },
];

const num = (v: string | undefined, d: number) => (v != null && v !== "" ? Number(v) : d);
const bool = (v: string | undefined, d: boolean) =>
  v == null ? d : ["1", "true", "yes", "y"].includes(v.toLowerCase());

export const config = {
  // ---- endpoints ----
  rtdsUrl: process.env.RTDS_URL || "wss://ws-live-data.polymarket.com",
  gamma: process.env.GAMMA_URL || "https://gamma-api.polymarket.com",
  clobHost: process.env.CLOB_HOST || "https://clob.polymarket.com",
  chainId: num(process.env.CHAIN_ID, 137),

  // ---- auth (reused from copybot: deposit wallet = sigType 3) ----
  privateKey: (process.env.POLY_PRIVATE_KEY || "0x") as `0x${string}`,
  funderAddress: process.env.POLY_FUNDER_ADDRESS || "",
  signatureType: num(process.env.POLY_SIGNATURE_TYPE, 3),

  // ---- mode ----
  dryRun: bool(process.env.DRY_RUN, true),

  // ---- strategy stake ----
  stakeUsd: num(process.env.STAKE_USD, 1), // $1 per trade (Rule 3)

  // ---- Rule 1: entry timing window (seconds remaining) ----
  entryMaxSecs: num(process.env.ENTRY_MAX_SECS, 50), // never above 50s... and never >60 anyway
  entryMinSecs: num(process.env.ENTRY_MIN_SECS, 15), // ...down to 15s

  // ---- Rule 3: price band (buying the favorite side) ----
  // Entry is a BAND, not a point: buy when the ask is within [bandLow, bandHigh].
  // 0.98 (1.02x) up to 0.99 (1.01x). Floor is the hard minimum we'll ever pay.
  priceBandLow: num(process.env.PRICE_BAND_LOW, 0.98), // 1.02x — lowest acceptable
  priceBandHigh: num(process.env.PRICE_BAND_HIGH, 0.99), // 1.01x — best we wait for
  priceFloor: num(process.env.PRICE_FLOOR, 0.98), // hard floor, never pay below
  // legacy (kept for compatibility; band takes precedence)
  priceTarget: num(process.env.PRICE_TARGET, 0.99),
  priceTol: num(process.env.PRICE_TOL, 0.001),

  // ---- Rule 3.2: stability ----
  stabilityMinMs: num(process.env.STABILITY_MIN_MS, 2000), // 2s+ = good/excellent

  // ---- Rule 2: order book skew confirmation ----
  // soft signal; veto only when book leans hard AGAINST our side
  bookVetoSkew: num(process.env.BOOK_VETO_SKEW, 5000), // shares of imbalance against us

  // ---- Rule 5: US market session to AVOID (ET) ----
  avoidSessionStartHHMM: process.env.SESSION_START || "09:30",
  avoidSessionEndHHMM: process.env.SESSION_END || "16:00",

  // ---- Rule 6: daily loss kill ----
  maxLossesPerDay: num(process.env.MAX_LOSSES_PER_DAY, 1),

  // ---- execution guards ----
  maxSlippage: num(process.env.MAX_SLIPPAGE, 0.01),
  pollMs: num(process.env.POLL_MS, 250), // strategy loop cadence

  // ---- which markets to trade ----
  enabledIntervals: (process.env.ENABLED_INTERVALS || "5m,15m").split(","),
};

export function assertLiveConfig(): string[] {
  const errs: string[] = [];
  if (!config.privateKey || config.privateKey === "0x") errs.push("POLY_PRIVATE_KEY missing");
  if (!config.funderAddress) errs.push("POLY_FUNDER_ADDRESS missing");
  return errs;
}