# Deploying btc5bot for a multi-day autonomous dry-run

The bot is a long-running loop that streams Polymarket's Chainlink price feed and
order book, evaluates the 6 rules every 250ms, and logs simulated trades + P&L to
`data/dryrun_trades.csv`. This guide runs it as an auto-restarting Docker service
on a VM so it gathers data unattended for days.

## What you need on the VM

- Docker + Docker Compose (`docker --version`, `docker compose version`)
- This project folder copied to the VM
- A `.env` file (copy from `.env.example`). For DRY-RUN you do NOT need a private
  key — leave `POLY_PRIVATE_KEY` blank. `DRY_RUN=true` is the default.

## Run it

```bash
cd btc5bot
cp .env.example .env        # DRY_RUN=true is fine as-is for data gathering
docker compose up -d --build
```

That's it. `restart: unless-stopped` means it survives crashes AND VM reboots.

## Watch it

```bash
docker compose logs -f --tail=50          # live heartbeats + fires + summaries
docker compose logs --since=1h | grep FIRE  # just the trades in the last hour
cat data/dryrun_stats.json                 # current win rate + P&L snapshot (updates every ~60s)
```

The CSV and stats live in `./data/` on the HOST (mounted volume), so they persist
even if you destroy and recreate the container. Pull them anytime:

```bash
column -s, -t data/dryrun_trades.csv | less -S   # pretty-print the trade log
```

## Stop / restart

```bash
docker compose stop      # graceful: SIGTERM flushes stats, CSV is intact
docker compose start     # resume (note: in-memory win/loss tally resets;
                         #   the CSV is the source of truth across restarts)
docker compose down      # stop + remove container (data/ is preserved)
```

> Note: the running win/loss counters are in memory and reset on restart. The
> **CSV is the durable record** — analyze that for the full multi-day picture,
> not a single session's `[summary]`.

## Reviewing the data (the part that matters)

After a few hundred trades, the question is NOT "what's the win rate" — it's
"is cumulative P&L positive". At these payouts one loss (~-$1.00) wipes ~49–99
wins, so you need a very high hit rate just to break even. Quick checks:

```bash
# total simulated P&L
awk -F, 'NR>1{s+=$13} END{printf "net pnl: $%.4f over %d trades\n", s, NR-1}' data/dryrun_trades.csv

# win rate by entry price (does 0.98 hold up vs 0.99?)
awk -F, 'NR>1{n[$5]++; if($12=="true") w[$5]++} END{for(p in n) printf "@%s: %d/%d = %.1f%%\n", p, w[p], n[p], 100*w[p]/n[p]}' data/dryrun_trades.csv

# do losses cluster at low diff? (col 9 = diffAtEntry, col 12 = won)
awk -F, 'NR>1 && $12=="false"{print "LOSS diff="$9" secsLeft="$10}' data/dryrun_trades.csv
```

Send me `dryrun_stats.json` + the CSV and we'll read whether the edge is real
before anything goes live.

## Resource footprint

Tiny — a couple of WebSockets and a 250ms loop. A 1 vCPU / 1 GB VM is plenty.
Logs are capped at 20 MB × 5 files so they won't fill the disk over days.

## IMPORTANT: this image is dry-run only by design

`DRY_RUN=true` is baked in as the default and there's no key in the image. Going
live is a deliberate, separate step (set `DRY_RUN=false` + provide
`POLY_PRIVATE_KEY`/`POLY_FUNDER_ADDRESS`) that we should only take after the
dry-run data justifies it AND we've spot-checked sim wins against real Polymarket
resolutions. Do not flip it casually.