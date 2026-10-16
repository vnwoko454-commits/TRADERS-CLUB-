
import {
  BUY_FEE_PCT,
  SELL_FEE_PCT,
  SLIPPAGE_PCT,
  SCAN_CONFIG,
  MONITOR_INTERVAL_MS,
} from "./core";

import {
  Position,
  Settings,
  TpLevel,
  Trade,
  DiscoveredToken,
  ScanResult,
} from "./core";

import {
  state,
  saveState,
  uid,
  snapshotPayload,
  broadcast,
} from "./core";

import {
  getTokenMarket,
  getBoostedTokens,
  checkToken,
  getCurveState,
  getConnection,
  sendTelegram,
} from "./services";

export function tokensFor(
  p: { sizeNaira: number; entryPrice: number }
): number {
  if (!p.entryPrice || p.entryPrice <= 0) return 0;

  return (
    (p.sizeNaira * (1 - BUY_FEE_PCT)) /
    p.entryPrice
  );
}

export function remainingFraction(p: Position): number {
  return (p.remainingPct ?? 100) / 100;
}

export function unrealizedPnlOf(p: Position): number {
  if (!p.currentPrice || p.currentPrice <= 0) return 0;

  const frac = remainingFraction(p);

  return (
    tokensFor(p) *
      frac *
      p.currentPrice *
      (1 - SELL_FEE_PCT - SLIPPAGE_PCT) -
    p.sizeNaira * frac
  );
}

export function computeStopPrice(
  entryPrice: number,
  size: number,
  lossTrigger: number
): number | null {
  if (lossTrigger >= size) return null;

  const denom =
    size *
    (1 - BUY_FEE_PCT) *
    (1 - SELL_FEE_PCT - SLIPPAGE_PCT);

  const price =
    ((size - lossTrigger) * entryPrice) / denom;

  return isFinite(price) && price > 0 ? price : null;
}

export function tpLevelsFor(s: Settings): TpLevel[] {
  return [
    {
      gain: Number(s.tpGain1) || 0,
      pct: Number(s.tpPct1) || 0,
    },
    {
      gain: Number(s.tpGain2) || 0,
      pct: Number(s.tpPct2) || 0,
    },
  ].filter((l) => l.pct > 0 && l.gain > 0);
}

export function validateTpLevels(s: Settings) {
  const levels = tpLevelsFor(s);
  const total = levels.reduce((a, l) => a + l.pct, 0);

  return {
    valid: total <= 100 && total > 0,
    total,
    error:
      total > 100
        ? "Exceeds 100%"
        : total === 0
          ? "No TP configured"
          : null,
  };
}

export function buildEntryTrade(
  p: Position,
  simulated: boolean
): Trade {
  return {
    id: uid("trd"),
    timestamp: p.openedAt,
    symbol: p.symbol,
    address: p.address,
    strategy: p.strategy,
    type: "buy",
    sizeNaira: p.sizeNaira,
    entryPrice: p.entryPrice,
    exitPrice: 0,
    exitPct: 0,
    partial: false,
    entryFee: p.sizeNaira * BUY_FEE_PCT,
    exitFee: 0,
    slippage: 0,
    netPnl: 0,
    simulated,
    reason: "entry",
  };
}

export function buildExitTrade(
  p: Position,
  exitPct: number,
  exitPrice: number,
  reason: string,
  simulated: boolean
) {
  const frac = Math.min(exitPct, p.remainingPct) / 100;

  const gross = tokensFor(p) * frac * exitPrice;
  const exitFee = gross * SELL_FEE_PCT;
  const slippage = gross * SLIPPAGE_PCT;

  const netPnl =
    gross * (1 - SELL_FEE_PCT - SLIPPAGE_PCT) -
    p.sizeNaira * frac;

  const trade: Trade = {
    id: uid("trd"),
    timestamp: new Date().toISOString(),
    symbol: p.symbol,
    address: p.address,
    strategy: p.strategy,
    type: "sell",
    sizeNaira: p.sizeNaira * frac,
    entryPrice: p.entryPrice,
    exitPrice,
    exitPct,
    partial: exitPct < p.remainingPct - 1e-9,
    entryFee: 0,
    exitFee,
    slippage,
    netPnl,
    simulated,
    reason,
  };

  return { trade, netPnlDelta: netPnl };
}

export function getExposure(): number {
  return state.positions.reduce(
    (sum, p) => sum + p.sizeNaira * remainingFraction(p),
    0
  );
}

export function getUnrealizedPnl(): number {
  return state.positions.reduce(
    (sum, p) => sum + unrealizedPnlOf(p),
    0
  );
}

export function tradingDayStart(tz: string): Date {
  try {
    const ymd = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .format(new Date())
      .split("-");

    return new Date(
      Date.UTC(+ymd[0], +ymd[1] - 1, +ymd[2])
    );
  } catch {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t;
  }
}

export function sumDailyLosses(
  history: Trade[],
  tz: string
): number {
  const dayStart = tradingDayStart(tz).getTime();

  let sum = 0;

  history.forEach((t) => {
    if (
      t.type === "sell" &&
      t.netPnl < 0 &&
      new Date(t.timestamp).getTime() >= dayStart
    ) {
      sum += -t.netPnl;
    }
  });

  return Math.max(0, sum);
}

export function riskStatus() {
  const s = state.settings;

  const dailyLossUsed = sumDailyLosses(
    state.tradeHistory,
    s.timezone
  );

  const total =
    state.realizedPnl + getUnrealizedPnl();

  return {
    dailyLossUsed,
    dailyLimitHit: dailyLossUsed >= s.dailyLossLimit,
    drawdownHit: -total >= s.drawdownTrigger,
    drawdownValue: Math.max(0, -total),
    maxPosHit: state.positions.length >= s.maxPositions,
    expHit: getExposure() >= s.maxExposure,
    feedUnreliable: state.feedFailures >= 3,
  };
}

export function entryBlockReason(): string | null {
  if (state.emergencyStop) {
    return "Emergency stop active";
  }

  const r = riskStatus();

  if (r.dailyLimitHit) {
    return "Daily loss limit reached";
  }

  if (r.drawdownHit) {
    return "Drawdown trigger reached";
  }

  if (r.feedUnreliable) {
    return "Market feed unreliable";
  }

  if (r.maxPosHit) {
    return "Max positions reached";
  }

  if (r.expHit) {
    return "Max exposure reached";
  }

  return null;
}

export async function runScan(
  strategy: "early_hunter" | "confirmation_hunter"
): Promise<ScanResult> {
  const cfg =
    strategy === "confirmation_hunter"
      ? SCAN_CONFIG.confirmation
      : SCAN_CONFIG.early;

  const rejectCounts = {
    age: 0,
    liquidity: 0,
    marketCap: 0,
    volume: 0,
    invalid: 0,
  };

  const rejectedSample: {
    symbol: string;
    reasons: string;
  }[] = [];

  let candidates = 0;
  let sourceErrors = 0;

  let pool: { address: string }[];

  if (strategy === "confirmation_hunter") {
    pool = await getBoostedTokens();
  } else {
    pool = state.recentMints
      .slice(-SCAN_CONFIG.maxEnrichPerScan)
      .reverse();
  }

  for (const mint of pool) {
    const market = await getTokenMarket(mint.address);

    if (!market) {
      sourceErrors++;
      rejectCounts.invalid++;
      continue;
    }

    const ageHours = market.pairCreatedAt
      ? (Date.now() - market.pairCreatedAt) / 3600000
      : 999;

    const reasons: string[] = [];

    if (ageHours > cfg.maxAgeHours) {
      reasons.push("age");
    }

    if (
      market.liquidityUsd < cfg.minLiq ||
      market.liquidityUsd > cfg.maxLiq
    ) {
      reasons.push("liquidity");
    }

    if (
      market.marketCap == null ||
      market.marketCap < cfg.minMcap ||
      market.marketCap > cfg.maxMcap
    ) {
      reasons.push("marketCap");
    }

    if (market.volume24h < cfg.minVol) {
      reasons.push("volume");
    }

    if (market.priceUsd <= 0) {
      reasons.push("invalid");
    }

    if (reasons.length > 0) {
      reasons.forEach((r) => {
        if (r in rejectCounts) {
          (rejectCounts as any)[r]++;
        }
      });

      if (rejectedSample.length < 12) {
        rejectedSample.push({
          symbol: market.symbol || mint.address.slice(0, 6),
          reasons: reasons.join(", "),
        });
      }

      continue;
    }

    const security = await checkToken(mint.address);

    const token: DiscoveredToken = {
      id: uid("tok"),
      address: mint.address,
      symbol: market.symbol || mint.address.slice(0, 6),
      source:
        strategy === "confirmation_hunter"
          ? "dexscreener+boost"
          : "pumpfun-listener",
      discoveredAt: new Date().toISOString(),
      priceUsd: market.priceUsd,
      liquidityUsd: market.liquidityUsd,
      marketCap: market.marketCap,
      fdv: market.fdv,
      volume24h: market.volume24h,
      score: 75,
      securityStatus: security.status,
      securityNotes: security.notes,
      status: "candidate",
    };

    candidates++;

    const found = state.discoveredTokens.find(
      (t) => t.address === token.address
    );

    if (found) {
      Object.assign(found, token);
    } else {
      state.discoveredTokens.push(token);

      if (state.discoveredTokens.length > 100) {
        state.discoveredTokens =
          state.discoveredTokens.slice(-100);
      }
    }

    broadcast({
      type: "token_discovered",
      data: token,
    });
  }

  const result: ScanResult = {
    strategy,
    scanned: pool.length,
    candidates,
    rejectCounts,
    rejectedSample,
    sourceErrors,
    at: new Date().toISOString(),
  };

  state.lastScan = result;

  saveState();

  broadcast({
    type: "scan_result",
    data: result,
  });

  return result;
}

export async function openPaperPosition(
  token: DiscoveredToken
) {
  const blocked = entryBlockReason();

  if (blocked) {
    broadcast({
      type: "risk_alert",
      data: {
        active: true,
        message: blocked + " — new entries blocked.",
      },
    });

    return { ok: false, reason: blocked };
  }

  const s = state.settings;
  const price = token.priceUsd;

  if (!price || price <= 0) {
    return { ok: false, reason: "Invalid price" };
  }

  const position: Position = {
    id: uid("pos"),
    address: token.address,
    symbol: token.symbol,
    strategy: token.source.includes("confirm")
      ? "confirmation_hunter"
      : "early_hunter",
    sizeNaira: s.positionSize,
    entryPrice: price,
    currentPrice: price,
    stopLossPrice: computeStopPrice(
      price,
      s.positionSize,
      s.lossTrigger
    ),
    remainingPct: 100,
    tpLevels: tpLevelsFor(s),
    executedTps: [],
    entryLiquidityUsd: token.liquidityUsd,
    currentLiquidityUsd: token.liquidityUsd,
    trailHigh: 0,
    openedAt: new Date().toISOString(),
    lastPriceUpdate: new Date().toISOString(),
    maxHoldHours: s.maxHoldHours,
    securityStatus: token.securityStatus,
    realizedPnl: 0,
  };

  state.positions.push(position);

  const entryTrade = buildEntryTrade(position, true);

  state.tradeHistory.push(entryTrade);

  token.status = "traded";

  saveState();

  broadcast({
    type: "position_opened",
    data: position,
  });

  broadcast({
    type: "trade_recorded",
    data: {
      ...entryTrade,
      realizedPnlDelta: 0,
    },
  });

  broadcast({
    type: "state_snapshot",
    data: snapshotPayload(),
  });

  sendTelegram(
    `\u{1F7E2} <b>PAPER BUY</b> ${position.symbol}\n` +
      `Size: \u20A6${position.sizeNaira}\n` +
      `Entry: $${price}`
  );

  return { ok: true };
}

export function applyExit(
  p: Position,
  exitPct: number,
  price: number,
  reason: string
) {
  const { trade, netPnlDelta } = buildExitTrade(
    p,
    exitPct,
    price,
    reason,
    true
  );

  state.tradeHistory.push(trade);
  state.realizedPnl += netPnlDelta;
  p.realizedPnl += netPnlDelta;

  const sold = Math.min(exitPct, p.remainingPct);

  p.remainingPct = Math.max(
    0,
    p.remainingPct - sold
  );

  if (p.remainingPct <= 0.0001) {
    state.positions = state.positions.filter(
      (x) => x.id !== p.id
    );

    broadcast({
      type: "position_closed",
      data: {
        id: p.id,
        trade,
        realizedPnl: state.realizedPnl,
      },
    });

    sendTelegram(
      `\u{1F534} <b>CLOSED</b> ${p.symbol} (${reason})\n` +
        `PnL: \u20A6${netPnlDelta.toFixed(0)}`
    );
  } else {
    broadcast({
      type: "trade_recorded",
      data: {
        ...trade,
        realizedPnlDelta: netPnlDelta,
      },
    });

    broadcast({
      type: "position_updated",
      data: p,
    });

    sendTelegram(
      `\u{1F7E1} <b>PARTIAL EXIT</b> ${p.symbol} — ${sold}% (${reason})`
    );
  }

  saveState();

  broadcast({
    type: "state_snapshot",
    data: snapshotPayload(),
  });
}

export async function closePosition(
  positionId: string,
  reason = "manual"
) {
  const p = state.positions.find(
    (x) => x.id === positionId
  );

  if (!p) {
    return {
      ok: false,
      reason: "Position not found",
    };
  }

  let price = p.currentPrice;

  if (!price || price <= 0) {
    const market = await getTokenMarket(p.address);

    price = market?.priceUsd || 0;

    if (price > 0) {
      p.currentPrice = price;
    }
  }

  if (!price || price <= 0) {
    return {
      ok: false,
      reason: "No current price available",
    };
  }

  applyExit(p, p.remainingPct, price, reason);

  return { ok: true };
}

export async function monitorTick() {
  if (state.positions.length === 0) {
    state.serviceHealth.monitor = "idle";
    return;
  }

  state.serviceHealth.monitor = "running";

  const s = state.settings;

  let anySuccess = false;

  for (const p of state.positions.slice()) {
    try {
      const curve = await getCurveState(
        getConnection(),
        p.address
      );

      const market = curve
        ? null
        : await getTokenMarket(p.address);

      const price =
        curve?.priceUsd || market?.priceUsd || 0;

      const liquidity =
        market?.liquidityUsd ||
        curve?.liquidityUsd ||
        0;

      if (price > 0) {
        anySuccess = true;

        p.currentPrice = price;
        p.currentLiquidityUsd = liquidity;
        p.lastPriceUpdate = new Date().toISOString();

        if (s.trailingEnabled) {
          if (
            p.trailHigh === 0 &&
            unrealizedPnlOf(p) >= s.lossTrigger
          ) {
            p.trailHigh = price;
          } else if (
            p.trailHigh > 0 &&
            price > p.trailHigh
          ) {
            p.trailHigh = price;
          }
        }

        broadcast({
          type: "position_updated",
          data: p,
        });

        if (
          p.remainingPct > 0 &&
          p.stopLossPrice &&
          price <= p.stopLossPrice
        ) {
          applyExit(
            p,
            p.remainingPct,
            price,
            "stop_loss"
          );

          continue;
        }

        if (
          p.remainingPct > 0 &&
          s.trailingEnabled &&
          p.trailHigh > 0
        ) {
          const trailStop =
            p.trailHigh * (1 - s.trailPct / 100);

          if (price <= trailStop) {
            applyExit(
              p,
              p.remainingPct,
              price,
              "trailing_stop"
            );

            continue;
          }
        }

        if (p.remainingPct > 0) {
          const fullPnl =
            tokensFor(p) *
              price *
              (1 - SELL_FEE_PCT - SLIPPAGE_PCT) -
            p.sizeNaira;

          for (let i = 0; i < p.tpLevels.length; i++) {
            if (p.remainingPct <= 0) break;

            if (p.executedTps.includes(i)) continue;

            if (fullPnl >= p.tpLevels[i].gain) {
              p.executedTps.push(i);

              applyExit(
                p,
                p.tpLevels[i].pct,
                price,
                `take_profit_${i + 1}`
              );
            }
          }
        }

        if (p.remainingPct > 0) {
          const elapsed =
            (Date.now() -
              new Date(p.openedAt).getTime()) /
            3600000;

          if (elapsed >= p.maxHoldHours) {
            applyExit(
              p,
              p.remainingPct,
              price,
              "max_hold"
            );

            continue;
          }
        }

        if (
          p.remainingPct > 0 &&
          p.entryLiquidityUsd > 0 &&
          liquidity > 0
        ) {
          const drop =
            (1 - liquidity / p.entryLiquidityUsd) * 100;

          if (drop >= s.liquidityDropPct) {
            applyExit(
              p,
              p.remainingPct,
              price,
              "liquidity_drop"
            );
          }
        }
      }
    } catch {}
  }

  if (!anySuccess) {
    state.feedFailures++;
  } else {
    state.feedFailures = 0;
  }

  const r = riskStatus();

  if (
    r.dailyLimitHit ||
    r.drawdownHit ||
    r.feedUnreliable
  ) {
    let message =
      "Risk limit reached — new entries blocked.";

    if (r.dailyLimitHit) {
      message =
        `Daily loss limit reached (\u20A6${s.dailyLossLimit}) — new purchases blocked.`;
    } else if (r.drawdownHit) {
      message =
        `Portfolio drawdown trigger reached (\u20A6${s.drawdownTrigger}) — new purchases blocked.`;
    } else if (r.feedUnreliable) {
      message =
        "Market data unreliable — new entries paused.";
    }

    broadcast({
      type: "risk_alert",
      data: {
        active: true,
        message,
      },
    });
  }

  saveState();
}

let monitorTimer: NodeJS.Timeout | null = null;

export function startMonitor() {
  if (monitorTimer) return;

  const interval =
    MONITOR_INTERVAL_MS ||
    Number(process.env.MONITOR_INTERVAL_MS) ||
    10000;

  monitorTimer = setInterval(() => {
    monitorTick().catch(() => {});
  }, interval);
}

let autoTimer: NodeJS.Timeout | null = null;

export function startAutoScan() {
  if (!SCAN_CONFIG.autoScan || autoTimer) return;

  autoTimer = setInterval(() => {
    runScan("early_hunter").catch(() => {});
  }, SCAN_CONFIG.autoScanIntervalMs);
}

export function updateSettings(
  settings: Partial<Settings>
): { ok: boolean; error?: string } {
  Object.assign(state.settings, settings);

  const v = validateTpLevels(state.settings);

  if (!v.valid) {
    saveState();

    return {
      ok: false,
      error: v.error || "Invalid settings",
    };
  }

  saveState();

  broadcast({
    type: "settings_synced",
    data: state.settings,
  });

  return { ok: true };
}

export function toggleEmergencyStop(activate: boolean) {
  state.emergencyStop = activate !== false;

  saveState();

  broadcast({
    type: "risk_status",
    data: {
      emergencyStop: state.emergencyStop,
      realizedPnl: state.realizedPnl,
      feedFailures: state.feedFailures,
    },
  });

  if (state.emergencyStop) {
    broadcast({
      type: "risk_alert",
      data: {
        active: true,
        message:
          "EMERGENCY STOP ACTIVE — New entries blocked. Existing positions continue per exit policy.",
      },
    });
  } else {
    broadcast({
      type: "risk_alert",
      data: { active: false },
    });
  }

  return {
    ok: true,
    emergencyStop: state.emergencyStop,
  };
}
