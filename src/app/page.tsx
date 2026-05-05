import { fetchMarketData, calculateTrend, getRSIZone, getSignal } from "@/lib/market";
import { fetchEtoroPortfolio } from "@/lib/etoro";
import { classifyActionZone, buildProjection, computeTodayPnlUSD } from "@/lib/wealth";
import type {
  ManualInput,
  PositionWithLive,
  Flag,
  MarketData,
  SmartPortfolio,
} from "@/lib/types";
import manualInput from "@/data/manual-input.json";
import RefreshButton from "./refresh-button";
import LiveNewsFeed from "./components/LiveNewsFeed";
import StrategistPanel from "./components/StrategistPanel";

export const revalidate = 900; // 15 min ISR — Refresh button bypasses cache on demand

interface FearGreedEntry {
  value: string;
  value_classification: string;
  timestamp: string;
}

async function fetchFearGreed(): Promise<FearGreedEntry | null> {
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=1", {
      next: { revalidate: 3600 },
    } as RequestInit);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.[0] ?? null;
  } catch {
    return null;
  }
}

async function getDashboardData() {
  const data = manualInput as unknown as ManualInput;
  // Fetch market prices (15 min), eToro portfolio (1 hr), and Fear & Greed (1 hr) in parallel
  const [marketData, etoroData, fearGreed] = await Promise.all([
    fetchMarketData(data.marketSymbols),
    fetchEtoroPortfolio(),
    fetchFearGreed(),
  ]);
  return { data, marketData, etoroData, fearGreed };
}

function formatCurrency(value: number): string {
  if (value === 0) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatPrice(value: number): string {
  if (value === 0) return "—";
  if (value > 100) return value.toFixed(2);
  return value.toFixed(4);
}

// Days between an ISO date string (YYYY-MM-DD) and today's Dubai date.
function daysOld(dateStr?: string): number | null {
  if (!dateStr) return null;
  const today = new Date(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Dubai" }));
  const then = new Date(dateStr);
  if (isNaN(then.getTime())) return null;
  return Math.floor((today.getTime() - then.getTime()) / (1000 * 60 * 60 * 24));
}

// Inline staleness badge — green if fresh, amber if borderline, red if past threshold.
function StaleBadge({ dateStr, freshDays = 1, staleDays = 3, label = "updated" }: {
  dateStr?: string; freshDays?: number; staleDays?: number; label?: string;
}) {
  const age = daysOld(dateStr);
  if (age === null) return (
    <span className="text-[10px] font-mono text-gray-500">no date</span>
  );
  const tone = age <= freshDays ? "text-emerald-400"
             : age <= staleDays ? "text-amber-400"
             : "text-red-400";
  const dot  = age <= freshDays ? "bg-emerald-500"
             : age <= staleDays ? "bg-amber-500"
             : "bg-red-500 animate-pulse";
  const word = age === 0 ? "today"
             : age === 1 ? "1 day ago"
             : age <= 7 ? `${age} days ago`
             : `${Math.floor(age / 7)} wk${Math.floor(age / 7) > 1 ? "s" : ""} ago`;
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-mono ${tone}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      {label} {word}{age > staleDays ? " · STALE" : ""}
    </span>
  );
}

function getMarketData(
  symbol: string,
  marketDataMap: Map<string, MarketData>
): MarketData {
  return (
    marketDataMap.get(symbol) || {
      symbol,
      price: 0,
      changePercent: 0,
    }
  );
}

function enrichPositionWithLiveData(
  position: any,
  marketDataMap: Map<string, MarketData>,
  etoroAggregated?: Map<string, { units: number; avgCost: number; totalInvested: number }>
): PositionWithLive {
  // Use live eToro units/avgCost/totalInvested if available, otherwise fall back to manual-input.json
  const liveEtoro = etoroAggregated?.get(position.symbol);
  const quantity = liveEtoro?.units ?? position.quantity;
  const avgCost = liveEtoro?.avgCost ?? position.avgCost;
  // Cost basis: prefer eToro `amount` (cash actually invested, leverage-adjusted) over qty×avgCost
  const costBasis = liveEtoro?.totalInvested ?? quantity * avgCost;

  const mkt = getMarketData(position.symbol, marketDataMap);
  const livePrice = mkt.price || avgCost;
  // Mark-to-market: cash invested + (price delta × units). For unleveraged this equals quantity×livePrice.
  // For leveraged CFDs (Gold non-expiry, etc.) eToro reports `units` as the levered notional, so
  // qty×livePrice would over-count. Cost-basis + delta works correctly for both.
  const unrealizedPnl = quantity * (livePrice - avgCost);
  const currentValue = costBasis + unrealizedPnl;
  const unrealizedPnlPercent =
    costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : 0;

  return {
    ...position,
    quantity,   // live from eToro if available
    avgCost,    // live from eToro if available
    livePrice,
    changePercent: mkt.changePercent || 0,
    currentValue,
    unrealizedPnl,
    unrealizedPnlPercent,
    sma50: mkt.sma50,
    sma200: mkt.sma200,
    rsi14: mkt.rsi14,
    dataSource: liveEtoro ? "etoro-live" : "manual",
  };
}

function getPositionFlags(position: PositionWithLive): Flag[] {
  const flags: Flag[] = [];

  if (position.livePrice <= position.stopLoss) {
    flags.push({
      severity: "critical",
      title: `${position.label} Below Stop — $${position.livePrice.toFixed(2)} (Stop: $${position.stopLoss.toFixed(2)})`,
      pnlPercent: position.unrealizedPnlPercent,
    });
  } else if (position.livePrice >= position.takeProfit2) {
    flags.push({
      severity: "ok",
      title: `${position.label} Hit TP2 — ${formatPercent(position.unrealizedPnlPercent)}`,
      pnlPercent: position.unrealizedPnlPercent,
    });
  } else if (position.livePrice >= position.takeProfit) {
    flags.push({
      severity: "watch",
      title: `${position.label} Near TP1 — ${formatPercent(position.unrealizedPnlPercent)}`,
      pnlPercent: position.unrealizedPnlPercent,
    });
  } else if (position.livePrice > position.avgCost) {
    flags.push({
      severity: "ok",
      title: `${position.label} in Profit — ${formatPercent(position.unrealizedPnlPercent)}`,
      pnlPercent: position.unrealizedPnlPercent,
    });
  }

  return flags;
}

export default async function Dashboard() {
  const { data, marketData, etoroData, fearGreed } = await getDashboardData();

  // Live cash from eToro API (credit minus pending orders), falls back to manual-input.json
  const cashIdle = etoroData?.cashAvailable ?? data.equity.cashIdle;
  const isEtoroLive = etoroData !== null;
  const hasLiveMirrors = isEtoroLive && (etoroData?.mirrors.length ?? 0) > 0;

  const enrichedPositions = data.positions.map((pos) =>
    enrichPositionWithLiveData(pos, marketData, etoroData?.aggregated)
  );

  // Direct book — sum from positions joined to live Yahoo prices + live eToro units/cost
  const directBookValue = enrichedPositions.reduce(
    (sum, pos) => sum + pos.currentValue,
    0
  );
  const directBookInvested = isEtoroLive
    ? (etoroData!.directInvested || enrichedPositions.reduce((s, p) => s + p.quantity * p.avgCost, 0))
    : enrichedPositions.reduce((s, p) => s + p.quantity * p.avgCost, 0);

  // Mirrors (Copy traders + Smart Portfolios) — live from eToro when available,
  // otherwise fall back to manual smartPortfolios + copyPortfolio snapshots
  const liveMirrorsInvested = etoroData?.mirrorsInvested ?? 0;
  const liveMirrorsValue = etoroData?.mirrorsValue ?? 0;

  const manualMirrorsInvested =
    (data.smartPortfolios?.reduce((s, sp) => s + (sp.currentValue - sp.currentPnl), 0) ?? 0) +
    ((data.copyPortfolio.currentValue ?? 0) - (data.copyPortfolio.currentPnl ?? 0));
  const manualMirrorsValue =
    (data.smartPortfolios?.reduce((s, sp) => s + sp.currentValue, 0) ?? 0) +
    (data.copyPortfolio.currentValue ?? 0);

  const mirrorsInvested = hasLiveMirrors ? liveMirrorsInvested : manualMirrorsInvested;
  const mirrorsValue = hasLiveMirrors ? liveMirrorsValue : manualMirrorsValue;

  // Headline totals — single source of truth, matches eToro's app totals
  const investedValue = directBookInvested + mirrorsInvested;
  const totalPortfolioValue = directBookValue + mirrorsValue + cashIdle;
  const totalPnL = totalPortfolioValue - investedValue - cashIdle; // P/L excludes cash
  const totalPnLPct = investedValue > 0 ? (totalPnL / investedValue) * 100 : 0;

  // Diagnostic banner: show source + known caveat for mirrors
  const dataSourceLabel = hasLiveMirrors
    ? "eToro API · live (mirror values at cost basis — open P/L not included)"
    : isEtoroLive
      ? "eToro API (cash + direct only) · mirrors from manual snapshot"
      : "manual snapshot — eToro API unreachable";

  const allFlags = enrichedPositions.flatMap(getPositionFlags);

  // Live AED conversions for wealth progress (Schwab RSUs marked-to-market via Yahoo)
  const usdToAed = data.wealthProgress?.usdToAed ?? 3.6725;
  const etoroPortfolioAED = Math.round(totalPortfolioValue * usdToAed);
  const pinsLivePrice = marketData.get("PINS")?.price ?? 0;
  const snapLivePrice = marketData.get("SNAP")?.price ?? 0;
  const pinsRsuAED = pinsLivePrice > 0 ? Math.round(pinsLivePrice * 1429 * usdToAed) : 0;
  const snapRsuAED = snapLivePrice > 0 ? Math.round(snapLivePrice * 1798 * usdToAed) : 0;

  // ─── Wealth Hero math ───
  const wp = data.wealthProgress;
  const liveWealthComponents = (wp?.components ?? []).map((c: any) => {
    if (c.label === "eToro Portfolio" && etoroPortfolioAED > 0) return { ...c, valueAED: etoroPortfolioAED };
    if (c.label?.startsWith("PINS RSU") && pinsRsuAED > 0)       return { ...c, valueAED: pinsRsuAED };
    if (c.label?.startsWith("SNAP RSU") && snapRsuAED > 0)       return { ...c, valueAED: snapRsuAED };
    return c;
  });
  const grossAssetsAED = liveWealthComponents.reduce((s: number, c: any) => s + c.valueAED, 0);
  const totalLiabilitiesAED = (wp?.liabilities ?? []).reduce((s: number, l: any) => s + l.balanceAED, 0);
  const netWorthAED = grossAssetsAED - totalLiabilitiesAED;
  const projection = buildProjection(netWorthAED, wp?.goalAED ?? 1_000_000);

  // Momentum tiles
  const todayPnlUSD = computeTodayPnlUSD(enrichedPositions);
  const todayPnlAED = todayPnlUSD * usdToAed;
  const monthlyIncomeAED = (wp?.incomeSources ?? []).reduce((s: number, i: any) => s + i.monthlyAED, 0);

  // ─── Action Zones (sorted by urgency desc) ───
  const actionZones = enrichedPositions
    .map(classifyActionZone)
    .sort((a, b) => b.urgency - a.urgency);
  const urgentZones = actionZones.filter((z) => z.urgency >= 40);

  // Filter to only upcoming/today events — compare date string to today in Dubai time
  const todayDubai = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Dubai" }); // YYYY-MM-DD
  const upcomingEvents = (data.events ?? []).filter(
    (evt: any) => evt.status !== "passed" && evt.date >= todayDubai
  );

  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const timeStr = now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

  const marketSymbols = [
    "^GSPC",
    "^IXIC",
    "GC=F",
    "BZ=F",
    "BTC-USD",
    "ETH-USD",
    "^VIX",
  ];
  const marketTiles = marketSymbols.map((sym) => getMarketData(sym, marketData));

  // Portfolio snapshot — passed to StrategistPanel for AI regeneration
  const portfolioSnapshot = {
    portfolioValue: totalPortfolioValue,
    cashIdle,
    totalPnL,
    isEtoroLive,
    positions: enrichedPositions.map((p) => ({
      symbol: p.symbol,
      livePrice: p.livePrice,
      avgCost: p.avgCost,
      unrealizedPnlPercent: p.unrealizedPnlPercent,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
    })),
    events: upcomingEvents.slice(0, 6).map((e: any) => ({
      date: e.date,
      label: e.label,
      priority: e.priority ?? "medium",
    })),
    warStatus: {
      status: data.warStatus.status,
      description: data.warStatus.description,
    },
    marketContext: marketTiles
      .filter((m) => m.price > 0)
      .map((m) => ({
        symbol: m.symbol,
        price: m.price,
        changePercent: m.changePercent,
      })),
  };

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-5">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">C&G Brief</h1>
              <p className="text-sm text-gray-400">
                Live Dashboard · {dateStr} {timeStr} Dubai
              </p>
            </div>
            <div className="flex flex-col items-end gap-2">
              <RefreshButton />
              <p className={`text-xs font-mono ${hasLiveMirrors ? "text-emerald-500" : isEtoroLive ? "text-amber-500" : "text-red-500"}`}>
                ● {dataSourceLabel}
              </p>
              {etoroData?.fetchedAt && (
                <p className="text-[10px] text-gray-600 font-mono">
                  eToro synced {new Date(etoroData.fetchedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Dubai" })} Dubai
                </p>
              )}
            </div>
          </div>

          {/* ─── Wealth Hero ─── */}
          <div className="mb-5 bg-gradient-to-br from-emerald-950/40 via-gray-900 to-sky-950/30 border border-gray-800 rounded-2xl p-6">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Net Worth + AED 1M progress */}
              <div className="lg:col-span-2">
                <p className="text-[11px] font-bold text-emerald-400 uppercase tracking-widest mb-1">Road to AED 1,000,000</p>
                <div className="flex items-baseline gap-3 mb-1">
                  <p className="text-4xl font-mono font-bold text-white">
                    AED {netWorthAED.toLocaleString()}
                  </p>
                  <p className="text-2xl font-mono font-bold text-emerald-400">
                    {projection.pctToGoal.toFixed(1)}%
                  </p>
                </div>
                <p className="text-xs text-gray-400 font-mono mb-1">
                  AED {projection.remainingAED.toLocaleString()} to goal · gross AED {grossAssetsAED.toLocaleString()} − liabilities AED {totalLiabilitiesAED.toLocaleString()}
                </p>
                {(() => {
                  const lowConf = liveWealthComponents.filter((c: any) => c.confidence === "low");
                  const lowConfAED = lowConf.reduce((s: number, c: any) => s + c.valueAED, 0);
                  if (lowConfAED === 0) return null;
                  return (
                    <p className="text-[11px] text-amber-400 font-mono mb-3">
                      ⚠ {((lowConfAED / grossAssetsAED) * 100).toFixed(0)}% of gross (AED {lowConfAED.toLocaleString()}) is from STALE Sep 2025 snapshots — verify Wio + ENBD balances
                    </p>
                  );
                })()}

                {/* Segmented progress bar */}
                <div className="relative h-7 bg-gray-900 rounded-lg overflow-hidden flex border border-gray-800">
                  {liveWealthComponents.map((c: any, i: number) => {
                    const segColors: Record<string, string> = {
                      emerald: "bg-emerald-500", amber: "bg-amber-400", sky: "bg-sky-400",
                      indigo: "bg-indigo-400", purple: "bg-purple-400", slate: "bg-slate-500",
                    };
                    const w = (c.valueAED / projection.goalAED) * 100;
                    return (
                      <div
                        key={i}
                        className={`${segColors[c.color] || "bg-gray-500"} h-full transition-all`}
                        style={{ width: `${w}%` }}
                        title={`${c.label}: AED ${c.valueAED.toLocaleString()} (${w.toFixed(1)}%)`}
                      />
                    );
                  })}
                  {totalLiabilitiesAED > 0 && (
                    <div
                      className="bg-red-900/70 h-full border-l border-red-700"
                      style={{ width: `${(totalLiabilitiesAED / projection.goalAED) * 100}%` }}
                      title={`Liabilities: AED ${totalLiabilitiesAED.toLocaleString()}`}
                    />
                  )}
                  <div className="bg-gray-800/40 h-full flex-1 border-l border-dashed border-gray-700" />
                  {/* 50% / 75% target markers */}
                  {[0.5, 0.75].map((m) => (
                    <div key={m} className="absolute top-0 bottom-0 border-l border-dashed border-gray-600 opacity-50"
                         style={{ left: `${m * 100}%` }} />
                  ))}
                </div>

                {/* Scenario ETA cards */}
                <div className="grid grid-cols-3 gap-2 mt-4">
                  {projection.scenarios.map((s) => {
                    const yrs = isFinite(s.months) ? (s.months / 12) : Infinity;
                    const accent = s.label === "Base case" ? "border-emerald-700 bg-emerald-950/30" : "border-gray-700 bg-gray-900/50";
                    return (
                      <div key={s.label} className={`rounded-lg p-3 border ${accent}`}>
                        <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">{s.label}</p>
                        <p className="text-sm font-mono text-gray-200 mt-1">
                          {isFinite(yrs) ? `${yrs.toFixed(1)} yrs` : "—"}
                        </p>
                        <p className="text-[10px] text-gray-500 font-mono">
                          {s.etaDate} · AED {(s.monthlySavingsAED / 1000).toFixed(0)}K/mo @ {s.cagrPct}%
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Momentum tiles */}
              <div className="grid grid-cols-2 gap-2 content-start">
                <div className="bg-gray-900/70 border border-gray-800 rounded-lg p-3">
                  <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Today</p>
                  <p className={`text-lg font-mono font-bold ${todayPnlUSD >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {todayPnlUSD >= 0 ? "+" : ""}${Math.abs(todayPnlUSD).toFixed(0)}
                  </p>
                  <p className="text-[10px] text-gray-600 font-mono">≈ AED {Math.round(todayPnlAED).toLocaleString()}</p>
                </div>
                <div className="bg-gray-900/70 border border-gray-800 rounded-lg p-3">
                  <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Unrealized</p>
                  <p className={`text-lg font-mono font-bold ${totalPnL >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {totalPnL >= 0 ? "+" : ""}${Math.abs(totalPnL).toFixed(0)}
                  </p>
                  <p className="text-[10px] text-gray-600 font-mono">{formatPercent(totalPnLPct)} on invested</p>
                </div>
                <div className="bg-gray-900/70 border border-gray-800 rounded-lg p-3">
                  <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Monthly inflow</p>
                  <p className="text-lg font-mono font-bold text-sky-400">
                    AED {Math.round(monthlyIncomeAED / 1000)}K
                  </p>
                  <p className="text-[10px] text-gray-600 font-mono">salary + consulting</p>
                </div>
                <div className="bg-gray-900/70 border border-gray-800 rounded-lg p-3">
                  <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Action items</p>
                  <p className="text-lg font-mono font-bold text-amber-400">
                    {urgentZones.length}
                  </p>
                  <p className="text-[10px] text-gray-600 font-mono">positions need a decision</p>
                </div>
              </div>
            </div>
          </div>

          {/* Stat Tiles */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1 flex items-center gap-1">
                Portfolio
                <span className={`text-xs font-normal normal-case tracking-normal ${hasLiveMirrors ? "text-emerald-500" : "text-amber-500"}`}>
                  {hasLiveMirrors ? "● live" : "⚠ partial"}
                </span>
              </p>
              <p className="text-xl font-mono font-bold">
                {formatCurrency(totalPortfolioValue)}
              </p>
              <p className="text-[10px] text-gray-600 mt-0.5 font-mono">
                direct {formatCurrency(directBookValue)} · mirrors {formatCurrency(mirrorsValue)} · cash {formatCurrency(cashIdle)}
              </p>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1 flex items-center gap-1">
                Invested
                <span className={`text-xs font-normal normal-case tracking-normal ${hasLiveMirrors ? "text-emerald-500" : "text-amber-500"}`}>
                  {hasLiveMirrors ? "● live" : "⚠ partial"}
                </span>
              </p>
              <p className="text-xl font-mono font-bold">
                {formatCurrency(investedValue)}
              </p>
              <p className="text-[10px] text-gray-600 mt-0.5 font-mono">
                direct {formatCurrency(directBookInvested)} · mirrors {formatCurrency(mirrorsInvested)}
              </p>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1 flex items-center gap-1">
                Cash Idle
                {isEtoroLive && (
                  <span className="text-emerald-500 text-xs font-normal normal-case tracking-normal">● live</span>
                )}
              </p>
              <p className="text-xl font-mono font-bold text-amber-400">
                {formatCurrency(cashIdle)}
              </p>
              {(etoroData?.pendingOrdersValue ?? 0) > 0 && (
                <p className="text-[10px] text-gray-600 mt-0.5 font-mono">
                  +{formatCurrency(etoroData!.pendingOrdersValue)} locked in pending orders
                </p>
              )}
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1 flex items-center gap-1">
                Total P/L
                <span className={`text-xs font-normal normal-case tracking-normal ${hasLiveMirrors ? "text-emerald-500" : "text-amber-500"}`}>
                  {hasLiveMirrors ? "● live" : "⚠ partial"}
                </span>
              </p>
              <p className={`text-xl font-mono font-bold ${totalPnL >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {formatCurrency(totalPnL)}
              </p>
              <p className="text-[10px] text-gray-600 mt-0.5 font-mono">
                {formatPercent(totalPnLPct)} · unrealized · all positions
              </p>
            </div>
          </div>
        </div>

        {/* Live Intelligence Feed */}
        <LiveNewsFeed />

        {/* Main Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Left Column */}
          <div className="lg:col-span-2 space-y-5">
            {/* Direct Book */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-4 pb-2 border-b border-gray-800">
                Direct Book
              </p>
              <div className="space-y-3">
                {enrichedPositions.map((pos) => (
                  <div
                    key={pos.symbol}
                    className="bg-gray-800/30 border border-gray-700 rounded-lg p-4 text-sm"
                  >
                    <div className="flex justify-between items-start mb-2">
                      <div>
                        <p className="font-bold text-gray-100">
                          {pos.symbol}
                        </p>
                        <p className="text-xs text-gray-400">{pos.label}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-mono text-gray-100">
                          {pos.quantity.toFixed(5)} × ${pos.avgCost.toFixed(2)}
                        </p>
                        <p className="text-xs text-gray-400">
                          cost ${pos.currentValue && pos.unrealizedPnl != null ? (pos.currentValue - pos.unrealizedPnl).toFixed(2) : (pos.quantity * pos.avgCost).toFixed(2)}
                        </p>
                      </div>
                    </div>

                    <div className="flex justify-between items-center">
                      <div>
                        <p className="font-mono">
                          Live: ${formatPrice(pos.livePrice)}
                        </p>
                        <p
                          className={`text-xs font-mono ${
                            pos.unrealizedPnl >= 0
                              ? "text-emerald-400"
                              : "text-red-400"
                          }`}
                        >
                          {formatCurrency(pos.unrealizedPnl)} (
                          {formatPercent(pos.unrealizedPnlPercent)})
                        </p>
                      </div>
                      <div className="text-right text-xs text-gray-400">
                        <p>SL: ${pos.stopLoss.toFixed(2)}</p>
                        <p>TP: ${pos.takeProfit.toFixed(2)}</p>
                        <p>TP2: ${pos.takeProfit2.toFixed(2)}</p>
                      </div>
                    </div>

                    {pos.notes && (
                      <p className="text-xs text-gray-500 mt-2 italic">
                        {pos.notes}
                      </p>
                    )}

                    {(pos as any).addZones && (
                      <div className="mt-3 pt-2 border-t border-gray-700/50">
                        <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">Add Zones</p>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
                          {(pos as any).addZones.uptrendAdd && (
                            <div className="col-span-2 flex justify-between items-center py-0.5">
                              <span className="text-emerald-400 font-semibold">↑ Uptrend Add</span>
                              <span className="font-mono text-emerald-300">
                                above ${(pos as any).addZones.uptrendAdd.price.toFixed(2)}
                                <span className="text-gray-500 ml-1 font-normal">— {(pos as any).addZones.uptrendAdd.note}</span>
                              </span>
                            </div>
                          )}
                          {(pos as any).addZones.dipLight && (
                            <div className="col-span-2 flex justify-between items-center py-0.5">
                              <span className="text-amber-400 font-semibold">↓ Dip (light)</span>
                              <span className="font-mono text-amber-300">
                                ${(pos as any).addZones.dipLight.min}–${(pos as any).addZones.dipLight.max}
                                <span className="text-gray-500 ml-1 font-normal">— {(pos as any).addZones.dipLight.note}</span>
                              </span>
                            </div>
                          )}
                          {(pos as any).addZones.dipMedium && (
                            <div className="col-span-2 flex justify-between items-center py-0.5">
                              <span className="text-amber-400 font-semibold">↓ Dip (medium)</span>
                              <span className="font-mono text-amber-300">
                                ${(pos as any).addZones.dipMedium.min}–${(pos as any).addZones.dipMedium.max}
                                <span className="text-gray-500 ml-1 font-normal">— {(pos as any).addZones.dipMedium.note}</span>
                              </span>
                            </div>
                          )}
                          {(pos as any).addZones.dipConviction && (
                            <div className="col-span-2 flex justify-between items-center py-0.5">
                              <span className="text-sky-400 font-semibold">↓ Dip (conviction)</span>
                              <span className="font-mono text-sky-300">
                                ${(pos as any).addZones.dipConviction.min}–${(pos as any).addZones.dipConviction.max}
                                <span className="text-gray-500 ml-1 font-normal">— {(pos as any).addZones.dipConviction.note}</span>
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Copy Portfolio */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-4 pb-2 border-b border-gray-800">
                Copy Portfolio
              </p>
              <div className="bg-gray-800/30 border border-gray-700 rounded-lg p-4 text-sm">
                <div className="flex justify-between items-center mb-2">
                  <p className="font-bold text-gray-100">{data.copyPortfolio.trader}</p>
                  {data.copyPortfolio.currentValue && (
                    <div className="text-right">
                      <p className="font-mono text-gray-100">{formatCurrency(data.copyPortfolio.currentValue)}</p>
                      <p className={`text-xs font-mono ${(data.copyPortfolio.currentPnl ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {formatCurrency(data.copyPortfolio.currentPnl ?? 0)} ({formatPercent(data.copyPortfolio.currentPnlPct ?? 0)})
                      </p>
                    </div>
                  )}
                </div>
                <div className="space-y-1 text-xs text-gray-400">
                  {data.copyPortfolio.positions.map((pos) => {
                    const mkt = getMarketData(pos.symbol, marketData);
                    return (
                      <p key={pos.symbol} className="font-mono">
                        {pos.label}: ${formatPrice(mkt.price)}{" "}
                        <span
                          className={
                            mkt.changePercent >= 0
                              ? "text-emerald-400"
                              : "text-red-400"
                          }
                        >
                          ({formatPercent(mkt.changePercent)})
                        </span>
                      </p>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Mirrors (Smart Portfolios + Copy traders) */}
            {(hasLiveMirrors || (data.smartPortfolios && data.smartPortfolios.length > 0)) && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                <div className="flex items-center gap-2 mb-4 pb-2 border-b border-gray-800">
                  <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">
                    Smart Portfolios &amp; Copy Traders
                  </p>
                  <span className={`text-xs ${hasLiveMirrors ? "text-emerald-500" : "text-amber-500"}`}>
                    {hasLiveMirrors ? "● live from eToro" : "⚠ snapshot — eToro mirrors unreachable"}
                  </span>
                </div>
                <div className="space-y-2">
                  {hasLiveMirrors ? (
                    etoroData!.mirrors.map((m) => (
                      <div key={m.parentUsername} className="flex justify-between items-center border-b border-gray-800/50 pb-2 last:border-0 text-sm">
                        <div>
                          <p className="font-bold text-gray-100">{m.parentUsername}</p>
                          <p className="text-xs text-gray-500 font-mono">invested {formatCurrency(m.amountInvested)}</p>
                        </div>
                        <div className="text-right">
                          <p className="font-mono text-gray-100">{formatCurrency(m.currentValue)}</p>
                          <p className={`text-xs font-mono ${m.netProfit >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                            {formatCurrency(m.netProfit)} ({formatPercent(m.netProfitPct)})
                          </p>
                        </div>
                      </div>
                    ))
                  ) : (
                    (data.smartPortfolios as SmartPortfolio[]).map((sp) => (
                      <div key={sp.name} className="flex justify-between items-center border-b border-gray-800/50 pb-2 last:border-0 text-sm">
                        <div>
                          <p className="font-bold text-gray-100">{sp.name}</p>
                          <p className="text-xs text-gray-400">{sp.label}</p>
                        </div>
                        <div className="text-right">
                          <p className="font-mono text-gray-100">{formatCurrency(sp.currentValue)}</p>
                          <p className={`text-xs font-mono ${sp.currentPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                            {formatCurrency(sp.currentPnl)} ({formatPercent(sp.currentPnlPct)})
                          </p>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {/* Recently Closed */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-4 pb-2 border-b border-gray-800">
                Recently Closed
              </p>
              <div className="space-y-2 text-sm">
                {data.closedPositions.map((pos, idx) => (
                  <div
                    key={idx}
                    className="flex justify-between items-center border-b border-gray-800 pb-2 last:border-0"
                  >
                    <div>
                      <p className="font-bold text-gray-100">{pos.symbol}</p>
                      <p className="text-xs text-gray-400">{pos.closeDate}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-mono">@ ${pos.closePrice.toFixed(2)}</p>
                      <p
                        className={`text-xs font-mono ${
                          pos.pnl >= 0
                            ? "text-emerald-400"
                            : "text-red-400"
                        }`}
                      >
                        {formatCurrency(pos.pnl)}
                        {pos.pnlPct && ` (${formatPercent(pos.pnlPct)})`}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Market Context */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-4 pb-2 border-b border-gray-800">
                Market Context
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-3">
                {marketTiles.map((mkt) => {
                  const labels: Record<string, string> = {
                    "^GSPC": "S&P 500",
                    "^IXIC": "Nasdaq",
                    "GC=F": "Gold",
                    "BZ=F": "Brent Crude",
                    "BTC-USD": "BTC",
                    "ETH-USD": "ETH",
                    "^VIX": "VIX Fear",
                  };
                  const isVix = mkt.symbol === "^VIX";
                  // VIX coloring: <15 green (complacent), 15-20 gray, 20-30 amber, >30 red
                  const vixColor = isVix
                    ? mkt.price >= 30 ? "text-red-400"
                    : mkt.price >= 20 ? "text-amber-400"
                    : mkt.price >= 15 ? "text-gray-300"
                    : "text-emerald-400"
                    : mkt.changePercent >= 0 ? "text-emerald-400" : "text-red-400";
                  const vixLabel = isVix
                    ? mkt.price >= 30 ? "FEAR"
                    : mkt.price >= 20 ? "ELEVATED"
                    : mkt.price >= 15 ? "NORMAL"
                    : "COMPLACENT"
                    : null;
                  return (
                    <div
                      key={mkt.symbol}
                      className={`bg-gray-800/30 border rounded-lg p-3 ${
                        isVix && mkt.price >= 30 ? "border-red-800" :
                        isVix && mkt.price >= 20 ? "border-amber-800" :
                        "border-gray-700"
                      }`}
                    >
                      <p className="text-xs font-bold text-gray-400 mb-1">
                        {labels[mkt.symbol] || mkt.symbol}
                      </p>
                      <p className="font-mono font-bold text-gray-100">
                        {mkt.price > 0
                          ? isVix
                            ? mkt.price.toFixed(1)
                            : mkt.price > 100
                              ? mkt.price.toFixed(0)
                              : mkt.price.toFixed(4)
                          : "—"}
                      </p>
                      <p className={`text-xs font-mono ${vixColor}`}>
                        {mkt.price > 0
                          ? isVix
                            ? vixLabel
                            : formatPercent(mkt.changePercent)
                          : "—"}
                      </p>
                    </div>
                  );
                })}
              </div>

              {/* Crypto Fear & Greed Index */}
              {fearGreed && (
                <div className={`flex items-center justify-between rounded-lg p-3 border ${
                  Number(fearGreed.value) >= 75 ? "bg-red-950/20 border-red-800" :
                  Number(fearGreed.value) >= 55 ? "bg-emerald-950/20 border-emerald-800" :
                  Number(fearGreed.value) >= 45 ? "bg-gray-800/40 border-gray-700" :
                  Number(fearGreed.value) >= 25 ? "bg-amber-950/20 border-amber-800" :
                  "bg-red-950/30 border-red-700"
                }`}>
                  <div>
                    <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">Crypto Fear & Greed</p>
                    <p className="text-xs text-gray-500 mt-0.5">alternative.me · updates daily</p>
                  </div>
                  <div className="text-right">
                    <p className={`text-2xl font-mono font-bold ${
                      Number(fearGreed.value) >= 75 ? "text-red-400" :
                      Number(fearGreed.value) >= 55 ? "text-emerald-400" :
                      Number(fearGreed.value) >= 45 ? "text-gray-300" :
                      Number(fearGreed.value) >= 25 ? "text-amber-400" :
                      "text-red-500"
                    }`}>{fearGreed.value}</p>
                    <p className={`text-xs font-semibold ${
                      Number(fearGreed.value) >= 75 ? "text-red-400" :
                      Number(fearGreed.value) >= 55 ? "text-emerald-400" :
                      Number(fearGreed.value) >= 45 ? "text-gray-400" :
                      Number(fearGreed.value) >= 25 ? "text-amber-400" :
                      "text-red-500"
                    }`}>{fearGreed.value_classification}</p>
                  </div>
                </div>
              )}
            </div>

          </div>

          {/* Right Column */}
          <div className="lg:col-span-1 space-y-5">
            {/* Strategist Note + Action Items */}
            <StrategistPanel
              initialNote={data.strategistNote}
              initialActionItems={data.actionItems}
              portfolioSnapshot={portfolioSnapshot}
            />

            {/* Wealth Progress */}
            {data.wealthProgress && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                <p className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-4 pb-2 border-b border-gray-800">
                  AED 1M Progress
                </p>
                {(() => {
                  const wp = data.wealthProgress!;
                  // Override eToro / PINS-RSU / SNAP-RSU with live mark-to-market when available
                  const liveComponents = wp.components.map((c: any) => {
                    if (c.label === "eToro Portfolio" && isEtoroLive && etoroPortfolioAED > 0)
                      return { ...c, valueAED: etoroPortfolioAED, note: `$${totalPortfolioValue.toFixed(0)} × ${usdToAed} — live now` };
                    if (c.label?.startsWith("PINS RSU") && pinsRsuAED > 0)
                      return { ...c, valueAED: pinsRsuAED, note: `1,429 sh × $${pinsLivePrice.toFixed(2)} × ${usdToAed} — live (cost $46,650)` };
                    if (c.label?.startsWith("SNAP RSU") && snapRsuAED > 0)
                      return { ...c, valueAED: snapRsuAED, note: `1,798 sh × $${snapLivePrice.toFixed(2)} × ${usdToAed} — live (cost $12,340)` };
                    return c;
                  });
                  const grossAssets = liveComponents.reduce((s: number, c: any) => s + c.valueAED, 0);
                  const totalLiabilities = (wp.liabilities ?? []).reduce((s: number, l: any) => s + l.balanceAED, 0);
                  const netWorth = grossAssets - totalLiabilities;
                  const pct = Math.min((netWorth / wp.goalAED) * 100, 100);
                  const grossPct = Math.min((grossAssets / wp.goalAED) * 100, 100);
                  const segColors: Record<string, string> = {
                    emerald: "bg-emerald-500",
                    amber: "bg-amber-400",
                    sky: "bg-sky-400",
                    indigo: "bg-indigo-400",
                    purple: "bg-purple-400",
                    slate: "bg-slate-500",
                  };
                  return (
                    <div>
                      {/* Net wealth headline */}
                      <div className="flex justify-between items-baseline mb-1">
                        <div>
                          <p className="text-2xl font-mono font-bold text-white">
                            AED {netWorth.toLocaleString()}
                          </p>
                          <p className="text-[10px] text-gray-600 mt-0.5">
                            gross {grossAssets.toLocaleString()} − liabilities {totalLiabilities.toLocaleString()}
                          </p>
                        </div>
                        <p className="text-sm text-gray-400">/ AED 1,000,000</p>
                      </div>

                      {/* Stacked bar — gross assets (liabilities visually reduce at end) */}
                      <div className="h-4 bg-gray-800 rounded-full overflow-hidden flex mb-1 mt-3">
                        {liveComponents.map((c: any, i: number) => (
                          <div
                            key={i}
                            className={`${segColors[c.color] || "bg-gray-500"} h-full transition-all`}
                            style={{ width: `${(c.valueAED / wp.goalAED) * 100}%` }}
                            title={`${c.label}: AED ${c.valueAED.toLocaleString()}`}
                          />
                        ))}
                        {/* Liabilities shown as a red notch cutting into the bar */}
                        {totalLiabilities > 0 && (
                          <div
                            className="bg-red-900/70 h-full border-l border-red-700"
                            style={{ width: `${(totalLiabilities / wp.goalAED) * 100}%` }}
                            title={`Liabilities: AED ${totalLiabilities.toLocaleString()}`}
                          />
                        )}
                        {/* Remaining gap */}
                        <div className="bg-gray-700/40 h-full flex-1 border-l border-dashed border-gray-600" />
                      </div>

                      {/* Percentage */}
                      <p className="text-right text-xs text-gray-400 mb-4 font-mono">
                        <span className="text-lg font-bold text-white">{pct.toFixed(1)}%</span> net toward goal
                        <span className="text-gray-600 ml-2">({grossPct.toFixed(1)}% gross)</span>
                      </p>

                      {/* Asset breakdown */}
                      <div className="space-y-2 text-xs">
                        <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Assets</p>
                        {liveComponents.map((c: any, i: number) => (
                          <div key={i} className="flex justify-between items-center">
                            <div className="flex items-center gap-2">
                              <div className={`w-2.5 h-2.5 rounded-sm ${segColors[c.color] || "bg-gray-500"}`} />
                              <div>
                                <p className="text-gray-300 font-semibold">{c.label}</p>
                                <p className="text-gray-600">{c.note}</p>
                              </div>
                            </div>
                            <div className="text-right">
                              <p className="font-mono text-gray-200">AED {c.valueAED.toLocaleString()}</p>
                              <p className={`font-mono text-xs ${c.confidence === "high" ? "text-emerald-500" : c.confidence === "medium" ? "text-amber-500" : "text-gray-600"}`}>
                                {c.confidence} confidence
                              </p>
                            </div>
                          </div>
                        ))}

                        {/* Liabilities */}
                        {wp.liabilities && wp.liabilities.length > 0 && (
                          <div className="mt-3 pt-2 border-t border-gray-800">
                            <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Liabilities</p>
                            {wp.liabilities.map((l: any, i: number) => (
                              <div key={i} className="flex justify-between items-center mb-1.5">
                                <div className="flex items-center gap-2">
                                  <div className="w-2.5 h-2.5 rounded-sm bg-red-900" />
                                  <div>
                                    <p className="text-gray-400 font-semibold">{l.label}</p>
                                    <p className="text-gray-700">{l.note}</p>
                                  </div>
                                </div>
                                <p className="font-mono text-red-400 text-xs">− AED {l.balanceAED.toLocaleString()}</p>
                              </div>
                            ))}
                            <div className="flex justify-between items-center mt-1 pt-1 border-t border-gray-800/60">
                              <p className="text-gray-500 text-xs">Total liabilities</p>
                              <p className="font-mono text-red-500 text-xs font-bold">− AED {totalLiabilities.toLocaleString()}</p>
                            </div>
                          </div>
                        )}

                        {/* Income sources */}
                        {wp.incomeSources && wp.incomeSources.length > 0 && (
                          <div className="mt-3 pt-2 border-t border-gray-800">
                            <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Active Income</p>
                            {wp.incomeSources.map((s: any, i: number) => (
                              <div key={i} className="flex justify-between items-center mb-1">
                                <div>
                                  <p className="text-gray-400 font-semibold">{s.label}</p>
                                  <p className="text-gray-700">{s.note}</p>
                                </div>
                                <p className="font-mono text-emerald-600 text-xs">+AED {s.monthlyAED.toLocaleString()}/mo</p>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Untracked */}
                        {wp.untracked && wp.untracked.length > 0 && (
                          <div className="mt-3 pt-2 border-t border-gray-800">
                            <p className="text-gray-600 mb-1">⬜ Not yet tracked / estimated:</p>
                            {wp.untracked.map((u: string, i: number) => (
                              <p key={i} className="text-gray-700 ml-2">· {u}</p>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Action Zones (merged with Technical Signals) — ranked by urgency */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <div className="flex items-center justify-between mb-4 pb-2 border-b border-gray-800">
                <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">
                  Action Zones · Technicals
                </p>
                <p className="text-[10px] text-gray-600 font-mono">
                  {urgentZones.length} of {actionZones.length} need attention
                </p>
              </div>
              <div className="space-y-2">
                {actionZones.length === 0 ? (
                  <p className="text-xs text-gray-400 italic">No positions to evaluate</p>
                ) : (
                  actionZones.map((z) => {
                    const colorMap: Record<string, string> = {
                      red:     "bg-red-950/40 border-red-800 text-red-200",
                      emerald: "bg-emerald-950/30 border-emerald-800 text-emerald-200",
                      sky:     "bg-sky-950/30 border-sky-800 text-sky-200",
                      amber:   "bg-amber-950/30 border-amber-800 text-amber-200",
                      gray:    "bg-gray-800/30 border-gray-700 text-gray-400",
                    };
                    const ctaColor: Record<string, string> = {
                      red:     "bg-red-900 text-red-100",
                      emerald: "bg-emerald-900 text-emerald-100",
                      sky:     "bg-sky-900 text-sky-100",
                      amber:   "bg-amber-900 text-amber-100",
                      gray:    "bg-gray-700 text-gray-300",
                    };
                    // Pull merged tech-signal data for this position
                    const pos = enrichedPositions.find((p) => p.symbol === z.symbol);
                    const trend = pos ? calculateTrend(pos.livePrice, pos.sma50, pos.sma200) : "unknown";
                    const rsiZone = pos ? getRSIZone(pos.rsi14) : "unknown";
                    const { signal } = pos ? getSignal(trend, rsiZone) : { signal: "wait" };
                    const rsi = pos?.rsi14;
                    const rsiTone = rsi == null ? "bg-gray-800 text-gray-500"
                                  : rsi >= 75 ? "bg-red-950/50 text-red-300 border border-red-800"
                                  : rsi >= 65 ? "bg-amber-950/40 text-amber-300 border border-amber-800"
                                  : rsi <= 30 ? "bg-emerald-950/40 text-emerald-300 border border-emerald-800"
                                  : "bg-gray-800 text-gray-400 border border-gray-700";
                    const trendTone = trend === "uptrend" ? "bg-emerald-950/40 text-emerald-300 border border-emerald-800"
                                    : trend === "downtrend" ? "bg-red-950/40 text-red-300 border border-red-800"
                                    : "bg-gray-800 text-gray-400 border border-gray-700";
                    const sigTone = signal === "buy" ? "bg-emerald-900 text-emerald-100"
                                  : signal === "sell" ? "bg-red-900 text-red-100"
                                  : signal === "hold" ? "bg-amber-900 text-amber-100"
                                  : "bg-gray-800 text-gray-400";
                    return (
                      <div key={z.symbol} className={`rounded-lg p-3 text-xs border ${colorMap[z.color]}`}>
                        <div className="flex items-start justify-between gap-2 mb-1.5">
                          <div className="flex items-center gap-2">
                            <span className="font-bold font-mono">{z.symbol}</span>
                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${ctaColor[z.color]}`}>
                              {z.cta}
                            </span>
                          </div>
                          <span className={`text-[10px] font-mono ${z.pnlPercent >= 0 ? "text-emerald-300" : "text-red-300"}`}>
                            {formatPercent(z.pnlPercent)}
                          </span>
                        </div>

                        {/* Tech chip row */}
                        <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
                          <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${rsiTone}`}>
                            RSI {rsi == null ? "—" : rsi.toFixed(0)}
                          </span>
                          <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded uppercase tracking-wider ${trendTone}`}>
                            {trend}
                          </span>
                          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider ${sigTone}`}>
                            tech: {signal}
                          </span>
                        </div>

                        <p className="text-[11px] leading-snug opacity-90">{z.rationale}</p>
                        <p className="text-[10px] font-mono opacity-60 mt-1">live ${z.livePrice >= 100 ? z.livePrice.toFixed(0) : z.livePrice.toFixed(2)} · urgency {z.urgency}</p>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Upcoming Catalysts */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <div className="flex items-center justify-between mb-4 pb-2 border-b border-gray-800">
                <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">
                  Upcoming Catalysts
                </p>
                {upcomingEvents.length > 8 && (
                  <p className="text-xs text-gray-600">{upcomingEvents.length} total</p>
                )}
              </div>
              <div className="space-y-2 text-xs">
                {upcomingEvents.length === 0 ? (
                  <p className="text-gray-600 italic">No upcoming events queued — update manual-input.json to add catalysts.</p>
                ) : (
                  upcomingEvents.slice(0, 8).map((evt: any, idx: number) => (
                    <div
                      key={idx}
                      className={`border-b border-gray-800 pb-2 last:border-0 ${
                        evt.priority === "critical" ? "border-l-2 border-l-red-700 pl-2" :
                        evt.priority === "high" ? "border-l-2 border-l-amber-700 pl-2" : ""
                      }`}
                    >
                      <p className="text-gray-300 font-semibold leading-snug">{evt.label}</p>
                      <p className="text-gray-500 mt-0.5">
                        {evt.date} · {evt.symbol} · {evt.type}
                      </p>
                    </div>
                  ))
                )}
                {upcomingEvents.length > 8 && (
                  <p className="text-gray-600 text-xs pt-1 border-t border-gray-800">
                    +{upcomingEvents.length - 8} more events through Aug 2026
                  </p>
                )}
              </div>
            </div>

            {/* War & Deployment */}
            {(() => {
              const warAge = daysOld((data.warStatus as any).lastUpdated);
              const warStale = warAge !== null && warAge > 1;
              return (
                <div className={`border rounded-xl p-5 ${warStale ? "bg-red-950/20 border-red-900/60" : "bg-gray-900 border-gray-800"}`}>
                  <div className="flex items-center justify-between mb-4 pb-2 border-b border-gray-800">
                    <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">
                      War &amp; Deployment
                    </p>
                    <StaleBadge dateStr={(data.warStatus as any).lastUpdated} freshDays={1} staleDays={3} />
                  </div>
                  {warStale && (
                    <p className="text-[11px] text-red-300 mb-3 leading-snug">
                      ⚠ This section is manual and {warAge} days old. Geopolitics moves daily — do NOT make 115K-AED-deployment decisions on this without re-reading current Hormuz news. Hit ⚡ Live Analysis above to refresh, or update <code className="font-mono text-[10px] bg-gray-800 px-1 rounded">manual-input.json &gt; warStatus</code>.
                    </p>
                  )}
                  <div className="text-xs">
                    <p className="font-bold text-gray-100 mb-2">
                      {data.warStatus.status}
                    </p>
                    <p className="text-gray-400 mb-3">
                      {data.warStatus.description}
                    </p>
                <div className="space-y-1 mb-3">
                  {data.warStatus.triggers.map((trigger, idx) => (
                    <div key={idx} className="flex items-start gap-2">
                      <span
                        className={`mt-0.5 ${
                          trigger.state === "met"
                            ? "text-emerald-400"
                            : "text-red-400"
                        }`}
                      >
                        {trigger.state === "met" ? "✓" : "○"}
                      </span>
                      <div>
                        <p className="text-gray-300">{trigger.label}</p>
                        <p className="text-gray-500 text-xs">
                          {trigger.detail}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
                {data.warStatus.deploymentLocked && (
                  <p className="text-amber-400 text-xs font-semibold">
                    Deployment Locked: {formatCurrency(data.warStatus.deploymentAmountAED)} AED
                  </p>
                )}
              </div>
                </div>
              );
            })()}

          </div>

          {/* Bull Run Watchlist — full width */}
          {data.bullRunWatchlist && data.bullRunWatchlist.length > 0 && (
            <div className="lg:col-span-3 bg-gray-900 border border-gray-800 rounded-xl p-5">
              <div className="flex items-center justify-between mb-4 pb-2 border-b border-gray-800">
                <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">
                  Bull Run Watchlist — Next Entries
                </p>
                <StaleBadge dateStr={(data as any).bullRunWatchlistUpdatedAt} freshDays={3} staleDays={14} label="reviewed" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {data.bullRunWatchlist!.map((pick, idx) => {
                  const mkt = getMarketData(pick.symbol, marketData);
                  const hasPrice = mkt.price > 0;
                  const inZone = hasPrice && pick.entryZone && mkt.price >= pick.entryZone.min && mkt.price <= pick.entryZone.max;
                  const aboveEntry = hasPrice && pick.entryZone && mkt.price > pick.entryZone.max;
                  const signalColors: Record<string, string> = {
                    strong_buy: "bg-emerald-500/20 border-emerald-500 text-emerald-300",
                    buy: "bg-sky-500/20 border-sky-500 text-sky-300",
                    watch: "bg-amber-500/20 border-amber-500 text-amber-300",
                  };
                  const signalLabel: Record<string, string> = {
                    strong_buy: "STRONG BUY",
                    buy: "BUY",
                    watch: "WATCH",
                  };
                  const typeColors: Record<string, string> = {
                    stock: "text-purple-400",
                    etf: "text-sky-400",
                    crypto: "text-amber-400",
                    commodity: "text-orange-400",
                  };
                  const convictionBars = Array.from({ length: 10 }, (_, i) => i < pick.conviction);
                  return (
                    <div key={idx} className="bg-gray-800/50 border border-gray-700 rounded-lg p-4">
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <p className="font-mono font-bold text-white text-base">{pick.symbol}</p>
                          <p className="text-xs text-gray-400">{pick.label}</p>
                          {hasPrice && (
                            <p className={`text-xs font-mono mt-0.5 ${mkt.changePercent >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                              ${mkt.price > 100 ? mkt.price.toFixed(2) : mkt.price.toFixed(3)} ({formatPercent(mkt.changePercent)})
                            </p>
                          )}
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          <span className={`text-xs font-bold px-2 py-0.5 rounded border ${signalColors[pick.signal] || "bg-gray-700 border-gray-600 text-gray-400"}`}>
                            {signalLabel[pick.signal] || pick.signal}
                          </span>
                          <span className={`text-xs font-semibold ${typeColors[pick.type] || "text-gray-500"}`}>
                            {pick.type?.toUpperCase()}
                          </span>
                          {hasPrice && (
                            <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                              inZone ? "bg-emerald-900/50 text-emerald-300 border border-emerald-700" :
                              aboveEntry ? "bg-amber-900/50 text-amber-300 border border-amber-700" :
                              "bg-gray-800 text-gray-500 border border-gray-700"
                            }`}>
                              {inZone ? "🎯 IN ZONE" : aboveEntry ? "↑ ABOVE ENTRY" : "⏳ WAITING"}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Conviction bars */}
                      <div className="flex items-center gap-1 mb-2">
                        <span className="text-xs text-gray-600 mr-1">Conviction</span>
                        {convictionBars.map((filled: boolean, i: number) => (
                          <div key={i} className={`h-1.5 w-4 rounded-sm ${filled ? "bg-emerald-400" : "bg-gray-700"}`} />
                        ))}
                        <span className="text-xs text-gray-500 ml-1">{pick.conviction}/10</span>
                      </div>

                      {/* Thesis */}
                      {pick.thesis && (
                        <p className="text-xs text-gray-400 leading-relaxed mb-2">{pick.thesis}</p>
                      )}

                      {/* Catalysts */}
                      {pick.catalysts && pick.catalysts.length > 0 && (
                        <div className="flex flex-wrap gap-1 mb-2">
                          {pick.catalysts.map((cat: string, ci: number) => (
                            <span key={ci} className="text-xs bg-gray-700/60 text-gray-400 px-1.5 py-0.5 rounded">
                              {cat}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Entry zone */}
                      {pick.entryZone && (
                        <p className="text-xs font-mono">
                          <span className="text-gray-600">Entry: </span>
                          <span className="text-emerald-400">${pick.entryZone.min}–${pick.entryZone.max}</span>
                          {pick.stopLoss && <span className="text-gray-600"> · SL: <span className="text-red-400">${pick.stopLoss}</span></span>}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="mt-12 text-center text-xs text-gray-500 border-t border-gray-800 pt-5">
        <p>
          C&G Brief · {data.strategistNote.edition || "Edition"} · Generated{" "}
          {dateStr} {timeStr} Dubai · Market data refreshes every 15 min · hit Refresh for live prices
        </p>
      </div>
    </div>
  );
}
