"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function RefreshButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<string | null>(null);

  const handleRefresh = async () => {
    setLoading(true);
    router.refresh();
    // Give the server a moment to revalidate, then clear loading state
    await new Promise((r) => setTimeout(r, 1500));
    const now = new Date().toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
    setLastRefreshed(now);
    setLoading(false);
  };

  return (
    <div className="flex items-center gap-2">
      {lastRefreshed && (
        <span className="text-xs text-emerald-500 font-mono">
          ✓ refreshed {lastRefreshed}
        </span>
      )}
      <button
        onClick={handleRefresh}
        disabled={loading}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-700 bg-gray-800 hover:bg-gray-700 hover:border-gray-500 text-gray-300 hover:text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <svg
          className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
          />
        </svg>
        {loading ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  );
}
