/**
 * Sameer Trading Bot — Pepperstone / cTrader
 * Data:      Twelve Data API (free tier ~530 credits/day with bias cache)
 * Execution: cTrader Open API (Pepperstone)
 *
 * Forex pairs (best spread/volatility ratio for scalping):
 *   EURUSD · GBPUSD · USDJPY · GBPJPY
 *   Sessions: London 07:00–09:30 UTC · NY 13:30–15:30 UTC
 *   Strategy: 15m EMA(50) bias → 5m EMA(8/21) cross → RSI(14) → FVG bonus
 *   SL: ATR×0.8 · TP: 2:1 RR
 *
 * Gold (XAUUSD):
 *   ICT Silver Bullet enhanced — FVG entry + displacement candle confirmation
 *   SL: beyond FVG edge · TP: 2:1 RR
 *
 * Tech stocks (NYSE):
 *   Opening Range Breakout (ORB) — first 15-min high/low
 *   Entry: breakout + VWAP alignment + RSI(14)
 *   Session: 13:45–15:30 UTC (after opening range is set)
 *   SL: ATR×1.0 · TP: 2:1 RR
 *
 * Risk: max 6 trades/day · −2% daily loss limit · safe-moderate sizing
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { placeMarketOrder, isConfigured } from "./ctrader.js";
import { syncToSheets } from "./sync-sheets.js";
import { exportToExcel } from "./export-excel.js";
import http from "http";

http.createServer((_, res) => res.end("OK"))
  .on("error", () => {})
  .listen(process.env.PORT || 3000);

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
  portfolioValue:    parseFloat(process.env.PORTFOLIO_VALUE_USD  || "300"),
  maxTradeSizeUSD:   parseFloat(process.env.MAX_TRADE_SIZE_USD   || "25"),
  maxTradesPerDay:   parseInt(process.env.MAX_TRADES_PER_DAY     || "6"),
  dailyLossLimitPct: parseFloat(process.env.DAILY_LOSS_LIMIT_PCT || "2"),
  paperTrading:      process.env.PAPER_TRADING !== "false",
  tdApiKey:          process.env.TWELVE_DATA_API_KEY || "",
};

// Best 4 forex pairs for scalping on Pepperstone ECN
const FOREX_SCALP_PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "GBPJPY"];

const CSV_FILE       = process.env.TRADE_LOG_PATH || "C:/Users/spathan/Desktop/sameer-trades.csv";
const POSITIONS_FILE = "open-positions.json";
const LOG_FILE       = "safety-check-log.json";
const WATCHLIST_FILE = "watchlist.json";

const TD_SYMBOL = {
  EURUSD: "EUR/USD", GBPUSD: "GBP/USD", USDJPY: "USD/JPY", GBPJPY: "GBP/JPY",
  AUDUSD: "AUD/USD", USDCAD: "USD/CAD", USDCHF: "USD/CHF",
  NZDUSD: "NZD/USD", EURGBP: "EUR/GBP", EURJPY: "EUR/JPY",
  XAUUSD: "XAU/USD",
};

// High-volume NYSE stocks — best for ORB intraday scalping
const STOCK_POOL = [
  "AAPL","TSLA","NVDA","MSFT","GOOGL","AMZN","META",
  "AMD","NFLX","QCOM","AVGO","CRM","DDOG",
];

const FOREX_SET = new Set(["EURUSD","GBPUSD","USDJPY","GBPJPY","AUDUSD","USDCAD","USDCHF","NZDUSD","EURGBP","EURJPY"]);

function assetClass(symbol) {
  if (symbol.includes("XAU") || symbol.includes("XAG")) return "commodity";
  if (FOREX_SET.has(symbol)) return "forex";
  return "stock";
}

// ─── Market Data ──────────────────────────────────────────────────────────────

const INTERVAL_MAP = { "1m":"1min","5m":"5min","15m":"15min","30m":"30min","1H":"1h","4H":"4h","1D":"1day" };

async function fetchCandles(symbol, limit = 100, tf = "5m") {
  const tdSym    = TD_SYMBOL[symbol] || symbol;
  const interval = INTERVAL_MAP[tf] || "5min";
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
  if (closes.length < period) return closes[closes.length - 1];
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(closes, period = 14) {
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
  const src      = session.length >= 3 ? session : candles.slice(-20);
  if (!src.length) return null;
  const cumVol = src.reduce((s, c) => s + c.volume, 0);
  if (cumVol === 0) return src.reduce((s, c) => s + (c.high + c.low + c.close) / 3, 0) / src.length;
  return src.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0) / cumVol;
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = candles.slice(1).map((c, i) => Math.max(
    c.high - c.low,
    Math.abs(c.high - candles[i].close),
    Math.abs(c.low  - candles[i].close)
  ));
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ─── 15m Trend Bias — cached per symbol, refreshed every 15 min ──────────────

const biasCache = {}; // { symbol: { bias, expiresAt } }

async function getTrendBias(symbol) {
  const now = Date.now();
  if (biasCache[symbol]?.expiresAt > now) return biasCache[symbol].bias;

  try {
    const candles = await fetchCandles(symbol, 60, "15m");
    const closes  = candles.map(c => c.close);
    const ema50   = calcEMA(closes, 50);
    const price   = closes[closes.length - 1];
    const bias    = price > ema50 ? "bullish" : "bearish";
    biasCache[symbol] = { bias, expiresAt: now + 15 * 60 * 1000 };
    console.log(`  15m EMA(50): ${ema50.toFixed(5)} → bias: ${bias.toUpperCase()} (cached 15m)`);
    return bias;
  } catch {
    return biasCache[symbol]?.bias ?? null;
  }
}

// ─── Session Guards ───────────────────────────────────────────────────────────

function getUTCHour() {
  return new Date().getUTCHours() + new Date().getUTCMinutes() / 60;
}

function isActiveSession(cls) {
  const h = getUTCHour();
  if (cls === "forex")     return (h >= 7.0 && h < 9.5) || (h >= 13.5 && h < 15.5);
  if (cls === "stock")     return h >= 13.75 && h < 15.5;  // 13:45–15:30 UTC (after ORB set)
  if (cls === "commodity") return isInSilverBulletWindow();
  return false;
}

// ─── Weekly Stock Scanner ─────────────────────────────────────────────────────

function isWatchlistStale() {
  if (!existsSync(WATCHLIST_FILE)) return true;
  const { updatedAt } = JSON.parse(readFileSync(WATCHLIST_FILE, "utf8"));
  return Date.now() - new Date(updatedAt).getTime() > 7 * 24 * 60 * 60 * 1000;
}

async function scoreStock(symbol) {
  try {
    const candles = await fetchCandles(symbol, 50, "5m");
    const closes  = candles.map(c => c.close);
    const atr     = calcATR(candles, 14) || 0;
    // Score = ATR% — higher daily range relative to price = better scalp target
    return (atr / closes[closes.length - 1]) * 100;
  } catch { return 0; }
}

async function refreshWatchlist() {
  const isSunday = new Date().getUTCDay() === 0;
  if (!isSunday && !isWatchlistStale()) return;

  console.log("[Watchlist] Sunday scan — scoring stocks by ATR% (scalp suitability)...");
  const scores = [];
  for (const sym of STOCK_POOL) {
    const score = await scoreStock(sym);
    console.log(`  ${sym.padEnd(8)} ATR%: ${score.toFixed(3)}%`);
    scores.push({ sym, score });
    await new Promise(r => setTimeout(r, 8000));
  }

  // Top 8 stocks by ATR% — best intraday range for ORB scalping
  const top8  = scores.sort((a, b) => b.score - a.score).slice(0, 8).map(s => s.sym);
  const pairs = ["XAUUSD", ...FOREX_SCALP_PAIRS, ...top8];
  writeFileSync(WATCHLIST_FILE, JSON.stringify({ pairs, updatedAt: new Date().toISOString() }, null, 2));
  console.log(`[Watchlist] Active: ${pairs.join(", ")}`);
}

function getActiveSymbols() {
  if (existsSync(WATCHLIST_FILE)) {
    const wl = JSON.parse(readFileSync(WATCHLIST_FILE, "utf8"));
    if (wl.pairs?.length) return wl.pairs;
  }
  return ["XAUUSD", ...FOREX_SCALP_PAIRS, "AAPL", "TSLA", "NVDA", "MSFT", "GOOGL", "AMZN", "META", "AMD"];
}

// ─── ICT Silver Bullet — XAUUSD ───────────────────────────────────────────────

function getNYHour() {
  const now = new Date();
  const offset = isDST(now) ? -4 : -5;
  return ((now.getUTCHours() + offset + 24) % 24) + now.getUTCMinutes() / 60;
}

function isDST(date) {
  const jan = new Date(date.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
  return date.getTimezoneOffset() < Math.max(jan, jul);
}

function isInSilverBulletWindow() {
  const nyH = getNYHour();
  const utcH = getUTCHour();
  return (utcH >= 8 && utcH < 10)  ||  // London open
         (nyH  >= 3 && nyH  < 4)   ||  // 3–4 AM NY
         (nyH  >= 10 && nyH  < 11) ||  // 10–11 AM NY
         (nyH  >= 14 && nyH  < 15);    // 2–3 PM NY
}

function detectFVG(candles) {
  for (let i = candles.length - 1; i >= 2; i--) {
    const [a, , c] = [candles[i - 2], candles[i - 1], candles[i]];
    if (c.low  > a.high) return { type: "bullish", top: c.low,  bottom: a.high, mid: (c.low + a.high) / 2 };
    if (c.high < a.low)  return { type: "bearish", top: a.low,  bottom: c.high, mid: (a.low + c.high) / 2 };
  }
  return null;
}

function isDisplacementCandle(candles, atr) {
  if (!atr || candles.length < 2) return false;
  const last = candles[candles.length - 1];
  return (last.high - last.low) >= atr * 1.2; // candle body > 1.2× ATR = strong displacement
}

function runSilverBulletCheck(candles, trendBias) {
  const results = [];
  const check   = (label, pass) => { results.push({ label, pass }); console.log(`  ${pass ? "✅" : "🚫"} ${label}`); };

  const price   = candles[candles.length - 1].close;
  const nyH     = getNYHour().toFixed(2);
  const atr     = calcATR(candles, 14);
  const closes  = candles.map(c => c.close);
  const ema8    = calcEMA(closes, 8);
  const ema21   = calcEMA(closes, 21);

  check(`Silver Bullet window (London 08–10 UTC / 3–4 AM / 10–11 AM / 2–3 PM NY) — now ${nyH} NY`, isInSilverBulletWindow());

  if (trendBias) {
    check(`15m trend bias ${trendBias.toUpperCase()} aligned with 5m EMA(8/21)`,
      (trendBias === "bullish" && ema8 > ema21) || (trendBias === "bearish" && ema8 < ema21));
  }

  const fvg = detectFVG(candles.slice(-15));
  check("Fair Value Gap detected in last 15 candles", !!fvg);
  if (!fvg) return { results, allPass: false, side: null, fvg: null };

  const inFVG = price >= fvg.bottom && price <= fvg.top;
  check(`Price retracing into FVG (${fvg.bottom.toFixed(2)}–${fvg.top.toFixed(2)})`, inFVG);

  const displacement = isDisplacementCandle(candles.slice(-3), atr);
  check("Displacement candle confirms move (body ≥ 1.2× ATR)", displacement);

  console.log(`  ℹ️  FVG: ${fvg.type.toUpperCase()} | ATR: ${atr ? atr.toFixed(2) : "N/A"}`);

  const allPass = results.every(r => r.pass);
  const side    = fvg.type === "bullish" ? "buy" : "sell";
  return { results, allPass, side, fvg };
}

// ─── Forex Scalp — EMA(8/21) + RSI + 15m Bias + FVG bonus ───────────────────

function runForexScalpCheck(symbol, candles, trendBias) {
  const results = [];
  const check   = (label, pass) => { results.push({ label, pass }); console.log(`  ${pass ? "✅" : "🚫"} ${label}`); };

  const closes = candles.map(c => c.close);
  const price  = closes[closes.length - 1];
  const ema8   = calcEMA(closes, 8);
  const ema21  = calcEMA(closes, 21);
  const rsi14  = calcRSI(closes, 14);
  const h      = getUTCHour();

  const inLondon = h >= 7.0 && h < 9.5;
  const inNY     = h >= 13.5 && h < 15.5;

  console.log(`  EMA(8): ${ema8.toFixed(5)} | EMA(21): ${ema21.toFixed(5)} | RSI: ${rsi14 ? rsi14.toFixed(1) : "N/A"}`);

  check(`Session active (London 07–09:30 / NY 13:30–15:30 UTC)`, inLondon || inNY);

  const bullishEMA = ema8 > ema21;
  const bearishEMA = ema8 < ema21;

  if (trendBias) {
    check(`15m bias ${trendBias.toUpperCase()} aligned with 5m EMA cross`,
      (trendBias === "bullish" && bullishEMA) || (trendBias === "bearish" && bearishEMA));
  }

  const goLong  = bullishEMA && trendBias !== "bearish";
  const goShort = bearishEMA && trendBias !== "bullish";

  if (goLong) {
    check("EMA(8) above EMA(21) — 5m uptrend confirmed", true);
    check("RSI(14) in bullish momentum zone (50–72)", rsi14 !== null && rsi14 >= 50 && rsi14 <= 72);
  } else if (goShort) {
    check("EMA(8) below EMA(21) — 5m downtrend confirmed", true);
    check("RSI(14) in bearish momentum zone (28–50)", rsi14 !== null && rsi14 >= 28 && rsi14 <= 50);
  } else {
    check("EMA(8/21) + 15m bias alignment required", false);
  }

  // FVG: bonus — aligned FVG allows tighter SL, does not block trade
  const fvg        = detectFVG(candles.slice(-15));
  const fvgAligned = fvg && ((goLong && fvg.type === "bullish") || (goShort && fvg.type === "bearish"));
  if (fvg) console.log(`  ℹ️  FVG ${fvg.type} — ${fvgAligned ? "✅ aligned (tighter SL)" : "⚪ not aligned"}`);

  const allPass = results.every(r => r.pass);
  const side    = goLong ? "buy" : goShort ? "sell" : null;
  return { results, allPass, side, fvg: fvgAligned ? fvg : null };
}

// ─── NYSE ORB Scalp — Opening Range Breakout + VWAP + RSI ────────────────────

function getOpeningRange(candles) {
  // NYSE open = 13:30 UTC. Opening range = candles from 13:30–13:45 UTC
  const orbStart = 13.5;   // 13:30
  const orbEnd   = 13.75;  // 13:45
  const orbCandles = candles.filter(c => {
    const h = new Date(c.time).getUTCHours() + new Date(c.time).getUTCMinutes() / 60;
    return h >= orbStart && h < orbEnd;
  });
  if (orbCandles.length < 2) return null;
  return {
    high: Math.max(...orbCandles.map(c => c.high)),
    low:  Math.min(...orbCandles.map(c => c.low)),
  };
}

function runStockORBCheck(symbol, candles, trendBias) {
  const results = [];
  const check   = (label, pass) => { results.push({ label, pass }); console.log(`  ${pass ? "✅" : "🚫"} ${label}`); };

  const closes  = candles.map(c => c.close);
  const price   = closes[closes.length - 1];
  const rsi14   = calcRSI(closes, 14);
  const vwap    = calcVWAP(candles);
  const h       = getUTCHour();

  console.log(`  Price: ${price.toFixed(3)} | VWAP: ${vwap ? vwap.toFixed(3) : "N/A"} | RSI: ${rsi14 ? rsi14.toFixed(1) : "N/A"}`);

  check("NYSE scalp session (13:45–15:30 UTC)", h >= 13.75 && h < 15.5);

  const orb = getOpeningRange(candles);
  if (!orb) {
    check("Opening range established (13:30–13:45 candles available)", false);
    return { results, allPass: false, side: null };
  }

  console.log(`  ORB: ${orb.low.toFixed(3)}–${orb.high.toFixed(3)}`);

  const aboveORB = price > orb.high;
  const belowORB = price < orb.low;

  check(`ORB breakout (above ${orb.high.toFixed(3)} or below ${orb.low.toFixed(3)})`, aboveORB || belowORB);

  if (aboveORB) {
    check("VWAP supports long (price above VWAP)", vwap ? price > vwap : false);
    check("RSI(14) bullish momentum (52–75)", rsi14 !== null && rsi14 >= 52 && rsi14 <= 75);
    if (trendBias) check(`15m bias ${trendBias.toUpperCase()} supports long`, trendBias === "bullish");
  } else if (belowORB) {
    check("VWAP supports short (price below VWAP)", vwap ? price < vwap : false);
    check("RSI(14) bearish momentum (25–48)", rsi14 !== null && rsi14 >= 25 && rsi14 <= 48);
    if (trendBias) check(`15m bias ${trendBias.toUpperCase()} supports short`, trendBias === "bearish");
  }

  const allPass = results.every(r => r.pass);
  const side    = aboveORB ? "buy" : belowORB ? "sell" : null;
  return { results, allPass, side, orb };
}

// ─── Position Tracking ────────────────────────────────────────────────────────

function loadPositions() { return existsSync(POSITIONS_FILE) ? JSON.parse(readFileSync(POSITIONS_FILE, "utf8")) : []; }
function savePositions(p) { writeFileSync(POSITIONS_FILE, JSON.stringify(p, null, 2)); }

function addPosition(symbol, side, price, qty, orderId, paper, extras = {}) {
  const { fvg, atr, orb } = extras;
  const cls = assetClass(symbol);
  let sl, tp, risk;

  if (cls === "commodity" && fvg) {
    const buf = atr ? atr * 0.3 : 2.0;
    sl   = side === "buy" ? fvg.bottom - buf : fvg.top + buf;
    risk = Math.abs(price - sl);
  } else if (cls === "forex") {
    if (fvg) {
      const buf = atr ? atr * 0.15 : price * 0.0003;
      sl   = side === "buy" ? fvg.bottom - buf : fvg.top + buf;
      risk = Math.abs(price - sl);
    } else {
      risk = atr ? atr * 0.8 : price * 0.002;  // ATR×0.8 — tight scalp SL
      sl   = side === "buy" ? price - risk : price + risk;
    }
  } else {
    // Stocks: ORB-anchored SL if available, else ATR×1.0
    if (orb) {
      const buf = atr ? atr * 0.2 : price * 0.003;
      sl   = side === "buy" ? orb.low - buf : orb.high + buf;
      risk = Math.abs(price - sl);
    } else {
      risk = atr ? atr * 1.0 : price * 0.004;
      sl   = side === "buy" ? price - risk : price + risk;
    }
  }

  tp = side === "buy" ? price + risk * 2 : price - risk * 2;  // 2:1 RR on all

  const pos = loadPositions();
  pos.push({ symbol, side, entryPrice: price, quantity: qty, orderId, sl, tp, slMoved: false, paperTrading: paper, openedAt: new Date().toISOString() });
  savePositions(pos);
}

function checkAndClosePositions(symbol, price) {
  const positions = loadPositions(), remaining = [], closed = [];
  for (const pos of positions) {
    if (pos.symbol !== symbol) { remaining.push(pos); continue; }
    const isLong = pos.side === "buy";

    if (!pos.slMoved) {
      const tpDist = Math.abs(pos.tp - pos.entryPrice);
      const moved  = isLong ? price - pos.entryPrice : pos.entryPrice - price;
      if (tpDist > 0 && moved / tpDist >= 0.5) {
        pos.sl = pos.entryPrice;
        pos.slMoved = true;
        console.log(`  🔒 ${symbol} SL → breakeven @ ${pos.entryPrice.toFixed(5)}`);
      }
    }

    const hitTP = isLong ? price >= pos.tp : price <= pos.tp;
    const hitSL = isLong ? price <= pos.sl : price >= pos.sl;
    if (hitTP || hitSL) {
      const exit   = hitTP ? pos.tp : pos.sl;
      const pnlUSD = isLong ? (exit - pos.entryPrice) * pos.quantity : (pos.entryPrice - exit) * pos.quantity;
      const pnlPct = ((exit - pos.entryPrice) / pos.entryPrice) * (isLong ? 100 : -100);
      closed.push({ ...pos, exitPrice: exit, exitTime: new Date().toISOString(), pnlUSD, pnlPct, result: hitTP ? "WIN" : "LOSS" });
    } else {
      remaining.push(pos);
    }
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

function getDailyPnL() {
  if (!existsSync(CSV_FILE)) return 0;
  const today = new Date().toISOString().slice(0, 10);
  return readFileSync(CSV_FILE, "utf8").trim().split("\n").slice(1)
    .filter(l => l.startsWith(today))
    .reduce((sum, l) => { const p = parseFloat(l.split(",")[15]); return sum + (isNaN(p) ? 0 : p); }, 0);
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
    row = [date, time, "Pepperstone", entry.symbol, cls, entry.side?.toUpperCase() || "", qty, entry.price?.toFixed(5) || "", entry.tradeSize.toFixed(2), fee, entry.orderId || "", entry.paperTrading ? "PAPER" : "LIVE", "OPEN", "", "", "", "", `"All conditions met"`].join(",");
  }
  appendFileSync(CSV_FILE, row + "\n");
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
    `"${closed.result === "WIN" ? "TP hit" : "SL hit"}"`,
  ].join(",");
  appendFileSync(CSV_FILE, row + "\n");
  console.log(`  ${closed.result === "WIN" ? "✅ WIN" : "❌ LOSS"} ${closed.symbol} | P&L: $${closed.pnlUSD.toFixed(4)} (${closed.pnlPct.toFixed(2)}%)`);
}

// ─── Per-Symbol Run ───────────────────────────────────────────────────────────

async function runSymbol(symbol, log) {
  const cls = assetClass(symbol);
  console.log(`\n── ${symbol} (${cls}) ${"─".repeat(38)}`);

  if (!isActiveSession(cls)) {
    console.log(`  ⏸  Outside active session — skipping`);
    return;
  }

  let candles;
  try { candles = await fetchCandles(symbol, 100, "5m"); }
  catch (err) { console.log(`  ⚠️  Data error: ${err.message}`); return; }

  const price = candles[candles.length - 1].close;
  const atr   = calcATR(candles, 14);
  console.log(`  Price: ${price.toFixed(5)} | ATR(14): ${atr ? atr.toFixed(5) : "N/A"}`);

  const closed = checkAndClosePositions(symbol, price);
  for (const c of closed) writeCloseCsv(c);

  const trendBias = await getTrendBias(symbol);

  let results, allPass, side, fvg = null, orb = null;
  const tradeSize = Math.min(CONFIG.portfolioValue * 0.05, CONFIG.maxTradeSizeUSD);

  if (symbol === "XAUUSD") {
    ({ results, allPass, side, fvg } = runSilverBulletCheck(candles, trendBias));
  } else if (cls === "stock") {
    ({ results, allPass, side, orb } = runStockORBCheck(symbol, candles, trendBias));
  } else {
    ({ results, allPass, side, fvg } = runForexScalpCheck(symbol, candles, trendBias));
  }

  const entry = {
    timestamp: new Date().toISOString(), symbol, price, side, tradeSize,
    conditions: results, allPass, paperTrading: CONFIG.paperTrading,
    orderPlaced: false, orderId: null,
  };

  if (!allPass) {
    console.log(`  🚫 BLOCKED — ${results.filter(r => !r.pass).map(r => r.label).join("; ")}`);
  } else {
    const qty = tradeSize / price;
    if (CONFIG.paperTrading) {
      console.log(`  📋 PAPER — ${side.toUpperCase()} ${symbol} ~$${tradeSize.toFixed(2)} | SL: ATR×${cls === "forex" ? "0.8" : "1.0"} | TP: 2:1`);
      entry.orderPlaced = true;
      entry.orderId     = `PAPER-${Date.now()}`;
      addPosition(symbol, side, price, qty, entry.orderId, true, { fvg, atr, orb });
    } else if (isConfigured()) {
      console.log(`  🔴 LIVE — ${side.toUpperCase()} ${symbol} ~$${tradeSize.toFixed(2)}`);
      try {
        const order = await placeMarketOrder(symbol, side, tradeSize, price);
        entry.orderPlaced = true;
        entry.orderId     = order.orderId;
        addPosition(symbol, side, price, qty, order.orderId, false, { fvg, atr, orb });
        console.log(`  ✅ Order ID: ${order.orderId}`);
      } catch (err) {
        console.log(`  ❌ Order failed: ${err.message}`);
        entry.error = err.message;
      }
    } else {
      console.log(`  ⏳ cTrader not configured — awaiting KYC`);
    }
  }

  log.trades.push(entry);
  writeTradeCsv(entry);
}

// ─── Main Loop ────────────────────────────────────────────────────────────────

async function run() {
  if (!CONFIG.tdApiKey) { console.log("⚠️  TWELVE_DATA_API_KEY missing."); return; }

  await refreshWatchlist();
  const symbols = getActiveSymbols();
  const h = getUTCHour();

  const anyActive = symbols.some(s => isActiveSession(assetClass(s)));
  if (!anyActive) {
    console.log(`[${new Date().toISOString()}] No active sessions (UTC ${h.toFixed(1)}h) — next: London 07:00 or NYSE 13:45`);
    return;
  }

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Sameer Trading Bot — Pepperstone");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER" : "🔴 LIVE"} | cTrader: ${isConfigured() ? "✅ Ready" : "⏳ Awaiting KYC"}`);
  console.log(`  Symbols: ${symbols.join(", ")}`);
  console.log("═══════════════════════════════════════════════════════════");

  initCsv();
  const log = loadLog();

  if (todayCount(log) >= CONFIG.maxTradesPerDay) {
    console.log(`\n🚫 Daily trade limit (${CONFIG.maxTradesPerDay}) reached.`); return;
  }

  const dailyPnL  = getDailyPnL();
  const lossLimit = -(CONFIG.portfolioValue * CONFIG.dailyLossLimitPct / 100);
  if (dailyPnL <= lossLimit) {
    console.log(`\n🚫 Daily loss limit hit ($${dailyPnL.toFixed(2)} / $${lossLimit.toFixed(2)}).`); return;
  }

  for (const symbol of symbols) {
    if (todayCount(log) >= CONFIG.maxTradesPerDay) break;
    await runSymbol(symbol, log);
    await new Promise(r => setTimeout(r, 5000));
  }

  saveLog(log);
  await exportToExcel().catch(err => console.log(`  ⚠️  Excel: ${err.message}`));
  await syncToSheets().catch(err => console.log(`  ⚠️  Sheets: ${err.message}`));
  console.log("\n═══════════════════════════════════════════════════════════\n");
}

const RUN_INTERVAL_MS = 5 * 60 * 1000;

async function loop() {
  await run().catch(err => console.error("Cycle error:", err));
  setTimeout(loop, RUN_INTERVAL_MS);
}

loop();
