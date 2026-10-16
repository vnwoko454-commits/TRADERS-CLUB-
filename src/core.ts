
import dotenv from "dotenv";
import path from "path";
import fs from "fs";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return isFinite(n) ? n : def;
}

function str(name: string, def = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? def : v;
}

function bool(name: string, def = false): boolean {
  const v = (process.env[name] || "").toLowerCase();
  if (v === "") return def;
  return v === "true" || v === "1" || v === "yes";
}

export const PUMPFUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const LAMPORTS_PER_SOL = 1_000_000_000;
export const TOKEN_DECIMALS = 6;

export const API = {
  DEXSCREENER: str("DEXSCREENER_API_URL", "https://api.dexscreener.com"),
  RUGCHECK: str("RUGCHECK_API_URL", "https://api.rugcheck.xyz/v1"),
  JUPITER_QUOTE: str("JUPITER_API_URL", "https://quote-api.jup.ag/v6"),
  SOL_USD_PRICE: str(
    "SOL_USD_PRICE_URL",
    "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
  ),
  TELEGRAM: "https://api.telegram.org",
};

export const ENV = {
  RPC_HTTPS_URL: str(
    "RPC_HTTPS_URL",
    "https://api.mainnet-beta.solana.com"
  ),
  RPC_WSS_URL: str(
    "RPC_WSS_URL",
    "wss://api.mainnet-beta.solana.com"
  ),
  WALLET_PRIVATE_KEY: str("WALLET_PRIVATE_KEY"),
  TELEGRAM_BOT_TOKEN: str("TELEGRAM_BOT_TOKEN"),
  TELEGRAM_CHAT_ID: str("TELEGRAM_CHAT_ID"),
  LIVE_TRADING_ENABLED: bool("LIVE_TRADING_ENABLED", false),
  LIVE_TRADING_ACK: str("LIVE_TRADING_ACK"),
  PORT: num("PORT", 8080),
  MONITOR_INTERVAL_MS: num("MONITOR_INTERVAL_MS", 10000),
  RUGCHECK_API_KEY: str("RUGCHECK_API_KEY"),
  RUGCHECK_MAX_SCORE: num("RUGCHECK_MAX_SCORE", 40),
  SOL_NGN_RATE: num("SOL_NGN_RATE", 180000),
  STATE_FILE: str(
    "STATE_FILE",
    path.resolve(process.cwd(), "data", "state.json")
  ),
  WEBHOOK_URL: str("WEBHOOK_URL"),
  TELEGRAM_WEBHOOK_SECRET: str("TELEGRAM_WEBHOOK_SECRET"),
};

export const MONITOR_INTERVAL_MS = ENV.MONITOR_INTERVAL_MS;

export const BUY_FEE_PCT = 0.005;
export const SELL_FEE_PCT = 0.01;
export const SLIPPAGE_PCT = 0.01;

export const SCAN_CONFIG = {
  early: {
    maxAgeHours: 6,
    minLiq: 10_000,
    maxLiq: 250_000,
    minMcap: 50_000,
    maxMcap: 1_000_000,
    minVol: 100_000,
  },
  confirmation: {
    maxAgeHours: 24,
    minLiq: 25_000,
    maxLiq: 500_000,
    minMcap: 100_000,
    maxMcap: 2_000_000,
    minVol: 250_000,
  },
  autoScan: bool("AUTO_SCAN", true),
  autoScanIntervalMs: num("AUTO_SCAN_INTERVAL_MS", 60_000),
  maxEnrichPerScan: num("MAX_ENRICH_PER_SCAN", 20),
  recentMintBuffer: num("RECENT_MINT_BUFFER", 300),
};

export type Mode = "paper" | "live";

export interface Settings {
  budget: number;
  lossTrigger: number;
  positionSize: number;
  maxPositions: number;
  maxExposure: number;
  drawdownTrigger: number;
  dailyLossLimit: number;
  solNgnRate: number;
  reinvest: boolean;
  trailingEnabled: boolean;
  trailPct: number;
  tpGain1: number;
  tpPct1: number;
  tpGain2: number;
  tpPct2: number;
  maxHoldHours: number;
  liquidityDropPct: number;
  timezone: string;
}

export interface TpLevel {
  gain: number;
  pct: number;
}

export interface Position {
  id: string;
  address: string;
  symbol: string;
  strategy: string;
  sizeNaira: number;
  entryPrice: number;
  currentPrice: number;
  stopLossPrice: number | null;
  remainingPct: number;
  tpLevels: TpLevel[];
  executedTps: number[];
  entryLiquidityUsd: number;
  currentLiquidityUsd: number;
  trailHigh: number;
  openedAt: string;
  lastPriceUpdate: string;
  maxHoldHours: number;
  securityStatus: string;
  realizedPnl: number;
}

export interface Trade {
  id: string;
  timestamp: string;
  symbol: string;
  address: string;
  strategy: string;
  type: "buy" | "sell";
  sizeNaira: number;
  entryPrice: number;
  exitPrice: number;
  exitPct: number;
  partial: boolean;
  entryFee: number;
  exitFee: number;
  slippage: number;
  netPnl: number;
  simulated: boolean;
  reason: string;
}

export interface DiscoveredToken {
  id: string;
  address: string;
  symbol: string;
  name?: string;
  source: string;
  discoveredAt: string;
  pairCreatedAt?: number;
  priceUsd: number;
  liquidityUsd: number;
  marketCap: number | null;
  fdv: number | null;
  volume24h: number;
  score: number;
  securityStatus: "pending" | "passed" | "failed" | "unavailable";
  securityNotes: string;
  status: "candidate" | "traded" | "rejected";
}

export interface RecentMint {
  address: string;
  symbol: string;
  signature: string;
  detectedAt: string;
}

export interface ScanResult {
  strategy: string;
  scanned: number;
  candidates: number;
  rejectCounts: {
    age: number;
    liquidity: number;
    marketCap: number;
    volume: number;
    invalid: number;
  };
  rejectedSample: {
    symbol: string;
    reasons: string;
  }[];
  sourceErrors: number;
  at: string;
}

export interface ServiceHealth {
  rpc: string;
  telegram: string;
  listener: string;
  monitor: string;
  rugcheck: string;
}

export interface PersistedState {
  mode: Mode;
  liveEnabled: boolean;
  emergencyStop: boolean;
  feedFailures: number;
  settings: Settings;
  positions: Position[];
  tradeHistory: Trade[];
  discoveredTokens: DiscoveredToken[];
  recentMints: RecentMint[];
  realizedPnl: number;
  serviceHealth: ServiceHealth;
  lastScan: ScanResult | null;
}

export function uid(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export function log(
  level: "info" | "warn" | "error" | "debug",
  component: string,
  message: string,
  extra?: unknown
): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] [${component}] ${message}`;

  if (level === "error") console.error(line, extra ?? "");
  else if (level === "warn") console.warn(line, extra ?? "");
  else console.log(line, extra ?? "");
}

export function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && isFinite(n);
}

export const DEFAULT_STATE: PersistedState = {
  mode: "paper",
  liveEnabled: false,
  emergencyStop: false,
  feedFailures: 0,
  settings: {
    budget: 50000,
    lossTrigger: 500,
    positionSize: 1000,
    maxPositions: 3,
    maxExposure: 3000,
    drawdownTrigger: 2500,
    dailyLossLimit: 1000,
    solNgnRate: ENV.SOL_NGN_RATE,
    reinvest: false,
    trailingEnabled: true,
    trailPct: 20,
    tpGain1: 500,
    tpPct1: 50,
    tpGain2: 2000,
    tpPct2: 50,
    maxHoldHours: 24,
    liquidityDropPct: 50,
    timezone: "Africa/Lagos",
  },
  positions: [],
  tradeHistory: [],
  discoveredTokens: [],
  recentMints: [],
  realizedPnl: 0,
  serviceHealth: {
    rpc: "unknown",
    telegram: "unknown",
    listener: "stopped",
    monitor: "idle",
    rugcheck: "unknown",
  },
  lastScan: null,
};

function loadState(): PersistedState {
  try {
    const file = ENV.STATE_FILE;

    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));

      return {
        ...DEFAULT_STATE,
        ...raw,
        settings: {
          ...DEFAULT_STATE.settings,
          ...(raw.settings || {}),
        },
        serviceHealth: {
          ...DEFAULT_STATE.serviceHealth,
          ...(raw.serviceHealth || {}),
        },
      };
    }
  } catch (e) {
    log("warn", "state", "State load failed, using defaults", e);
  }

  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

export const state: PersistedState = loadState();

// Always start with live trading disabled.
state.liveEnabled = false;

let saveTimer: NodeJS.Timeout | null = null;

export function saveState(): void {
  if (saveTimer) return;

  saveTimer = setTimeout(() => {
    saveTimer = null;

    try {
      const file = ENV.STATE_FILE;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state, null, 2));
    } catch (e) {
      log("warn", "state", "State save failed", e);
    }
  }, 250);
}

export function snapshotPayload(): Record<string, unknown> {
  return {
    settings: state.settings,
    positions: state.positions,
    tradeHistory: state.tradeHistory,
    discoveredTokens: state.discoveredTokens,
    realizedPnl: state.realizedPnl,
    emergencyStop: state.emergencyStop,
    mode: state.mode,
    serviceHealth: state.serviceHealth,
    lastScan: state.lastScan,
  };
}

type Sender = (msg: Record<string, unknown>) => void;

let sender: Sender = () => {};

export function setSender(fn: Sender): void {
  sender = fn;
}

export function broadcast(msg: Record<string, unknown>): void {
  try {
    sender(msg);
  } catch {}
}
