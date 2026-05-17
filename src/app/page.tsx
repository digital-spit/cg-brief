import { fetchMarketData, calculateTrend, getRSIZone, getSignal } from "@/lib/market";
import { fetchEtoroPortfolio } from "@/lib/etoro";
import {
  classifyActionZone, buildProjection, computeTodayPnlUSD,
  computePerformance, computeAllocation, applyStressScenario,
  computeCashflow, inflationAdjustedGoal, reconcilePositions,
  buildCashDeploymentPlan, analyzeRsu,
} from "@/lib/wealth";
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
import InteractiveChecklist from "./components/InteractiveChecklist";

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

interface LiveWarPulse {
  status: string;
  statusKey: string;
  description: string;
  triggers: Array<{ label: string; state: string; detail: string }>;
  deploymentLocked: boolean;
  deploymentAmountAED: number;
  lastUpdated: string;
  source: "live-ai" | "live-rule" | "fallback";
  oilSpotUSD?: number;
  oilDailyChangePct?: number;
  headlinesUsed: Array<{ title: string; publisher: string; ageMinutes: number; link: string }>;
}

async function fetchWarPulse(origin: string | null): Promise<LiveWarPulse | null> {
  if (!origin) return null;
  try {
    const res = await fetch(`${origin}/api/war-pulse`, { next: { revalidate: 1800 } } as RequestInit);
    if (!res.ok) return null;
    return (await res.json()) as LiveWarPulse;
  } catch {
    return null;
  }
}

async function getDashboardData(origin: string | null) {
  const data = manualInput as unknown as ManualInput;
  const [marketData, etoroData, fearGreed, warPulse] = await Promise.all([
    fetchMarketData(data.marketSymbols),
    fetchEtoroPortfolio(),
    fetchFearGreed(),
    fetchWarPulse(origin),
  ]);
  return { data, marketData, etoroData, fearGreed, warPulse };
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

// Top-of-page banner that aggregates every staleness signal so you can't miss it.
// Rendered ABOVE the header; hidden entirely when everything is fresh.
function StaleDataBanner({
  lastUpdated,
  warLastUpdated,
  etoroConnected,
  etoroSnapshotDate,
  etoroStatementPeriod,
}: {
  lastUpdated?: string;
  warLastUpdated?: string;
  etoroConnected: boolean;
  etoroSnapshotDate?: string;
  etoroStatementPeriod?: string;
}) {
  const issues: Array<{ severity: "red" | "amber"; text: string }> = [];

  const manualAge = daysOld(lastUpdated);
  if (manualAge !== null) {
    if (manualAge > 3) issues.push({ severity: "red", text: `Manual data is ${manualAge} days old (last edit: ${lastUpdated}). Trading decisions on this snapshot are unsafe.` });
    else if (manualAge > 1) issues.push({ severity: "amber", text: `Manual data is ${manualAge} days old. Verify equity + strategist note before acting.` });
  } else if (lastUpdated) {
    issues.push({ severity: "amber", text: `Could not parse lastUpdated: "${lastUpdated}".` });
  }

  if (!etoroConnected) {
    issues.push({ severity: "red", text: "eToro API is disconnected (401 / no keys). Live equity, cash, mirrors, and positions all fall back to manual snapshots." });
  } else {
    const snapAge = daysOld(etoroSnapshotDate);
    if (snapAge !== null && snapAge > 7) {
      issues.push({ severity: "amber", text: `eToro snapshot ${etoroSnapshotDate} is ${snapAge} days old — pull fresh statement.` });
    }
  }

  const warAge = daysOld(warLastUpdated);
  if (warAge !== null && warAge > 5) {
    issues.push({ severity: "amber", text: `War status not reviewed in ${warAge} days. Hormuz + oil context may have shifted.` });
  }

  if (issues.length === 0) return null;

  const hasRed = issues.some((i) => i.severity === "red");
  const wrapperClass = hasRed
    ? "border-red-700 bg-red-950/40"
    : "border-amber-700 bg-amber-950/30";
  const headerColor = hasRed ? "text-red-300" : "text-amber-300";
  const headerLabel = hasRed ? "⚠ STALE DATA — DO NOT TRADE ON THIS DASHBOARD UNTIL REVIEWED" : "⚠ Data is borderline stale";

  return (
    <div className={`mb-5 border ${wrapperClass} rounded-2xl p-4`}>
      <p className={`text-xs font-bold ${headerColor} uppercase tracking-widest mb-2`}>
        {headerLabel}
      </p>
      <ul className="space-y-1">
        {issues.map((i, idx) => (
          <li key={idx} className={`text-sm font-mono ${i.severity === "red" ? "text-red-200" : "text-amber-200"}`}>
            <span className={`inline-block w-1.5 h-1.5 rounded-full mr-2 align-middle ${i.severity === "red" ? "bg-red-500 animate-pulse" : "bg-amber-500"}`} />
            {i.text}
          </li>
        ))}
      </ul>
      {etoroStatementPeriod && !etoroConnected && (
        <p className="text-[10px] text-gray-500 font-mono mt-2">
          eToro statement period on file: {etoroStatementPeriod}
        </p>
      )}
    </div>
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
  // Build absolute origin for server-side fetch to our own API route
  const origin = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}`
              : process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const { data, marketData, etoroData, fearGreed, warPulse } = await getDashboardData(origin);

  // Use live war pulse when available; otherwise fall back to manual-input.json warStatus
  const liveWar: { status: string; description: string; triggers: any[]; deploymentLocked: boolean; deploymentAmountAED: number; lastUpdated?: string; source?: string; oilSpotUSD?: number; oilDailyChangePct?: number; headlines?: LiveWarPulse["headlinesUsed"] } =
    warPulse
      ? {
          status: warPulse.status,
          description: warPulse.description,
          triggers: warPulse.triggers,
          deploymentLocked: warPulse.deploymentLocked,
          deploymentAmountAED: warPulse.deploymentAmountAED,
          lastUpdated: warPulse.lastUpdated,
          source: warPulse.source,
          oilSpotUSD: warPulse.oilSpotUSD,
          oilDailyChangePct: warPulse.oilDailyChangePct,
          headlines: warPulse.headlinesUsed,
        }
      : {
          status: data.warStatus.status,
          description: data.warStatus.description,
          triggers: data.warStatus.triggers as any[],
          deploymentLocked: data.warStatus.deploymentLocked,
          deploymentAmountAED: data.warStatus.deploymentAmountAED,
          lastUpdated: (data.warStatus as any).lastUpdated,
          source: "fallback",
        };

  // Live cash from eToro API (credit minus pending orders), falls back to manual-input.json
  const cashIdle = etoroData?.cashAvailable ?? data.equity.cashIdle;
  const isEtoroLive = etoroData !== null;
  const hasLiveMirrors = isEtoroLive && (etoroData?.mirrors.length ?? 0) > 0;

  // RECONCILE: eToro live = source of truth for which positions exist + qty + avgCost.
  // manual-input.json positions[] = metadata only (SL/TP/notes/addZones).
  // Anything in manual but not in eToro live = stale (likely closed); flagged via banner.
  // Anything in eToro live but not in manual = unmapped (no SL/TP); flagged via banner.
  const reconciliation = reconcilePositions(
    data.positions as any,
    etoroData?.aggregated,
    marketData
  );
  const enrichedPositions = reconciliation.livePositions;

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

  // ─── Cash Drag — revenue left on the table at 0% across idle accounts ───
  const cashDragCfg = (wp as any)?.cashDragConfig as { targetMmfRatePct?: number } | undefined;
  const targetRatePct = cashDragCfg?.targetMmfRatePct ?? 4.5;
  const cashDragAccounts = ((wp as any)?.cashDragAccounts ?? []) as Array<{
    label: string; currency: "USD" | "EUR" | "AED"; balance: number; currentRatePct: number; asOf: string;
  }>;
  // FX → AED conversion. Use static rates that match the dashboard's stated assumptions.
  const fxToAed: Record<string, number> = { AED: 1, USD: usdToAed, EUR: 4.13 };
  // Per-currency suggested target vehicle when an account is idle at <target rate
  const suggestedVenue: Record<string, { name: string; ratePct: number }> = {
    USD: { name: "Wio Fixed Saving USD or Schwab SWVXX", ratePct: 4.7 },
    EUR: { name: "Wio Fixed Saving EUR (or convert to USD MMF)", ratePct: 3.5 },
    AED: { name: "Wio Fixed Saving AED Space", ratePct: 4.0 },
  };
  const cashDragRows = cashDragAccounts.map((a) => {
    const balanceAED = a.balance * (fxToAed[a.currency] ?? 1);
    const targetForRow = suggestedVenue[a.currency]?.ratePct ?? targetRatePct;
    const lossPct = Math.max(0, targetForRow - (a.currentRatePct ?? 0));
    const annualLossAED = balanceAED * (lossPct / 100);
    const recommendation = lossPct > 0 && balanceAED >= 1000
      ? `Move ${a.currency} ${a.balance.toLocaleString(undefined, { maximumFractionDigits: 2 })} → ${suggestedVenue[a.currency]?.name} (~${targetForRow}%) — recovers AED ${Math.round(annualLossAED).toLocaleString()}/yr`
      : null;
    return { ...a, balanceAED, lossPct, annualLossAED, targetForRow, recommendation };
  });
  const totalIdleAED = cashDragRows.reduce((s, r) => s + r.balanceAED, 0);
  const totalAnnualLossAED = cashDragRows.reduce((s, r) => s + r.annualLossAED, 0);
  const totalMonthlyLossAED = totalAnnualLossAED / 12;

  // ─── Performance from snapshots ───
  const snapshots = ((wp as any)?.snapshots ?? []) as Array<{ date: string; netWorthAED: number; portfolioUSD?: number }>;
  const liveSnapshot = { date: new Date().toISOString().slice(0, 10), netWorthAED, portfolioUSD: totalPortfolioValue };
  const snapshotsWithToday = (snapshots.length === 0 || snapshots[snapshots.length - 1].date !== liveSnapshot.date)
    ? [...snapshots, liveSnapshot]
    : snapshots;
  const performance = computePerformance(snapshotsWithToday);

  // ─── Allocation vs target ───
  const targetAlloc = (wp as any)?.targetAllocationPct as
    | { equity: number; crypto: number; commodity: number; rsu: number; cash: number; realEstate: number; rebalanceBandPct: number }
    | undefined;
  const allocation = targetAlloc
    ? computeAllocation(liveWealthComponents, enrichedPositions, cashIdle * usdToAed, targetAlloc)
    : null;

  // ─── Stress test scenarios ───
  const stressScenarioDefs = ((wp as any)?.stressScenarios ?? []) as Array<{
    name: string; icon?: string; shocks: Array<{ label: string; shockPct: number }>;
  }>;
  const stressResults = stressScenarioDefs.map((s) =>
    applyStressScenario(s, liveWealthComponents, totalLiabilitiesAED)
  );

  // ─── Cashflow waterfall ───
  const monthlyExpenses = ((wp as any)?.monthlyExpenses ?? []) as Array<{ label: string; amountAED: number; category: string; fixed?: boolean }>;
  const liquidCashAED = (cashIdle * usdToAed) + 4468 + 222150 + 46218; // direct cash sources from current snapshot
  const cashflow = monthlyExpenses.length > 0
    ? computeCashflow(wp?.incomeSources ?? [], monthlyExpenses, liquidCashAED)
    : null;

  // ─── RSU live analysis (PINS + SNAP @ Schwab) ───
  const pinsDayChange = marketData.get("PINS")?.changePercent ?? 0;
  const snapDayChange = marketData.get("SNAP")?.changePercent ?? 0;
  const rsuAnalyses = [
    analyzeRsu({
      symbol: "PINS",
      label: "Pinterest RSU",
      shares: 1429,
      costBasisUSD: 46649.76,
      livePrice: pinsLivePrice,
      dayChangePct: pinsDayChange,
      isEmployer: false,
      schwabAccountSuffix: "790",
      netWorthAED,
      usdToAed,
    }),
    analyzeRsu({
      symbol: "SNAP",
      label: "Snap RSU",
      shares: 1798,
      costBasisUSD: 12339.58,
      livePrice: snapLivePrice,
      dayChangePct: snapDayChange,
      isEmployer: true,
      schwabAccountSuffix: "343",
      netWorthAED,
      usdToAed,
    }),
  ];

  // ─── Cash Deployment Plan ───
  const enbdAED = liveWealthComponents.find((c: any) => c.label?.startsWith("ENBD"))?.valueAED ?? 0;
  const schwabCashUSD = (liveWealthComponents.find((c: any) => c.label === "Schwab cash")?.valueAED ?? 0) / usdToAed;
  const cashAccountsForPlan = cashDragRows.map((a) => ({
    label: a.label, currency: a.currency, balance: a.balance, balanceAED: a.balanceAED,
    currentRatePct: a.currentRatePct,
  }));
  const monthlyBurnAED = cashflow?.monthlyExpensesTotal ?? 12504;
  const underweightBuckets = (allocation?.outOfBand ?? [])
    .filter((s) => s.status === "underweight")
    .map((s) => ({ key: s.key, label: s.label, deviationPct: s.deviationPct, targetPct: s.targetPct }));
  const cashPlan = buildCashDeploymentPlan({
    cashAccounts: cashAccountsForPlan,
    enbdAED,
    etoroCashUSD: cashIdle,
    schwabCashUSD,
    usdToAed,
    monthlyBurnAED,
    watchlist: ((data as any).bullRunWatchlist ?? []) as any[],
    marketData,
    positionsWithZones: enrichedPositions as any[],
    underweightBuckets,
  });

  // ─── Inflation-adjusted target ───
  const baseYear = (wp as any)?.goalBaseYear ?? 2026;
  const inflPct = (wp as any)?.inflationPct ?? 2.5;
  // Compute ETA year from the base scenario (8% / AED 30K/mo)
  const baseScenario = projection.scenarios.find((s) => s.label === "Base case");
  const etaYearForInflation = baseScenario?.etaDate ? parseInt(baseScenario.etaDate.slice(0, 4), 10) : new Date().getFullYear() + 5;
  const inflatedGoal = inflationAdjustedGoal(projection.goalAED, baseYear, etaYearForInflation, inflPct);

  // ─── Action Zones (sorted by urgency desc) ───
  const actionZones = enrichedPositions
    .map((p) => classifyActionZone(p, usdToAed))
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
        {/* Staleness banner — surfaces lastUpdated age, eToro connection, snapshot freshness */}
        <StaleDataBanner
          lastUpdated={data.lastUpdated}
          warLastUpdated={liveWar.lastUpdated}
          etoroConnected={isEtoroLive}
          etoroSnapshotDate={(data as any).etoro?.currentSnapshot?.date}
          etoroStatementPeriod={(data as any).etoro?.statementPeriod}
        />

        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">C&G Brief</h1>
              <p className="text-sm text-gray-400">
                Live Dashboard · {dateStr} {timeStr} Dubai
              </p>
              <p className="text-[10px] text-gray-500 font-mono mt-1">
                Manual data <StaleBadge dateStr={data.lastUpdated} freshDays={1} staleDays={3} label="edited" />
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
                <p className="text-[11px] text-amber-300 font-mono mb-1">
                  Real target (today {baseYear} AED): {inflatedGoal.realTargetAED.toLocaleString()} · nominal at ETA ({inflatedGoal.etaYear}) @ {inflPct}% CPI: AED {Math.round(inflatedGoal.nominalTargetAED).toLocaleString()} (+AED {Math.round(inflatedGoal.upliftAED).toLocaleString()})
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
                <div className="bg-red-950/40 border border-red-800 rounded-lg p-3">
                  <p className="text-[10px] font-bold text-red-400 uppercase tracking-widest">Cash drag</p>
                  <p className="text-lg font-mono font-bold text-red-300">
                    −AED {Math.round(totalAnnualLossAED).toLocaleString()}/yr
                  </p>
                  <p className="text-[10px] text-red-400/80 font-mono">
                    AED {Math.round(totalIdleAED / 1000)}K idle @ &lt;{targetRatePct}% MMF · ≈ AED {Math.round(totalMonthlyLossAED).toLocaleString()}/mo
                  </p>
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

        {/* ─── Performance Suite (TWR · Allocation · Stress · Cashflow) ─── */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mb-5">
        {/* ─── Performance (TWR / CAGR / Sharpe / Max DD) ─── */}
        {performance.monthsTracked >= 2 && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4 pb-2 border-b border-gray-800">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">Performance</p>
              <p className="text-[10px] text-gray-600 font-mono">
                {performance.monthsTracked} pts · {performance.rangeStart} → {performance.rangeEnd}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="bg-gray-800/40 rounded-lg p-2.5">
                <p className="text-[10px] text-gray-500 uppercase tracking-widest">Total return</p>
                <p className={`text-lg font-mono font-bold ${(performance.twrPct ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {performance.twrPct == null ? "—" : `${performance.twrPct >= 0 ? "+" : ""}${performance.twrPct.toFixed(2)}%`}
                </p>
                <p className="text-[10px] text-gray-600 font-mono">since {performance.rangeStart}</p>
              </div>
              <div className="bg-gray-800/40 rounded-lg p-2.5">
                <p className="text-[10px] text-gray-500 uppercase tracking-widest">CAGR</p>
                <p className={`text-lg font-mono font-bold ${(performance.cagrPct ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {performance.cagrPct == null ? "—" : `${performance.cagrPct >= 0 ? "+" : ""}${performance.cagrPct.toFixed(2)}%`}
                </p>
                <p className="text-[10px] text-gray-600 font-mono">annualized</p>
              </div>
              <div className="bg-gray-800/40 rounded-lg p-2.5">
                <p className="text-[10px] text-gray-500 uppercase tracking-widest">Max DD</p>
                <p className="text-lg font-mono font-bold text-red-400">
                  {performance.maxDrawdownPct.toFixed(2)}%
                </p>
                <p className="text-[10px] text-gray-600 font-mono">
                  AED {Math.round(performance.maxDrawdownAED).toLocaleString()}
                </p>
              </div>
              <div className="bg-gray-800/40 rounded-lg p-2.5">
                <p className="text-[10px] text-gray-500 uppercase tracking-widest">Sharpe (vs 4% rf)</p>
                <p className={`text-lg font-mono font-bold ${(performance.sharpe ?? 0) >= 1 ? "text-emerald-400" : (performance.sharpe ?? 0) >= 0 ? "text-amber-400" : "text-red-400"}`}>
                  {performance.sharpe == null ? "—" : performance.sharpe.toFixed(2)}
                </p>
                <p className="text-[10px] text-gray-600 font-mono">
                  best {performance.bestMonthPct?.toFixed(1) ?? "—"}% / worst {performance.worstMonthPct?.toFixed(1) ?? "—"}%
                </p>
              </div>
            </div>
            <p className="text-[10px] text-gray-600 mt-2 font-mono italic">
              Snapshots maintained manually until /api/snapshot cron is wired (see manual-input.json &gt; wealthProgress &gt; snapshots).
            </p>
          </div>
        )}

        {/* ─── Allocation vs Target ─── */}
        {allocation && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4 pb-2 border-b border-gray-800">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">Allocation · Rebalance</p>
              <p className={`text-[10px] font-mono ${allocation.outOfBand.length > 0 ? "text-amber-400" : "text-emerald-400"}`}>
                {allocation.outOfBand.length === 0
                  ? `● within ±${allocation.bandPct}% band`
                  : `⚠ ${allocation.outOfBand.length} slice${allocation.outOfBand.length > 1 ? "s" : ""} out of band`}
              </p>
            </div>
            {/* Stacked bar: actual */}
            <div className="h-4 bg-gray-800 rounded-full overflow-hidden flex mb-3 border border-gray-700">
              {allocation.slices.map((s) => (
                <div key={s.key} className={`${s.color} h-full transition-all`}
                     style={{ width: `${s.actualPct}%` }}
                     title={`${s.label}: ${s.actualPct.toFixed(1)}% (target ${s.targetPct}%)`} />
              ))}
            </div>
            <div className="space-y-1.5 text-xs">
              {allocation.slices.map((s) => {
                const tone = s.status === "on-target" ? "text-gray-300"
                          : s.status === "overweight" ? "text-amber-300"
                          : "text-sky-300";
                const arrow = s.status === "overweight" ? "↑" : s.status === "underweight" ? "↓" : "·";
                return (
                  <div key={s.key} className="flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-sm ${s.color}`} />
                      <span className="text-gray-300">{s.label}</span>
                    </div>
                    <div className="flex items-center gap-3 text-right">
                      <span className="font-mono text-gray-400 text-[10px]">AED {Math.round(s.valueAED).toLocaleString()}</span>
                      <span className="font-mono text-gray-200 w-12 text-right">{s.actualPct.toFixed(1)}%</span>
                      <span className="font-mono text-gray-600 w-10 text-right">/{s.targetPct}%</span>
                      <span className={`font-mono w-12 text-right ${tone}`}>
                        {arrow} {s.deviationPct >= 0 ? "+" : ""}{s.deviationPct.toFixed(1)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
            {allocation.outOfBand.length > 0 && (
              <div className="mt-3 pt-2 border-t border-gray-800 space-y-1">
                <p className="text-[10px] font-bold text-amber-400 uppercase tracking-widest mb-1">Rebalance suggestions</p>
                {allocation.outOfBand.map((s) => {
                  const direction = s.status === "overweight" ? "Trim" : "Add to";
                  const dollarsAED = (Math.abs(s.deviationPct) / 100) * allocation.totalAED;
                  return (
                    <p key={s.key} className="text-[11px] text-gray-300 leading-snug">
                      <span className="text-gray-500 font-mono mr-1">→</span>
                      {direction} <span className="font-semibold">{s.label}</span> by ≈ AED {Math.round(dollarsAED).toLocaleString()} to hit target {s.targetPct}%
                    </p>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ─── Stress Test ─── */}
        {stressResults.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4 pb-2 border-b border-gray-800">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">Stress Test</p>
              <p className="text-[10px] text-gray-600 font-mono">vs current AED {netWorthAED.toLocaleString()}</p>
            </div>
            <div className="space-y-1.5">
              {stressResults
                .slice()
                .sort((a, b) => a.deltaAED - b.deltaAED)
                .map((r) => {
                  const tone = r.deltaAED >= 0
                    ? "border-emerald-800 bg-emerald-950/30 text-emerald-200"
                    : Math.abs(r.deltaPct) >= 10
                      ? "border-red-800 bg-red-950/40 text-red-200"
                      : "border-amber-800 bg-amber-950/30 text-amber-200";
                  return (
                    <div key={r.name} className={`rounded-lg p-2.5 text-xs border ${tone}`}>
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-semibold flex items-center gap-1.5">
                          <span>{r.icon}</span>
                          <span>{r.name}</span>
                        </p>
                        <div className="text-right font-mono">
                          <span className={`font-bold ${r.deltaAED >= 0 ? "text-emerald-300" : "text-red-300"}`}>
                            {r.deltaAED >= 0 ? "+" : ""}AED {Math.round(r.deltaAED).toLocaleString()}
                          </span>
                          <span className="text-[10px] opacity-70 ml-1.5">({r.deltaPct >= 0 ? "+" : ""}{r.deltaPct.toFixed(1)}%)</span>
                        </div>
                      </div>
                      <p className="text-[10px] opacity-70 mt-0.5 font-mono">
                        Net would be AED {Math.round(r.netWorthAfterAED).toLocaleString()}
                        {r.affectedComponents.length > 0 && (
                          <span> · hits: {r.affectedComponents.map((c) => c.label.replace(" (Schwab)", "").replace(" Portfolio", "")).join(", ")}</span>
                        )}
                      </p>
                    </div>
                  );
                })}
            </div>
          </div>
        )}

        {/* ─── Cashflow Waterfall ─── */}
        {cashflow && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4 pb-2 border-b border-gray-800">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">Cashflow · Monthly</p>
              <p className="text-[10px] text-gray-600 font-mono">
                save {cashflow.savingsRatePct.toFixed(0)}%
                {cashflow.runwayMonths !== null && ` · runway ${cashflow.runwayMonths.toFixed(1)} mo`}
              </p>
            </div>

            {/* Waterfall: income → categories → net */}
            <div className="space-y-1.5 text-xs">
              <div className="flex justify-between bg-emerald-950/40 border border-emerald-800 rounded p-2">
                <span className="text-emerald-200 font-semibold">Gross income</span>
                <span className="font-mono text-emerald-300 font-bold">+AED {cashflow.monthlyIncomeAED.toLocaleString()}</span>
              </div>
              {Object.entries(cashflow.monthlyExpensesByCategory)
                .sort((a, b) => b[1] - a[1])
                .map(([cat, amt]) => {
                  const pctOfIncome = cashflow.monthlyIncomeAED > 0 ? (amt / cashflow.monthlyIncomeAED) * 100 : 0;
                  return (
                    <div key={cat} className="flex justify-between items-center bg-gray-800/40 rounded p-2">
                      <span className="text-gray-300 capitalize">− {cat}</span>
                      <div className="text-right">
                        <span className="font-mono text-red-300">−AED {amt.toLocaleString()}</span>
                        <span className="text-[10px] text-gray-600 font-mono ml-2">({pctOfIncome.toFixed(0)}%)</span>
                      </div>
                    </div>
                  );
                })}
              <div className={`flex justify-between border rounded p-2 ${cashflow.netInvestableAED >= 0 ? "bg-sky-950/40 border-sky-800 text-sky-200" : "bg-red-950/40 border-red-800 text-red-200"}`}>
                <span className="font-bold">= Net investable</span>
                <span className={`font-mono font-bold ${cashflow.netInvestableAED >= 0 ? "text-sky-300" : "text-red-300"}`}>
                  {cashflow.netInvestableAED >= 0 ? "+" : ""}AED {cashflow.netInvestableAED.toLocaleString()}
                </span>
              </div>
            </div>

            <p className="text-[10px] text-gray-600 mt-3 font-mono italic">
              Dashboard projection assumes AED 30K/mo savings (Base case). Actual capacity = AED {cashflow.netInvestableAED.toLocaleString()}/mo.
              {cashflow.netInvestableAED < 30000 && cashflow.netInvestableAED > 0 && (
                <span className="text-amber-400"> Base scenario may be optimistic — adjust target.</span>
              )}
            </p>
          </div>
        )}

        </div>

        {/* ─── RSU Live Analysis (PINS + SNAP) ─── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-5">
          {rsuAnalyses.map((rsu) => {
            const recColor: Record<string, string> = {
              STRONG_TRIM: "from-red-950/40 via-gray-900 to-amber-950/30 border-red-800",
              TRIM: "from-amber-950/30 via-gray-900 to-amber-950/30 border-amber-800",
              RECOVERY_HOLD: "from-sky-950/30 via-gray-900 to-gray-900 border-sky-800",
              HOLD: "from-emerald-950/30 via-gray-900 to-gray-900 border-emerald-800",
            };
            const recLabel: Record<string, string> = {
              STRONG_TRIM: "STRONG TRIM",
              TRIM: "TRIM",
              RECOVERY_HOLD: "RECOVERY HOLD",
              HOLD: "HOLD",
            };
            const recBadge: Record<string, string> = {
              STRONG_TRIM: "bg-red-900 text-red-100",
              TRIM: "bg-amber-900 text-amber-100",
              RECOVERY_HOLD: "bg-sky-900 text-sky-100",
              HOLD: "bg-emerald-900 text-emerald-100",
            };
            return (
              <div key={rsu.symbol} className={`bg-gradient-to-br ${recColor[rsu.recommendation]} border rounded-xl p-5`}>
                <div className="flex items-center justify-between mb-3 pb-2 border-b border-gray-800">
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">{rsu.label}</p>
                    {rsu.isEmployer && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-purple-900 text-purple-100">EMPLOYER</span>}
                  </div>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${recBadge[rsu.recommendation]}`}>
                    {recLabel[rsu.recommendation]}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 mb-3">
                  <div className="bg-gray-900/60 rounded p-2">
                    <p className="text-[10px] text-gray-500 uppercase tracking-widest">Live value</p>
                    <p className="text-base font-mono font-bold text-white">${rsu.currentValueUSD.toFixed(0)}</p>
                    <p className="text-[10px] text-gray-600 font-mono">
                      AED {Math.round(rsu.currentValueAED).toLocaleString()} · {rsu.shares.toLocaleString()} sh × ${rsu.livePrice.toFixed(2)}
                      {rsu.dayChangePct !== 0 && (
                        <span className={`ml-1 ${rsu.dayChangePct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          ({rsu.dayChangePct >= 0 ? "+" : ""}{rsu.dayChangePct.toFixed(2)}% today)
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="bg-gray-900/60 rounded p-2">
                    <p className="text-[10px] text-gray-500 uppercase tracking-widest">vs cost basis</p>
                    <p className={`text-base font-mono font-bold ${rsu.unrealizedPnlUSD >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {rsu.unrealizedPnlUSD >= 0 ? "+" : ""}${Math.abs(rsu.unrealizedPnlUSD).toFixed(0)}
                    </p>
                    <p className="text-[10px] text-gray-600 font-mono">
                      ${rsu.costBasisUSD.toLocaleString()} cost · ${rsu.costPerShareUSD.toFixed(2)}/sh · {rsu.unrealizedPnlPct >= 0 ? "+" : ""}{rsu.unrealizedPnlPct.toFixed(1)}%
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 mb-3 text-xs">
                  <div className={`rounded p-2 border ${rsu.concentrationPct > 10 ? "border-red-800 bg-red-950/30" : rsu.concentrationPct > 6 ? "border-amber-800 bg-amber-950/30" : "border-gray-700 bg-gray-800/40"}`}>
                    <p className="text-[10px] text-gray-500 uppercase tracking-widest">Concentration</p>
                    <p className={`font-mono font-bold ${rsu.concentrationPct > 10 ? "text-red-300" : rsu.concentrationPct > 6 ? "text-amber-300" : "text-gray-200"}`}>
                      {rsu.concentrationPct.toFixed(1)}% of NW
                    </p>
                    <p className="text-[10px] text-gray-600 font-mono">cap 10%</p>
                  </div>
                  <div className="bg-gray-800/40 border border-gray-700 rounded p-2">
                    <p className="text-[10px] text-gray-500 uppercase tracking-widest">{rsu.recoveryNeededPct > 0 ? "Recovery needed" : "Distance from cost"}</p>
                    <p className="font-mono font-bold text-gray-200">
                      {rsu.recoveryNeededPct > 0 ? `+${rsu.recoveryNeededPct.toFixed(1)}%` : `${rsu.unrealizedPnlPct.toFixed(1)}%`}
                    </p>
                    <p className="text-[10px] text-gray-600 font-mono">
                      {rsu.recoveryNeededPct > 0 ? `to break even at $${rsu.costPerShareUSD.toFixed(2)}` : "above cost"}
                    </p>
                  </div>
                </div>

                <div className="rounded-md px-3 py-2 bg-black/40 border border-white/5 mb-2">
                  <p className="text-[11px] leading-snug text-gray-200">{rsu.rationale}</p>
                </div>

                <ol className="pl-1 space-y-0.5 list-none">
                  {rsu.executionSteps.map((s, i) => (
                    <li key={i} className="text-[10px] leading-snug opacity-90 flex gap-1.5">
                      <span className="text-gray-500 font-mono shrink-0 w-3">{i + 1}.</span>
                      <span>{s}</span>
                    </li>
                  ))}
                </ol>
              </div>
            );
          })}
        </div>

        {/* ─── Cash Deployment Plan — treasury-grade allocation of all idle cash ─── */}
        {cashPlan.totalLiquidAED > 0 && (
          <div className="bg-gradient-to-br from-sky-950/30 via-gray-900 to-emerald-950/20 border border-gray-800 rounded-xl p-5 mb-5">
            <div className="flex items-center justify-between mb-3 pb-2 border-b border-gray-800">
              <div>
                <p className="text-xs font-bold text-emerald-400 uppercase tracking-widest">Cash Deployment Plan</p>
                <p className="text-[10px] text-gray-500 font-mono mt-0.5">
                  Treasury-grade · uses live signals across portfolio + watchlist + allocation gaps
                </p>
              </div>
              <div className="text-right">
                <p className="text-[10px] font-mono text-gray-500">Total liquid</p>
                <p className="text-lg font-mono font-bold text-white">AED {Math.round(cashPlan.totalLiquidAED).toLocaleString()}</p>
              </div>
            </div>

            {/* Capital allocation bar */}
            <div className="grid grid-cols-3 gap-2 mb-4 text-xs">
              <div className="bg-amber-950/30 border border-amber-800 rounded p-2">
                <p className="text-[10px] text-amber-400 uppercase tracking-widest font-bold">Reserve ({cashPlan.reserveCoverMonths}× burn)</p>
                <p className="font-mono text-amber-200 font-bold mt-0.5">AED {Math.round(cashPlan.emergencyReserveAED).toLocaleString()}</p>
                <p className="text-[10px] text-amber-300/70 font-mono mt-0.5">Untouchable runway</p>
              </div>
              <div className="bg-sky-950/30 border border-sky-800 rounded p-2">
                <p className="text-[10px] text-sky-400 uppercase tracking-widest font-bold">MMF Park (30%)</p>
                <p className="font-mono text-sky-200 font-bold mt-0.5">AED {Math.round(cashPlan.mmfParkAED).toLocaleString()}</p>
                <p className="text-[10px] text-sky-300/70 font-mono mt-0.5">~4.7% APR · liquid</p>
              </div>
              <div className="bg-emerald-950/30 border border-emerald-800 rounded p-2">
                <p className="text-[10px] text-emerald-400 uppercase tracking-widest font-bold">Deploy now (70%)</p>
                <p className="font-mono text-emerald-200 font-bold mt-0.5">AED {Math.round(cashPlan.deployNowAED).toLocaleString()}</p>
                <p className="text-[10px] text-emerald-300/70 font-mono mt-0.5">Conviction-tilted</p>
              </div>
            </div>

            {cashPlan.trades.length > 0 ? (
              <InteractiveChecklist
                storagePrefix="cashDeploy"
                showResetButton={true}
                items={cashPlan.trades.map((t, i) => {
                  const sourceColor =
                    t.source === "conviction-watchlist" ? "border-emerald-800 bg-emerald-950/30" :
                    t.source === "existing-addzone"    ? "border-sky-800 bg-sky-950/30" :
                    t.source === "underweight-bucket"  ? "border-amber-800 bg-amber-950/30" :
                    /* yield-park */                     "border-gray-700 bg-gray-800/40";
                  const sourceBadge =
                    t.source === "conviction-watchlist" ? "WATCHLIST" :
                    t.source === "existing-addzone"    ? "EXISTING" :
                    t.source === "underweight-bucket"  ? "REBALANCE" :
                    "PARK";
                  return {
                    id: `${t.source}-${t.symbol ?? t.label}-${t.sizeAED}-${i}`,
                    content: (
                      <div className={`rounded-lg p-3 text-xs border ${sourceColor}`}>
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-black/30 text-gray-300">{sourceBadge}</span>
                            {t.symbol && <span className="font-bold font-mono text-white">{t.symbol}</span>}
                            <span className="font-mono text-emerald-300 font-bold">AED {Math.round(t.sizeAED).toLocaleString()}</span>
                            {t.conviction && <span className="text-[10px] font-mono opacity-70">conviction {t.conviction}/10</span>}
                          </div>
                          <span className="text-[10px] font-mono opacity-50">P{t.priority.toFixed(0)}</span>
                        </div>
                        <p className="text-[11px] font-semibold leading-snug mt-1">
                          <span className="text-gray-500 font-mono mr-1">→</span>
                          {t.instruction}
                        </p>
                        <p className="text-[10px] leading-snug opacity-75 mt-1">{t.rationale}</p>
                        {t.steps && t.steps.length > 0 && (
                          <ol className="mt-1.5 pl-1 space-y-0.5 list-none">
                            {t.steps.map((s, si) => (
                              <li key={si} className="text-[10px] leading-snug opacity-90 flex gap-1.5">
                                <span className="text-gray-500 font-mono shrink-0 w-3">{si + 1}.</span>
                                <span>{s}</span>
                              </li>
                            ))}
                          </ol>
                        )}
                      </div>
                    ),
                  };
                })}
              />
            ) : (
              <p className="text-xs text-gray-400 italic">No deployable surplus — all liquid is committed to reserve + MMF park.</p>
            )}

            <p className="text-[10px] text-gray-600 mt-3 font-mono italic">
              Plan recomputes each render from live cash balances (Wio + ENBD + eToro + Schwab), live Yahoo prices, current allocation deviations, and watchlist conviction levels. Reserve = {cashPlan.reserveCoverMonths} × monthly burn (AED {Math.round(monthlyBurnAED).toLocaleString()}). Tick a trade once placed — state persists.
            </p>
          </div>
        )}

        {/* Main Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Left Column */}
          <div className="lg:col-span-2 space-y-5">
            {/* Direct Book */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <div className="flex items-center justify-between mb-4 pb-2 border-b border-gray-800">
                <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">
                  Direct Book
                </p>
                <span className={`text-[10px] font-mono ${reconciliation.source === "etoro-live" ? "text-emerald-400" : "text-amber-400"}`}>
                  ● {reconciliation.source === "etoro-live" ? `live · ${enrichedPositions.length} from eToro` : "manual fallback"}
                </span>
              </div>
              {reconciliation.staleManualEntries.length > 0 && (
                <div className="mb-3 p-2 rounded border border-amber-800 bg-amber-950/30 text-[11px] leading-snug">
                  <p className="text-amber-300 font-semibold mb-0.5">⚠ Stale metadata in manual-input.json</p>
                  <p className="text-amber-200/80">
                    {reconciliation.staleManualEntries.join(", ")} listed locally but not in eToro live — position{reconciliation.staleManualEntries.length > 1 ? "s" : ""} likely closed. Remove from <code className="font-mono text-[10px] bg-gray-800 px-1 rounded">manual-input.json &gt; positions[]</code> to clean up.
                  </p>
                </div>
              )}
              {reconciliation.unmappedLiveEntries.length > 0 && (
                <div className="mb-3 p-2 rounded border border-sky-800 bg-sky-950/30 text-[11px] leading-snug">
                  <p className="text-sky-300 font-semibold mb-0.5">ℹ Live position without metadata</p>
                  <p className="text-sky-200/80">
                    {reconciliation.unmappedLiveEntries.join(", ")} on eToro live but no SL/TP defined — add metadata in <code className="font-mono text-[10px] bg-gray-800 px-1 rounded">manual-input.json &gt; positions[]</code> for proper Action Zones classification.
                  </p>
                </div>
              )}
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
              manualLastUpdated={data.lastUpdated}
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

                        {/* Cash Drag — per-account revenue lost at 0% */}
                        {cashDragRows.length > 0 && (
                          <div className="mt-3 pt-2 border-t border-gray-800">
                            <div className="flex items-center justify-between mb-2">
                              <p className="text-[10px] font-bold text-red-400 uppercase tracking-widest">
                                Cash Drag · idle @ &lt;{targetRatePct}% MMF
                              </p>
                              <p className="text-[10px] font-mono text-red-300">
                                Total loss: AED {Math.round(totalAnnualLossAED).toLocaleString()}/yr
                              </p>
                            </div>
                            {cashDragRows
                              .slice()
                              .sort((a, b) => b.annualLossAED - a.annualLossAED)
                              .map((row, i) => {
                                const idleSeverity =
                                  row.balanceAED >= 50_000 ? "border-red-700 bg-red-950/40" :
                                  row.balanceAED >= 10_000 ? "border-amber-700 bg-amber-950/30" :
                                  "border-gray-700 bg-gray-800/30";
                                return (
                                  <div key={i} className={`mb-1.5 px-2 py-1.5 rounded border ${idleSeverity} text-xs`}>
                                    <div className="flex justify-between items-start">
                                      <div>
                                        <p className="text-gray-200 font-semibold">{row.label}</p>
                                        <p className="text-[10px] text-gray-500 font-mono">
                                          {row.currency} {row.balance.toLocaleString(undefined, { maximumFractionDigits: 2 })} @ {row.currentRatePct}% · as of {row.asOf}
                                        </p>
                                      </div>
                                      <div className="text-right">
                                        <p className="font-mono text-red-300 text-xs">
                                          −AED {Math.round(row.annualLossAED).toLocaleString()}/yr
                                        </p>
                                        <p className="text-[10px] text-gray-600 font-mono">
                                          AED {Math.round(row.balanceAED).toLocaleString()} idle
                                        </p>
                                      </div>
                                    </div>
                                    {row.recommendation && (
                                      <p className="text-[10px] mt-1 leading-snug text-emerald-200/90">
                                        <span className="text-gray-500 font-mono mr-1">→</span>
                                        {row.recommendation}
                                      </p>
                                    )}
                                  </div>
                                );
                              })}
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
              <InteractiveChecklist
                storagePrefix="actionZone"
                emptyMessage="No positions to evaluate"
                showResetButton={true}
                items={actionZones.map((z) => {
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
                    return {
                      id: `${z.symbol}-${z.kind}-${z.execution?.instruction?.slice(0, 30) ?? z.cta}`,
                      content: (
                        <div className={`rounded-lg p-3 text-xs border ${colorMap[z.color]}`}>
                          <div className="flex items-start justify-between gap-2 mb-1.5">
                            <div className="flex items-center gap-2">
                              <span className="font-bold font-mono">{z.symbol}</span>
                              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${ctaColor[z.color]}`}>{z.cta}</span>
                            </div>
                            <span className={`text-[10px] font-mono ${z.pnlPercent >= 0 ? "text-emerald-300" : "text-red-300"}`}>
                              {formatPercent(z.pnlPercent)}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
                            <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${rsiTone}`}>RSI {rsi == null ? "—" : rsi.toFixed(0)}</span>
                            <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded uppercase tracking-wider ${trendTone}`}>{trend}</span>
                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider ${sigTone}`}>tech: {signal}</span>
                          </div>
                          <p className="text-[11px] leading-snug opacity-90 mb-1.5">{z.rationale}</p>
                          {z.execution && (
                            <div className="mt-1.5 mb-1 rounded-md px-2 py-2 bg-black/30 border border-white/5">
                              <p className="text-[11px] font-semibold leading-snug">
                                <span className="text-gray-500 font-mono mr-1">→</span>
                                {z.execution.instruction}
                              </p>
                              {z.execution.detail && <p className="text-[10px] leading-snug opacity-75 mt-1">{z.execution.detail}</p>}
                              {z.execution.steps && z.execution.steps.length > 0 && (
                                <ol className="mt-1.5 pl-1 space-y-0.5 list-none">
                                  {z.execution.steps.map((step, i) => (
                                    <li key={i} className="text-[10px] leading-snug opacity-90 flex gap-1.5">
                                      <span className="text-gray-500 font-mono shrink-0 w-3">{i + 1}.</span>
                                      <span>{step}</span>
                                    </li>
                                  ))}
                                </ol>
                              )}
                              {z.execution.note && (
                                <p className="text-[10px] leading-snug italic opacity-60 mt-1.5 pt-1.5 border-t border-white/5">
                                  {z.execution.note}
                                </p>
                              )}
                            </div>
                          )}
                          <p className="text-[10px] font-mono opacity-60 mt-1">live ${z.livePrice >= 100 ? z.livePrice.toFixed(0) : z.livePrice.toFixed(2)} · urgency {z.urgency}</p>
                        </div>
                      ),
                    };
                  })
                }
              />
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

            {/* War & Deployment — live from /api/war-pulse (Yahoo news + Brent + Anthropic synthesis) */}
            {(() => {
              const isLive = liveWar.source === "live-ai" || liveWar.source === "live-rule";
              const ageMin = liveWar.lastUpdated
                ? Math.floor((Date.now() - new Date(liveWar.lastUpdated).getTime()) / 60000)
                : null;
              const ageLabel = !isLive
                ? "manual fallback"
                : ageMin === null ? "—"
                : ageMin < 1 ? "just now"
                : ageMin < 60 ? `${ageMin}m ago`
                : ageMin < 1440 ? `${Math.floor(ageMin / 60)}h ago`
                : `${Math.floor(ageMin / 1440)}d ago`;
              const sourceLabel = liveWar.source === "live-ai" ? "AI synthesis"
                                : liveWar.source === "live-rule" ? "rule synthesis"
                                : "manual fallback";
              const dotColor = isLive ? "bg-emerald-500" : "bg-red-500 animate-pulse";
              const tone = isLive ? "bg-gray-900 border-gray-800" : "bg-red-950/20 border-red-900/60";
              return (
                <div className={`border rounded-xl p-5 ${tone}`}>
                  <div className="flex items-center justify-between mb-4 pb-2 border-b border-gray-800">
                    <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">
                      War &amp; Deployment
                    </p>
                    <span className={`inline-flex items-center gap-1 text-[10px] font-mono ${isLive ? "text-emerald-400" : "text-red-400"}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
                      {sourceLabel} · {ageLabel}
                    </span>
                  </div>
                  <div className="text-xs">
                    <p className="font-bold text-gray-100 mb-2">{liveWar.status}</p>
                    {(liveWar.oilSpotUSD ?? 0) > 0 && (
                      <p className="text-[10px] text-gray-500 font-mono mb-2">
                        Brent crude ${liveWar.oilSpotUSD!.toFixed(2)}{" "}
                        <span className={(liveWar.oilDailyChangePct ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}>
                          ({(liveWar.oilDailyChangePct ?? 0) >= 0 ? "+" : ""}{(liveWar.oilDailyChangePct ?? 0).toFixed(2)}%)
                        </span>
                      </p>
                    )}
                    <p className="text-gray-400 mb-3 leading-relaxed">{liveWar.description}</p>
                    <div className="space-y-1 mb-3">
                      {liveWar.triggers.map((trigger: any, idx: number) => {
                        const icon = trigger.state === "met" ? "✓"
                                  : trigger.state === "partial" ? "◐"
                                  : "○";
                        const color = trigger.state === "met" ? "text-emerald-400"
                                   : trigger.state === "partial" ? "text-amber-400"
                                   : "text-red-400";
                        return (
                          <div key={idx} className="flex items-start gap-2">
                            <span className={`mt-0.5 ${color}`}>{icon}</span>
                            <div>
                              <p className="text-gray-300">{trigger.label}</p>
                              <p className="text-gray-500 text-xs">{trigger.detail}</p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {liveWar.deploymentLocked && (
                      <p className="text-amber-400 text-xs font-semibold">
                        Deployment Locked: AED {liveWar.deploymentAmountAED.toLocaleString()}
                      </p>
                    )}
                    {liveWar.headlines && liveWar.headlines.length > 0 && (
                      <div className="mt-3 pt-2 border-t border-gray-800">
                        <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Source headlines</p>
                        <ul className="space-y-1">
                          {liveWar.headlines.slice(0, 4).map((h, i) => (
                            <li key={i} className="text-[10px] text-gray-400 leading-snug">
                              <span className="text-gray-600 font-mono mr-1">
                                {h.ageMinutes < 60 ? `${h.ageMinutes}m` : `${Math.floor(h.ageMinutes / 60)}h`}
                              </span>
                              <a href={h.link} target="_blank" rel="noopener noreferrer" className="hover:text-gray-200 hover:underline">
                                {h.title}
                              </a>
                              <span className="text-gray-600"> — {h.publisher}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
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
