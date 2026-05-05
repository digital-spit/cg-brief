import type { PositionWithLive } from "./types";

// ─────────── Action Zone classification ───────────
// Translates each position's live price + manual SL/TP/addZones into a single
// ranked recommendation. Higher urgency means "do something today."

export type ZoneKind =
  | "below-sl"
  | "near-sl"
  | "hit-tp2"
  | "near-tp2"
  | "hit-tp1"
  | "near-tp1"
  | "add-conviction"
  | "add-medium"
  | "add-light"
  | "add-uptrend"
  | "coast";

export interface ActionZone {
  symbol: string;
  label: string;
  kind: ZoneKind;
  urgency: number;       // 0–100, sort desc
  cta: string;           // imperative — e.g. "RESPECT STOP", "TAKE PROFIT"
  rationale: string;     // one-line why
  livePrice: number;
  pnlPercent: number;
  color: "red" | "amber" | "emerald" | "sky" | "gray";
  execution: {
    instruction: string; // single sentence imperative — "Sell 0.7 sh ($278) on eToro"
    detail?: string;     // optional second line — leftover position, expected fees, etc.
  } | null;
}

// Default sizing for ADD CTAs — converts AED budget per conviction tier into units/$
const ADD_BUDGET_AED: Record<string, number> = {
  "add-conviction": 5000,
  "add-medium":     3000,
  "add-uptrend":    2500,
  "add-light":      1500,
};

function fmtUnits(units: number): string {
  if (units >= 100) return units.toFixed(0);
  if (units >= 10)  return units.toFixed(1);
  if (units >= 1)   return units.toFixed(2);
  if (units >= 0.01) return units.toFixed(4);
  return units.toFixed(6);
}

function fmtUSD(amount: number): string {
  if (Math.abs(amount) >= 1000) return `$${amount.toFixed(0)}`;
  return `$${amount.toFixed(2)}`;
}

// Build the imperative execution instruction for a given zone kind + position state.
function buildExecution(
  kind: ZoneKind,
  pos: PositionWithLive,
  usdToAed: number
): ActionZone["execution"] {
  const p = pos.livePrice;
  const qty = pos.quantity;
  const currentValue = pos.currentValue;
  const symbol = pos.symbol;
  const venue = "eToro"; // direct positions all live on eToro

  switch (kind) {
    case "below-sl": {
      // 100% exit
      const proceedsUSD = currentValue;
      return {
        instruction: `Close ${fmtUnits(qty)} ${symbol} @ ~${fmtUSD(p)} → ${fmtUSD(proceedsUSD)} on ${venue}`,
        detail: `Realize loss ~${fmtUSD(pos.unrealizedPnl)} (${pos.unrealizedPnlPercent.toFixed(1)}%) — UAE $0 CGT, full proceeds redeployable`,
      };
    }
    case "near-sl": {
      // Tighten — half the position, OR move stop to breakeven
      const trimUnits = qty * 0.5;
      const proceedsUSD = trimUnits * p;
      return {
        instruction: `Trim 50% (${fmtUnits(trimUnits)} ${symbol} ≈ ${fmtUSD(proceedsUSD)}) OR raise SL closer to live price`,
        detail: `Leaves ${fmtUnits(qty - trimUnits)} ${symbol} ≈ ${fmtUSD((qty - trimUnits) * p)} exposed`,
      };
    }
    case "hit-tp2": {
      // Book 50%, trail rest
      const trimUnits = qty * 0.5;
      const proceedsUSD = trimUnits * p;
      return {
        instruction: `Sell 50% (${fmtUnits(trimUnits)} ${symbol} ≈ ${fmtUSD(proceedsUSD)}) on ${venue}; trail SL on remainder`,
        detail: `Booked profit ≈ ${fmtUSD(trimUnits * (p - pos.avgCost))}. Leaves ${fmtUnits(qty - trimUnits)} ${symbol} riding`,
      };
    }
    case "hit-tp1": {
      // Trim 30% (mid of 25–33), raise SL to breakeven
      const trimUnits = qty * 0.30;
      const proceedsUSD = trimUnits * p;
      const bookedProfit = trimUnits * (p - pos.avgCost);
      return {
        instruction: `Sell 30% (${fmtUnits(trimUnits)} ${symbol} ≈ ${fmtUSD(proceedsUSD)}) on ${venue}; raise SL to breakeven $${pos.avgCost.toFixed(2)}`,
        detail: `Books ≈ ${fmtUSD(bookedProfit)} profit. Leaves ${fmtUnits(qty - trimUnits)} ${symbol} (≈${fmtUSD((qty - trimUnits) * p)}) riding`,
      };
    }
    case "near-tp2":
    case "near-tp1": {
      const ladderTarget = kind === "near-tp2" ? pos.takeProfit2 : pos.takeProfit;
      const ladderTrim = qty * 0.30;
      return {
        instruction: `Set limit-sell on ${venue}: ${fmtUnits(ladderTrim)} ${symbol} @ $${ladderTarget.toFixed(2)} (≈ ${fmtUSD(ladderTrim * ladderTarget)})`,
        detail: `Ladder triggers automatically when target hits — no manual monitoring needed`,
      };
    }
    case "add-conviction":
    case "add-medium":
    case "add-light":
    case "add-uptrend": {
      const budgetAED = ADD_BUDGET_AED[kind] ?? 2500;
      const budgetUSD = budgetAED / usdToAed;
      const addUnits = budgetUSD / p;
      return {
        instruction: `Buy ${fmtUnits(addUnits)} ${symbol} @ ~${fmtUSD(p)} ≈ ${fmtUSD(budgetUSD)} (AED ${budgetAED.toLocaleString()}) on ${venue}`,
        detail: `New avg cost ≈ $${((qty * pos.avgCost + addUnits * p) / (qty + addUnits)).toFixed(2)} (was $${pos.avgCost.toFixed(2)})`,
      };
    }
    case "coast":
    default:
      return null;
  }
}

export function classifyActionZone(
  pos: PositionWithLive & { addZones?: any },
  usdToAed = 3.6725
): ActionZone {
  const p = pos.livePrice;
  const sl = pos.stopLoss;
  const tp1 = pos.takeProfit;
  const tp2 = pos.takeProfit2;
  const az = (pos as any).addZones;

  const slBufPct = sl > 0 ? ((p - sl) / p) * 100 : Infinity;
  const tp1ApproachPct = tp1 > 0 ? ((tp1 - p) / p) * 100 : Infinity;
  const tp2ApproachPct = tp2 > 0 ? ((tp2 - p) / p) * 100 : Infinity;

  const make = (
    kind: ZoneKind,
    urgency: number,
    cta: string,
    rationale: string,
    color: ActionZone["color"]
  ): ActionZone => ({
    symbol: pos.symbol,
    label: pos.label,
    kind,
    urgency,
    cta,
    rationale,
    livePrice: p,
    pnlPercent: pos.unrealizedPnlPercent,
    color,
    execution: buildExecution(kind, pos, usdToAed),
  });

  // ── Risk side (high urgency) ──
  if (p <= sl) return make("below-sl", 100, "RESPECT STOP",
    `Below SL $${sl.toFixed(2)} — exit now or document a clear thesis to stay in.`, "red");
  if (slBufPct < 3) return make("near-sl", 90, "TIGHTEN / REVIEW",
    `Only ${slBufPct.toFixed(1)}% above SL — manage size or hedge.`, "red");

  // ── Profit side ──
  if (tp2 > 0 && p >= tp2) return make("hit-tp2", 95, "TAKE PROFIT (TP2)",
    `Hit TP2 — book ≥50%, trail rest.`, "emerald");
  if (tp1 > 0 && p >= tp1) return make("hit-tp1", 80, "TRIM (TP1)",
    `Hit TP1 — trim 30%, raise SL to breakeven.`, "emerald");
  if (tp2 > 0 && tp2ApproachPct >= 0 && tp2ApproachPct < 4) return make("near-tp2", 75,
    "PREPARE TO TRIM", `${tp2ApproachPct.toFixed(1)}% from TP2 — set sell ladder.`, "emerald");
  if (tp1 > 0 && tp1ApproachPct >= 0 && tp1ApproachPct < 5) return make("near-tp1", 65,
    "PREPARE TO TRIM", `${tp1ApproachPct.toFixed(1)}% from TP1 — set sell ladder.`, "emerald");

  // ── Add zones ──
  if (az) {
    if (az.dipConviction && p >= az.dipConviction.min && p <= az.dipConviction.max)
      return make("add-conviction", 70, "ADD — CONVICTION",
        `In conviction zone $${az.dipConviction.min}–${az.dipConviction.max}: ${az.dipConviction.note}`, "sky");
    if (az.dipMedium && p >= az.dipMedium.min && p <= az.dipMedium.max)
      return make("add-medium", 55, "ADD — MEDIUM",
        `In dip zone $${az.dipMedium.min}–${az.dipMedium.max}: ${az.dipMedium.note}`, "amber");
    if (az.dipLight && p >= az.dipLight.min && p <= az.dipLight.max)
      return make("add-light", 40, "ADD — LIGHT",
        `In light dip $${az.dipLight.min}–${az.dipLight.max}: ${az.dipLight.note}`, "amber");
    if (az.uptrendAdd && p >= az.uptrendAdd.price)
      return make("add-uptrend", 50, "ADD — UPTREND",
        `Above $${az.uptrendAdd.price}: ${az.uptrendAdd.note}`, "sky");
  }

  // ── Coast ──
  return make("coast", 10, "HOLD", `Between SL ($${sl}) and TP1 ($${tp1}) — no action.`, "gray");
}

// ─────────── AED 1M projection ───────────
// Future-value with monthly contributions: FV = PV*(1+i)^n + PMT*((1+i)^n − 1)/i
// Given target FV, solve for n (months). Closed-form not pretty; binary-search.

export interface WealthProjection {
  netWorthAED: number;
  goalAED: number;
  pctToGoal: number;
  remainingAED: number;
  scenarios: {
    label: string;
    monthlySavingsAED: number;
    cagrPct: number;
    months: number;     // null if unreachable
    etaDate: string;    // ISO YYYY-MM
  }[];
}

function monthsToTarget(pv: number, fv: number, monthlyPmt: number, annualRate: number): number {
  if (pv >= fv) return 0;
  const i = annualRate / 12;
  // Cap at 100 years to avoid pathological loops
  const max = 1200;
  let lo = 0, hi = max;
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    const fvAt = pv * Math.pow(1 + i, mid) + (i > 0 ? monthlyPmt * (Math.pow(1 + i, mid) - 1) / i : monthlyPmt * mid);
    if (fvAt >= fv) hi = mid; else lo = mid;
  }
  return hi >= max - 1 ? Infinity : hi;
}

export function buildProjection(netWorthAED: number, goalAED: number): WealthProjection {
  const remaining = Math.max(0, goalAED - netWorthAED);

  const scenarios = [
    { label: "Conservative", monthlySavingsAED: 20_000, cagrPct: 5 },
    { label: "Base case",    monthlySavingsAED: 30_000, cagrPct: 8 },
    { label: "Aggressive",   monthlySavingsAED: 40_000, cagrPct: 12 },
  ].map((s) => {
    const months = monthsToTarget(netWorthAED, goalAED, s.monthlySavingsAED, s.cagrPct / 100);
    const eta = new Date();
    eta.setMonth(eta.getMonth() + Math.ceil(isFinite(months) ? months : 0));
    return {
      ...s,
      months,
      etaDate: isFinite(months) ? eta.toISOString().slice(0, 7) : "—",
    };
  });

  return {
    netWorthAED,
    goalAED,
    pctToGoal: goalAED > 0 ? (netWorthAED / goalAED) * 100 : 0,
    remainingAED: remaining,
    scenarios,
  };
}

// ─────────── Reconcile eToro live positions with manual metadata ───────────
// eToro is the source of truth for "what positions exist + units + avgCost". Manual
// positions[] supplies metadata only: SL/TP/TP2/notes/addZones/label. Anything in
// manual but not in eToro live = stale entry (likely closed, e.g. GDX). Anything in
// eToro live but not in manual = missing metadata, render with warning.

import type { MarketData } from "./types";
import type { AggregatedPosition } from "./etoro";

export interface ReconciliationResult {
  livePositions: PositionWithLive[];
  staleManualEntries: string[];   // symbols in manual but absent from eToro live
  unmappedLiveEntries: string[];  // symbols in eToro live but absent from manual metadata
  source: "etoro-live" | "manual-fallback";
}

export function reconcilePositions(
  manualMetadata: Array<Record<string, unknown>>,
  etoroAggregated: Map<string, AggregatedPosition> | undefined,
  marketData: Map<string, MarketData>
): ReconciliationResult {
  // Fallback: no eToro live → render manual as-is (legacy path)
  if (!etoroAggregated || etoroAggregated.size === 0) {
    const livePositions = manualMetadata.map((m) => {
      const sym = m.symbol as string;
      const mkt = marketData.get(sym);
      const livePrice = mkt?.price || (m.avgCost as number) || 0;
      const qty = (m.quantity as number) || 0;
      const avgCost = (m.avgCost as number) || 0;
      const costBasis = qty * avgCost;
      const unrealizedPnl = qty * (livePrice - avgCost);
      const currentValue = costBasis + unrealizedPnl;
      return {
        ...(m as any),
        livePrice,
        changePercent: mkt?.changePercent ?? 0,
        currentValue,
        unrealizedPnl,
        unrealizedPnlPercent: costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : 0,
        sma50: mkt?.sma50,
        sma200: mkt?.sma200,
        rsi14: mkt?.rsi14,
        dataSource: "manual",
      } as PositionWithLive;
    });
    return { livePositions, staleManualEntries: [], unmappedLiveEntries: [], source: "manual-fallback" };
  }

  // eToro live is source of truth for which symbols exist
  const liveSymbols = new Set(etoroAggregated.keys());
  const manualBySymbol = new Map<string, Record<string, unknown>>();
  for (const m of manualMetadata) manualBySymbol.set(m.symbol as string, m);

  const livePositions: PositionWithLive[] = [];
  const unmappedLiveEntries: string[] = [];

  for (const [symbol, agg] of etoroAggregated.entries()) {
    const meta = manualBySymbol.get(symbol);
    const mkt = marketData.get(symbol);
    const livePrice = mkt?.price || agg.avgCost;
    const costBasis = agg.totalInvested;
    const unrealizedPnl = agg.units * (livePrice - agg.avgCost);
    const currentValue = costBasis + unrealizedPnl;
    const unrealizedPnlPercent = costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : 0;

    const baseMeta = meta ?? {
      symbol,
      label: `${symbol} (no metadata)`,
      stopLoss: 0,
      takeProfit: 0,
      takeProfit2: 0,
      entryDate: "",
      notes: `⚠ No SL/TP set — add metadata to manual-input.json > positions[] for this symbol.`,
      status: "active",
    };
    if (!meta) unmappedLiveEntries.push(symbol);

    livePositions.push({
      ...(baseMeta as any),
      symbol,
      quantity: agg.units,    // live from eToro
      avgCost: agg.avgCost,   // live from eToro
      livePrice,
      changePercent: mkt?.changePercent ?? 0,
      currentValue,
      unrealizedPnl,
      unrealizedPnlPercent,
      sma50: mkt?.sma50,
      sma200: mkt?.sma200,
      rsi14: mkt?.rsi14,
      dataSource: "etoro-live",
    } as PositionWithLive);
  }

  // Anything in manual that is NOT in live = stale (e.g. closed position not yet removed)
  const staleManualEntries: string[] = [];
  for (const m of manualMetadata) {
    const sym = m.symbol as string;
    if (!liveSymbols.has(sym)) staleManualEntries.push(sym);
  }

  return {
    livePositions,
    staleManualEntries,
    unmappedLiveEntries,
    source: "etoro-live",
  };
}

// ─────────── Today's momentum ───────────
// Sum of (live position currentValue × Yahoo daily change %) — proxy for $ change today.

export function computeTodayPnlUSD(positions: PositionWithLive[]): number {
  return positions.reduce((sum, p) => {
    if (!p.changePercent || p.currentValue <= 0) return sum;
    return sum + (p.currentValue * (p.changePercent / 100));
  }, 0);
}

// ─────────── Performance metrics from daily/monthly snapshot history ───────────
// snapshots: ascending by date, each {date:"YYYY-MM-DD", netWorthAED, portfolioUSD}
// All annualized assuming 12 monthly observations / year.

export interface PerformanceMetrics {
  twrPct: number | null;       // total time-weighted return (begin → end)
  twrAnnualizedPct: number | null;
  cagrPct: number | null;
  maxDrawdownPct: number;       // worst peak-to-trough during window
  maxDrawdownAED: number;
  sharpe: number | null;        // monthly returns sd, rfRate as decimal
  bestMonthPct: number | null;
  worstMonthPct: number | null;
  monthsTracked: number;
  rangeStart: string | null;
  rangeEnd: string | null;
}

export function computePerformance(
  snapshots: Array<{ date: string; netWorthAED: number; portfolioUSD?: number }>,
  rfAnnualPct = 4.0
): PerformanceMetrics {
  if (!snapshots || snapshots.length < 2) {
    return {
      twrPct: null, twrAnnualizedPct: null, cagrPct: null,
      maxDrawdownPct: 0, maxDrawdownAED: 0,
      sharpe: null, bestMonthPct: null, worstMonthPct: null,
      monthsTracked: snapshots?.length ?? 0,
      rangeStart: null, rangeEnd: null,
    };
  }
  const sorted = snapshots.slice().sort((a, b) => a.date.localeCompare(b.date));
  const n = sorted.length;
  const start = sorted[0];
  const end = sorted[n - 1];

  // Per-month returns (assumes monthly cadence; use date diffs for true freq if irregular)
  const returns: number[] = [];
  for (let i = 1; i < n; i++) {
    const prev = sorted[i - 1].netWorthAED;
    const curr = sorted[i].netWorthAED;
    if (prev > 0) returns.push((curr - prev) / prev);
  }

  const twr = end.netWorthAED / start.netWorthAED - 1;
  const monthsBetween = (() => {
    const a = new Date(start.date), b = new Date(end.date);
    return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  })();
  const periods = Math.max(1, monthsBetween);
  const cagr = Math.pow(1 + twr, 12 / periods) - 1;
  const twrAnnualized = cagr;

  // Max drawdown
  let peak = sorted[0].netWorthAED;
  let maxDdPct = 0;
  let maxDdAED = 0;
  for (const s of sorted) {
    peak = Math.max(peak, s.netWorthAED);
    const dd = (s.netWorthAED - peak) / peak;
    if (dd < maxDdPct) {
      maxDdPct = dd;
      maxDdAED = s.netWorthAED - peak;
    }
  }

  // Sharpe (monthly): mean / sd × √12, minus rf
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.length > 1
    ? returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1)
    : 0;
  const sd = Math.sqrt(variance);
  const rfMonthly = rfAnnualPct / 100 / 12;
  const sharpe = sd > 0 ? ((mean - rfMonthly) / sd) * Math.sqrt(12) : null;

  return {
    twrPct: twr * 100,
    twrAnnualizedPct: twrAnnualized * 100,
    cagrPct: cagr * 100,
    maxDrawdownPct: maxDdPct * 100,
    maxDrawdownAED: maxDdAED,
    sharpe,
    bestMonthPct: returns.length ? Math.max(...returns) * 100 : null,
    worstMonthPct: returns.length ? Math.min(...returns) * 100 : null,
    monthsTracked: n,
    rangeStart: start.date,
    rangeEnd: end.date,
  };
}

// ─────────── Allocation: actual vs target by asset class ───────────
// Maps wealth components + eToro positions → {equity, crypto, commodity, rsu, cash, realEstate}
// Returns each slice with actualPct, targetPct, deviation, status.

export type AllocationSlice = {
  key: "equity" | "crypto" | "commodity" | "rsu" | "cash" | "realEstate";
  label: string;
  valueAED: number;
  actualPct: number;
  targetPct: number;
  deviationPct: number;
  status: "on-target" | "underweight" | "overweight";
  color: string;
};

const SLICE_LABELS: Record<AllocationSlice["key"], string> = {
  equity: "Equity (ETFs + Stocks)",
  crypto: "Crypto",
  commodity: "Commodity (Gold/GDX)",
  rsu: "Employer RSU",
  cash: "Cash + MMF",
  realEstate: "Real Estate",
};

const SLICE_COLORS: Record<AllocationSlice["key"], string> = {
  equity: "bg-emerald-500",
  crypto: "bg-amber-400",
  commodity: "bg-yellow-600",
  rsu: "bg-sky-400",
  cash: "bg-slate-500",
  realEstate: "bg-purple-400",
};

export function computeAllocation(
  components: Array<{ label: string; valueAED: number }>,
  positions: PositionWithLive[],
  cashIdleAED: number,
  targetAllocation: { equity: number; crypto: number; commodity: number; rsu: number; cash: number; realEstate: number; rebalanceBandPct: number }
): { slices: AllocationSlice[]; totalAED: number; bandPct: number; outOfBand: AllocationSlice[] } {
  const buckets: Record<AllocationSlice["key"], number> = {
    equity: 0, crypto: 0, commodity: 0, rsu: 0, cash: 0, realEstate: 0,
  };

  // Heuristics: classify each component by label, fall back to equity for unknowns
  for (const c of components) {
    const l = c.label.toLowerCase();
    if (/rsu/.test(l))                                 buckets.rsu += c.valueAED;
    else if (/wio|enbd|schwab cash|cash|aed account|usd account|eur account/.test(l)) buckets.cash += c.valueAED;
    else if (/real ?estate|stake|smartcrowd/.test(l))  buckets.realEstate += c.valueAED;
    else if (/etoro/.test(l))                          {/* split below */}
    else                                               buckets.equity += c.valueAED;
  }

  // Split eToro portfolio into equity/crypto/commodity by underlying positions
  const etoroComponent = components.find((c) => c.label === "eToro Portfolio");
  if (etoroComponent && positions.length > 0) {
    const totalPosValue = positions.reduce((s, p) => s + p.currentValue, 0);
    if (totalPosValue > 0) {
      for (const p of positions) {
        const share = p.currentValue / totalPosValue;
        const portion = etoroComponent.valueAED * share;
        const sym = p.symbol.toUpperCase();
        if (/BTC|ETH|SOL|XRP|CRYPTO/.test(sym))                            buckets.crypto += portion;
        else if (/GC=F|GLD|GDX|SLV|XAU|XAG|GOLD|SILVER|COPPER|BRENT/.test(sym)) buckets.commodity += portion;
        else                                                                buckets.equity += portion;
      }
    } else {
      buckets.equity += etoroComponent.valueAED;
    }
  }

  const totalAED = Object.values(buckets).reduce((s, v) => s + v, 0);
  const slices: AllocationSlice[] = (Object.keys(buckets) as Array<AllocationSlice["key"]>).map((key) => {
    const valueAED = buckets[key];
    const actualPct = totalAED > 0 ? (valueAED / totalAED) * 100 : 0;
    const targetPct = (targetAllocation as any)[key] ?? 0;
    const deviationPct = actualPct - targetPct;
    const band = targetAllocation.rebalanceBandPct;
    const status = Math.abs(deviationPct) <= band ? "on-target" : deviationPct > 0 ? "overweight" : "underweight";
    return { key, label: SLICE_LABELS[key], valueAED, actualPct, targetPct, deviationPct, status, color: SLICE_COLORS[key] };
  });

  return {
    slices,
    totalAED,
    bandPct: targetAllocation.rebalanceBandPct,
    outOfBand: slices.filter((s) => s.status !== "on-target"),
  };
}

// ─────────── Stress test: apply named shocks to wealth components ───────────

export interface StressResult {
  name: string;
  icon: string;
  netWorthAfterAED: number;
  deltaAED: number;
  deltaPct: number;
  affectedComponents: Array<{ label: string; deltaAED: number }>;
}

export function applyStressScenario(
  scenario: { name: string; icon?: string; shocks: Array<{ label: string; shockPct: number }> },
  components: Array<{ label: string; valueAED: number }>,
  liabilitiesAED: number
): StressResult {
  const baseline = components.reduce((s, c) => s + c.valueAED, 0) - liabilitiesAED;
  const affected: Array<{ label: string; deltaAED: number }> = [];

  const newComponents = components.map((c) => {
    const shock = scenario.shocks.find((s) => c.label.toLowerCase().includes(s.label.toLowerCase()));
    if (!shock) return c;
    const delta = c.valueAED * (shock.shockPct / 100);
    affected.push({ label: c.label, deltaAED: delta });
    return { ...c, valueAED: c.valueAED + delta };
  });

  const newNet = newComponents.reduce((s, c) => s + c.valueAED, 0) - liabilitiesAED;
  const deltaAED = newNet - baseline;
  return {
    name: scenario.name,
    icon: scenario.icon ?? "•",
    netWorthAfterAED: newNet,
    deltaAED,
    deltaPct: baseline > 0 ? (deltaAED / baseline) * 100 : 0,
    affectedComponents: affected,
  };
}

// ─────────── Cashflow waterfall ───────────

export interface CashflowSummary {
  monthlyIncomeAED: number;
  monthlyExpensesByCategory: Record<string, number>;
  monthlyExpensesTotal: number;
  netInvestableAED: number;
  savingsRatePct: number;
  runwayMonths: number | null; // if income stops
  liquidCashAED: number;
}

export function computeCashflow(
  income: Array<{ monthlyAED: number }>,
  expenses: Array<{ amountAED: number; category: string }>,
  liquidCashAED: number
): CashflowSummary {
  const monthlyIncome = income.reduce((s, i) => s + i.monthlyAED, 0);
  const byCat: Record<string, number> = {};
  for (const e of expenses) byCat[e.category] = (byCat[e.category] ?? 0) + e.amountAED;
  const totalExp = Object.values(byCat).reduce((s, v) => s + v, 0);
  const investable = monthlyIncome - totalExp;
  return {
    monthlyIncomeAED: monthlyIncome,
    monthlyExpensesByCategory: byCat,
    monthlyExpensesTotal: totalExp,
    netInvestableAED: investable,
    savingsRatePct: monthlyIncome > 0 ? (investable / monthlyIncome) * 100 : 0,
    runwayMonths: totalExp > 0 ? liquidCashAED / totalExp : null,
    liquidCashAED,
  };
}

// ─────────── Inflation-adjusted goal ───────────

export interface InflatedGoal {
  baseYear: number;
  realTargetAED: number;          // goal value in baseYear AED
  nominalTargetAED: number;       // grossed-up to ETA year using inflation
  etaYear: number;
  inflationPct: number;
  upliftAED: number;
}

export function inflationAdjustedGoal(
  realTargetAED: number,
  baseYear: number,
  etaYear: number,
  inflationPct: number
): InflatedGoal {
  const yrs = Math.max(0, etaYear - baseYear);
  const nominal = realTargetAED * Math.pow(1 + inflationPct / 100, yrs);
  return {
    baseYear,
    realTargetAED,
    nominalTargetAED: nominal,
    etaYear,
    inflationPct,
    upliftAED: nominal - realTargetAED,
  };
}
