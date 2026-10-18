

import axios from "axios";
import WebSocket from "ws";
import { Connection, PublicKey } from "@solana/web3.js";
import { API, ENV, PUMPFUN_PROGRAM_ID, LAMPORTS_PER_SOL, TOKEN_DECIMALS, SCAN_CONFIG } from "./core";
import { state, saveState } from "./core";
import { log } from "./core";

// ================= RATE LIMIT COOLDOWN =================
let rpcRateLimitedUntil = 0;
function isRpcRateLimited(): boolean { return Date.now() < rpcRateLimitedUntil; }
function setRpcRateLimited(durationMs: number): void {
  rpcRateLimitedUntil = Date.now() + durationMs;
  state.serviceHealth.rpc = "rate_limited";
  log("warn", "rpc", `RPC rate limited — cooling down ${durationMs / 1000}s`);
}

// ================= MARKET DATA =================
export async function getTokenMarket(address: string) {
  try {
    const res = await axios.get(`${API.DEXSCREENER}/latest/dex/tokens/${address}`, { timeout: 12000 });
    const pairs = res.data?.pairs || [];
    const pair = pairs.slice().sort((a: any, b: any) => (b?.liquidity?.usd || 0) - (a?.liquidity?.usd || 0))[0];
    if (!pair) return null;
    const price = Number(pair.priceUsd);
    return {
      symbol: pair.baseToken?.symbol || "",
      priceUsd: isFinite(price) ? price : 0,
      liquidityUsd: Number(pair.liquidity?.usd) || 0,
      marketCap: pair.marketCap != null ? Number(pair.marketCap) : null,
      fdv: pair.fdv != null ? Number(pair.fdv) : null,
      volume24h: Number(pair.volume?.h24) || 0,
      pairCreatedAt: pair.pairCreatedAt != null ? Number(pair.pairCreatedAt) : null,
    };
  } catch (e: any) {
    log("debug", "market", `DexScreener lookup failed for ${address}: ${e.message}`);
    return null;
  }
}

export async function getBoostedTokens(): Promise<{ address: string }[]> {
  try {
    const res = await axios.get(`${API.DEXSCREENER}/token-boosted/top/v1`, { timeout: 12000 });
    if (!Array.isArray(res.data)) return [];
    return res.data
      .filter((t: any) => t.chainId === "solana" && t.tokenAddress)
      .slice(0, SCAN_CONFIG.maxEnrichPerScan)
      .map((t: any) => ({ address: String(t.tokenAddress) }));
  } catch (e: any) {
    log("debug", "scanner", `Boosted tokens fetch failed: ${e.message}`);
    return [];
  }
}

let cachedSolUsd = 0;
let cachedSolUsdAt = 0;
export async function getSolUsd(): Promise<number> {
  const now = Date.now();
  if (cachedSolUsd > 0 && now - cachedSolUsdAt < 60_000) return cachedSolUsd;
  try {
    const res = await axios.get(API.SOL_USD_PRICE, { timeout: 8000 });
    const p = Number(res.data?.solana?.usd);
    if (isFinite(p) && p > 0) { cachedSolUsd = p; cachedSolUsdAt = now; }
  } catch {}
  return cachedSolUsd || 0;
}

// ================= PUMP.FUN BONDING CURVE =================
const PUMPFUN_PROGRAM = new PublicKey(PUMPFUN_PROGRAM_ID);
export function bondingCurvePda(mint: string): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()], PUMPFUN_PROGRAM)[0];
}

export function decodeBondingCurve(data: Buffer) {
  if (!data || data.length < 49) return null;
  try {
    const virtualTokenReserves = Number(data.readBigUInt64LE(8));
    const virtualSolReserves = Number(data.readBigUInt64LE(16));
    const realSolReserves = Number(data.readBigUInt64LE(32));
    const complete = data.readUInt8(48) !== 0;
    const solReserve = virtualSolReserves / LAMPORTS_PER_SOL;
    const tokenReserve = virtualTokenReserves / Math.pow(10, TOKEN_DECIMALS);
    const priceSol = tokenReserve > 0 ? solReserve / tokenReserve : 0;
    return { priceSol, priceUsd: 0, virtualSolReserves: solReserve, virtualTokenReserves: tokenReserve, realSolReserves: realSolReserves / LAMPORTS_PER_SOL, liquidityUsd: 0, complete };
  } catch { return null; }
}

export async function getCurveState(conn: any, mint: string) {
  if (isRpcRateLimited()) return null;
  try {
    const info = await conn.getAccountInfo(bondingCurvePda(mint));
    if (!info || !info.data) return null;
    const curve = decodeBondingCurve(Buffer.from(info.data));
    if (!curve) return null;
    const solUsd = await getSolUsd();
    curve.priceUsd = curve.priceSol * solUsd;
    curve.liquidityUsd = curve.realSolReserves * 2 * solUsd;
    return curve;
  } catch (e: any) {
    if (e.message?.includes("429") || e.message?.includes("rate") || e.message?.includes("Too Many")) {
      setRpcRateLimited(10000);
    }
    return null;
  }
}

// ================= SECURITY CHECK =================
export async function checkToken(mint: string) {
  try {
    const headers: Record<string, string> = {};
    if (ENV.RUGCHECK_API_KEY) headers["X-API-KEY"] = ENV.RUGCHECK_API_KEY;
    const res = await axios.get(`${API.RUGCHECK}/tokens/${mint}/report/summary`, { headers, timeout: 12000 });
    const data = res.data || {};
    const score = Number(data.score_normalised ?? data.score);
    const risks: any[] = Array.isArray(data.risks) ? data.risks : [];
    const riskNames = risks.filter((r) => r && (r.level === "danger" || r.level === "warn")).map((r) => r.name || "risk").slice(0, 4);
    state.serviceHealth.rugcheck = "verified";
    if (!isFinite(score)) return { status: "unavailable" as const, score: null, notes: "No score returned" };
    const passed = score <= ENV.RUGCHECK_MAX_SCORE && !risks.some((r) => r && r.level === "danger");
    return { status: passed ? "passed" as const : "failed" as const, score, notes: riskNames.length ? riskNames.join(", ") : "No major risks reported" };
  } catch {
    state.serviceHealth.rugcheck = "error";
    return { status: "unavailable" as const, score: null, notes: "Security provider unavailable" };
  }
}

// ================= TELEGRAM =================
export function telegramEnabled(): boolean { return Boolean(ENV.TELEGRAM_BOT_TOKEN && ENV.TELEGRAM_CHAT_ID); }
export function botTokenSet(): boolean { return Boolean(ENV.TELEGRAM_BOT_TOKEN); }

export async function sendTelegram(text: string): Promise<boolean> {
  if (!telegramEnabled()) { state.serviceHealth.telegram = "unconfigured"; return false; }
  return sendTelegramTo(ENV.TELEGRAM_CHAT_ID, text);
}

export async function sendTelegramTo(chatId: string | number, text: string): Promise<boolean> {
  if (!ENV.TELEGRAM_BOT_TOKEN) { state.serviceHealth.telegram = "unconfigured"; return false; }
  try {
    await axios.post(`${API.TELEGRAM}/bot${ENV.TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }, { timeout: 10000 });
    state.serviceHealth.telegram = "ok";
    return true;
  } catch { state.serviceHealth.telegram = "error"; return false; }
}

export async function setTelegramWebhook(url: string, secretToken: string): Promise<boolean> {
  if (!ENV.TELEGRAM_BOT_TOKEN) return false;
  try {
    const res = await axios.post(`${API.TELEGRAM}/bot${ENV.TELEGRAM_BOT_TOKEN}/setWebhook`,
      { url, secret_token: secretToken, allowed_updates: ["message"] }, { timeout: 10000 });
    log("info", "telegram", `Webhook set → ${url} (${res.data?.description || "ok"})`);
    return true;
  } catch (e: any) {
    log("error", "telegram", `setWebhook failed: ${e.message}`);
    return false;
  }
}

export async function getTelegramWebhookInfo(): Promise<any> {
  if (!ENV.TELEGRAM_BOT_TOKEN) return { ok: false, error: "No bot token" };
  try {
    const res = await axios.get(`${API.TELEGRAM}/bot${ENV.TELEGRAM_BOT_TOKEN}/getWebhookInfo`, { timeout: 10000 });
    return res.data;
  } catch (e: any) { return { ok: false, error: e.message }; }
}

export async function deleteTelegramWebhook(): Promise<boolean> {
  if (!ENV.TELEGRAM_BOT_TOKEN) return false;
  try {
    await axios.post(`${API.TELEGRAM}/bot${ENV.TELEGRAM_BOT_TOKEN}/deleteWebhook`, {}, { timeout: 10000 });
    log("info", "telegram", "Webhook deleted (switching to polling)");
    return true;
  } catch { return false; }
}

export async function getTelegramUpdates(offset: number, timeout: number): Promise<any[]> {
  if (!ENV.TELEGRAM_BOT_TOKEN) return [];
  try {
    const res = await axios.get(`${API.TELEGRAM}/bot${ENV.TELEGRAM_BOT_TOKEN}/getUpdates`,
      { params: { offset, timeout, allowed_updates: ["message"] }, timeout: (timeout + 5) * 1000 });
    return res.data?.result || [];
  } catch { return []; }
}

// ================= SOLANA RPC CONNECTION =================
let connection: Connection | null = null;
export function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(ENV.RPC_HTTPS_URL, {
      wsEndpoint: ENV.RPC_WSS_URL,
      commitment: "confirmed",
      disableRetryOnRateLimit: true,
      confirmTransactionInitialTimeout: 30000,
    });
  }
  return connection;
}

// ================= PUMP.FUN LISTENER (raw WebSocket + exponential backoff) =================
let pumpWs: WebSocket | null = null;
let pumpRunning = false;
let pumpBackoffMs = 1000;
const PUMP_BACKOFF_MAX_MS = 60_000;
let pumpReconnectTimer: NodeJS.Timeout | null = null;
let pumpHeartbeatTimer: NodeJS.Timeout | null = null;
let pumpLastMessageAt = 0;
let pumpSubId: number | null = null;

export function startPumpListener(): void {
  if (pumpRunning) return;
  pumpRunning = true;
  connectPumpListener();
}

function connectPumpListener(): void {
  if (!pumpRunning) return;

  // Clean up any existing connection
  if (pumpWs) {
    try { pumpWs.removeAllListeners(); pumpWs.close(); } catch {}
    pumpWs = null;
  }
  if (pumpHeartbeatTimer) { clearTimeout(pumpHeartbeatTimer); pumpHeartbeatTimer = null; }

  const wsUrl = ENV.RPC_WSS_URL;
  log("info", "listener", `Connecting Pump.fun listener → ${wsUrl} (backoff: ${pumpBackoffMs}ms)`);

  try {
    pumpWs = new WebSocket(wsUrl, { handshakeTimeout: 10000 });
  } catch (e: any) {
    log("error", "listener", `WebSocket creation failed: ${e.message}`);
    schedulePumpReconnect();
    return;
  }

  pumpWs.on("open", () => {
    pumpBackoffMs = 1000; // Reset backoff on successful connection
    pumpLastMessageAt = Date.now();
    state.serviceHealth.listener = "running";
    state.serviceHealth.rpc = "ok";
    log("info", "listener", "Pump.fun WebSocket connected — subscribing to logs");

    // Subscribe to logs mentioning the Pump.fun program
    pumpWs?.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [{ mentions: [PUMPFUN_PROGRAM_ID] }, { commitment: "confirmed" }],
    }));

    // Heartbeat: detect stale connections (no message in 90s → force reconnect)
    pumpHeartbeatTimer = setInterval(() => {
      if (Date.now() - pumpLastMessageAt > 90_000) {
        log("warn", "listener", "Heartbeat timeout — no messages in 90s, forcing reconnect");
        try { pumpWs?.close(); } catch {}
      }
    }, 30_000);
  });

  pumpWs.on("message", (data: Buffer) => {
    pumpLastMessageAt = Date.now();
    try {
      const msg = JSON.parse(data.toString());

      // Subscription confirmation
      if (msg.id === 1 && msg.result !== undefined) {
        pumpSubId = msg.result;
        log("info", "listener", `Subscribed to Pump.fun logs (sub ID: ${msg.result})`);
        return;
      }

      // Log notification
      if (msg.method === "logsNotification") {
        const logInfo = msg.params?.result?.value;
        if (logInfo && !logInfo.err) {
          handlePumpLog(logInfo).catch(() => {});
        }
      }
    } catch {}
  });

  pumpWs.on("error", (err: Error) => {
    const isRateLimit = err.message.includes("429") || err.message.includes("Too Many") || err.message.includes("rate");
    if (isRateLimit) {
      state.serviceHealth.rpc = "rate_limited";
      state.serviceHealth.listener = "rate_limited";
      log("error", "listener", `WebSocket error: 429 RATE LIMITED — RPC is throttling us`);
    } else {
      log("error", "listener", `WebSocket error: ${err.message}`);
    }
  });

  pumpWs.on("close", (code: number, reason: Buffer) => {
    if (pumpHeartbeatTimer) { clearTimeout(pumpHeartbeatTimer); pumpHeartbeatTimer = null; }
    pumpSubId = null;
    state.serviceHealth.listener = "reconnecting";
    const reasonStr = reason?.toString() || "";
    log("warn", "listener", `WebSocket closed (code ${code}${reasonStr ? ": " + reasonStr : ""}) — reconnecting in ${pumpBackoffMs}ms`);
    schedulePumpReconnect();
  });
}

function schedulePumpReconnect(): void {
  if (!pumpRunning) return;
  if (pumpReconnectTimer) return;

  // Exponential backoff: 1s → 2s → 4s → 8s → 16s → 32s → 60s (capped)
  pumpBackoffMs = Math.min(pumpBackoffMs * 2, PUMP_BACKOFF_MAX_MS);
  pumpReconnectTimer = setTimeout(() => {
    pumpReconnectTimer = null;
    connectPumpListener();
  }, pumpBackoffMs);
}

export function stopPumpListener(): void {
  pumpRunning = false;
  if (pumpReconnectTimer) { clearTimeout(pumpReconnectTimer); pumpReconnectTimer = null; }
  if (pumpHeartbeatTimer) { clearTimeout(pumpHeartbeatTimer); pumpHeartbeatTimer = null; }
  if (pumpWs) { try { pumpWs.removeAllListeners(); pumpWs.close(); } catch {} pumpWs = null; }
  state.serviceHealth.listener = "stopped";
  log("info", "listener", "Pump.fun listener stopped");
}

async function handlePumpLog(logInfo: any): Promise<void> {
  try {
    const sig = logInfo.signature;
    if (!sig || state.recentMints.some((m) => m.signature === sig)) return;
    const logs: string[] = logInfo.logs || [];
    if (!logs.some((l: string) => l.includes("Instruction: Create"))) return;

    // Fetch the full transaction to extract the mint address
    if (isRpcRateLimited()) return; // Skip if RPC is rate limited
    const conn = getConnection();
    const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    const mint = extractMint(tx);
    if (!mint || state.recentMints.some((m) => m.address === mint)) return;

    state.recentMints.push({ address: mint, symbol: "", signature: sig, detectedAt: new Date().toISOString() });
    if (state.recentMints.length > SCAN_CONFIG.recentMintBuffer) state.recentMints = state.recentMints.slice(-SCAN_CONFIG.recentMintBuffer);
    saveState();
    log("info", "listener", `New mint detected: ${mint}`);
  } catch (e: any) {
    if (e.message?.includes("429") || e.message?.includes("rate") || e.message?.includes("Too Many")) {
      setRpcRateLimited(10000);
    }
  }
}

function extractMint(tx: any): string | null {
  try {
    for (const group of (tx?.meta?.innerInstructions || [])) {
      for (const ix of (group.instructions || [])) {
        if (ix?.programId === PUMPFUN_PROGRAM_ID && ix?.parsed?.type === "create" && ix?.parsed?.info?.mint) return String(ix.parsed.info.mint);
      }
    }

    const pre = new Set<string>();
    (tx?.meta?.preTokenBalances || []).forEach((b: any) => b?.mint && pre.add(b.mint));

    for (const b of (tx?.meta?.postTokenBalances || [])) {
      if (b?.mint && !pre.has(b.mint)) return String(b.mint);
    }
  } catch {}

  return null;
}

