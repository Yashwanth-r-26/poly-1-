import http from "http";
import fs from "fs";
import type { PnlSim } from "./pnl.js";
import { config } from "./config.js";

/**
 * Minimal status server (Node built-in http, no deps).
 *   GET /        -> auto-refreshing HTML stats page
 *   GET /stats   -> JSON summary
 *   GET /csv     -> download the raw trade log
 *   GET /health  -> "ok" (for uptime checks)
 *
 * Bind 0.0.0.0 so it's reachable from outside the VM. Open the port in your
 * cloud firewall / security group to view it in a browser.
 */
export function startStatusServer(
  sim: PnlSim,
  getMeta: () => { feedBTC?: number; feedETH?: number; uptimeSec: number; openPositions: number },
  port = parseInt(process.env.STATUS_PORT || "8080", 10)
) {
  const csvPath = process.env.SIM_CSV || "data/dryrun_trades.csv";

  const server = http.createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];

    if (url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    if (url === "/stats") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...sim.summary(), ...getMeta() }, null, 2));
      return;
    }

    if (url === "/csv") {
      try {
        const data = fs.readFileSync(csvPath);
        res.writeHead(200, {
          "Content-Type": "text/csv",
          "Content-Disposition": "attachment; filename=dryrun_trades.csv",
        });
        res.end(data);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("no CSV yet — no trades recorded");
      }
      return;
    }

    // default: HTML dashboard
    const s = sim.summary();
    const meta = getMeta();
    const bands = Object.keys(s.byPrice).sort();
    const bandRows = bands.map((k) => {
      const b = s.byPrice[k];
      const wr = b.n ? ((b.wins / b.n) * 100).toFixed(1) : "0";
      return `<tr><td>@${k}</td><td>${b.wins}/${b.n}</td><td>${wr}%</td><td>$${b.pnl.toFixed(4)}</td></tr>`;
    }).join("");
    const up = Math.floor(meta.uptimeSec);
    const upStr = `${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m`;
    const pnlColor = s.pnl >= 0 ? "#16a34a" : "#dc2626";
    const wrColor = s.winRate >= 0.98 ? "#16a34a" : s.trades > 0 ? "#dc2626" : "#64748b";

    const html = `<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>btc5bot — dry-run stats</title>
<style>
  body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#0b0f17;color:#e2e8f0;margin:0;padding:24px;}
  .wrap{max-width:720px;margin:0 auto;}
  h1{font-size:18px;color:#94a3b8;font-weight:600;margin:0 0 4px;}
  .sub{color:#475569;font-size:12px;margin-bottom:20px;}
  .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:20px;}
  .card{background:#111827;border:1px solid #1f2937;border-radius:10px;padding:16px;}
  .label{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;}
  .val{font-size:26px;font-weight:700;margin-top:6px;}
  table{width:100%;border-collapse:collapse;background:#111827;border:1px solid #1f2937;border-radius:10px;overflow:hidden;}
  th,td{padding:10px 14px;text-align:left;font-size:13px;border-bottom:1px solid #1f2937;}
  th{color:#64748b;font-weight:600;font-size:11px;text-transform:uppercase;}
  .warn{margin-top:18px;padding:12px 14px;background:#1e1b16;border:1px solid #422006;border-radius:8px;color:#fbbf24;font-size:12px;line-height:1.5;}
  a{color:#60a5fa;}
  .feed{font-size:12px;color:#64748b;margin-top:16px;}
</style></head><body><div class="wrap">
<h1>btc5bot — dry-run stats</h1>
<div class="sub">${config.dryRun ? "DRY-RUN" : "LIVE"} · uptime ${upStr} · auto-refreshes every 15s · <a href="/csv">download CSV</a> · <a href="/stats">json</a></div>
<div class="grid">
  <div class="card"><div class="label">Trades settled</div><div class="val">${s.trades}</div></div>
  <div class="card"><div class="label">Win rate</div><div class="val" style="color:${wrColor}">${(s.winRate*100).toFixed(1)}%</div></div>
  <div class="card"><div class="label">Net P&amp;L</div><div class="val" style="color:${pnlColor}">$${s.pnl.toFixed(4)}</div></div>
  <div class="card"><div class="label">W / L</div><div class="val">${s.wins} / ${s.losses}</div></div>
</div>
${bands.length ? `<table><tr><th>Entry price</th><th>W/N</th><th>Win rate</th><th>P&amp;L</th></tr>${bandRows}</table>` : '<div class="card">No settled trades yet.</div>'}
<div class="feed">feed: BTC=${meta.feedBTC?.toFixed(2) ?? "—"} ETH=${meta.feedETH?.toFixed(2) ?? "—"} · open positions: ${meta.openPositions}</div>
<div class="warn"><b>Reading this:</b> win rate alone is misleading. At ~$0.99 entries one loss (−$1.00) wipes ~99 wins; at $0.98, ~49. The number that decides go-live is <b>Net P&amp;L positive over a large sample</b>, not a high win rate. In-memory counters reset on restart — the CSV is the durable record.</div>
</div></body></html>`;

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  });

  server.on("error", (e: any) => console.log(`[status] server error: ${e?.message}`));
  server.listen(port, "0.0.0.0", () => {
    console.log(`[status] dashboard on http://0.0.0.0:${port}  (/, /stats, /csv, /health)`);
  });
  return server;
}