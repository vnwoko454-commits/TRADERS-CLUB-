
import crypto from "crypto";
import { ENV, state, log } from "./core";
import {
  botTokenSet,
  sendTelegramTo,
  setTelegramWebhook,
  getTelegramWebhookInfo,
  deleteTelegramWebhook,
  getTelegramUpdates,
} from "./services";
import {
  runScan,
  toggleEmergencyStop,
  closePosition,
  riskStatus,
  getExposure,
  getUnrealizedPnl,
  unrealizedPnlOf,
} from "./trading";

const WEBHOOK_PATH = "/api/telegram/webhook";

function webhookSecret(): string {
  if (ENV.TELEGRAM_WEBHOOK_SECRET) {
    return ENV.TELEGRAM_WEBHOOK_SECRET;
  }

  return crypto
    .createHash("sha256")
    .update(ENV.TELEGRAM_BOT_TOKEN || "fallback")
    .digest("hex")
    .slice(0, 32);
}

export function verifyWebhookSecret(req: any): boolean {
  return (
    req.headers["x-telegram-bot-api-secret-token"] ===
    webhookSecret()
  );
}

export async function setupTelegram(): Promise<void> {
  if (!botTokenSet()) {
    log("warn", "telegram", "No TELEGRAM_BOT_TOKEN — bot disabled");
    state.serviceHealth.telegram = "unconfigured";
    return;
  }

  if (ENV.WEBHOOK_URL) {
    const url =
      ENV.WEBHOOK_URL.replace(/\/+$/, "") + WEBHOOK_PATH;

    log("info", "telegram", `Setting webhook → ${url}`);

    await setTelegramWebhook(url, webhookSecret());
    state.serviceHealth.telegram = "ok";
  } else {
    log("info", "telegram", "No WEBHOOK_URL — starting long polling");

    await deleteTelegramWebhook();
    startTelegramPolling();

    state.serviceHealth.telegram = "ok";
  }
}

let polling = false;

export async function startTelegramPolling(): Promise<void> {
  if (polling || !botTokenSet()) return;

  polling = true;

  let offset = 0;

  log("info", "telegram", "Polling started");

  while (polling) {
    try {
      const updates = await getTelegramUpdates(offset, 30);

      for (const update of updates) {
        offset = update.update_id + 1;
        await handleTelegramUpdate(update);
      }
    } catch (e: any) {
      log("warn", "telegram", `Polling error: ${e.message}`);

      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

export function stopTelegramPolling(): void {
  polling = false;
}

export async function handleTelegramUpdate(
  update: any
): Promise<void> {
  const msg = update?.message;

  if (!msg || !msg.text) return;

  const chatId = msg.chat?.id;

  if (!chatId) return;

  const text = msg.text.trim();
  const command = text.split(/\s+/)[0].toLowerCase().split("@")[0];

  log("info", "telegram", `Cmd from ${chatId}: ${command}`);

  try {
    switch (command) {
      case "/start":
        await cmdStart(chatId);
        break;

      case "/help":
        await cmdHelp(chatId);
        break;

      case "/status":
        await cmdStatus(chatId);
        break;

      case "/positions":
        await cmdPositions(chatId);
        break;

      case "/trades":
        await cmdTrades(chatId);
        break;

      case "/scan":
        await cmdScan(chatId, "early_hunter");
        break;

      case "/scanconfirm":
        await cmdScan(chatId, "confirmation_hunter");
        break;

      case "/close":
        await cmdClose(chatId, text);
        break;

      case "/emergency":
        await cmdEmergency(chatId, true);
        break;

      case "/reset":
        await cmdEmergency(chatId, false);
        break;

      case "/settings":
        await cmdSettings(chatId);
        break;

      case "/webhook":
        await cmdWebhookInfo(chatId);
        break;

      default:
        if (command.startsWith("/")) {
          await sendTelegramTo(
            chatId,
            `Unknown: <code>${command}</code>\nSend /help for commands.`
          );
        }
    }
  } catch (e: any) {
    log("error", "telegram", `Handler error: ${e.message}`);
  }
}

function fmt(n: number): string {
  return (
    "\u20A6" +
    Math.round(n || 0).toLocaleString("en-NG")
  );
}

function fmtUsd(n: number): string {
  return n > 0 ? "$" + n.toPrecision(6) : "\u2014";
}

async function cmdStart(
  chatId: string | number
): Promise<void> {
  await sendTelegramTo(
    chatId,
    "\u{1F680} <b>Vankleff Solana Hunter</b>\n\n" +
      "Backend-connected trading assistant.\n" +
      "Mode: <b>Paper Trading</b> (Live disabled)\n\n" +
      "Commands:\n" +
      "/help — List all commands\n" +
      "/status — Bot &amp; portfolio status\n" +
      "/positions — Open positions\n" +
      "/trades — Recent trade history\n" +
      "/scan — Run Early Hunter\n" +
      "/scanconfirm — Run Confirmation Hunter\n" +
      "/close &lt;symbol&gt; — Close a position\n" +
      "/emergency — Activate emergency stop\n" +
      "/reset — Reset emergency stop\n" +
      "/settings — Show settings\n" +
      "/webhook — Webhook info"
  );
}

async function cmdHelp(
  chatId: string | number
): Promise<void> {
  await sendTelegramTo(
    chatId,
    "\u{1F4CB} <b>Commands</b>\n\n" +
      "/start — Welcome\n" +
      "/status — Status, P&amp;L, risk limits\n" +
      "/positions — Open positions\n" +
      "/trades — Recent trades (last 10)\n" +
      "/scan — Early Hunter scan\n" +
      "/scanconfirm — Confirmation Hunter\n" +
      "/close &lt;symbol&gt; — Close position by symbol\n" +
      "/emergency — Emergency stop (blocks new entries)\n" +
      "/reset — Reset emergency stop\n" +
      "/settings — Trading config\n" +
      "/webhook — Webhook status"
  );
}

async function cmdStatus(
  chatId: string | number
): Promise<void> {
  const r = riskStatus();
  const unrealized = getUnrealizedPnl();
  const totalPnl = state.realizedPnl + unrealized;
  const exposure = getExposure();
  const available =
    state.settings.budget + state.realizedPnl - exposure;

  const sh = state.serviceHealth;

  let text = "\u{1F4CA} <b>Status</b>\n\n";

  text += `Mode: <b>${
    state.emergencyStop
      ? "\u{1F6A8} EMERGENCY STOP"
      : "Paper Trading"
  }</b>\n`;

  text += `Positions: <b>${state.positions.length}</b> / ${state.settings.maxPositions}\n`;
  text += `Available: ${fmt(Math.max(0, available))}\n`;
  text += `Committed: ${fmt(exposure)} / ${fmt(state.settings.maxExposure)}\n`;
  text += `Realized P&amp;L: ${fmt(state.realizedPnl)}\n`;
  text += `Unrealized P&amp;L: ${fmt(unrealized)} (est.)\n`;
  text += `Total P&amp;L: ${fmt(totalPnl)}\n\n`;

  text += "<b>Risk Limits</b>\n";

  text += `Daily Loss: ${fmt(r.dailyLossUsed)} / ${fmt(state.settings.dailyLossLimit)} ${
    r.dailyLimitHit ? "\u26A0\uFE0F" : "\u2705"
  }\n`;

  text += `Drawdown: ${fmt(r.drawdownValue)} / ${fmt(state.settings.drawdownTrigger)} ${
    r.drawdownHit ? "\u26A0\uFE0F" : "\u2705"
  }\n`;

  text += `Feed: ${
    r.feedUnreliable ? "\u26A0\uFE0F UNRELIABLE" : "\u2705 OK"
  } (${state.feedFailures} fails)\n`;

  text += `Emergency: ${
    state.emergencyStop ? "\u{1F6A8} ACTIVE" : "\u2705 Inactive"
  }\n\n`;

  text += "<b>Services</b>\n";
  text += `RPC: ${sh.rpc} | Listener: ${sh.listener} | Monitor: ${sh.monitor}\n`;
  text += `RugCheck: ${sh.rugcheck}`;

  await sendTelegramTo(chatId, text);
}

async function cmdPositions(
  chatId: string | number
): Promise<void> {
  if (state.positions.length === 0) {
    await sendTelegramTo(chatId, "\u{1F4ED} No open positions.");
    return;
  }

  let text =
    `\u{1F4C2} <b>Open Positions (${state.positions.length})</b>\n\n`;

  for (const p of state.positions) {
    const pnl = unrealizedPnlOf(p);

    text += `<b>${p.symbol}</b> [${p.strategy}]\n`;
    text += `  Size: ${fmt(p.sizeNaira)} | Rem: ${p.remainingPct ?? 100}%\n`;
    text += `  Entry: ${fmtUsd(p.entryPrice)} | Now: ${fmtUsd(p.currentPrice)}\n`;
    text += `  P&amp;L: ${pnl >= 0 ? "+" : ""}${fmt(pnl)} | Trail: ${
      p.trailHigh > 0 ? "\u2705" : "\u2014"
    }\n\n`;
  }

  await sendTelegramTo(chatId, text);
}

async function cmdTrades(
  chatId: string | number
): Promise<void> {
  const trades = state.tradeHistory.slice(-10).reverse();

  if (trades.length === 0) {
    await sendTelegramTo(chatId, "\u{1F4ED} No trades yet.");
    return;
  }

  let text =
    `\u{1F4DC} <b>Recent Trades (${trades.length})</b>\n\n`;

  for (const t of trades) {
    const time = new Date(t.timestamp).toLocaleString(
      "en-NG",
      {
        hour: "2-digit",
        minute: "2-digit",
        day: "2-digit",
        month: "short",
      }
    );

    const icon =
      t.type === "buy" ? "\u{1F7E2} BUY" : "\u{1F534} SELL";

    const pnl =
      t.type === "sell"
        ? ` | ${t.netPnl >= 0 ? "+" : ""}${fmt(t.netPnl)}`
        : "";

    text += `${icon} <b>${t.symbol}</b> [${t.strategy}]\n`;
    text += `  ${time} | ${fmt(t.sizeNaira)}${pnl} | ${t.reason}\n`;
  }

  await sendTelegramTo(chatId, text);
}

async function cmdScan(
  chatId: string | number,
  strategy: string
): Promise<void> {
  if (state.emergencyStop) {
    await sendTelegramTo(
      chatId,
      "\u{1F6A8} Emergency stop active — scan blocked."
    );
    return;
  }

  await sendTelegramTo(
    chatId,
    `\u{1F50D} Dispatching <b>${strategy}</b> scan…`
  );

  try {
    const result = await runScan(strategy as any);

    await sendTelegramTo(
      chatId,
      `\u2705 <b>${strategy}</b> done\n` +
        `Scanned: ${result.scanned} | Candidates: ${result.candidates}\n` +
        `Rejected: age=${result.rejectCounts.age} ` +
        `liq=${result.rejectCounts.liquidity} ` +
        `mcap=${result.rejectCounts.marketCap} ` +
        `vol=${result.rejectCounts.volume}`
    );
  } catch (e: any) {
    await sendTelegramTo(
      chatId,
      `\u274C Scan failed: ${e.message}`
    );
  }
}

async function cmdClose(
  chatId: string | number,
  text: string
): Promise<void> {
  const parts = text.split(/\s+/);

  if (parts.length < 2) {
    await sendTelegramTo(
      chatId,
      "Usage: /close &lt;symbol&gt;\nExample: /close SOL"
    );
    return;
  }

  const symbol = parts[1].toUpperCase();

  const pos = state.positions.find(
    (p) => p.symbol.toUpperCase() === symbol
  );

  if (!pos) {
    await sendTelegramTo(
      chatId,
      `\u274C No open position for ${symbol}`
    );
    return;
  }

  await sendTelegramTo(chatId, `\u{1F504} Closing ${symbol}…`);

  const result = await closePosition(pos.id, "telegram_manual");

  await sendTelegramTo(
    chatId,
    result.ok
      ? `\u2705 Closed ${symbol}`
      : `\u274C Close failed: ${result.reason}`
  );
}

async function cmdEmergency(
  chatId: string | number,
  activate: boolean
): Promise<void> {
  toggleEmergencyStop(activate);

  if (activate) {
    await sendTelegramTo(
      chatId,
      "\u{1F6A8} <b>EMERGENCY STOP ACTIVATED</b>\n\n" +
        "New entries blocked. Existing positions continue per exit policy.\n" +
        "Send /reset to deactivate."
    );
  } else {
    await sendTelegramTo(
      chatId,
      "\u2705 Emergency stop reset. New entries allowed (subject to risk limits)."
    );
  }
}

async function cmdSettings(
  chatId: string | number
): Promise<void> {
  const s = state.settings;

  let text = "\u2699\uFE0F <b>Settings</b>\n\n";

  text += `Budget: ${fmt(s.budget)}\n`;
  text += `Position Size: ${fmt(s.positionSize)}\n`;
  text += `Loss Trigger: ${fmt(s.lossTrigger)}\n`;
  text += `Max Positions: ${s.maxPositions}\n`;
  text += `Max Exposure: ${fmt(s.maxExposure)}\n`;
  text += `Drawdown: ${fmt(s.drawdownTrigger)}\n`;
  text += `Daily Loss Limit: ${fmt(s.dailyLossLimit)}\n`;
  text += `SOL/NGN: \u20A6${s.solNgnRate.toLocaleString()}\n`;
  text += `Trailing: ${s.trailingEnabled ? "\u2705" : "\u274C"} (${s.trailPct}%)\n`;
  text += `Max Hold: ${s.maxHoldHours}h\n`;
  text += `TP1: +${fmt(s.tpGain1)} → ${s.tpPct1}%\n`;
  text += `TP2: +${fmt(s.tpGain2)} → ${s.tpPct2}%\n`;
  text += `Liq Drop Exit: ${s.liquidityDropPct}%\n`;
  text += `Timezone: ${s.timezone}`;

  await sendTelegramTo(chatId, text);
}

async function cmdWebhookInfo(
  chatId: string | number
): Promise<void> {
  const info = await getTelegramWebhookInfo();

  if (!info?.ok) {
    await sendTelegramTo(
      chatId,
      `\u274C Webhook info error: ${info?.error || "unknown"}`
    );
    return;
  }

  const wh = info.result || {};

  let text = "\u{1F517} <b>Webhook Info</b>\n\n";

  text += `URL: ${wh.url || "(not set)"}\n`;
  text += `Pending: ${wh.pending_update_count || 0}\n`;
  text += `Last error: ${wh.last_error_message || "none"}`;

  if (ENV.WEBHOOK_URL) {
    text += `\n\nConfigured: ${ENV.WEBHOOK_URL.replace(/\/+$/, "")}${WEBHOOK_PATH}`;
  } else {
    text += "\n\nMode: Long polling (no WEBHOOK_URL)";
  }

  await sendTelegramTo(chatId, text);
}
