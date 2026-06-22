# Durable trade logging to Google Sheets (no API keys)

Every settled trade is POSTed to a Google Sheet the instant it closes. This
survives container restarts, broken volume mounts, and the entire VM being
destroyed — the row is in the cloud immediately. The local CSV remains as a
secondary backup.

## One-time setup (~3 minutes)

### 1. Create the sheet
- New Google Sheet. Name it e.g. "btc5bot trades".

### 2. Add the Apps Script
- In the sheet: **Extensions -> Apps Script**.
- Delete whatever's there, paste this:

```javascript
const HEADERS = ["ts","asset","window","side","entryPrice","amountUsd","strike",
  "liveAtEntry","diffAtEntry","secsLeftAtEntry","finalPrice","won","pnl"];

function doPost(e) {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    // write header row once
    if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);
    const data = JSON.parse(e.postData.contents);
    sheet.appendRow(HEADERS.map(function(h){ return data[h] !== undefined ? data[h] : ""; }));
    return ContentService.createTextOutput(JSON.stringify({ok:true}))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ok:false,error:String(err)}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet() {
  return ContentService.createTextOutput("btc5bot sheet webhook alive");
}
```

### 3. Deploy as a web app
- Click **Deploy -> New deployment**.
- Type: **Web app**.
- Execute as: **Me**.
- Who has access: **Anyone**.  *(required so the bot can POST without OAuth)*
- Deploy. **Authorize** when prompted (it's your own script).
- Copy the **Web app URL** — it looks like:
  `https://script.google.com/macros/s/AKfy.../exec`

### 4. Give it to the bot
Add to your `.env`:
```
SHEETS_WEBHOOK_URL=https://script.google.com/macros/s/AKfy.../exec
```
Redeploy: `docker compose up -d --build`.

### 5. Verify
- Watch the logs: `docker compose logs -f | grep sheets`
  You should see `[sheets] logging trades to Google Sheet via webhook`.
- Test the URL is alive in a browser — visiting it should print
  `btc5bot sheet webhook alive`.
- On the next settled trade, a row appears in your sheet in real time.

## What happens if the sheet is briefly unreachable

The bot buffers the row to `data/unsent_trades.jsonl` and retries on the next
settle, so a network blip never loses a trade. (If the volume is mounted, that
buffer also survives a restart; if not, see the mount test in DEPLOY.md.)

## Why this is the durable fix

The earlier CSV-only setup lost data on redeploy because the Docker volume
wasn't actually mounting — the file lived inside the ephemeral container. The
Google Sheet lives entirely off-box, so no container/volume/VM failure can wipe
it. You also get a live, shareable view of every trade without SSH.