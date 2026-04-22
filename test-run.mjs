/**
 * test-run.mjs — injects realistic sample trades then syncs Excel + Google Sheets
 * Run: node test-run.mjs
 */

import "dotenv/config";
import { writeFileSync, appendFileSync, existsSync } from "fs";
import { syncToSheets } from "./sync-sheets.js";
import { exportToExcel } from "./export-excel.js";

const CSV_FILE = process.env.TRADE_LOG_PATH || "C:/Users/spathan/Desktop/sameer-trades.csv";

const HEADERS = "Date,Time (UTC),Broker,Symbol,Asset Class,Side,Quantity,Entry Price,Total USD,Fee (est.),Order ID,Mode,Status,Confidence,Exit Price,Exit Time,P&L USD,P&L %,Notes";

const today = new Date().toISOString().slice(0, 10);

const trades = [
  // Forex — FULL signal, WIN
  [today,"07:12:00","Pepperstone","EURUSD","forex","BUY","22.831204","1.09420","24.98","0.0175","PAPER-1001","PAPER","WIN","✅ FULL","1.09640","2026-04-18 08:45:00","4.5850","0.42%",'"TP hit"'],
  // Forex — STRONG signal, WIN
  [today,"07:35:00","Pepperstone","GBPUSD","forex","SELL","19.120000","1.30680","24.98","0.0175","PAPER-1002","PAPER","WIN","💪 STRONG","1.30280","2026-04-18 09:02:00","7.6480","0.31%",'"TP hit"'],
  // Forex — HALF signal, LOSS
  [today,"08:05:00","Pepperstone","USDJPY","forex","BUY","0.162000","154.320","25.00","0.0175","PAPER-1003","PAPER","LOSS","〰️ HALF","154.190","2026-04-18 08:50:00","-2.1060","-0.08%",'"SL hit"'],
  // Gold — STRONG signal, WIN
  [today,"09:05:00","Pepperstone","XAUUSD","commodity","BUY","0.013800","2712.50","37.43","0.0262","PAPER-1004","PAPER","WIN","💪 STRONG","2724.90","2026-04-18 10:30:00","17.1120","0.46%",'"TP hit"'],
  // Gold — FULL signal, OPEN
  [today,"10:12:00","Pepperstone","XAUUSD","commodity","SELL","0.009200","2718.40","25.01","0.0175","PAPER-1005","PAPER","OPEN","✅ FULL","","","","",'"✅ FULL signal"'],
  // Stocks — STRONG signal, WIN
  [today,"13:52:00","Pepperstone","NVDA","stock","BUY","0.217000","115.30","25.02","0.0175","PAPER-1006","PAPER","WIN","💪 STRONG","116.90","2026-04-18 14:40:00","3.4720","0.30%",'"TP hit"'],
  // Stocks — FULL signal, WIN
  [today,"14:05:00","Pepperstone","TSLA","stock","BUY","0.097000","257.80","25.01","0.0175","PAPER-1007","PAPER","WIN","✅ FULL","260.40","2026-04-18 14:55:00","2.5220","0.10%",'"TP hit"'],
  // Stocks — HALF signal, LOSS
  [today,"14:20:00","Pepperstone","AAPL","stock","SELL","0.115000","217.40","25.00","0.0175","PAPER-1008","PAPER","LOSS","〰️ HALF","218.20","2026-04-18 14:48:00","-0.9200","-0.04%",'"SL hit"'],
  // Stocks — STRONG signal, OPEN
  [today,"14:35:00","Pepperstone","MSFT","stock","BUY","0.062000","403.20","24.99","0.0175","PAPER-1009","PAPER","OPEN","💪 STRONG","","","","",'"💪 STRONG signal"'],
  // Forex — BLOCKED (critical failed)
  [today,"13:31:00","Pepperstone","GBPJPY","forex","","","197.840","","","","BLOCKED","BLOCKED","BLOCKED","","","","",'"Failed: EMA(8/21) direction established"'],
];

console.log("🧪 Writing test trades to CSV...");
writeFileSync(CSV_FILE, HEADERS + "\n");
for (const t of trades) appendFileSync(CSV_FILE, t.join(",") + "\n");
console.log(`   ✅ ${trades.length} trades written to ${CSV_FILE}`);

console.log("\n📊 Exporting to Excel...");
await exportToExcel()
  .then(() => console.log("   ✅ Excel updated on Desktop"))
  .catch(err => console.log(`   ⚠️  Excel failed: ${err.message}`));

console.log("\n☁️  Syncing to Google Sheets...");
await syncToSheets()
  .then(() => console.log("   ✅ Google Sheets synced"))
  .catch(err => console.log(`   ⚠️  Sheets failed: ${err.message}`));

// Summary
const wins   = trades.filter(t => t[12] === "WIN").length;
const losses = trades.filter(t => t[12] === "LOSS").length;
const open   = trades.filter(t => t[12] === "OPEN").length;
const blocked = trades.filter(t => t[12] === "BLOCKED").length;
const pnl    = trades.reduce((s, t) => s + (parseFloat(t[16]) || 0), 0);

console.log("\n─── Test Summary ───────────────────────────────");
console.log(`  Trades: ${wins} WIN · ${losses} LOSS · ${open} OPEN · ${blocked} BLOCKED`);
console.log(`  Net P&L: $${pnl.toFixed(2)}`);
console.log(`  STRONG signals: ${trades.filter(t => t[13] === "💪 STRONG").length}`);
console.log(`  FULL signals:   ${trades.filter(t => t[13] === "✅ FULL").length}`);
console.log(`  HALF signals:   ${trades.filter(t => t[13] === "〰️ HALF").length}`);
console.log("────────────────────────────────────────────────\n");
