
import express from "express";
import http from "http";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import { ENV } from "./core";
import { state, saveState, snapshotPayload, setSender, broadcast, uid, log } from "./core";
import { validateTpLevels, closePosition, openPaperPosition, startMonitor, runScan, startAutoScan, updateSettings, toggleEmergencyStop } from "./trading";
import { startPumpListener, getTelegramWebhookInfo } from "./services";
import { setupTelegram, handleTelegramUpdate, verifyWebhookSecret } from "./telegram";

// This log fires immediately after module loading — if it's missing in Railway
// logs, the crash is in an import above (missing dependency).
log("info", "boot", "Server module loaded — initializing...");

process.on("uncaughtException", (err) => {
  log("error", "process", "Uncaught exception", err);
});

process.on("unhandledRejection", (err) => {
  log("error", "process", "Unhandled rejection", err);
});

process.on("exit", (code) => {
  log("warn", "process", `Process exiting with code ${code}`);
});

// Keep-alive safety net — ensures the event loop never drains even if the
// HTTP server or WebSocket listener fails to start.
setInterval(() => {}, 60_000);

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function sendAll(msg: Record<string, unknown>): void {
  const data = JSON.stringify(msg);

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(data);
      } catch {}
    }
  });
}

setSender(sendAll);

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    mode: state.mode,
    live: "disabled",
    positions: state.positions.length,
    listener: state.serviceHealth.listener,
  });
});

// ================= TELEGRAM WEBHOOK =================
app.post("/api/telegram/webhook", async (req, res) => {
  if (!verifyWebhookSecret(req)) {
    log("warn", "telegram", "Webhook secret mismatch — rejecting");
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    await handleTelegramUpdate(req.body);
  } catch (e) {
    log("error", "telegram", `Webhook handler error: ${(e as any)?.message}`);
  }

  res.json({ ok: true });
});

app.get("/api/telegram/webhook-info", async (_req, res) => {
  res.json(await getTelegramWebhookInfo());
});

// ================= REST API =================
app.post("/api/settings", (req, res) => {
  const settings = req.body?.settings;

  if (!settings) {
    return res.status(400).json({ ok: false, error: "settings required" });
  }

  const result = updateSettings(settings);

  if (!result.ok) {
    return res.status(400).json({ ok: false, error: result.error });
  }

  return res.json({ ok: true, settings: state.settings });
});

app.post("/api/emergency-stop", (req, res) => {
  const result = toggleEmergencyStop(req.body?.activate !== false);
  return res.json(result);
});

app.post("/api/close-position", async (req, res) => {
  const result = await closePosition(String(req.body?.positionId), "manual");
  return res.json(result);
});

app.post("/api/scan", async (req, res) => {
  const strategy =
    req.body?.strategy === "confirmation_hunter"
      ? "confirmation_hunter"
      : "early_hunter";

  const result = await runScan(strategy);

  return res.json({ ok: true, result });
});

app.post("/api/paper-trade", async (req, res) => {
  const token = state.discoveredTokens.find(
    (t) => t.id === req.body?.tokenId || t.address === req.body?.address
  );

  if (!token) {
    return res.status(404).json({ ok: false, error: "Token not found" });
  }

  const result = await openPaperPosition(token);

  return res.status(result.ok ? 200 : 409).json(result);
});

// ================= WEBSOCKET =================
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "state_snapshot", data: snapshotPayload() }));
  ws.send(JSON.stringify({ type: "service_health", data: state.serviceHealth }));

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      switch (msg.type) {
        case "subscribe":
        case "get_state":
          ws.send(JSON.stringify({ type: "state_snapshot", data: snapshotPayload() }));
          ws.send(JSON.stringify({ type: "service_health", data: state.serviceHealth }));
          break;

        case "ping":
          ws.send(JSON.stringify({ type: "pong" }));
          break;

        case "run_scan":
          runScan(msg.data?.strategy || "early_hunter").catch(() => {});
          break;

        case "paper_trade": {
          const data = msg.data || {};

          let token = state.discoveredTokens.find(
            (t) => t.id === data.tokenId || t.address === data.address
          );

          if (!token && data.address) {
            token = {
              id: data.tokenId || uid("tok"),
              address: data.address,
              symbol: data.symbol || "",
              source: "manual",
              discoveredAt: new Date().toISOString(),
              priceUsd: Number(data.priceUsd) || 0,
              liquidityUsd: 0,
              marketCap: null,
              fdv: null,
              volume24h: 0,
              score: 0,
              securityStatus: "pending",
              securityNotes: "",
              status: "candidate",
            };
          }

          if (token) {
            openPaperPosition(token).catch(() => {});
          }

          break;
        }

        case "close_position":
          if (msg.data?.positionId) {
            closePosition(msg.data.positionId).catch(() => {});
          }
          break;

        case "emergency_stop":
          toggleEmergencyStop(msg.data?.activate !== false);
          break;

        case "update_settings":
          updateSettings(msg.data || {});
          break;
      }
    } catch {}
  });
});

setInterval(() => {
  broadcast({ type: "service_health", data: state.serviceHealth });
}, 30000);

server.on("error", (err) => {
  log("error", "server", "HTTP server error", err);
});

// Wrap listen in try/catch so a port binding error is logged, not silent.
try {
  server.listen(ENV.PORT, "0.0.0.0", () => {
    log("info", "boot", `Vankleff backend listening on 0.0.0.0:${ENV.PORT}`);

    try {
      startPumpListener();
      startMonitor();
      startAutoScan();

      setupTelegram().catch((e) =>
        log("error", "boot", `Telegram setup failed: ${e.message}`)
      );
    } catch (e: any) {
      log("error", "boot", `Startup callback error: ${e.message}`);
    }
  });
} catch (e: any) {
  log("error", "boot", `server.listen failed: ${e.message}`);
}
