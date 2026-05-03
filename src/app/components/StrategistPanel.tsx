"use client";

import { useState } from "react";

interface StrategistNote {
  title: string;
  body: string;
  edition?: string;
  stalenessWarning?: string;
}

interface ActionItem {
  label: string;
  priority: string;
  done: boolean;
}

interface PortfolioSnapshot {
  portfolioValue: number;
  cashIdle: number;
  totalPnL: number;
  isEtoroLive: boolean;
  positions: Array<{
    symbol: string;
    livePrice: number;
    avgCost: number;
    unrealizedPnlPercent: number;
    stopLoss: number;
    takeProfit: number;
  }>;
  events: Array<{ date: string; label: string; priority: string }>;
  warStatus: { status: string; description: string };
  marketContext: Array<{ symbol: string; price: number; changePercent: number }>;
}

interface Props {
  initialNote: StrategistNote;
  initialActionItems: ActionItem[];
  portfolioSnapshot: PortfolioSnapshot;
}

const PRIORITY_STYLES: Record<string, string> = {
  critical: "bg-red-950/40 border-red-800 text-red-200",
  high:     "bg-amber-950/30 border-amber-800 text-amber-100",
  medium:   "bg-gray-800/40 border-gray-700 text-gray-200",
  low:      "bg-gray-900/40 border-gray-800 text-gray-400",
};

const PRIORITY_DOT: Record<string, string> = {
  critical: "bg-red-500",
  high:     "bg-amber-500",
  medium:   "bg-gray-500",
  low:      "bg-gray-700",
};

export default function StrategistPanel({
  initialNote,
  initialActionItems,
  portfolioSnapshot,
}: Props) {
  const [note, setNote] = useState<StrategistNote>(initialNote);
  const [actionItems, setActionItems] = useState<ActionItem[]>(initialActionItems);
  const [loading, setLoading] = useState(false);
  const [generatedAt, setGeneratedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [isFallback, setIsFallback] = useState(false);

  async function regenerate() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/strategist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(portfolioSnapshot),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setNote({
        title: data.title,
        body: data.body,
        edition: data.edition,
      });
      setActionItems(data.actionItems ?? []);
      setGeneratedAt(data.generatedAt);
      setIsLive(true);
      setIsFallback(!!data._fallback);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      setError(`Analysis error: ${msg}`);
    } finally {
      setLoading(false);
    }
  }

  const minsAgo =
    generatedAt !== null ? Math.floor((Date.now() - generatedAt) / 60000) : null;

  return (
    <>
      {/* Strategist Note */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">
              Strategist Note
            </p>
            {isLive ? (
              isFallback ? (
                <span className="text-amber-400 text-xs">⚡ rule-based · {minsAgo === 0 ? "just now" : `${minsAgo}m ago`}</span>
              ) : (
                <span className="text-emerald-500 text-xs">● AI live · {minsAgo === 0 ? "just now" : `${minsAgo}m ago`}</span>
              )
            ) : (
              <span className="text-amber-500 text-xs">⚠ manual — may be stale</span>
            )}
          </div>
          <button
            onClick={regenerate}
            disabled={loading}
            className="shrink-0 text-xs px-3 py-1.5 rounded-lg bg-indigo-900/50 hover:bg-indigo-800/60 text-indigo-300 hover:text-indigo-100 border border-indigo-700 hover:border-indigo-500 transition-all disabled:opacity-50 disabled:cursor-not-allowed font-semibold"
          >
            {loading ? "⟳ Generating..." : "⚡ Live Analysis"}
          </button>
        </div>

        {error && (
          <div className="bg-red-950/40 border border-red-800 rounded-lg p-3 mb-3 text-xs text-red-300">
            {error}
          </div>
        )}

        <p className="text-sm font-semibold text-gray-200 mb-2 italic leading-snug">
          {note.title}
        </p>
        <p className="text-sm text-gray-400 leading-relaxed">{note.body}</p>

        {note.edition && (
          <p className="text-[10px] text-gray-600 mt-2">{note.edition}</p>
        )}
      </div>

      {/* Action Items */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex items-center gap-2 mb-4 pb-2 border-b border-gray-800">
          <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">
            Action Items
          </p>
          {isLive && (
            <span className="text-emerald-500 text-xs">● live</span>
          )}
        </div>
        <div className="space-y-2">
          {actionItems.map((item, idx) => {
            const style =
              PRIORITY_STYLES[item.priority] ?? PRIORITY_STYLES.medium;
            const dot = PRIORITY_DOT[item.priority] ?? PRIORITY_DOT.medium;
            return (
              <div
                key={idx}
                className={`rounded-lg p-3 text-xs border ${style} ${
                  item.done ? "opacity-40 line-through" : ""
                }`}
              >
                <div className="flex items-start gap-2">
                  <span className={`mt-1 shrink-0 w-1.5 h-1.5 rounded-full ${dot}`} />
                  <p className="leading-relaxed">{item.label}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
