import manualInput from "@/data/manual-input.json";
import { fetchMarketData, calculateTrend, getRSIZone } from "@/lib/market";
import { fetchEtoroPortfolio } from "@/lib/etoro";
import { reconcilePositions } from "@/lib/wealth";
import type { ManualInput, PositionWithLive, MarketData } from "@/lib/types";
import { NextResponse } from "next/server";

// Cache at edge for 5 minutes to keep the artifact snappy without hammering Yahoo/eToro.
export const revalidate = 300;

/**
 * GET /api/snapshot
 *
 * Returns the full ManualInput document with positions reconciled against the
 * LIVE eToro book. eToro is the only source of truth for which positions exist,
 * their quantities, and their average cost. The manual `positions[]` array in
 * data/manual-input.json supplies metadata only (SL/TP/notes/addZones/label),
 * joined by symbol.
 *
 * V2 policy — no silent stale data. If eToro is unreachable, this endpoint
 * returns an empty `positionsLive` array and `dataSource: "etoro-unavailable"`
 * with HTTP 503 so that consumers (Cowork artifact, scheduled review task)
 * never compute decisions from a 14-day-old phantom book.
 *
 * No auth — same threat model as the public dashboard page.
 */
export async function GET() {
  const snapshot = manualInput as ManualInput;

  // ── 1. Fetch eToro live first — this is the gate for serving any positions.
  const etoro = await fetchEtoroPortfolio();

  // ── 2. Collect symbols for market data: prefer live eToro symbols when present,
  //       otherwise just pull the watchlist/index symbols. Never use manual qty.
  const liveSymbols = etoro ? Array.from(etoro.aggregated.keys()) : [];
  const symbols = Array.from(
    new Set([
      ...liveSymbols,
      ...(snapshot.marketSymbols ?? []),
    ])
  );

  let marketDataMap: Record<string, MarketData> = {};
  let marketData = new Map<string, MarketData>();
  try {
    marketData = await fetchMarketData(symbols);
    for (const [symbol, data] of marketData.entries()) {
      marketDataMap[symbol] = data;
    }
  } catch (error) {
    console.error("snapshot route — fetchMarketData failed:", error);
    // Market data failure is non-fatal; reconciliation still runs with empty prices.
  }

  // ── 3. Reconcile: eToro live qty/avgCost + manual metadata (SL/TP/notes).
  //       requireLive: true → if eToro is unavailable, return empty positions and
  //       fail loudly rather than serving manual fallback data.
  const reconciled = reconcilePositions(
    snapshot.positions as unknown as Array<Record<string, unknown>>,
    etoro?.aggregated,
    marketData,
    { requireLive: true }
  );

  // ── 4. Enrich reconciled positions with trend + rsiZone computed from market data.
  const positionsLive: PositionWithLive[] = reconciled.livePositions.map((p) => ({
    ...p,
    trend: calculateTrend(p.livePrice, p.sma50, p.sma200),
    rsiZone: getRSIZone(p.rsi14),
  } as PositionWithLive & { trend: string; rsiZone: string }));

  // ── 5. Replace snapshot.positions with the reconciled live view so any consumer
  //       reading `snapshot.positions` sees real data, not the manual qty/avgCost.
  //       When eToro is unavailable, positions is an empty array — consumer must
  //       check `dataSource` before using any numbers.
  const reconciledSnapshot = {
    ...snapshot,
    positions: positionsLive,
  };

  const isLive = reconciled.source === "etoro-live";
  const httpStatus = isLive ? 200 : 503;

  return NextResponse.json(
    {
      snapshot: reconciledSnapshot,
      positionsLive,
      marketData: marketDataMap,
      fetchedAt: Date.now(),
      lastUpdated: snapshot.lastUpdated,

      // V2 source-of-truth diagnostics — every consumer should check these.
      dataSource: reconciled.source,                // "etoro-live" | "etoro-unavailable" | "manual-fallback"
      etoroFetchedAt: etoro?.fetchedAt ?? null,
      etoroCashUSD: etoro?.cashAvailable ?? null,
      etoroPositionCount: etoro?.aggregated.size ?? 0,
      staleManualEntries: reconciled.staleManualEntries,    // in manual but not live (e.g. ICLN)
      unmappedLiveEntries: reconciled.unmappedLiveEntries,  // in live but no manual metadata
      warnings: isLive ? [] : [
        "eToro live data unavailable. Positions array is intentionally empty.",
        "Do NOT make decisions from this response. Reconnect etoro-mcp and retry.",
      ],
    },
    {
      status: httpStatus,
      headers: {
        "Cache-Control": isLive
          ? "public, s-maxage=300, stale-while-revalidate=900"
          : "no-store", // never cache an unavailable state
      },
    }
  );
}
