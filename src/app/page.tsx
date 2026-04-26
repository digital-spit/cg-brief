import { fetchMarketData, calculateTrend, getRSIZone, getSignal } from "@/lib/market";
import type {
  ManualInput,
  PositionWithLive,
  Flag,
  MarketData,
} from "@/lib/types";
import manualInput from "@/data/manual-input.json";

export const revalidate = 300; // 5 min ISR

async function getDashboardData() {
  const data = manualInput as unknown as ManualInput;
  const marketData = await fetchMarketData(data.marketSymbols);
  return { data, marketData };
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
  marketDataMap: Map<string, MarketData>
): PositionWithLive {
  const mkt = getMarketData(position.symbol, marketDataMap);
  const livePrice = mkt.price || position.avgCost;
  const currentValue = position.quantity * livePrice;
  const costBasis = position.quantity * position.avgCost;
  const unrealizedPnl = currentValue - costBasis;
  const unrealizedPnlPercent =
    costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : 0;

  return {
    ...position,
    livePrice,
    changePercent: mkt.changePercent || 0,
    currentValue,
    unrealizedPnl,
    unrealizedPnlPercent,
    sma50: mkt.sma50,
    sma200: mkt.sma200,
    rsi14: mkt.rsi14,
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
  const { data, marketData } = await getDashboardData();

  const enrichedPositions = data.positions.map((pos) =>
    enrichPositionWithLiveData(pos, marketData)
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

  const totalPortfolioValue =
    currentPortfolioValue +
    data.equity.cashIdle +
    data.copyPortfolio.totalAllocated;

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
            <div className="text-right text-xs text-gray-400">
              <p>Last updated: {dateStr} {timeStr} Dubai</p>
            </div>
          </div>

          {/* Stat Tiles */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1">
                Portfolio
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
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1">
                Cash Idle
              </p>
              <p className="text-xl font-mono font-bold text-amber-400">
                {formatCurrency(data.equity.cashIdle)}
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
                <p className="font-bold text-gray-100 mb-2">
                  {data.copyPortfolio.trader} — Total Allocated{" "}
                  {formatCurrency(data.copyPortfolio.totalAllocated)}
                </p>
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
                        : item.priority === "high"
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
        </div>
      </div>

      {/* Footer */}
      <div className="mt-12 text-center text-xs text-gray-500 border-t border-gray-800 pt-5">
        <p>
          C&G Brief · {data.strategistNote.edition || "Edition"} · Generated{" "}
          {dateStr} {timeStr} Dubai · Market data refreshes every 5 min
        </p>
      </div>
    </div>
  );
}
