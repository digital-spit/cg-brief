import manualInput from "@/data/manual-input.json";
import { fetchMarketData, calculateTrend, getRSIZone } from "@/lib/market";
import type { ManualInput, PositionWithLive } from "@/lib/types";
import { NextResponse } from "next/server";

// Cache at edge for 5 minutes to keep the artifact snappy without hammering Yahoo Finance.
export const revalidate = 300;

/**
 * GET /api/snapshot
 *
 * Returns the full ManualInput document with positions enriched by live market
 * data (price, % change, SMA50/200, RSI14, trend). Used by the Cowork
 * "cg-brief-mirror" artifact for at-a-glance trading state without alt-tabbing.
 *
 * No auth — same threat model as the public dashboard page.
 */
export async function GET() {
  const snapshot = manualInput as ManualInput;

  // Collect all symbols we need live data for: positions + marketSymbols
  const symbols = Array.from(
    new Set([
      ...snapshot.positions.map((p) => p.symbol),
      ...(snapshot.marketSymbols ?? []),
    ])
  );

  let positionsWithLive: PositionWithLive[] = [];
  let marketDataMap: Record<string, unknown> = {};

  try {
    const marketData = await fetchMarketData(symbols);

    positionsWithLive = snapshot.positions.map((position) => {
      const live = marketData.get(position.symbol);
      const livePrice = live?.price ?? 0;
      const changePercent = live?.changePercent ?? 0;
      const currentValue = livePrice * position.quantity;
      const costBasis = position.avgCost * position.quantity;
      const unrealizedPnl = currentValue - costBasis;
      const unrealizedPnlPercent = costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : 0;
      const trend = calculateTrend(livePrice, live?.sma50, live?.sma200);
      const rsiZone = getRSIZone(live?.rsi14);

      return {
        ...position,
        livePrice,
        changePercent,
        currentValue,
        unrealizedPnl,
        unrealizedPnlPercent,
        sma50: live?.sma50,
        sma200: live?.sma200,
        rsi14: live?.rsi14,
        trend,
        rsiZone,
      } as PositionWithLive & { trend: string; rsiZone: string };
    });

    // Surface market data for non-position symbols too (indices, references)
    for (const [symbol, data] of marketData.entries()) {
      marketDataMap[symbol] = data;
    }
  } catch (error) {
    console.error("snapshot route — fetchMarketData failed:", error);
    // Fall back to positions without live data so the artifact still renders
    positionsWithLive = snapshot.positions.map((p) => ({
      ...p,
      livePrice: 0,
      changePercent: 0,
      currentValue: 0,
      unrealizedPnl: 0,
      unrealizedPnlPercent: 0,
    }));
  }

  return NextResponse.json(
    {
      snapshot,
      positionsLive: positionsWithLive,
      marketData: marketDataMap,
      fetchedAt: Date.now(),
      lastUpdated: snapshot.lastUpdated,
    },
    {
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=900",
      },
    }
  );
}
