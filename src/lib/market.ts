import type { MarketData } from "./types";

interface YahooResponse {
  chart: {
    result: Array<{
      meta: {
        regularMarketPrice?: number;
        regularMarketChangePercent?: number;
      };
      timestamp?: number[];
      indicators?: {
        adjclose?: Array<{
          adjclose?: number[];
        }>;
      };
    }>;
    error: null;
  };
}

export async function fetchMarketData(symbols: string[]): Promise<Map<string, MarketData>> {
  const results = new Map<string, MarketData>();

  for (const symbol of symbols) {
    try {
      const response = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=200d&includeAdjustedClose=true`,
        { next: { revalidate: 300 } } as RequestInit
      );

      if (!response.ok) {
        console.warn(`Failed to fetch ${symbol}: ${response.status}`);
        results.set(symbol, {
          symbol,
          price: 0,
          changePercent: 0,
        });
        continue;
      }

      const data = (await response.json()) as YahooResponse;

      if (!data.chart?.result?.[0]) {
        console.warn(`No data for ${symbol}`);
        results.set(symbol, {
          symbol,
          price: 0,
          changePercent: 0,
        });
        continue;
      }

      const result = data.chart.result[0];
      const price = result.meta.regularMarketPrice ?? 0;
      const changePercent = result.meta.regularMarketChangePercent ?? 0;

      let sma50: number | undefined;
      let sma200: number | undefined;
      let rsi14: number | undefined;

      const prices = result.indicators?.adjclose?.[0]?.adjclose;
      if (prices && Array.isArray(prices)) {
        const validPrices = prices.filter((p) => p != null);

        if (validPrices.length >= 50) {
          sma50 = validPrices.slice(-50).reduce((a, b) => a + b) / 50;
        }

        if (validPrices.length >= 200) {
          sma200 = validPrices.slice(-200).reduce((a, b) => a + b) / 200;
        }

        if (validPrices.length >= 15) {
          rsi14 = calculateRSI(validPrices, 14);
        }
      }

      results.set(symbol, {
        symbol,
        price,
        changePercent,
        sma50,
        sma200,
        rsi14,
      });
    } catch (error) {
      console.error(`Error fetching ${symbol}:`, error);
      results.set(symbol, {
        symbol,
        price: 0,
        changePercent: 0,
      });
    }
  }

  return results;
}

function calculateRSI(prices: number[], period: number): number {
  if (prices.length < period + 1) return 50;

  const deltas: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    deltas.push(prices[i] - prices[i - 1]);
  }

  let gains = 0;
  let losses = 0;

  for (let i = 0; i < period; i++) {
    const delta = deltas[i];
    if (delta > 0) gains += delta;
    else losses -= delta;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period; i < deltas.length; i++) {
    const delta = deltas[i];
    if (delta > 0) {
      avgGain = (avgGain * (period - 1) + delta) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) - delta) / period;
    }
  }

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function calculateTrend(
  price: number,
  sma50?: number,
  sma200?: number
): string {
  if (!sma50 || !sma200) return "unknown";
  if (price > sma50 && sma50 > sma200) return "uptrend";
  if (price < sma50 && sma50 < sma200) return "downtrend";
  return "sideways";
}

export function getRSIZone(
  rsi?: number
): "oversold" | "bearish" | "neutral" | "bullish" | "overbought" {
  if (!rsi) return "neutral";
  if (rsi < 30) return "oversold";
  if (rsi < 45) return "bearish";
  if (rsi < 55) return "neutral";
  if (rsi < 70) return "bullish";
  return "overbought";
}

export function getSignal(
  trend: string,
  rsiZone: string
): { signal: string; recommendation: string } {
  if (trend === "uptrend") {
    if (rsiZone === "overbought") {
      return { signal: "hold", recommendation: "Trail stop, don't chase" };
    }
    if (rsiZone === "bullish" || rsiZone === "neutral") {
      return { signal: "buy", recommendation: "Add on dips" };
    }
    return { signal: "neutral", recommendation: "Wait for RSI recovery" };
  }

  if (trend === "downtrend") {
    return { signal: "sell", recommendation: "Consider exit" };
  }

  return { signal: "neutral", recommendation: "Await breakout" };
}
