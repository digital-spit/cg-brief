"use client";

import { useEffect, useState, useCallback } from "react";

interface NewsItem {
  title: string;
  publisher: string;
  link: string;
  providerPublishTime: number;
  symbol: string;
  ageMinutes: number;
}

function formatAge(ageMinutes: number): { label: string; color: string } {
  if (ageMinutes < 60) {
    return { label: `${ageMinutes}m ago`, color: "text-emerald-400" };
  } else if (ageMinutes < 360) {
    return { label: `${Math.floor(ageMinutes / 60)}h ago`, color: "text-amber-400" };
  } else if (ageMinutes < 1440) {
    return { label: `${Math.floor(ageMinutes / 60)}h ago`, color: "text-orange-400" };
  } else {
    return { label: `${Math.floor(ageMinutes / 1440)}d ago`, color: "text-gray-500" };
  }
}

const SYMBOL_LABELS: Record<string, string> = {
  "PINS": "PINS",
  "QQQ": "QQQ",
  "BTC-USD": "BTC",
  "BTC": "BTC",
  "GC=F": "GOLD",
  "VTI": "VTI",
  "TSM": "TSM",
  "GDX": "GDX",
  "ICLN": "ICLN",
  "BZ=F": "OIL",
  "ETH-USD": "ETH",
  "FED": "FED",
  "HORMUZ": "WAR",
  "WARSH": "FED",
};

const SYMBOL_COLORS: Record<string, string> = {
  "PINS": "bg-sky-900/60 text-sky-300 border-sky-700",
  "QQQ": "bg-indigo-900/60 text-indigo-300 border-indigo-700",
  "BTC": "bg-orange-900/60 text-orange-300 border-orange-700",
  "BTC-USD": "bg-orange-900/60 text-orange-300 border-orange-700",
  "GOLD": "bg-yellow-900/60 text-yellow-300 border-yellow-700",
  "GC=F": "bg-yellow-900/60 text-yellow-300 border-yellow-700",
  "GDX": "bg-yellow-900/40 text-yellow-400 border-yellow-800",
  "OIL": "bg-red-900/60 text-red-300 border-red-700",
  "FED": "bg-purple-900/60 text-purple-300 border-purple-700",
  "WAR": "bg-red-950/80 text-red-400 border-red-800",
  "TSM": "bg-blue-900/60 text-blue-300 border-blue-700",
  "VTI": "bg-emerald-900/60 text-emerald-300 border-emerald-700",
  "ETH": "bg-violet-900/60 text-violet-300 border-violet-700",
  "ICLN": "bg-green-900/60 text-green-300 border-green-700",
};

function getSymbolBadge(symbol: string) {
  const label = SYMBOL_LABELS[symbol] ?? symbol;
  const cls = SYMBOL_COLORS[label] ?? SYMBOL_COLORS[symbol] ?? "bg-gray-800 text-gray-400 border-gray-600";
  return { label, cls };
}

export default function LiveNewsFeed() {
  const [news, setNews] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [error, setError] = useState(false);

  const loadNews = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch("/api/news", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      setNews(data.news ?? []);
      setFetchedAt(data.fetchedAt);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadNews();
    // Auto-refresh every 30 minutes
    const interval = setInterval(loadNews, 30 * 60 * 1000);
    return () => clearInterval(interval);
  }, [loadNews]);

  const fetchedMinsAgo = fetchedAt
    ? Math.floor((Date.now() - fetchedAt) / 60000)
    : null;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-8">
      <div className="flex items-center justify-between mb-4 pb-2 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">
            Live Intelligence Feed
          </p>
          {!loading && fetchedAt && (
            <span className="text-emerald-500 text-xs">
              ● live{fetchedMinsAgo !== null && fetchedMinsAgo > 0 ? ` · fetched ${fetchedMinsAgo}m ago` : ""}
            </span>
          )}
          {loading && (
            <span className="text-gray-500 text-xs animate-pulse">● fetching...</span>
          )}
        </div>
        <button
          onClick={loadNews}
          disabled={loading}
          className="text-xs px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 transition-all disabled:opacity-40"
        >
          ↻ refresh
        </button>
      </div>

      {error && (
        <p className="text-xs text-red-400 italic">
          Failed to load news feed — Yahoo Finance may be rate limiting. Try refreshing.
        </p>
      )}

      {loading && !error && (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="animate-pulse flex gap-3 items-start">
              <div className="h-4 w-12 bg-gray-800 rounded" />
              <div className="flex-1 h-4 bg-gray-800 rounded" />
              <div className="h-4 w-10 bg-gray-800 rounded" />
            </div>
          ))}
        </div>
      )}

      {!loading && !error && news.length === 0 && (
        <p className="text-xs text-gray-500 italic">No recent news found.</p>
      )}

      {!loading && news.length > 0 && (
        <div className="space-y-1.5 max-h-96 overflow-y-auto pr-1">
          {news.map((item, idx) => {
            const age = formatAge(item.ageMinutes);
            const badge = getSymbolBadge(item.symbol);
            return (
              <a
                key={idx}
                href={item.link}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-start gap-2.5 py-1.5 border-b border-gray-800/50 last:border-0 hover:bg-gray-800/30 rounded px-1 -mx-1 transition-colors group"
              >
                <span
                  className={`shrink-0 mt-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded border ${badge.cls}`}
                >
                  {badge.label}
                </span>
                <span className="text-xs text-gray-300 group-hover:text-white leading-relaxed flex-1 line-clamp-2">
                  {item.title}
                </span>
                <span className={`shrink-0 text-[10px] font-mono mt-0.5 ${age.color}`}>
                  {age.label}
                </span>
              </a>
            );
          })}
        </div>
      )}

      {!loading && news.length > 0 && (
        <p className="text-[10px] text-gray-700 mt-3">
          Source: Yahoo Finance · {news.length} headlines · auto-refreshes every 30 min
        </p>
      )}
    </div>
  );
}
