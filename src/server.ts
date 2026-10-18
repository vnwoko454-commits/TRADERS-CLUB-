
import WebSocket from "ws";
import { ENV, state, saveState, log, getConnection, setRpcRateLimited, isRpcRateLimited, PUMPFUN_PROGRAM_ID, SCAN_CONFIG } from "./core";

// ================= PUMP.FUN LISTENER (raw WebSocket + 429 circuit breaker) =================
let pumpWs: WebSocket | null = null;
let pumpRunning = false;
let pumpBackoffMs = 5000;            // start at 5s, not 1s
const PUMP_BACKOFF_MAX_MS = 300_000; // cap at 5 minutes
let pumpReconnectTimer: NodeJS.Timeout | null = null;
let pumpHeartbeatTimer: NodeJS.Timeout | null = null;
let pumpLastMessageAt = 0;
let pumpSubId: number | null = null;
let pump429Count = 0;
const PUMP_429_LIMIT = 5;             // after 5 consecutive 429s, stop trying
let pump429CooldownUntil = 0;        // if set, don't reconnect until this time

export function startPumpListener(): void {
  if (pumpRunning) return;
  pumpRunning = true;
  pump429Count = 0;
  pumpBackoffMs = 5000;
  log("info", "listener", "Pump.fun new-mint listener started");
  connectPumpListener();
}

function connectPumpListener(): void {
  if (!pumpRunning) return;

  // Don't reconnect during a 429 cooldown
  if (Date.now() < pump429CooldownUntil) {
    const wait = pump429CooldownUntil - Date.now();
    log("info", "listener", `In 429 cooldown — waiting ${Math.round(wait / 1000)}s before reconnect`);
    pumpReconnectTimer = setTimeout(() => {
      pumpReconnectTimer = null;
      connectPumpListener();
    }, wait);
    return;
  }

  // Circuit breaker: too many 429s → stop the listener entirely
  if (pump429Count >= PUMP_429_LIMIT) {
    log("error", "listener", `CIRCUIT BREAKER: ${pump429Count} consecutive 429s. Listener STOPPED. The free RPC cannot handle WebSocket subscriptions — upgrade to Helius or QuickNode.`);
    state.serviceHealth.listener = "circuit_open";
    state.serviceHealth.rpc = "rate_limited";
    pumpRunning = false;
    return;
  }

  // Single-connection guarantee: tear down any existing socket first
  if (pumpWs) {
    try { pumpWs.removeAllListeners(); pumpWs.close(); } catch {}
    pumpWs = null;
  }
  if (pumpHeartbeatTimer) { clearTimeout(pumpHeartbeatTimer); pumpHeartbeatTimer = null; }

  const wsUrl = ENV.RPC_WSS_URL;
  log("info", "listener", `Connecting Pump.fun listener (backoff: ${pumpBackoffMs}ms, 429s: ${pump429Count}/${PUMP_429_LIMIT})`);

  try {
    pumpWs = new WebSocket(wsUrl, { handshakeTimeout: 15000 });
  } catch (e: any) {
    log("error", "listener", `WebSocket creation failed: ${e.message}`);
    schedulePumpReconnect();
    return;
  }

  pumpWs.on("open", () => {
    pumpBackoffMs = 5000;   // Reset backoff on successful connection
    pump429Count = 0;       // Reset 429 counter on success
    pumpLastMessageAt = Date.now();
    state.serviceHealth.listener = "running";
    state.serviceHealth.rpc = "ok";
    log("info", "listener", "Pump.fun WebSocket connected — subscribing to logs");

    pumpWs?.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [{ mentions: [PUMPFUN_PROGRAM_ID] }, { commitment: "confirmed" }],
    }));

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
      if (msg.id === 1 && msg.result !== undefined) {
        pumpSubId = msg.result;
        log("info", "listener", `Subscribed to Pump.fun logs (sub ID: ${msg.result})`);
        return;
      }
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
      pump429Count++;
      pump429CooldownUntil = Date.now() + 60_000;  // 60s cooldown, not 1s
      state.serviceHealth.rpc = "rate_limited";
      state.serviceHealth.listener = "rate_limited";
      log("error", "listener", `WebSocket 429 RATE LIMITED (#${pump429Count}/${PUMP_429_LIMIT}) — 60s cooldown. Free RPC cannot sustain this — upgrade to Helius/QuickNode.`);
    } else {
      log("error", "listener", `WebSocket error: ${err.message}`);
    }
  });

  pumpWs.on("close", (code: number, reason: Buffer) => {
    if (pumpHeartbeatTimer) { clearTimeout(pumpHeartbeatTimer); pumpHeartbeatTimer = null; }
    pumpSubId = null;
    state.serviceHealth.listener = "reconnecting";
    const reasonStr = reason?.toString() || "";
    log("warn", "listener", `WebSocket closed (code ${code}${reasonStr ? ": " + reasonStr : ""})`);
    schedulePumpReconnect();
  });
}

function schedulePumpReconnect(): void {
  if (!pumpRunning) return;
  if (pumpReconnectTimer) return;
  // Exponential backoff: 5s → 10s → 20s → 40s → 80s → 160s → 300s (capped)
  pumpBackoffMs = Math.min(pumpBackoffMs * 2, PUMP_BACKOFF_MAX_MS);
  // Respect 429 cooldown — wait at least 5s, or until cooldown ends, whichever is longer
  const delay = Math.max(pumpBackoffMs, pump429CooldownUntil - Date.now(), 5000);
  log("info", "listener", `Scheduling reconnect in ${Math.round(delay / 1000)}s`);
  pumpReconnectTimer = setTimeout(() => {
    pumpReconnectTimer = null;
    connectPumpListener();
  }, delay);
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

    if (isRpcRateLimited()) return;
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
    for (const b of (tx?.meta?.postTokenBalances || [])) { if (b?.mint && !pre.has(b.mint)) return String(b.mint); }
  } catch {}
  return null;
}

// ================= TELEGRAM WEBHOOK INFO =================
export async function getTelegramWebhookInfo(): Promise<any> {
  try {
    const token = ENV.TELEGRAM_BOT_TOKEN;
    if (!token) return { ok: false, error: "No token" };
    const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
    return await res.json();
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
