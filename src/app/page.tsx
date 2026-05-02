import { fetchMarketData, calculateTrend, getRSIZone, getSignal } from "@/lib/market";
import { fetchEtoroPortfolio } from "@/lib/etoro";
import type {
  ManualInput,
  PositionWithLive,
  Flag,
  MarketData,
  SmartPortfolio,
} from "@/lib/types";
import manualInput from "@/data/manual-input.json";
import RefreshButton from "./refresh-button";

export const revalidate = 900; // 15 min ISR — Refresh button bypasses cache on demand

async function getDashboardData() {
  const data = manualInput as unknown as ManualInput;
  // Fetch market prices (15 min) and eToro portfolio (1 hr) in parallel
  const [marketData, etoroData] = await Promise.all([
    fetchMarketData(data.marketSymbols),
    fetchEtoroPortfolio(),
  ]);
  return { data, marketData, etoroData };
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
  etoroAggregated?: Map<string, { units: number; avgCost: number }>
): PositionWithLive {
  // Use live eToro units/avgCost if available, otherwise fall back to manual-input.json
  const liveEtoro = etoroAggregated?.get(position.symbol);
  const quantity = liveEtoro?.units ?? position.quantity;
  const avgCost = liveEtoro?.avgCost ?? position.avgCost;

  const mkt = getMarketData(position.symbol, marketDataMap);
  const livePrice = mkt.price || avgCost;
  const currentValue = quantity * livePrice;
  const costBasis = quantity * avgCost;
  const unrealizedPnl = currentValue - costBasis;
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
  const { data, marketData, etoroData } = await getDashboardData();

  // Live cash from eToro API, falls back to manual-input.json
  const cashIdle = etoroData?.credit ?? data.equity.cashIdle;
  const isEtoroLive = etoroData !== null;

  const enrichedPositions = data.positions.map((pos) =>
    enrichPositionWithLiveData(pos, marketData, etoroData?.aggregated)
  );

  const copyPortfolioValue = enrichedPositions
    .filter(
      (pos) =>
        data.copyPortfolio.positions.some(
          (cp) => cp.symbol === pos.symbol
        ) && pos.avgCost === 0
    )
    .reduce((sum, pos) => sum + pos.currentValue, 0);

  const investedValue = enrichedPositions.reduce(
    (sum, pos) => sum + pos.quantity * pos.avgCost,
    0
  );

  const currentPortfolioValue = enrichedPositions.reduce(
    (sum, pos) => sum + pos.currentValue,
    0
  );

  // Portfolio value: live positions (Yahoo prices × live eToro units) + live cash
  const totalPortfolioValue = isEtoroLive
    ? currentPortfolioValue + cashIdle
    : data.equity.endingUnrealized;

  const totalPnL = currentPortfolioValue - investedValue;

  const allFlags = enrichedPositions.flatMap(getPositionFlags);

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
  ];
  const marketTiles = marketSymbols.map((sym) => getMarketData(sym, marketData));

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-5">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">C&G Brief</h1>
              <p className="text-sm text-gray-400">
                {data.strategistNote.edition || "Edition"}
              </p>
            </div>
            <div className="flex flex-col items-end gap-2">
              <RefreshButton />
              <p className="text-xs text-gray-500">data as of {dateStr} {timeStr} Dubai</p>
            </div>
          </div>

          {/* Stat Tiles */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1 flex items-center gap-1">
                Portfolio
                {isEtoroLive && (
                  <span className="text-emerald-500 text-xs font-normal normal-case tracking-normal">● live</span>
                )}
              </p>
              <p className="text-xl font-mono font-bold">
                {formatCurrency(totalPortfolioValue)}
              </p>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1">
                Invested
              </p>
              <p className="text-xl font-mono font-bold">
                {formatCurrency(investedValue)}
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
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1">
                Period P/L
              </p>
              <p
                className={`text-xl font-mono font-bold ${
                  data.equity.periodPnl >= 0
                    ? "text-emerald-400"
                    : "text-red-400"
                }`}
              >
                {formatCurrency(data.equity.periodPnl)}
              </p>
            </div>
          </div>
        </div>

        {/* Strategist Note */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-8">
          <p className="text-sm italic text-gray-300 font-semibold mb-2">
            {data.strategistNote.title}
          </p>
          <p className="text-sm text-gray-400 leading-relaxed">
            {data.strategistNote.body}
          </p>
        </div>

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
                          = ${(pos.quantity * pos.avgCost).toFixed(2)}
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

            {/* Smart Portfolios */}
            {data.smartPortfolios && data.smartPortfolios.length > 0 && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                <p className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-4 pb-2 border-b border-gray-800">
                  Smart Portfolios
                </p>
                <div className="space-y-2">
                  {(data.smartPortfolios as SmartPortfolio[]).map((sp) => (
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
                  ))}
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
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 gap-3">
                {marketTiles.map((mkt) => {
                  const labels: Record<string, string> = {
                    "^GSPC": "S&P 500",
                    "^IXIC": "Nasdaq",
                    "GC=F": "Gold",
                    "BZ=F": "Brent Crude",
                    "BTC-USD": "BTC",
                    "ETH-USD": "ETH",
                  };
                  return (
                    <div
                      key={mkt.symbol}
                      className="bg-gray-800/30 border border-gray-700 rounded-lg p-3"
                    >
                      <p className="text-xs font-bold text-gray-400 mb-1">
                        {labels[mkt.symbol] || mkt.symbol}
                      </p>
                      <p className="font-mono font-bold text-gray-100">
                        {mkt.price > 0
                          ? mkt.price > 100
                            ? mkt.price.toFixed(0)
                            : mkt.price.toFixed(4)
                          : "—"}
                      </p>
                      <p
                        className={`text-xs font-mono ${
                          mkt.changePercent >= 0
                            ? "text-emerald-400"
                            : "text-red-400"
                        }`}
                      >
                        {mkt.price > 0
                          ? formatPercent(mkt.changePercent)
                          : "—"}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Technical Signals */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-4 pb-2 border-b border-gray-800">
                Technical Signals
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-gray-800">
                      <th className="text-left py-2 px-2 text-gray-400 font-semibold">
                        Symbol
                      </th>
                      <th className="text-right py-2 px-2 text-gray-400 font-semibold">
                        RSI14
                      </th>
                      <th className="text-left py-2 px-2 text-gray-400 font-semibold">
                        Trend
                      </th>
                      <th className="text-left py-2 px-2 text-gray-400 font-semibold">
                        Signal
                      </th>
                      <th className="text-left py-2 px-2 text-gray-400 font-semibold">
                        Recommendation
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {enrichedPositions.map((pos) => {
                      const trend = calculateTrend(
                        pos.livePrice,
                        pos.sma50,
                        pos.sma200
                      );
                      const rsiZone = getRSIZone(pos.rsi14);
                      const { signal, recommendation } = getSignal(
                        trend,
                        rsiZone
                      );
                      return (
                        <tr
                          key={pos.symbol}
                          className="border-b border-gray-800/50 hover:bg-gray-800/20"
                        >
                          <td className="py-2 px-2 font-mono text-gray-200">
                            {pos.symbol}
                          </td>
                          <td className="py-2 px-2 text-right font-mono text-gray-300">
                            {pos.rsi14
                              ? pos.rsi14.toFixed(1)
                              : "—"}
                          </td>
                          <td className="py-2 px-2 capitalize text-gray-300">
                            {trend}
                          </td>
                          <td className="py-2 px-2 capitalize font-semibold">
                            <span
                              className={
                                signal === "buy"
                                  ? "text-emerald-400"
                                  : signal === "sell"
                                    ? "text-red-400"
                                    : signal === "hold"
                                      ? "text-amber-400"
                                      : "text-gray-400"
                              }
                            >
                              {signal}
                            </span>
                          </td>
                          <td className="py-2 px-2 text-gray-400">
                            {recommendation}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Right Column */}
          <div className="lg:col-span-1 space-y-5">
            {/* Wealth Progress */}
            {data.wealthProgress && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                <p className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-4 pb-2 border-b border-gray-800">
                  AED 1M Progress
                </p>
                {(() => {
                  const wp = data.wealthProgress!;
                  const total = wp.components.reduce((s, c) => s + c.valueAED, 0);
                  const pct = Math.min((total / wp.goalAED) * 100, 100);
                  const segColors: Record<string, string> = {
                    emerald: "bg-emerald-500",
                    amber: "bg-amber-400",
                    sky: "bg-sky-400",
                    purple: "bg-purple-400",
                  };
                  return (
                    <div>
                      {/* Big number */}
                      <div className="flex justify-between items-baseline mb-3">
                        <p className="text-2xl font-mono font-bold text-white">
                          {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(total).replace("$", "AED ")}
                        </p>
                        <p className="text-sm text-gray-400">/ AED 1,000,000</p>
                      </div>

                      {/* Stacked bar */}
                      <div className="h-4 bg-gray-800 rounded-full overflow-hidden flex mb-3">
                        {wp.components.map((c, i) => (
                          <div
                            key={i}
                            className={`${segColors[c.color] || "bg-gray-500"} h-full transition-all`}
                            style={{ width: `${(c.valueAED / wp.goalAED) * 100}%` }}
                            title={`${c.label}: AED ${c.valueAED.toLocaleString()}`}
                          />
                        ))}
                        {/* Unknown gap */}
                        <div className="bg-gray-700/40 h-full flex-1 border-l border-dashed border-gray-600" />
                      </div>

                      {/* Percentage */}
                      <p className="text-right text-xs text-gray-400 mb-4 font-mono">
                        <span className="text-lg font-bold text-white">{pct.toFixed(1)}%</span> tracked toward goal
                      </p>

                      {/* Component breakdown */}
                      <div className="space-y-2 text-xs">
                        {wp.components.map((c, i) => (
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
                        {/* Untracked */}
                        <div className="mt-3 pt-2 border-t border-gray-800">
                          <p className="text-gray-600 mb-1">⬜ Not yet tracked:</p>
                          {wp.untracked?.map((u, i) => (
                            <p key={i} className="text-gray-700 ml-2">· {u}</p>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Portfolio Flags */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-4 pb-2 border-b border-gray-800">
                Portfolio Flags
              </p>
              <div className="space-y-2">
                {allFlags.length === 0 ? (
                  <p className="text-xs text-gray-400 italic">
                    All positions nominal
                  </p>
                ) : (
                  allFlags.map((flag, idx) => (
                    <div
                      key={idx}
                      className={`rounded-lg p-3 text-xs border ${
                        flag.severity === "critical"
                          ? "bg-red-950/30 border-red-800"
                          : flag.severity === "watch"
                            ? "bg-amber-950/30 border-amber-800"
                            : "bg-emerald-950/30 border-emerald-800"
                      }`}
                    >
                      <p className="font-semibold text-gray-100">
                        {flag.title}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Upcoming Catalysts */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-4 pb-2 border-b border-gray-800">
                Upcoming Catalysts
              </p>
              <div className="space-y-2 text-xs">
                {data.events.map((evt, idx) => (
                  <div
                    key={idx}
                    className="border-b border-gray-800 pb-2 last:border-0"
                  >
                    <p className="text-gray-300 font-semibold">{evt.label}</p>
                    <p className="text-gray-500">
                      {evt.date} · {evt.symbol} · {evt.type}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            {/* War & Deployment */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-4 pb-2 border-b border-gray-800">
                War & Deployment
              </p>
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

            {/* Action Items */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-4 pb-2 border-b border-gray-800">
                Action Items
              </p>
              <div className="space-y-2">
                {data.actionItems.map((item, idx) => (
                  <div
                    key={idx}
                    className={`rounded-lg p-2 text-xs border-l-4 ${
                      item.done
                        ? "bg-gray-800/50 border-gray-600 text-gray-500 line-through"
                        : item.priority === "critical" || item.priority === "high"
                          ? "bg-red-950/30 border-red-600"
                          : item.priority === "medium"
                            ? "bg-amber-950/30 border-amber-600"
                            : "bg-gray-800/30 border-gray-600"
                    }`}
                  >
                    <p>{item.label}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Bull Run Watchlist — full width */}
          {data.bullRunWatchlist && data.bullRunWatchlist.length > 0 && (
            <div className="lg:col-span-3 bg-gray-900 border border-gray-800 rounded-xl p-5">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-4 pb-2 border-b border-gray-800">
                🔥 Bull Run Watchlist — Next Entries
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {data.bullRunWatchlist!.map((pick, idx) => {
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
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          <span className={`text-xs font-bold px-2 py-0.5 rounded border ${signalColors[pick.signal] || "bg-gray-700 border-gray-600 text-gray-400"}`}>
                            {signalLabel[pick.signal] || pick.signal}
                          </span>
                          <span className={`text-xs font-semibold ${typeColors[pick.type] || "text-gray-500"}`}>
                            {pick.type?.toUpperCase()}
                          </span>
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
