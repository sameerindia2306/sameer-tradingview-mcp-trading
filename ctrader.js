/**
 * cTrader Open API — Pepperstone execution module
 * Handles token refresh + market order placement.
 * Activated once KYC is approved and OAuth tokens are in .env.
 */

import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";

const TOKEN_URL  = "https://connect.spotware.com/apps/token";
const API_BASE   = "https://api.spotware.com/connect";
const ACCOUNT_ID = process.env.CTRADER_ACCOUNT_ID;
const CLIENT_ID  = process.env.CTRADER_CLIENT_ID;
const CLIENT_SECRET = process.env.CTRADER_CLIENT_SECRET;

// ─── Token Management ────────────────────────────────────────────────────────

async function refreshToken() {
  const refreshTok = process.env.CTRADER_REFRESH_TOKEN;
  if (!refreshTok) throw new Error("No refresh token in .env — run get-token.mjs first");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      refresh_token: refreshTok,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }).toString(),
  });

  const data = await res.json();
  if (!data.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);

  // Update .env with new tokens
  let env = readFileSync(".env", "utf8");
  env = env.replace(/CTRADER_ACCESS_TOKEN=.*/,  `CTRADER_ACCESS_TOKEN=${data.access_token}`);
  env = env.replace(/CTRADER_REFRESH_TOKEN=.*/, `CTRADER_REFRESH_TOKEN=${data.refresh_token || refreshTok}`);
  writeFileSync(".env", env);

  process.env.CTRADER_ACCESS_TOKEN  = data.access_token;
  process.env.CTRADER_REFRESH_TOKEN = data.refresh_token || refreshTok;

  return data.access_token;
}

async function getToken() {
  const token = process.env.CTRADER_ACCESS_TOKEN;
  if (!token) return refreshToken();
  return token;
}

// ─── API Helper ───────────────────────────────────────────────────────────────

async function ctraderRequest(method, path, body = null, retry = true) {
  const token = await getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type":  "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && retry) {
    await refreshToken();
    return ctraderRequest(method, path, body, false);
  }

  const data = await res.json();
  if (!res.ok) throw new Error(`cTrader API error ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

// ─── Account Info ─────────────────────────────────────────────────────────────

export async function getAccountInfo() {
  return ctraderRequest("GET", `/tradingaccounts/${ACCOUNT_ID}`);
}

// ─── Volume Calculator ────────────────────────────────────────────────────────
// cTrader uses units: forex 1 lot = 100,000 units, gold 1 lot = 100 units

export function calcVolume(symbol, sizeUSD, price) {
  const sym = symbol.toUpperCase();

  if (["AAPL","TSLA","NVDA","MSFT","AMZN","GOOGL","META"].includes(sym)) {
    // Stocks: units = shares. Min 1 share, use fractional if broker supports it
    return Math.max(1, Math.floor(sizeUSD / price));
  }

  if (sym === "XAUUSD") {
    // Gold: 1 unit = 1 oz. Use smallest possible: 100 units = 0.01 lot
    const units = Math.floor((sizeUSD / price) * 100) * 100;
    return Math.max(100, units);
  }

  // Forex: 1 lot = 100,000 units. Pepperstone min = 0.01 lot = 1,000 units
  // Margin required = (units / 100000) * price * (1 / leverage)
  const units = Math.floor((sizeUSD / price) * 100000 / 100) * 100;
  return Math.max(1000, units);
}

// ─── Order Placement ─────────────────────────────────────────────────────────

export async function placeMarketOrder(symbol, side, sizeUSD, price, sl = null, tp = null) {
  const volume = calcVolume(symbol, sizeUSD, price);

  const body = {
    symbolName: symbol,
    orderType:  "MARKET",
    tradeSide:  side.toUpperCase(),
    volume,
    // SL and TP sent to broker so positions are protected even if the bot restarts
    ...(sl !== null && { stopLoss:   parseFloat(sl.toFixed(5)) }),
    ...(tp !== null && { takeProfit: parseFloat(tp.toFixed(5)) }),
  };

  console.log(`  → cTrader: ${side.toUpperCase()} ${symbol} vol=${volume} SL=${sl?.toFixed(5) ?? "none"} TP=${tp?.toFixed(5) ?? "none"}`);
  const result = await ctraderRequest("POST", `/tradingaccounts/${ACCOUNT_ID}/marketorders`, body);
  return { orderId: result.orderId || result.id || "ctrader-order" };
}

// ─── Position Close ───────────────────────────────────────────────────────────

export async function closePosition(positionId, volume) {
  return ctraderRequest("DELETE", `/tradingaccounts/${ACCOUNT_ID}/positions/${positionId}`, { volume });
}

// ─── Token Status Check ───────────────────────────────────────────────────────

export function isConfigured() {
  return !!(process.env.CTRADER_ACCESS_TOKEN && process.env.CTRADER_ACCOUNT_ID);
}
