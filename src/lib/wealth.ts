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

// ─────────── Today's momentum ───────────
// Sum of (live position currentValue × Yahoo daily change %) — proxy for $ change today.

export function computeTodayPnlUSD(positions: PositionWithLive[]): number {
  return positions.reduce((sum, p) => {
    if (!p.changePercent || p.currentValue <= 0) return sum;
    return sum + (p.currentValue * (p.changePercent / 100));
  }, 0);
}
