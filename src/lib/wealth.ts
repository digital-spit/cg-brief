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
    detail?: string;     // expected outcome — booked profit, leftover position, etc.
    steps?: string[];    // exact eToro UI path, numbered
    note?: string;       // multi-lot / FIFO / tax behavior caveat
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
        instruction: `Close all ${fmtUnits(qty)} ${symbol} → ~${fmtUSD(proceedsUSD)} (full exit)`,
        detail: `Realize loss ~${fmtUSD(pos.unrealizedPnl)} (${pos.unrealizedPnlPercent.toFixed(1)}%). UAE $0 CGT — full proceeds redeployable.`,
        steps: [
          `On eToro app/web, open the ${symbol} position`,
          `Tap "Close Position" on the aggregated row`,
          `Confirm market close — all lots close at live price`,
        ],
        note: `If you hold multiple lots, eToro closes them all at once — single order, no FIFO concerns.`,
      };
    }
    case "near-sl": {
      const trimUnits = qty * 0.5;
      const proceedsUSD = trimUnits * p;
      return {
        instruction: `Trim 50% (${fmtUnits(trimUnits)} ${symbol} ≈ ${fmtUSD(proceedsUSD)}) OR move SL up`,
        detail: `Choose ONE: (a) reduce exposure by half, leaves ${fmtUnits(qty - trimUnits)} ${symbol} ≈ ${fmtUSD((qty - trimUnits) * p)} riding; (b) raise SL to ${fmtUSD(p * 0.97)} to lock in survival without giving up upside.`,
        steps: [
          `(Option a) Open ${symbol} in eToro → Edit Trade → Partial close ${fmtUnits(trimUnits)} units`,
          `(Option b) Open each ${symbol} lot → Edit Trade → set Stop Loss to ${fmtUSD(p * 0.97)}`,
        ],
        note: `Option (b) keeps 100% of upside but tightens risk. Pick based on conviction in the thesis.`,
      };
    }
    case "hit-tp2": {
      const trimUnits = qty * 0.5;
      const proceedsUSD = trimUnits * p;
      return {
        instruction: `Sell 50% (${fmtUnits(trimUnits)} ${symbol} ≈ ${fmtUSD(proceedsUSD)}) at market; trail SL on remainder`,
        detail: `Books ≈ ${fmtUSD(trimUnits * (p - pos.avgCost))} profit at TP2. Leaves ${fmtUnits(qty - trimUnits)} ${symbol} (≈${fmtUSD((qty - trimUnits) * p)}) riding for the cycle high.`,
        steps: [
          `On eToro, open ${symbol} → Edit Trade on the aggregated position`,
          `Choose "Partial Close" → enter ${fmtUnits(trimUnits)} units`,
          `Confirm at market price`,
          `Then on the remaining open lots: Edit Trade → set Stop Loss to ${fmtUSD(p * 0.92)} (trailing)`,
        ],
        note: `Multi-lot? eToro closes oldest lots first (FIFO). UAE zero CGT means lot order is tax-irrelevant — just take the proceeds.`,
      };
    }
    case "hit-tp1": {
      const trimUnits = qty * 0.30;
      const proceedsUSD = trimUnits * p;
      const bookedProfit = trimUnits * (p - pos.avgCost);
      return {
        instruction: `Sell 30% (${fmtUnits(trimUnits)} ${symbol} ≈ ${fmtUSD(proceedsUSD)}); raise SL to breakeven`,
        detail: `Books ≈ ${fmtUSD(bookedProfit)} profit. Leaves ${fmtUnits(qty - trimUnits)} ${symbol} (≈${fmtUSD((qty - trimUnits) * p)}) free-rolling toward TP2 with breakeven SL — zero further risk on remainder.`,
        steps: [
          `On eToro, open ${symbol} → Edit Trade on the aggregated position`,
          `Choose "Partial Close" → enter ${fmtUnits(trimUnits)} units`,
          `Confirm at market price`,
          `On the remaining lots: Edit Trade → set Stop Loss to $${pos.avgCost.toFixed(2)} (your avg cost)`,
        ],
        note: `Multi-lot caveat: eToro's partial close fills oldest lots first (FIFO). With UAE zero CGT this is a non-issue — accept the default. New avg cost on the remaining ${fmtUnits(qty - trimUnits)} ${symbol} stays at $${pos.avgCost.toFixed(2)}.`,
      };
    }
    case "near-tp2":
    case "near-tp1": {
      const ladderTarget = kind === "near-tp2" ? pos.takeProfit2 : pos.takeProfit;
      const tpName = kind === "near-tp2" ? "TP2" : "TP1";
      const ladderTrim = kind === "near-tp2" ? qty * 0.50 : qty * 0.30;
      const trimPct = kind === "near-tp2" ? "50%" : "30%";
      return {
        instruction: `Pre-set a ${trimPct} ladder: auto-sell ${fmtUnits(ladderTrim)} ${symbol} when price hits $${ladderTarget.toFixed(2)} (${tpName})`,
        detail: `Locks in ≈ ${fmtUSD(ladderTrim * ladderTarget)} proceeds (${fmtUSD(ladderTrim * (ladderTarget - pos.avgCost))} profit) automatically the moment ${tpName} prints. No manual monitoring. Distance to target: ${(((ladderTarget - p) / p) * 100).toFixed(1)}%.`,
        steps: [
          `On eToro, open ${symbol} position page`,
          `Tap "Edit Trade" on the aggregated position (NOT a single lot)`,
          `Set "Take Profit" to $${ladderTarget.toFixed(2)}`,
          `If eToro asks how much to close, choose "Partial" and enter ${fmtUnits(ladderTrim)} units`,
          `Save. Order sits dormant until price hits — then closes automatically at market`,
        ],
        note: `Multi-lot caveat: setting TP on the aggregated position closes lots oldest-first when triggered. UAE zero CGT = lot order doesn't matter for tax; you just want the proceeds. Alternative: set the same TP on each individual lot (Edit Trade per lot) if you want to control exactly which lots close — only worth it if specific lots have meaning to you (e.g., emotional or DCA-tracking).`,
      };
    }
    case "add-conviction":
    case "add-medium":
    case "add-light":
    case "add-uptrend": {
      const budgetAED = ADD_BUDGET_AED[kind] ?? 2500;
      const budgetUSD = budgetAED / usdToAed;
      const addUnits = budgetUSD / p;
      const newAvg = (qty * pos.avgCost + addUnits * p) / (qty + addUnits);
      return {
        instruction: `Buy ${fmtUnits(addUnits)} ${symbol} ≈ ${fmtUSD(budgetUSD)} (AED ${budgetAED.toLocaleString()})`,
        detail: `Creates a new lot at $${p.toFixed(2)}. Aggregated avg cost moves from $${pos.avgCost.toFixed(2)} → $${newAvg.toFixed(2)} across ${fmtUnits(qty + addUnits)} ${symbol} total.`,
        steps: [
          `On eToro, search ${symbol} (or open the existing position page)`,
          `Tap "Trade" → "Buy"`,
          `Enter amount: $${budgetUSD.toFixed(0)} (or ${fmtUnits(addUnits)} units)`,
          `Set Stop Loss: $${pos.stopLoss.toFixed(2)} (same as your existing SL — keeps thesis aligned)`,
          `Confirm at market price`,
        ],
        note: `This adds a NEW lot — your existing lots stay untouched. eToro will list it separately under the same symbol. Total exposure becomes ${fmtUnits(qty + addUnits)} ${symbol} ≈ ${fmtUSD((qty + addUnits) * p)}.`,
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

// ─────────── Cash Deployment Plan ───────────
// Treasury-grade allocation of total idle cash across institutions, factoring:
// - 6-month emergency reserve based on actual monthly burn
// - Yield parking for cash not deployable within 30 days (MMF/Fixed Saving)
// - Conviction-weighted candidate trades from watchlist + position add-zones
// - Diversification toward under-target allocation buckets

export interface DeploymentTrade {
  source: "conviction-watchlist" | "existing-addzone" | "underweight-bucket" | "yield-park";
  vehicle: string;            // e.g. "eToro buy", "Wio Fixed Saving USD"
  symbol?: string;
  label: string;
  type?: string;              // stock | etf | crypto | commodity | mmf
  sizeAED: number;
  sizeUSD?: number;
  units?: number;
  livePrice?: number;
  conviction?: number;        // 1-10
  rationale: string;
  priority: number;           // 0-100, higher first
  instruction: string;        // imperative one-liner
  steps?: string[];
}

export interface DeploymentPlan {
  totalLiquidAED: number;
  emergencyReserveAED: number;
  reserveCoverMonths: number;
  deployableAED: number;
  mmfParkAED: number;
  deployNowAED: number;
  trades: DeploymentTrade[];
  byBucketAED: Record<string, number>;
}

interface BuildPlanInput {
  cashAccounts: Array<{ label: string; currency: string; balance: number; balanceAED: number }>;
  enbdAED: number;                  // ENBD AED current (post-CC)
  etoroCashUSD: number;             // eToro free cash
  schwabCashUSD: number;             // Schwab MMF (already yielding)
  usdToAed: number;
  monthlyBurnAED: number;            // from cashflow.monthlyExpensesTotal
  watchlist: Array<{
    symbol: string; label: string; type: string; conviction: number;
    signal: string; entryZone?: { min: number; max: number }; thesis?: string;
  }>;
  marketData: Map<string, MarketData>;
  positionsWithZones: Array<PositionWithLive & { addZones?: any }>;
  underweightBuckets: Array<{ key: string; label: string; deviationPct: number; targetPct: number }>;
}

const ADD_BUDGET_BY_CONVICTION_AED: Record<number, number> = {
  10: 8000, 9: 6000, 8: 5000, 7: 4000, 6: 3000, 5: 2500, 4: 2000, 3: 1500, 2: 1000, 1: 1000,
};

export function buildCashDeploymentPlan(input: BuildPlanInput): DeploymentPlan {
  // ── 1. Total liquid ──
  const cashAcctsAED = input.cashAccounts.reduce((s, a) => s + a.balanceAED, 0);
  const etoroCashAED = input.etoroCashUSD * input.usdToAed;
  const schwabAED = input.schwabCashUSD * input.usdToAed; // already at ~4.7%, exclude from deployable
  const totalLiquidAED = cashAcctsAED + input.enbdAED + etoroCashAED + schwabAED;

  // ── 2. Emergency reserve: 6 months × monthly burn ──
  const reserveCoverMonths = 6;
  const emergencyReserveAED = input.monthlyBurnAED * reserveCoverMonths;

  // ── 3. Deployable surplus ──
  const deployableAED = Math.max(0, totalLiquidAED - emergencyReserveAED - schwabAED);

  // ── 4. MMF park: 30% of surplus to keep opportunistic dry powder yielding ──
  const mmfParkAED = Math.round(deployableAED * 0.30);
  const deployNowAED = deployableAED - mmfParkAED;

  // ── 5. Candidate trades ──
  const candidates: DeploymentTrade[] = [];

  // 5a. Watchlist conviction buys with live price in entry zone
  for (const pick of input.watchlist) {
    if (!pick.entryZone) continue;
    if (pick.signal !== "strong_buy" && pick.signal !== "buy") continue;
    const live = input.marketData.get(pick.symbol)?.price ?? 0;
    if (live <= 0) continue;
    const inZone = live >= pick.entryZone.min && live <= pick.entryZone.max;
    const aboveZone = live > pick.entryZone.max;
    if (!inZone && !aboveZone) continue; // wait if below zone (still cheap, fine to add) — actually allow
    const placement = inZone ? "in entry zone" : "above entry zone — chasing";
    const sizeAED = ADD_BUDGET_BY_CONVICTION_AED[pick.conviction] ?? 2500;
    const sizeUSD = sizeAED / input.usdToAed;
    const units = sizeUSD / live;
    candidates.push({
      source: "conviction-watchlist",
      vehicle: "eToro buy",
      symbol: pick.symbol,
      label: pick.label,
      type: pick.type,
      sizeAED,
      sizeUSD,
      units,
      livePrice: live,
      conviction: pick.conviction,
      priority: pick.conviction * 10 + (inZone ? 5 : 0) + (pick.signal === "strong_buy" ? 3 : 0),
      rationale: `Conviction ${pick.conviction}/10 · ${pick.signal.replace("_", " ")} · ${placement} ($${pick.entryZone.min}-${pick.entryZone.max})${pick.thesis ? ` · ${pick.thesis.slice(0, 90)}…` : ""}`,
      instruction: `Buy AED ${sizeAED.toLocaleString()} (≈ $${sizeUSD.toFixed(0)}) of ${pick.symbol} @ ~$${live.toFixed(2)} on eToro`,
      steps: [
        `On eToro, search "${pick.symbol}" → tap Trade → Buy`,
        `Enter $${sizeUSD.toFixed(0)} OR ${units >= 1 ? units.toFixed(2) : units.toFixed(4)} units`,
        `Set Stop Loss to fund-off level for this thesis`,
        `Confirm at market`,
      ],
    });
  }

  // 5b. Existing positions currently in ADD zones
  for (const pos of input.positionsWithZones) {
    const az = (pos as any).addZones;
    if (!az) continue;
    const p = pos.livePrice;
    let zone: string | null = null;
    let conv = 5;
    if (az.dipConviction && p >= az.dipConviction.min && p <= az.dipConviction.max) { zone = "conviction"; conv = 9; }
    else if (az.dipMedium && p >= az.dipMedium.min && p <= az.dipMedium.max) { zone = "medium"; conv = 6; }
    else if (az.dipLight && p >= az.dipLight.min && p <= az.dipLight.max) { zone = "light"; conv = 4; }
    else if (az.uptrendAdd && p >= az.uptrendAdd.price) { zone = "uptrend"; conv = 5; }
    if (!zone) continue;
    const sizeAED = ADD_BUDGET_BY_CONVICTION_AED[conv] ?? 2500;
    const sizeUSD = sizeAED / input.usdToAed;
    const units = sizeUSD / p;
    candidates.push({
      source: "existing-addzone",
      vehicle: "eToro add to existing",
      symbol: pos.symbol,
      label: pos.label,
      type: pos.symbol.includes("BTC") || pos.symbol.includes("ETH") ? "crypto" : "equity",
      sizeAED,
      sizeUSD,
      units,
      livePrice: p,
      conviction: conv,
      priority: conv * 10 + 8, // existing positions get a small priority bump (already-aligned thesis)
      rationale: `Existing position in ${zone} zone — already vetted thesis. Avg cost stays anchored.`,
      instruction: `Buy AED ${sizeAED.toLocaleString()} (≈ $${sizeUSD.toFixed(0)}) more ${pos.symbol} @ ~$${p.toFixed(2)} on eToro`,
      steps: [
        `On eToro, open ${pos.symbol} → tap Trade → Buy`,
        `Enter $${sizeUSD.toFixed(0)} OR ${units >= 1 ? units.toFixed(2) : units.toFixed(4)} units`,
        `Set Stop Loss to $${pos.stopLoss.toFixed(2)} (existing SL)`,
        `Confirm — this creates a new lot under same symbol`,
      ],
    });
  }

  // 5c. Diversification fillers for underweight buckets (only if no high-conviction in that bucket already)
  const bucketCovered = new Set(candidates.map((c) => c.type));
  for (const u of input.underweightBuckets) {
    if (bucketCovered.has(u.key)) continue; // existing candidate fills this bucket
    if (Math.abs(u.deviationPct) < 2) continue; // not meaningfully underweight
    const fillSizeAED = Math.min(4000, Math.round(Math.abs(u.deviationPct) * 100));
    if (fillSizeAED < 1000) continue;
    candidates.push({
      source: "underweight-bucket",
      vehicle: u.key === "cash" ? "Wio Fixed Saving USD" : "eToro broad-market ETF",
      label: `Diversify into ${u.label}`,
      type: u.key,
      sizeAED: fillSizeAED,
      conviction: 5,
      priority: 30 + Math.abs(u.deviationPct), // lower than conviction picks
      rationale: `${u.label} is ${Math.abs(u.deviationPct).toFixed(1)}% under target ${u.targetPct}% — buy a broad proxy to rebalance.`,
      instruction: `Allocate AED ${fillSizeAED.toLocaleString()} toward ${u.label} (e.g. ${u.key === "equity" ? "VTI" : u.key === "crypto" ? "ETH-USD" : u.key === "commodity" ? "GC=F" : "Wio MMF"})`,
    });
  }

  // ── 6. Sort + budget allocation ──
  candidates.sort((a, b) => b.priority - a.priority);
  const trades: DeploymentTrade[] = [];
  let remainingBudget = deployNowAED;
  const byBucket: Record<string, number> = {};
  for (const c of candidates) {
    if (remainingBudget < 1000) break;
    const sized = Math.min(c.sizeAED, remainingBudget);
    if (sized < 1000) continue; // skip dust
    trades.push({ ...c, sizeAED: sized });
    remainingBudget -= sized;
    const k = c.type ?? "other";
    byBucket[k] = (byBucket[k] ?? 0) + sized;
  }

  // ── 7. MMF park as a final trade ──
  if (mmfParkAED >= 1000) {
    trades.push({
      source: "yield-park",
      vehicle: "Wio Fixed Saving USD or Schwab SWVXX",
      label: "Park dry powder at ~4.7% MMF",
      sizeAED: mmfParkAED,
      priority: 0,
      rationale: `30% of surplus held in MMF — ready to deploy on next signal. Earns ~AED ${Math.round(mmfParkAED * 0.047).toLocaleString()}/yr while waiting.`,
      instruction: `Move AED ${mmfParkAED.toLocaleString()} to Wio Fixed Saving USD or Schwab SWVXX (~4.7% APR)`,
      steps: [
        `Wio: Open Spaces → New Saving Space → Fixed (USD) → enter $${(mmfParkAED / input.usdToAed).toFixed(0)}`,
        `Or Schwab: Move cash to SWVXX (auto-yields, fully liquid)`,
      ],
    });
    byBucket["mmf"] = mmfParkAED;
  }

  return {
    totalLiquidAED,
    emergencyReserveAED,
    reserveCoverMonths,
    deployableAED,
    mmfParkAED,
    deployNowAED,
    trades,
    byBucketAED: byBucket,
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
