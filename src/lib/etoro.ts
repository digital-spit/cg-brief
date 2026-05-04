const ETORO_BASE = "https://public-api.etoro.com/api/v1";

// eToro instrumentID → Yahoo Finance symbol (direct positions)
export const INSTRUMENT_SYMBOL_MAP: Record<number, string> = {
  18: "GC=F",       // Gold CFD
  1184: "PINS",     // Pinterest
  3006: "QQQ",      // Nasdaq 100 ETF
  4237: "VTI",      // Vanguard Total Market ETF
  4481: "TSM",      // Taiwan Semiconductor ADR
  8739: "ICLN",     // iShares Clean Energy ETF
  100000: "BTC-USD", // Bitcoin
  100001: "ETH-USD", // Ethereum
};

export interface EtoroLot {
  positionID: number;
  instrumentID: number;
  symbol: string | null;
  units: number;
  openRate: number;
  amount: number;        // USD invested in this lot (cost basis)
  leverage: number;
  stopLossRate: number;
  takeProfitRate: number;
}

export interface AggregatedPosition {
  symbol: string;
  units: number;
  avgCost: number;
  totalInvested: number;  // sum of `amount` across lots — true cost basis incl. leverage
}

export interface EtoroMirror {
  mirrorID: number | null;
  parentUsername: string;
  amountInvested: number;  // cost basis
  currentValue: number;    // live mark-to-market
  netProfit: number;       // P/L
  netProfitPct: number;    // P/L %
}

export interface EtoroPortfolio {
  fetchedAt: string;          // ISO timestamp of this pull
  cashAvailable: number;      // credit minus pending limit orders
  pendingOrdersValue: number; // cash locked in pending limit orders
  aggregated: Map<string, AggregatedPosition>;
  mirrors: EtoroMirror[];

  // Whole-portfolio totals — these are the source of truth for headline tiles
  directInvested: number;     // sum of all direct position cost bases
  directValue: number;        // populated by page.tsx after market prices applied (set to 0 here)
  mirrorsInvested: number;    // sum of all mirror cost bases
  mirrorsValue: number;       // sum of all mirror current values (live)
  mirrorsPnl: number;         // sum of all mirror P/L (live)
}

function aggregateLots(lots: EtoroLot[]): Map<string, AggregatedPosition> {
  const map = new Map<string, AggregatedPosition>();

  for (const lot of lots) {
    if (!lot.symbol || lot.units <= 0 || lot.openRate <= 0) continue;
    // Cost basis: prefer `amount` (USD invested incl. leverage adjustment); fall back to units*openRate
    const lotInvested = lot.amount > 0 ? lot.amount : lot.units * lot.openRate;

    const existing = map.get(lot.symbol);
    if (!existing) {
      map.set(lot.symbol, {
        symbol: lot.symbol,
        units: lot.units,
        avgCost: lot.openRate,
        totalInvested: lotInvested,
      });
    } else {
      const newUnits = existing.units + lot.units;
      const newInvested = existing.totalInvested + lotInvested;
      // avgCost = units-weighted entry price across lots. Must use openRate (not
      // totalInvested/units) — for leveraged positions, totalInvested is the margin,
      // so totalInvested/units would equal openRate/leverage and break per-unit math.
      const newAvgCost = (existing.avgCost * existing.units + lot.openRate * lot.units) / newUnits;
      map.set(lot.symbol, {
        symbol: lot.symbol,
        units: newUnits,
        avgCost: newAvgCost,
        totalInvested: newInvested,
      });
    }
  }

  return map;
}

// Parse a mirror (Smart Portfolio or Copy trader) from eToro's portfolio response.
// The /trading/info/portfolio endpoint does NOT return per-mirror current value or
// unrealized P/L — only positions[].amount (cost basis at lot level), availableAmount
// (idle cash within the mirror), depositSummary/withdrawalSummary (net cash deposited),
// and closedPositionsNetProfit (realized profit kept inside the mirror).
//
// Best-effort live value = sum(positions.amount) + availableAmount + closedPositionsNetProfit.
// This treats currently-open mirror positions as flat to entry — i.e., understates value
// when the Smart Portfolio is in unrealized profit. The dashboard labels mirrors as
// "● live cost basis" to be honest about this limitation.
function parseMirror(raw: Record<string, unknown>): EtoroMirror | null {
  const parentUsername = (raw.parentUsername ?? "Unknown") as string;
  const mirrorID = (raw.mirrorID ?? null) as number | null;
  const positions = (raw.positions ?? []) as Array<Record<string, unknown>>;
  const availableAmount = Number(raw.availableAmount ?? 0);
  const depositSummary = Number(raw.depositSummary ?? 0);
  const withdrawalSummary = Number(raw.withdrawalSummary ?? 0);
  const closedPositionsNetProfit = Number(raw.closedPositionsNetProfit ?? 0);

  // Cost basis of currently-open positions
  const openPositionsCostBasis = positions.reduce(
    (s, p) => s + Number(p.amount ?? 0),
    0
  );

  // Net cash you've put into this mirror from your wallet
  const amountInvested = depositSummary - withdrawalSummary;
  if (amountInvested <= 0) return null;

  // Cost-basis approach: open positions flat-to-entry + idle cash. Realized P/L is
  // already implicit (closed positions returned cash that's now in idle or re-invested).
  // This UNDERSTATES Smart Portfolios that are in unrealized profit — the dashboard
  // surfaces this honestly via the badge "● live cost basis (open P/L not included)".
  const currentValue = openPositionsCostBasis + availableAmount;
  const netProfit = closedPositionsNetProfit; // only realized P/L is knowable here
  const netProfitPct = amountInvested > 0 ? (netProfit / amountInvested) * 100 : 0;

  return {
    mirrorID,
    parentUsername,
    amountInvested,
    currentValue,
    netProfit,
    netProfitPct,
  };
}

export async function fetchEtoroPortfolio(): Promise<EtoroPortfolio | null> {
  const apiKey = process.env.ETORO_API_KEY;
  const userKey = process.env.ETORO_USER_KEY;

  if (!apiKey || !userKey) {
    console.warn("[etoro] API keys not configured — falling back to manual data");
    return null;
  }

  try {
    const res = await fetch(`${ETORO_BASE}/trading/info/portfolio`, {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": userKey,
        "x-user-key": apiKey,
        "x-request-id": crypto.randomUUID(),
      },
      next: { revalidate: 900 }, // 15 min — match Yahoo prices for consistency
    } as RequestInit);

    if (!res.ok) {
      console.warn(`[etoro] API error: ${res.status}`);
      return null;
    }

    const data = await res.json();
    const p = data.clientPortfolio;
    if (!p) {
      console.warn("[etoro] No clientPortfolio in response");
      return null;
    }

    // ── Direct positions ──
    const lots: EtoroLot[] = (p.positions ?? []).map((pos: Record<string, unknown>) => ({
      positionID: pos.positionID as number,
      instrumentID: pos.instrumentID as number,
      symbol: INSTRUMENT_SYMBOL_MAP[pos.instrumentID as number] ?? null,
      units: Number(pos.units ?? 0),
      openRate: Number(pos.openRate ?? 0),
      amount: Number(pos.amount ?? 0),
      leverage: Number(pos.leverage ?? 1),
      stopLossRate: Number(pos.stopLossRate ?? 0),
      takeProfitRate: Number(pos.takeProfitRate ?? 0),
    }));

    const aggregated = aggregateLots(lots);
    // Sum cost basis across ALL direct lots (including unmapped symbols), not just aggregated set.
    // This matches eToro's app-level "Total Invested" for the direct book.
    const directInvested = lots.reduce((s, lot) => {
      if (lot.units <= 0 || lot.openRate <= 0) return s;
      return s + (lot.amount > 0 ? lot.amount : lot.units * lot.openRate);
    }, 0);

    // ── Mirrors (Copy traders + Smart Portfolios) ──
    // eToro response may put these in `mirrors` and/or `aggregatedMirrors`
    const rawMirrors: Record<string, unknown>[] = [
      ...(p.mirrors ?? []),
      ...(p.aggregatedMirrors ?? []),
    ];
    const mirrors = rawMirrors
      .map(parseMirror)
      .filter((m): m is EtoroMirror => m !== null);

    if (mirrors.length === 0 && rawMirrors.length > 0) {
      console.warn("[etoro] mirrors present in response but failed to parse — sample keys:",
        Object.keys(rawMirrors[0] ?? {}));
    }

    const mirrorsInvested = mirrors.reduce((s, m) => s + m.amountInvested, 0);
    const mirrorsValue = mirrors.reduce((s, m) => s + m.currentValue, 0);
    const mirrorsPnl = mirrors.reduce((s, m) => s + m.netProfit, 0);

    // ── Cash ──
    const pendingOrdersValue = (p.orders ?? []).reduce(
      (sum: number, o: Record<string, unknown>) => sum + Number(o.amount ?? 0),
      0
    );
    const cashAvailable = Number(p.credit ?? 0) - pendingOrdersValue;

    return {
      fetchedAt: new Date().toISOString(),
      cashAvailable,
      pendingOrdersValue,
      aggregated,
      mirrors,
      directInvested,
      directValue: 0, // calculated downstream once Yahoo prices are joined
      mirrorsInvested,
      mirrorsValue,
      mirrorsPnl,
    };
  } catch (err) {
    console.error("[etoro] fetch failed:", err);
    return null;
  }
}
