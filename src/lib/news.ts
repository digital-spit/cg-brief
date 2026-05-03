export interface NewsItem {
  title: string;
  publisher: string;
  link: string;
  providerPublishTime: number; // unix seconds
  symbol: string;
  ageMinutes: number;
}

// Portfolio symbols to pull news for
const PORTFOLIO_SYMBOLS = [
  "PINS", "QQQ", "BTC-USD", "GC=F", "VTI", "TSM", "GDX", "ICLN",
  "BZ=F", "BTC", "ETH-USD",
];

// Macro search queries
const MACRO_QUERIES = [
  "Federal Reserve interest rates 2026",
  "Iran Hormuz war ceasefire",
  "Kevin Warsh Fed Chair",
];

async function fetchNewsForQuery(query: string, label: string): Promise<NewsItem[]> {
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&newsCount=6&lang=en-US&region=US&quotesCount=0`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; financial-dashboard/1.0)",
        "Accept": "application/json",
      },
      next: { revalidate: 1800 }, // 30 min server cache
    });
    if (!res.ok) return [];
    const data = await res.json();
    const nowSec = Math.floor(Date.now() / 1000);
    return (data.news ?? []).map((item: Record<string, unknown>) => ({
      title: item.title as string,
      publisher: item.publisher as string,
      link: item.link as string,
      providerPublishTime: item.providerPublishTime as number,
      symbol: label,
      ageMinutes: Math.max(0, Math.floor((nowSec - (item.providerPublishTime as number)) / 60)),
    }));
  } catch {
    return [];
  }
}

export async function fetchPortfolioNews(): Promise<NewsItem[]> {
  const symbolFetches = PORTFOLIO_SYMBOLS.map((sym) => fetchNewsForQuery(sym, sym));
  const macroFetches = MACRO_QUERIES.map((q, i) =>
    fetchNewsForQuery(q, ["FED", "HORMUZ", "WARSH"][i])
  );

  const allResults = await Promise.all([...symbolFetches, ...macroFetches]);
  const flat = allResults.flat();

  // Deduplicate by title (lowercase trim)
  const seen = new Set<string>();
  const deduped = flat.filter((item) => {
    const key = item.title.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort: newest first
  return deduped
    .sort((a, b) => b.providerPublishTime - a.providerPublishTime)
    .slice(0, 25);
}

export function formatAge(ageMinutes: number): { label: string; color: string } {
  if (ageMinutes < 60) {
    return { label: `${ageMinutes}m ago`, color: "text-emerald-400" };
  } else if (ageMinutes < 360) {
    const h = Math.floor(ageMinutes / 60);
    return { label: `${h}h ago`, color: "text-amber-400" };
  } else if (ageMinutes < 1440) {
    const h = Math.floor(ageMinutes / 60);
    return { label: `${h}h ago`, color: "text-orange-400" };
  } else {
    const d = Math.floor(ageMinutes / 1440);
    return { label: `${d}d ago`, color: "text-gray-500" };
  }
}
