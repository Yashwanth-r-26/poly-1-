# btc5bot — structured BTC/ETH 5m & 15m strategy (dry-run first)

Trades Polymarket "Up or Down" crypto markets on a strict 6-rule strategy.
Default is DRY-RUN: it makes every real decision, simulates the fill, and scores
win/loss against the actual window close — no money moves until you flip it.

## Quick start

```bash
npm install
cp .env.example .env        # fill POLY_PRIVATE_KEY + POLY_FUNDER_ADDRESS for live; not needed for dry-run
npm start                   # dry-run by default
```

Let it run through several windows. Watch the `[FIRE]`, `[sim] FILL`,
`[sim] SETTLE`, and `[summary]` lines. Decisions are also written to
`dryrun_trades.csv`.

## The 6 rules (each a tested gate, evaluated in this order)

1. **Rule 5 — Session.** Skip during US market hours (NYSE 09:30–16:00 ET,
   Mon–Fri). Computed in ET with DST handled, regardless of your machine clock.
2. **Rule 6 — Daily loss kill.** One loss in an (ET) day -> halt immediately.
3. **Rule 1 — Timing.** Enter only between 50s and 15s remaining. Never >1 min.
4. **Book scan (replaces old Rule 4).** Fetch BOTH the Up-token and Down-token
   order books each tick. Entry is driven by price: whichever side's best ask
   sits at the ~$0.99 favorite is the candidate. (The old diff-vs-time Rule 4
   was removed — it conflicted with the 15–50s entry window.)
5. **Rule 3 / 3.1 / 3.2 — Price + stability.** Buy the favorite side at ~$0.99
   (never below the $0.98 floor, never above target+tol). Each side runs its own
   mark→leave→**return** + ≥2s stability state machine. If neither side is at
   ~$0.99, the bot simply waits.
6. **Rule 2 — Order book skew.** Soft veto only: skip the side if its book leans
   hard against us. Otherwise allow.

Strike (Chainlink at window open) is still captured — but only so the P&L sim
can settle win/loss. It is no longer a trading gate.

All gates pass -> place a $1 FOK buy on the winning side.

## One position at a time

Across all 4 markets, only one position is open at once. This keeps Rule 6's
one-loss kill enforceable — you can't open four losers in one bad window.

## Key facts baked in (learned the hard way)

- **Strike = Chainlink price at window open**, captured live from
  `wss://ws-live-data.polymarket.com` (topic `crypto_prices_chainlink`). It is
  NOT in the market metadata. The feed has no history, so the bot must be
  connected before a window opens; windows it joins late are skipped (strike not
  "clean").
- Subscribe with `type:"*"` and `filters` as an **escaped JSON string**; one
  symbol per socket; PING every 5s. (All handled in `feed.ts`.)
- Executor: `@polymarket/clob-client-v2` v1.0.6, `SignatureTypeV2.POLY_1271`
  (sigType 3), `createAndPostMarketOrder` + `OrderType.FOK`, amount in USDC $
  for BUY. This is the path that placed a real matched order.

## The honest economics

Buying at $0.99 means a win nets ~**+$0.0101** and a loss costs ~**−$1.00**.
**~99 wins are needed to recover a single loss.** The strategy only profits if
the hit rate stays extremely high — which is the entire point of Rule 4 (only
bet near-locked windows) and Rule 6 (stop after one loss). Dry-run exists to
measure that hit rate before risking capital. Watch the win rate in `[summary]`.

## Going live

Only after dry-run shows a hit rate that survives the economics above:
set `DRY_RUN=false` in `.env` (requires `POLY_PRIVATE_KEY` + `POLY_FUNDER_ADDRESS`).

## Files

- `feed.ts` — Chainlink RTDS client (strike capture, live price, joined-late guard)
- `rules.ts` — the 6 gates as pure functions
- `risk.ts` — Rule 6 kill switch
- `markets.ts` — active-window tokenIds + order book
- `executor.ts` — order placement (reused, dry-run aware)
- `pnl.ts` — fill simulation + settlement + CSV
- `strategy.ts` — orchestrator (gate order, one-position lock)
- `index.ts` — entrypoint
- `diagnose.ts` — standalone feed proof (Phase 0)