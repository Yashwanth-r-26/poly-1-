import { config, assertLiveConfig } from "./config.js";
import { ChainlinkFeed } from "./feed.js";
import { BookFeed } from "./bookfeed.js";
import { initExecutor } from "./executor.js";
import { Strategy } from "./strategy.js";
import { startStatusServer } from "./status.js";

async function main() {
  console.log("🤖 btc5bot — BTC/ETH 5m & 15m structured strategy");
  if (config.dryRun) console.log("   ⚠️  DRY-RUN — no real orders. Simulating fills + P&L.");
  else console.log("   🔴 LIVE MODE — real orders will be placed.");
  console.log(`   stake=$${config.stakeUsd}  entry=${config.entryMinSecs}-${config.entryMaxSecs}s  ` +
    `price=${config.priceTarget}(floor ${config.priceFloor})  stability=${config.stabilityMinMs}ms`);
  console.log(`   markets: ${config.enabledIntervals.join(", ")}  maxLoss/day=${config.maxLossesPerDay}`);

  if (!config.dryRun) {
    const errs = assertLiveConfig();
    if (errs.length) {
      console.error("   ✗ live config errors:\n   - " + errs.join("\n   - "));
      process.exit(1);
    }
  }

  const feed = new ChainlinkFeed();
  feed.start();

  const book = new BookFeed();
  book.start();

  try {
    await initExecutor();
  } catch (e: any) {
    if (config.dryRun) console.log(`[exec] init skipped/failed in dry-run: ${e?.message}`);
    else { console.error(`[exec] init failed: ${e?.message}`); process.exit(1); }
  }

  const strat = new Strategy(feed, book);

  // status dashboard — view stats in a browser, no SSH needed
  startStatusServer(strat.getSim(), () => strat.getMeta());

  // graceful shutdown: flush stats so a restart doesn't lose the running tally
  let shuttingDown = false;
  const shutdown = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[shutdown] ${sig} received — flushing stats and exiting`);
    try { strat.printSummary(); } catch { /* */ }
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM")); // docker stop sends this
  process.on("SIGINT", () => shutdown("SIGINT"));   // ctrl-c

  // crash guards: a WS callback throwing should NOT kill a multi-day run.
  // Log it and keep going; the loop and reconnect logic recover.
  process.on("unhandledRejection", (reason) => {
    console.log(`[guard] unhandledRejection: ${reason instanceof Error ? reason.message : reason}`);
  });
  process.on("uncaughtException", (err) => {
    console.log(`[guard] uncaughtException: ${err?.message || err}`);
    // do not exit — let the loop and reconnects carry on
  });

  console.log("\n🚀 running — connect a few min before judging (first window's strike may be missed)\n");

  let ticks = 0;
  const ticksPerHeartbeat = Math.max(1, Math.floor(5000 / config.pollMs));
  const ticksPerSummary = Math.max(1, Math.floor(60000 / config.pollMs));
  for (;;) {
    try { await strat.tick(); } catch (e: any) { console.log(`[tick] error: ${e?.message}`); }
    ticks++;
    if (ticks % ticksPerHeartbeat === 0) strat.heartbeat();
    if (ticks % ticksPerSummary === 0) strat.printSummary();
    await new Promise((r) => setTimeout(r, config.pollMs));
  }
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });