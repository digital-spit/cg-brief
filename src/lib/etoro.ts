const ETORO_BASE = "https://public-api.etoro.com/api/v1";

// eToro instrumentID → Yahoo Finance symbol
// Derived from live portfolio data
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
  leverage: number;
  stopLossRate: number;
  takeProfitRate: number;
}

export interface AggregatedPosition {
  symbol: string;
  units: number;
  avgCost: number;
  totalInvested: number;
}

export interface EtoroPortfolio {
  credit: number;
  aggregated: Map<string, AggregatedPosition>;
}

// Aggregate multiple eToro lots into single position per symbol
// Uses units-weighted average cost
function aggregateLots(lots: EtoroLot[]): Map<string, AggregatedPosition> {
  const map = new Map<string, AggregatedPosition>();

  for (const lot of lots) {
    if (!lot.symbol || lot.units <= 0 || lot.openRate <= 0) continue;

    const existing = map.get(lot.symbol);
    const lotInvested = lot.units * lot.openRate;

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
      map.set(lot.symbol, {
        symbol: lot.symbol,
        units: newUnits,
        avgCost: newInvested / newUnits,
        totalInvested: newInvested,
      });
    }
  }

  return map;
}

export async function fetchEtoroPortfolio(): Promise<EtoroPortfolio | null> {
  const apiKey = process.env.ETORO_API_KEY;
  const userKey = process.env.ETORO_USER_KEY;

  if (!apiKey || !userKey) {
    console.warn("eToro API keys not configured — falling back to manual data");
    return null;
  }

  try {
    const res = await fetch(`${ETORO_BASE}/trading/info/portfolio`, {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": userKey,  // userKey env var → x-api-key header (per etoro-client.ts)
        "x-user-key": apiKey,  // apiKey env var → x-user-key header (per etoro-client.ts)
        "x-request-id": crypto.randomUUID(),
      },
      next: { revalidate: 3600 }, // 1 hour cadence
    } as RequestInit);

    if (!res.ok) {
      console.warn(`eToro API error: ${res.status}`);
      return null;
    }

    const data = await res.json();
    const p = data.clientPortfolio;

    const lots: EtoroLot[] = (p.positions ?? []).map((pos: Record<string, unknown>) => ({
      positionID: pos.positionID,
      instrumentID: pos.instrumentID,
      symbol: INSTRUMENT_SYMBOL_MAP[pos.instrumentID as number] ?? null,
      units: pos.units,
      openRate: pos.openRate,
      leverage: pos.leverage,
      stopLossRate: pos.stopLossRate,
      takeProfitRate: pos.takeProfitRate,
    }));

    return {
      credit: p.credit ?? 0,
      aggregated: aggregateLots(lots),
    };
  } catch (err) {
    console.error("eToro fetch failed:", err);
    return null;
  }
}