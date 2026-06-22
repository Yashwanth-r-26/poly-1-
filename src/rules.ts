import { config } from "./config.js";

export interface Gate { pass: boolean; reason: string; }

// ---------------------------------------------------------------------------
// Rule 1 — Entry Timing
//   Never trade above 1 minute remaining. Enter only between 50s and 15s.
// ---------------------------------------------------------------------------
export function rule1Timing(secsRemaining: number): Gate {
  if (secsRemaining > 60) return { pass: false, reason: `>1min left (${secsRemaining}s)` };
  if (secsRemaining > config.entryMaxSecs) return { pass: false, reason: `>${config.entryMaxSecs}s (${secsRemaining}s)` };
  if (secsRemaining < config.entryMinSecs) return { pass: false, reason: `<${config.entryMinSecs}s (${secsRemaining}s)` };
  return { pass: true, reason: `in window (${secsRemaining}s)` };
}

// ---------------------------------------------------------------------------
// Rule 4 — REMOVED (Option C). Entry is driven by the order book: a side at the
// ~$0.99 favorite price IS the signal that the market has priced it near-certain.
// The diff-vs-time computation is no longer a gate.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Rule 3 — Entry Price Restriction + 3.1 (mark->leave->return) + 3.2 (stability)
//   Buy the favorite side at $0.99 (1.01x). Never pay below the floor $0.98
//   (worse than 1.02x). Use a state machine: price must reach target, leave,
//   then RETURN to target before we buy. And it must have been stable (sitting
//   at target) for >= 2s.
//
//   This is stateful, so it lives in a small class, tracked per the ONE active
//   candidate at a time (we trade one position across all 4 markets).
// ---------------------------------------------------------------------------
type PriceState = "WAITING" | "MARKED" | "LEFT" | "RETURNED";

interface SideTrack {
  state: PriceState;
  atTargetSinceMs: number | null;
}

/**
 * Rule 3 / 3.1 / 3.2 — Price + mark->leave->return + 2s stability.
 *
 * Now KEYED: each side (Up-ask, Down-ask) of each market window has its own
 * independent state machine, because they are separate price streams. Key is
 * caller-chosen, e.g. "BTC:300:<windowStart>:UP".
 */
export class PriceGate {
  private tracks = new Map<string, SideTrack>();

  private get(key: string): SideTrack {
    let t = this.tracks.get(key);
    if (!t) { t = { state: "WAITING", atTargetSinceMs: null }; this.tracks.set(key, t); }
    return t;
  }

  private atTarget(price: number): boolean {
    // "at target" = within the entry band [bandLow, bandHigh]
    return price >= config.priceBandLow - 1e-9 && price <= config.priceBandHigh + 1e-9;
  }
  private belowFloor(price: number): boolean {
    return price < config.priceFloor - 1e-9;
  }
  private aboveBand(price: number): boolean {
    return price > config.priceBandHigh + 1e-9;
  }

  /** call every tick with the current best ASK for this side */
  update(key: string, askPrice: number | undefined, nowMs: number): void {
    if (askPrice == null) return;
    const t = this.get(key);
    const onTarget = this.atTarget(askPrice);
    switch (t.state) {
      case "WAITING":
        if (onTarget) { t.state = "MARKED"; t.atTargetSinceMs = nowMs; }
        break;
      case "MARKED":
        if (!onTarget) { t.state = "LEFT"; t.atTargetSinceMs = null; }
        break;
      case "LEFT":
        if (onTarget) { t.state = "RETURNED"; t.atTargetSinceMs = nowMs; }
        break;
      case "RETURNED":
        if (!onTarget) { t.state = "LEFT"; t.atTargetSinceMs = null; }
        break;
    }
  }

  /**
   * Rule 3 + 3.1 + 3.2 verdict. Two entry paths (either can fire):
   *   (A) mark -> leave -> RETURN, then hold >= stabilityMinMs  [original 3.1]
   *   (B) stable in band >= stabilityMinMs without leaving       [climb-and-hold]
   * Path B is enabled by config.allowStableEntry. In BOTH paths the stability
   * timer is `nowMs - atTargetSinceMs`, which is set on first band-entry (MARKED)
   * and re-set on RETURN — i.e. continuous time in band since last entry.
   */
  evaluate(key: string, askPrice: number | undefined, nowMs: number): Gate {
    if (askPrice == null) return { pass: false, reason: "no ask" };
    if (this.belowFloor(askPrice)) return { pass: false, reason: `ask ${askPrice} < floor ${config.priceFloor}` };
    if (this.aboveBand(askPrice))
      return { pass: false, reason: `ask ${askPrice} above band ${config.priceBandHigh}` };

    const t = this.get(key);
    const eligibleState =
      t.state === "RETURNED" || (config.allowStableEntry && t.state === "MARKED");
    if (!eligibleState) {
      const why = config.allowStableEntry ? `state=${t.state}` : `awaiting return (state=${t.state})`;
      return { pass: false, reason: why };
    }
    if (t.atTargetSinceMs == null) return { pass: false, reason: "no stability anchor" };
    const stableMs = nowMs - t.atTargetSinceMs;
    if (stableMs < config.stabilityMinMs)
      return { pass: false, reason: `in band ${stableMs}ms < ${config.stabilityMinMs}ms` };

    const path = t.state === "RETURNED" ? "returned" : "stable";
    return { pass: true, reason: `${path} & held ${stableMs}ms at ${askPrice}` };
  }

  reset(key?: string): void {
    if (key) this.tracks.delete(key);
    else this.tracks.clear();
  }

  /** drop stale keys (windows that have closed) to bound memory */
  prune(keepKeys: Set<string>): void {
    for (const k of this.tracks.keys()) if (!keepKeys.has(k)) this.tracks.delete(k);
  }
}

// ---------------------------------------------------------------------------
// Rule 2 — Order Book Direction Check (SOFT)
//   Not a hard filter. Green(buy)/Red(sell) skew is a sign. Veto only when the
//   book leans HARD against the side we intend to buy.
//   skew = bidDepth - askDepth on OUR token. Heavy negative skew (more sell
//   pressure) against an UP buy is a discouraging sign.
// ---------------------------------------------------------------------------
export function rule2Book(
  skewOnOurToken: number | undefined,
  intendedSide: "UP" | "DOWN" | null
): Gate {
  if (skewOnOurToken == null || intendedSide == null)
    return { pass: true, reason: "no book signal (allow)" }; // soft => default allow
  // If buying this token and there's massive sell-side depth (very negative
  // skew) that's the book leaning against us.
  if (skewOnOurToken < -config.bookVetoSkew)
    return { pass: false, reason: `book against us (skew ${skewOnOurToken.toFixed(0)})` };
  return { pass: true, reason: `book ok (skew ${skewOnOurToken.toFixed(0)})` };
}

// ---------------------------------------------------------------------------
// Rule 5 — Session Restriction
//   Never trade during American stock market timing (NYSE 09:30-16:00 ET,
//   Mon-Fri). Computed in ET regardless of host clock.
// ---------------------------------------------------------------------------
function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function rule5Session(nowMsUtc: number): Gate {
  // 24/7 mode: session filter disabled -> always allow.
  if (!config.enableSessionFilter) return { pass: true, reason: "session filter off (24/7)" };
  // Convert to ET. ET = UTC-5 (EST) or UTC-4 (EDT). We compute using the
  // Intl API so DST is handled correctly.
  const et = new Date(nowMsUtc).toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  // et looks like "Mon, 14:35"
  const m = et.match(/^(\w{3}),?\s+(\d{2}):(\d{2})/);
  if (!m) return { pass: true, reason: "ET parse failed (allow)" };
  const day = m[1];
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  const isWeekend = day === "Sat" || day === "Sun";
  if (isWeekend) return { pass: true, reason: `weekend (${day})` };
  const start = hhmmToMin(config.avoidSessionStartHHMM);
  const end = hhmmToMin(config.avoidSessionEndHHMM);
  if (minutes >= start && minutes < end)
    return { pass: false, reason: `US market open (${day} ${m[2]}:${m[3]} ET)` };
  return { pass: true, reason: `US market closed (${day} ${m[2]}:${m[3]} ET)` };
}