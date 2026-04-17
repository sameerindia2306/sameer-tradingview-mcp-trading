/**
 * Sameer Trading Bot — Pepperstone / cTrader
 * Assets: Forex (EURUSD, GBPUSD, USDJPY) · Gold (XAUUSD) · Tech stocks (AAPL, TSLA, NVDA)
 * Data:   Twelve Data API (free tier)
 * Exec:   cTrader Open API (Pepperstone live account)
 * Strategies:
 *   XAUUSD  → ICT Silver Bullet (FVG + liquidity, 3 NY windows)
 *   Stocks  → EMA(9/21) cross + VWAP + RSI(14) momentum (trend-following)
 *   Forex   → London/NY breakout + EMA(9/21) cross + FVG confirmation
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { google } from "googleapis";
import { placeMarketOrder, isConfigured } from "./ctrader.js";
import http from "http";

// Health check endpoint so Railway can monitor and auto-restart if unresponsive
http.createServer((_, res) => res.end("OK")).listen(process.env.PORT || 3000);

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
  symbols:         (process.env.SYMBOLS || "EURUSD,GBPUSD,XAUUSD,AAPL,TSLA,NVDA").split(",").map(s => s.trim()),
  timeframe:       process.env.TIMEFRAME || "5m",
  portfolioValue:  parseFloat(process.env.PORTFOLIO_VALUE_USD  || "300"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD   || "25"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY     || "25"),
  paperTrading:    process.env.PAPER_TRADING !== "false",
  tdApiKey:        process.env.TWELVE_DATA_API_KEY || "",
};

const CSV_FILE = process.env.TRADE_LOG_PATH || "C:/Users/spathan/Desktop/sameer-trades.csv";
const POSITIONS_FILE = "open-positions.json";
const LOG_FILE       = "safety-check-log.json";
const SHEET_ID       = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME     = "Sameer Trades";

// Symbol → Twelve Data format
const TD_SYMBOL = {
  EURUSD: "EUR/USD", GBPUSD: "GBP/USD", USDJPY: "USD/JPY",
  AUDUSD: "AUD/USD", USDCAD: "USD/CAD", USDCHF: "USD/CHF",
  XAUUSD: "XAU/USD", XAGUSD: "XAG/USD",
  AAPL: "AAPL", TSLA: "TSLA", NVDA: "NVDA",
  MSFT: "MSFT", AMZN: "AMZN", GOOGL: "GOOGL", META: "META",
};

const FOREX_PAIRS = new Set(["EURUSD","GBPUSD","USDJPY","AUDUSD","USDCAD","USDCHF","NZDUSD","EURGBP","EURJPY","GBPJPY"]);
function assetClass(symbol) {
  if (symbol.includes("XAU") || symbol.includes("XAG")) return "commodity";
  if (FOREX_PAIRS.has(symbol)) return "forex";
  return "stock"; // any other symbol (AAPL, QCOM, DDOG, etc.)
}

// ─── Session Filter ───────────────────────────────────────────────────────────

function isInSession(symbol) {
  const t = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  if (assetClass(symbol) === "stock") return t >= 810 && t < 1200; // NYSE 13:30–20:00 UTC
  return (t >= 480 && t < 600) || (t >= 780 && t < 960);           // London + NY
}

// ─── Market Data (Twelve Data) ────────────────────────────────────────────────

const INTERVAL_MAP = { "1m":"1min","3m":"3min","5m":"5min","15m":"15min","30m":"30min","1H":"1h","4H":"4h","1D":"1day" };

async function fetchCandles(symbol, limit = 100) {
  const tdSym    = TD_SYMBOL[symbol] || symbol;
  const interval = INTERVAL_MAP[CONFIG.timeframe] || "5min";
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSym)}&interval=${interval}&outputsize=${limit}&order=ASC&apikey=${CONFIG.tdApiKey}`;
  const res  = await fetch(url);
  const json = await res.json();
  if (json.status === "error") throw new Error(`Twelve Data: ${json.message}`);
  if (!json.values?.length)    throw new Error(`No candle data for ${symbol}`);
  return json.values.map(v => ({
    time:   new Date(v.datetime).getTime(),
    open:   parseFloat(v.open),   high:  parseFloat(v.high),
    low:    parseFloat(v.low),    close: parseFloat(v.close),
    volume: parseFloat(v.volume || 0),
  }));
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(closes, period = 3) {
  if (closes.length < period + 1) return null;
  const diffs   = closes.slice(-period - 1).map((v, i, a) => i === 0 ? 0 : v - a[i - 1]).slice(1);
  const avgGain = diffs.map(d => d > 0 ? d : 0).reduce((a, b) => a + b, 0) / period;
  const avgLoss = diffs.map(d => d < 0 ? -d : 0).reduce((a, b) => a + b, 0) / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcVWAP(candles) {
  const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0);
  const session  = candles.filter(c => c.time >= midnight.getTime());
  // Fall back to all candles if no intraday data yet (e.g. outside market hours)
  const src      = session.length >= 3 ? session : candles.slice(-20);
  if (!src.length) return null;
  const cumVol = src.reduce((s, c) => s + c.volume, 0);
  // If no volume data (forex), use equal-weighted average of typical price
  if (cumVol === 0) return src.reduce((s, c) => s + (c.high + c.low + c.close) / 3, 0) / src.length;
  const cumTPV = src.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0);
  return cumTPV / cumVol;
}

function calcVolumeRatio(candles, period = 20) {
  if (candles.length < period + 1) return null;
  const avg = candles.slice(-period - 1, -1).reduce((s, c) => s + c.volume, 0) / period;
  return avg === 0 ? null : candles[candles.length - 1].volume / avg;
}

// ─── ICT Silver Bullet (XAUUSD only) ─────────────────────────────────────────

function getNYHour() {
  // Returns current NY hour accounting for EDT/EST
  const now = new Date();
  const nyOffset = isDST(now) ? -4 : -5;
  return ((now.getUTCHours() + nyOffset + 24) % 24) + now.getUTCMinutes() / 60;
}

function isDST(date) {
  // US DST: second Sunday March → first Sunday November
  const jan = new Date(date.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
  return date.getTimezoneOffset() < Math.max(jan, jul);
}

function isInSilverBulletWindow() {
  const nyH = getNYHour();
  return (nyH >= 3 && nyH < 4) ||   // 3–4 AM NY
         (nyH >= 10 && nyH < 11) ||  // 10–11 AM NY
         (nyH >= 14 && nyH < 15);    // 2–3 PM NY
}

function detectFVG(candles) {
  // Scan last 10 candles for the most recent Fair Value Gap
  for (let i = candles.length - 1; i >= 2; i--) {
    const prev2 = candles[i - 2];
    const curr  = candles[i];

    // Bullish FVG: gap between high of candle[i-2] and low of candle[i]
    if (curr.low > prev2.high) {
      return { type: "bullish", top: curr.low, bottom: prev2.high, mid: (curr.low + prev2.high) / 2, index: i };
    }

    // Bearish FVG: gap between low of candle[i-2] and high of candle[i]
    if (curr.high < prev2.low) {
      return { type: "bearish", top: prev2.low, bottom: curr.high, mid: (prev2.low + curr.high) / 2, index: i };
    }
  }
  return null;
}

function runSilverBulletCheck(candles) {
  const results = [];
  const check   = (label, pass) => { results.push({ label, pass }); console.log(`  ${pass ? "✅" : "🚫"} ${label}`); };

  const price   = candles[candles.length - 1].close;
  const inWindow = isInSilverBulletWindow();
  const nyH      = getNYHour().toFixed(2);

  check(`Silver Bullet window (3–4AM / 10–11AM / 2–3PM NY) — now ${nyH} NY`, inWindow);

  const fvg = detectFVG(candles.slice(-15));
  check("Fair Value Gap detected in last 15 candles", !!fvg);

  if (!fvg) return { results, allPass: false, side: null, fvg: null };

  const inFVG = price >= fvg.bottom && price <= fvg.top;
  check(`Price retracing into FVG (${fvg.bottom.toFixed(2)}–${fvg.top.toFixed(2)})`, inFVG);
  check(`FVG direction: ${fvg.type.toUpperCase()}`, true);

  const allPass = results.every(r => r.pass);
  const side    = fvg.type === "bullish" ? "buy" : "sell";
  return { results, allPass, side, fvg };
}

// ─── NYSE Tech Stock Strategy — EMA Cross + VWAP Bounce ──────────────────────

function isInNYSESession() {
  // NYSE: 9:35 AM–3:30 PM NY (skip first 5 min of open)
  const nyH = getNYHour();
  return nyH >= 9.583 && nyH < 15.5; // 9:35–15:30
}

function runStockCheck(symbol, candles) {
  const results = [];
  const check   = (label, pass) => { results.push({ label, pass }); console.log(`  ${pass ? "✅" : "🚫"} ${label}`); };

  const closes   = candles.map(c => c.close);
  const price    = closes[closes.length - 1];
  const ema9     = calcEMA(closes, 9);
  const ema21    = calcEMA(closes, 21);
  const rsi14    = calcRSI(closes, 14);
  const vwap     = calcVWAP(candles);
  const volRatio = calcVolumeRatio(candles);

  console.log(`  EMA(9): ${ema9.toFixed(3)} | EMA(21): ${ema21.toFixed(3)} | RSI(14): ${rsi14 ? rsi14.toFixed(1) : "N/A"}`);

  check("NYSE session (9:35 AM–3:30 PM NY)", isInNYSESession());

  const bullish = price > vwap && ema9 > ema21;
  const bearish = price < vwap && ema9 < ema21;

  if (bullish) {
    check("Price above VWAP — buyers in control", true);
    check("EMA(9) above EMA(21) — uptrend confirmed", true);
    check("RSI(14) in momentum zone (45–65)", rsi14 !== null && rsi14 >= 45 && rsi14 <= 65);
    check("Volume above average", volRatio !== null && volRatio > 1.0);
    check("Price within 1.0% of VWAP — near value area", vwap ? Math.abs((price - vwap) / vwap) < 0.010 : false);
  } else if (bearish) {
    check("Price below VWAP — sellers in control", true);
    check("EMA(9) below EMA(21) — downtrend confirmed", true);
    check("RSI(14) in momentum zone (35–55)", rsi14 !== null && rsi14 >= 35 && rsi14 <= 55);
    check("Volume above average", volRatio !== null && volRatio > 1.0);
    check("Price within 1.0% of VWAP — near value area", vwap ? Math.abs((price - vwap) / vwap) < 0.010 : false);
  } else {
    check("Market bias — EMA(9)/EMA(21) + VWAP alignment required", false);
  }

  const allPass = results.every(r => r.pass);
  const side    = bullish ? "buy" : bearish ? "sell" : null;
  return { results, allPass, side };
}

// ─── Forex Combo Strategy — Breakout + EMA Cross + FVG ───────────────────────

function getPreSessionRange(candles, sessionStartUTC, windowMins = 120) {
  // Build high/low from the consolidation window before a session opens
  const sessionStart = sessionStartUTC * 60; // minutes since midnight UTC
  const windowStart  = sessionStart - windowMins;
  const today        = new Date(); today.setUTCHours(0, 0, 0, 0);

  const windowCandles = candles.filter(c => {
    const minsIntoDay = (c.time - today.getTime()) / 60000;
    return minsIntoDay >= windowStart && minsIntoDay < sessionStart;
  });

  if (windowCandles.length < 3) return null;
  return {
    high: Math.max(...windowCandles.map(c => c.high)),
    low:  Math.min(...windowCandles.map(c => c.low)),
  };
}

function runForexComboCheck(symbol, candles) {
  const results  = [];
  const check    = (label, pass) => { results.push({ label, pass }); console.log(`  ${pass ? "✅" : "🚫"} ${label}`); };

  const closes   = candles.map(c => c.close);
  const price    = closes[closes.length - 1];
  const ema9     = calcEMA(closes, 9);
  const ema21    = calcEMA(closes, 21);
  const rsi14    = calcRSI(closes, 14);

  // Determine active session and its pre-session range
  const utcH = new Date().getUTCHours() + new Date().getUTCMinutes() / 60;
  const inLondon = utcH >= 8 && utcH < 10;
  const inNY     = utcH >= 13 && utcH < 16;

  check("London (08–10 UTC) or NY (13–16 UTC) session", inLondon || inNY);

  const range = inLondon
    ? getPreSessionRange(candles, 8,  120)   // 06:00–08:00 UTC
    : inNY
    ? getPreSessionRange(candles, 13, 120)   // 11:00–13:00 UTC
    : null;

  const bullish = ema9 > ema21 && price > (range?.high ?? price);
  const bearish = ema9 < ema21 && price < (range?.low  ?? price);

  if (range) {
    console.log(`  Range: ${range.low.toFixed(5)}–${range.high.toFixed(5)} | EMA(9): ${ema9.toFixed(5)} | EMA(21): ${ema21.toFixed(5)} | RSI(14): ${rsi14?.toFixed(1) ?? "N/A"}`);
    if (bullish) {
      check(`Breakout above pre-session high (${range.high.toFixed(5)})`, price > range.high);
    } else if (bearish) {
      check(`Breakout below pre-session low (${range.low.toFixed(5)})`, price < range.low);
    } else {
      check("Breakout above/below pre-session range", false);
    }
  } else {
    check("Pre-session range defined (need data from 2h before session)", false);
  }

  if (bullish) {
    check("EMA(9) above EMA(21) — uptrend aligned", true);
    check("RSI(14) in momentum zone (45–65)", rsi14 !== null && rsi14 >= 45 && rsi14 <= 65);
  } else if (bearish) {
    check("EMA(9) below EMA(21) — downtrend aligned", true);
    check("RSI(14) in momentum zone (35–55)", rsi14 !== null && rsi14 >= 35 && rsi14 <= 55);
  } else {
    check("EMA(9/21) trend aligned with breakout direction", false);
    check("RSI(14) in momentum zone", false);
  }

  // FVG in direction of trade
  const fvg = detectFVG(candles.slice(-15));
  const fvgAligned = fvg &&
    ((bullish && fvg.type === "bullish") ||
     (bearish && fvg.type === "bearish"));

  if (fvg) {
    check(`FVG aligned with direction — ${fvg.type} gap (${fvg.bottom.toFixed(5)}–${fvg.top.toFixed(5)})`, fvgAligned);
  } else {
    check("FVG in trade direction detected", false);
  }

  const allPass = results.every(r => r.pass);
  const side    = bullish ? "buy" : bearish ? "sell" : null;
  return { results, allPass, side, fvg: fvgAligned ? fvg : null };
}

// ─── Position Tracking ────────────────────────────────────────────────────────

function loadPositions() { return existsSync(POSITIONS_FILE) ? JSON.parse(readFileSync(POSITIONS_FILE, "utf8")) : []; }
function savePositions(p) { writeFileSync(POSITIONS_FILE, JSON.stringify(p, null, 2)); }

function addPosition(symbol, side, price, qty, orderId, paper, fvg = null) {
  let sl, tp;
  if (fvg) {
    // ICT Silver Bullet: SL beyond FVG edge + 2pt buffer, TP at 2:1
    const buf = 2.0; // $2 buffer beyond FVG edge
    sl = side === "buy"  ? fvg.bottom - buf : fvg.top + buf;
    const risk = Math.abs(price - sl);
    tp = side === "buy"  ? price + risk * 2  : price - risk * 2;
  } else if (assetClass(symbol) === "stock") {
    // Moderate risk for stocks: 0.5% SL, 1.5% TP (3:1)
    sl = side === "buy" ? price * 0.995 : price * 1.005;
    tp = side === "buy" ? price * 1.015 : price * 0.985;
  } else {
    // Forex combo: SL beyond FVG edge if available, else 0.25% SL, 0.5% TP (2:1)
    if (fvg) {
      const buf = price * 0.0005;
      sl = side === "buy"  ? fvg.bottom - buf : fvg.top + buf;
      const risk = Math.abs(price - sl);
      tp = side === "buy"  ? price + risk * 2  : price - risk * 2;
    } else {
      sl = side === "buy" ? price * 0.9975 : price * 1.0025;
      tp = side === "buy" ? price * 1.005  : price * 0.995;
    }
  }
  const pos = loadPositions();
  pos.push({ symbol, side, entryPrice: price, quantity: qty, orderId, sl, tp, paperTrading: paper, openedAt: new Date().toISOString() });
  savePositions(pos);
}

function checkAndClosePositions(symbol, price) {
  const positions = loadPositions(), remaining = [], closed = [];
  for (const pos of positions) {
    if (pos.symbol !== symbol) { remaining.push(pos); continue; }
    const isLong = pos.side === "buy";
    const hitTP  = isLong ? price >= pos.tp : price <= pos.tp;
    const hitSL  = isLong ? price <= pos.sl : price >= pos.sl;
    if (hitTP || hitSL) {
      const exit   = hitTP ? pos.tp : pos.sl;
      const pnlUSD = isLong ? (exit - pos.entryPrice) * pos.quantity : (pos.entryPrice - exit) * pos.quantity;
      const pnlPct = ((exit - pos.entryPrice) / pos.entryPrice) * (isLong ? 100 : -100);
      closed.push({ ...pos, exitPrice: exit, exitTime: new Date().toISOString(), pnlUSD, pnlPct, result: hitTP ? "WIN" : "LOSS" });
    } else { remaining.push(pos); }
  }
  savePositions(remaining);
  return closed;
}

// ─── Trade Log ────────────────────────────────────────────────────────────────

function loadLog()  { return existsSync(LOG_FILE) ? JSON.parse(readFileSync(LOG_FILE, "utf8")) : { trades: [] }; }
function saveLog(l) { writeFileSync(LOG_FILE, JSON.stringify(l, null, 2)); }
function todayCount(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(t => t.timestamp?.startsWith(today) && t.orderPlaced).length;
}

const CSV_HEADERS = "Date,Time (UTC),Broker,Symbol,Asset Class,Side,Quantity,Entry Price,Total USD,Fee (est.),Order ID,Mode,Status,Exit Price,Exit Time,P&L USD,P&L %,Notes";

function initCsv() {
  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
}

function writeTradeCsv(entry) {
  const now  = new Date(entry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);
  const cls  = assetClass(entry.symbol);
  let row;
  if (!entry.allPass) {
    const reasons = entry.conditions.filter(c => !c.pass).map(c => c.label).join("; ");
    row = [date, time, "Pepperstone", entry.symbol, cls, "", "", entry.price?.toFixed(5) || "", "", "", "BLOCKED", "BLOCKED", "BLOCKED", "", "", "", "", `"Failed: ${reasons}"`].join(",");
  } else {
    const qty = (entry.tradeSize / entry.price).toFixed(6);
    const fee = (entry.tradeSize * 0.0007).toFixed(4);
    row = [date, time, "Pepperstone", entry.symbol, cls, entry.side?.toUpperCase() || "BUY", qty, entry.price?.toFixed(5) || "", entry.tradeSize.toFixed(2), fee, entry.orderId || "", entry.paperTrading ? "PAPER" : "LIVE", "OPEN", "", "", "", "", `"All conditions met"`].join(",");
  }
  appendFileSync(CSV_FILE, row + "\n");
  appendSheetRow(row.split(","), entry.symbol).catch(() => {});
}

function writeCloseCsv(closed) {
  const o   = new Date(closed.openedAt);
  const x   = new Date(closed.exitTime);
  const cls = assetClass(closed.symbol);
  const row = [
    o.toISOString().slice(0,10), o.toISOString().slice(11,19), "Pepperstone",
    closed.symbol, cls, closed.side.toUpperCase(), closed.quantity.toFixed(6),
    closed.entryPrice.toFixed(5), (closed.entryPrice * closed.quantity).toFixed(2),
    (closed.entryPrice * closed.quantity * 0.0007).toFixed(4),
    closed.orderId, closed.paperTrading ? "PAPER" : "LIVE", closed.result,
    closed.exitPrice.toFixed(5), x.toISOString().slice(0,19).replace("T"," "),
    closed.pnlUSD.toFixed(4), closed.pnlPct.toFixed(2) + "%",
    `"${closed.result === "WIN" ? "Take profit hit" : "Stop loss hit"}"`,
  ].join(",");
  appendFileSync(CSV_FILE, row + "\n");
  appendSheetRow(row.split(","), closed.symbol).catch(() => {});
  console.log(`  ${closed.result === "WIN" ? "✅ WIN" : "❌ LOSS"} ${closed.symbol} | P&L: $${closed.pnlUSD.toFixed(4)} (${closed.pnlPct.toFixed(2)}%)`);
}

// ─── Google Sheets — 3-Tab Setup (Gold / Tech Stocks / Forex) ────────────────

const TABS = {
  commodity: { name: "Gold",        color: { red: 1.00, green: 0.84, blue: 0.00 } },
  stock:     { name: "Tech Stocks", color: { red: 0.20, green: 0.40, blue: 0.80 } },
  forex:     { name: "Forex",       color: { red: 0.20, green: 0.70, blue: 0.30 } },
};

const ROW_COLORS = {
  BLOCKED: { red: 0.835, green: 0.000, blue: 0.000 },
  OPEN:    { red: 0.000, green: 0.784, blue: 0.325 },
  WIN:     { red: 1.000, green: 0.839, blue: 0.000 },
  LOSS:    { red: 1.000, green: 0.427, blue: 0.000 },
};

const HEADER_COLOR  = { red: 0.082, green: 0.396, blue: 0.753 };
const BORDER_STYLE  = { style: "SOLID", color: { red: 0.6, green: 0.6, blue: 0.6 } };
const COL_COUNT     = 18;

const sheetIdCache  = {};   // tab name → numeric sheetId
let   sheetsClient  = null; // reuse across calls in same run

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  let credentials;
  if (process.env.GOOGLE_CREDENTIALS_B64) {
    credentials = JSON.parse(Buffer.from(process.env.GOOGLE_CREDENTIALS_B64, "base64").toString("utf8"));
  } else if (process.env.GOOGLE_CREDENTIALS_PATH && existsSync(process.env.GOOGLE_CREDENTIALS_PATH)) {
    credentials = JSON.parse(readFileSync(process.env.GOOGLE_CREDENTIALS_PATH, "utf8"));
  } else return null;
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  sheetsClient = google.sheets({ version: "v4", auth: await auth.getClient() });
  return sheetsClient;
}

async function getSheetId(sheets, tabName) {
  if (sheetIdCache[tabName] !== undefined) return sheetIdCache[tabName];
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  for (const s of meta.data.sheets) sheetIdCache[s.properties.title] = s.properties.sheetId;
  return sheetIdCache[tabName] ?? null;
}

async function ensureTab(sheets, tabName, tabColor) {
  const sid = await getSheetId(sheets, tabName);
  if (sid !== null) return sid;

  // Create the tab
  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: tabName, tabColor } } }] },
  });
  const newId = res.data.replies[0].addSheet.properties.sheetId;
  sheetIdCache[tabName] = newId;

  const headers = CSV_HEADERS.split(",");

  // Write header row
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID, range: `${tabName}!A1`,
    valueInputOption: "RAW", requestBody: { values: [headers] },
  });

  // Format header + freeze + borders on A:R up to row 1000
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests: [
      // Bold blue header
      { repeatCell: {
        range: { sheetId: newId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: {
          backgroundColor: HEADER_COLOR,
          textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 11 },
          horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE",
        }},
        fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)",
      }},
      // Freeze header
      { updateSheetProperties: {
        properties: { sheetId: newId, gridProperties: { frozenRowCount: 1 } },
        fields: "gridProperties.frozenRowCount",
      }},
      // Borders on entire data area
      { updateBorders: {
        range: { sheetId: newId, startRowIndex: 0, endRowIndex: 1000, startColumnIndex: 0, endColumnIndex: COL_COUNT },
        top: BORDER_STYLE, bottom: BORDER_STYLE, left: BORDER_STYLE, right: BORDER_STYLE,
        innerHorizontal: BORDER_STYLE, innerVertical: BORDER_STYLE,
      }},
      // Auto-resize columns
      { autoResizeDimensions: {
        dimensions: { sheetId: newId, dimension: "COLUMNS", startIndex: 0, endIndex: COL_COUNT },
      }},
    ]},
  });

  return newId;
}

async function formatDataRow(sheets, sheetId, rowIndex, status) {
  const color    = ROW_COLORS[status.toUpperCase()] || null;
  if (!color) return;
  const textWhite = status.toUpperCase() === "BLOCKED";
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests: [{ repeatCell: {
      range: { sheetId, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: 0, endColumnIndex: COL_COUNT },
      cell: { userEnteredFormat: {
        backgroundColor: color,
        textFormat: { foregroundColor: textWhite ? { red: 1, green: 1, blue: 1 } : { red: 0, green: 0, blue: 0 } },
        verticalAlignment: "MIDDLE",
      }},
      fields: "userEnteredFormat(backgroundColor,textFormat,verticalAlignment)",
    }}]},
  });
}

async function appendSheetRow(row, symbol) {
  if (!SHEET_ID) return;
  try {
    const sheets  = await getSheetsClient();
    if (!sheets) return;

    const cls     = assetClass(symbol || "");
    const tab     = TABS[cls] || TABS.forex;
    const sheetId = await ensureTab(sheets, tab.name, tab.color);

    // Count existing rows to know the index of the new row
    const countRes = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab.name}!A:A` });
    const rowIndex = countRes.data.values?.length ?? 1;

    // Append data
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: `${tab.name}!A:R`,
      valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row.map(v => String(v).replace(/^"|"$/g, ""))] },
    });

    // Colour-code the row by Status (column index 12)
    const status = String(row[12] || "").replace(/^"|"$/g, "").trim();
    await formatDataRow(sheets, sheetId, rowIndex, status);

  } catch (err) {
    console.log(`  ⚠️  Sheets sync failed: ${err.message}`);
  }
}

// ─── Per-Symbol Run ───────────────────────────────────────────────────────────

async function runSymbol(symbol, log) {
  console.log(`\n── ${symbol} (${assetClass(symbol)}) ${"─".repeat(38)}`);

  let candles;
  try { candles = await fetchCandles(symbol, 100); }
  catch (err) { console.log(`  ⚠️  Data error: ${err.message}`); return; }

  const closes   = candles.map(c => c.close);
  const price    = closes[closes.length - 1];
  const ema8     = calcEMA(closes, 8);
  const rsi3     = calcRSI(closes, 3);
  const vwap     = calcVWAP(candles);
  const volRatio = calcVolumeRatio(candles);

  console.log(`  Price: ${price.toFixed(5)} | EMA(8): ${ema8.toFixed(5)} | VWAP: ${vwap ? vwap.toFixed(5) : "N/A"} | RSI(3): ${rsi3 ? rsi3.toFixed(2) : "N/A"}`);

  const closed = checkAndClosePositions(symbol, price);
  for (const c of closed) writeCloseCsv(c);

  // Route XAUUSD to ICT Silver Bullet, everything else to VWAP+RSI
  let results, allPass, side, fvg = null;
  const tradeSize = Math.min(CONFIG.portfolioValue * 0.05, CONFIG.maxTradeSizeUSD);

  if (symbol === "XAUUSD") {
    ({ results, allPass, side, fvg } = runSilverBulletCheck(candles));
  } else if (assetClass(symbol) === "stock") {
    ({ results, allPass, side } = runStockCheck(symbol, candles));
  } else {
    // Forex: London Breakout + EMA Cross + FVG combo
    ({ results, allPass, side, fvg } = runForexComboCheck(symbol, candles));
  }

  const entry = { timestamp: new Date().toISOString(), symbol, price, side, tradeSize, conditions: results, allPass, paperTrading: CONFIG.paperTrading, orderPlaced: false, orderId: null };

  if (!allPass) {
    console.log(`  🚫 BLOCKED — ${results.filter(r => !r.pass).map(r => r.label).join("; ")}`);
  } else {
    const qty = tradeSize / price;
    if (CONFIG.paperTrading) {
      console.log(`  📋 PAPER TRADE — ${side.toUpperCase()} ${symbol} ~$${tradeSize.toFixed(2)}`);
      if (fvg) console.log(`  📐 FVG: ${fvg.bottom.toFixed(2)}–${fvg.top.toFixed(2)} | SL below/above gap | TP 2:1`);
      entry.orderPlaced = true;
      entry.orderId = `PAPER-${Date.now()}`;
      addPosition(symbol, side, price, qty, entry.orderId, true, fvg);
    } else if (isConfigured()) {
      console.log(`  🔴 LIVE ORDER — ${side.toUpperCase()} ${symbol} ~$${tradeSize.toFixed(2)}`);
      try {
        const order = await placeMarketOrder(symbol, side, tradeSize, price);
        entry.orderPlaced = true;
        entry.orderId = order.orderId;
        addPosition(symbol, side, price, qty, order.orderId, false, fvg);
        console.log(`  ✅ Order placed — ID: ${order.orderId}`);
      } catch (err) {
        console.log(`  ❌ Order failed: ${err.message}`);
        entry.error = err.message;
      }
    } else {
      console.log(`  ⏳ cTrader not configured yet — awaiting KYC approval`);
      console.log(`     Once approved: run get-token.mjs then set PAPER_TRADING=false`);
    }
  }

  log.trades.push(entry);
  writeTradeCsv(entry);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Sameer Trading Bot — Pepperstone");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER" : "🔴 LIVE"} | cTrader: ${isConfigured() ? "✅ Ready" : "⏳ Awaiting KYC"}`);
  console.log(`  Symbols: ${CONFIG.symbols.join(", ")}`);
  console.log("═══════════════════════════════════════════════════════════");

  if (!CONFIG.tdApiKey) {
    console.log("\n⚠️  TWELVE_DATA_API_KEY missing in .env");
    console.log("   Get your free key at https://twelvedata.com\n");
    return;
  }

  initCsv();
  const log = loadLog();

  if (todayCount(log) >= CONFIG.maxTradesPerDay) {
    console.log(`\n🚫 Daily limit reached (${CONFIG.maxTradesPerDay}). Stopping.`);
    return;
  }

  for (const symbol of CONFIG.symbols) {
    if (todayCount(log) >= CONFIG.maxTradesPerDay) break;
    await runSymbol(symbol, log);
    await new Promise(r => setTimeout(r, 5000)); // 5s gap → 14 symbols spread across ~70s, staying under 8 credits/min
  }

  saveLog(log);
  console.log("\n═══════════════════════════════════════════════════════════\n");
}

const RUN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function loop() {
  await run().catch(err => console.error("Bot cycle error:", err));
  setTimeout(loop, RUN_INTERVAL_MS);
}

loop();
