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
}

export function classifyActionZone(pos: PositionWithLive & { addZones?: any }): ActionZone {
  const p = pos.livePrice;
  const sl = pos.stopLoss;
  const tp1 = pos.takeProfit;
  const tp2 = pos.takeProfit2;
  const az = (pos as any).addZones;

  const slBufPct = sl > 0 ? ((p - sl) / p) * 100 : Infinity;
  const tp1ApproachPct = tp1 > 0 ? ((tp1 - p) / p) * 100 : Infinity;
  const tp2ApproachPct = tp2 > 0 ? ((tp2 - p) / p) * 100 : Infinity;

  // ── Risk side (high urgency) ──
  if (p <= sl) {
    return {
      symbol: pos.symbol, label: pos.label, kind: "below-sl", urgency: 100,
      cta: "RESPECT STOP", rationale: `Below SL $${sl.toFixed(2)} — exit now or document a clear thesis to stay in.`,
      livePrice: p, pnlPercent: pos.unrealizedPnlPercent, color: "red",
    };
  }
  if (slBufPct < 3) {
    return {
      symbol: pos.symbol, label: pos.label, kind: "near-sl", urgency: 90,
      cta: "TIGHTEN / REVIEW", rationale: `Only ${slBufPct.toFixed(1)}% above SL — manage size or hedge.`,
      livePrice: p, pnlPercent: pos.unrealizedPnlPercent, color: "red",
    };
  }

  // ── Profit side ──
  if (tp2 > 0 && p >= tp2) {
    return {
      symbol: pos.symbol, label: pos.label, kind: "hit-tp2", urgency: 95,
      cta: "TAKE PROFIT (TP2)", rationale: `Hit TP2 — book ≥50%, trail rest.`,
      livePrice: p, pnlPercent: pos.unrealizedPnlPercent, color: "emerald",
    };
  }
  if (tp1 > 0 && p >= tp1) {
    return {
      symbol: pos.symbol, label: pos.label, kind: "hit-tp1", urgency: 80,
      cta: "TRIM (TP1)", rationale: `Hit TP1 — trim 25–33%, raise SL to breakeven.`,
      livePrice: p, pnlPercent: pos.unrealizedPnlPercent, color: "emerald",
    };
  }
  if (tp2 > 0 && tp2ApproachPct >= 0 && tp2ApproachPct < 4) {
    return {
      symbol: pos.symbol, label: pos.label, kind: "near-tp2", urgency: 75,
      cta: "PREPARE TO TRIM", rationale: `${tp2ApproachPct.toFixed(1)}% from TP2 — set sell ladder.`,
      livePrice: p, pnlPercent: pos.unrealizedPnlPercent, color: "emerald",
    };
  }
  if (tp1 > 0 && tp1ApproachPct >= 0 && tp1ApproachPct < 5) {
    return {
      symbol: pos.symbol, label: pos.label, kind: "near-tp1", urgency: 65,
      cta: "PREPARE TO TRIM", rationale: `${tp1ApproachPct.toFixed(1)}% from TP1 — set sell ladder.`,
      livePrice: p, pnlPercent: pos.unrealizedPnlPercent, color: "emerald",
    };
  }

  // ── Add zones (medium urgency, opportunity to deploy capital) ──
  if (az) {
    if (az.dipConviction && p >= az.dipConviction.min && p <= az.dipConviction.max) {
      return {
        symbol: pos.symbol, label: pos.label, kind: "add-conviction", urgency: 70,
        cta: "ADD — CONVICTION", rationale: `In conviction zone $${az.dipConviction.min}–${az.dipConviction.max}: ${az.dipConviction.note}`,
        livePrice: p, pnlPercent: pos.unrealizedPnlPercent, color: "sky",
      };
    }
    if (az.dipMedium && p >= az.dipMedium.min && p <= az.dipMedium.max) {
      return {
        symbol: pos.symbol, label: pos.label, kind: "add-medium", urgency: 55,
        cta: "ADD — MEDIUM", rationale: `In dip zone $${az.dipMedium.min}–${az.dipMedium.max}: ${az.dipMedium.note}`,
        livePrice: p, pnlPercent: pos.unrealizedPnlPercent, color: "amber",
      };
    }
    if (az.dipLight && p >= az.dipLight.min && p <= az.dipLight.max) {
      return {
        symbol: pos.symbol, label: pos.label, kind: "add-light", urgency: 40,
        cta: "ADD — LIGHT", rationale: `In light dip $${az.dipLight.min}–${az.dipLight.max}: ${az.dipLight.note}`,
        livePrice: p, pnlPercent: pos.unrealizedPnlPercent, color: "amber",
      };
    }
    if (az.uptrendAdd && p >= az.uptrendAdd.price) {
      return {
        symbol: pos.symbol, label: pos.label, kind: "add-uptrend", urgency: 50,
        cta: "ADD — UPTREND", rationale: `Above $${az.uptrendAdd.price}: ${az.uptrendAdd.note}`,
        livePrice: p, pnlPercent: pos.unrealizedPnlPercent, color: "sky",
      };
    }
  }

  // ── Coast ──
  return {
    symbol: pos.symbol, label: pos.label, kind: "coast", urgency: 10,
    cta: "HOLD", rationale: `Between SL ($${sl}) and TP1 ($${tp1}) — no action.`,
    livePrice: p, pnlPercent: pos.unrealizedPnlPercent, color: "gray",
  };
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
