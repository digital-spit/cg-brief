"use client";

import { useState } from "react";
import InteractiveChecklist from "./InteractiveChecklist";

interface StrategistNote {
  title: string;
  body: string;
  edition?: string;
  stalenessWarning?: string;
}

// Known tickers in this user's universe — used to render mono badges
const KNOWN_TICKERS = new Set([
  "BTC", "ETH", "SOL", "XRP", "MSTR",
  "PINS", "SNAP", "VTI", "QQQ", "TSM", "ICLN", "GDX", "SLV",
  "AVGO", "NVDA", "MRVL", "VRT", "FCX", "SCCO", "WPM", "RGLD",
  "GOOG", "AMZN", "META", "AAPL", "MSFT", "NFLX", "WMT",
  "TP1", "TP2", "SL", "RSU", "ETF", "AED", "USD", "EUR", "FOMC", "CPI", "PPI",
  "BOE", "ECB", "GDP", "CGT", "IRA",
]);

// Words/phrases that trigger color tinting per sentence
const URGENCY_RED = /\b(CRITICAL|do not|don't|exit|stop|fraud|lawsuit|⚠️|⚠|Decide before|caution|avoid|risk|losing)\b/i;
const URGENCY_GREEN = /\b(accumulate|add|deploy|TP1|TP2|breakout|bullish|inflows|cycle intact|strongest)\b/i;
const URGENCY_AMBER = /\b(wait|hold|monitor|reassess|trim|review|watch|trigger)\b/i;

function classifySentence(s: string): "red" | "green" | "amber" | "gray" {
  if (URGENCY_RED.test(s)) return "red";
  if (URGENCY_GREEN.test(s)) return "green";
  if (URGENCY_AMBER.test(s)) return "amber";
  return "gray";
}

const TONE_STYLES: Record<string, string> = {
  red:   "border-l-2 border-red-700 bg-red-950/20 text-gray-200",
  green: "border-l-2 border-emerald-700 bg-emerald-950/20 text-gray-200",
  amber: "border-l-2 border-amber-700 bg-amber-950/15 text-gray-200",
  gray:  "border-l-2 border-gray-700 bg-gray-800/30 text-gray-300",
};

// Split body on sentence boundaries, preserving en-dashes inside a sentence.
function splitSentences(body: string): string[] {
  // Split on ". " or "! " followed by capital/emoji, but keep ⚠ markers attached.
  return body
    .split(/(?<=[.!?])\s+(?=[A-Z⚠🚨📊🏛️🥇₿📈🔑📡🛒🤖🔧🔥📉📌])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Render a sentence with ticker badges + price highlights inline.
function renderRichSentence(s: string, key: number): JSX.Element {
  // Tokenize: split on whitespace, preserve, then re-style known tickers / $ / %
  const parts = s.split(/(\s+)/);
  return (
    <p key={key} className="text-[13px] leading-relaxed">
      {parts.map((tok, i) => {
        // strip trailing punctuation for ticker check
        const clean = tok.replace(/[.,:;!?)\]]+$/, "");
        const trail = tok.slice(clean.length);
        if (KNOWN_TICKERS.has(clean)) {
          return (
            <span key={i}>
              <span className="font-mono text-[12px] px-1.5 py-0.5 rounded bg-gray-700/70 text-emerald-300 font-semibold">
                {clean}
              </span>
              {trail}
            </span>
          );
        }
        // price like $75K, $4,612, $20.22, AED 115K
        if (/^\$[\d,]+(\.\d+)?[KMB]?$/.test(clean) || /^AED$/.test(clean)) {
          return <span key={i} className="font-mono text-amber-300">{tok}</span>;
        }
        // percent
        if (/^[+-]?\d+(\.\d+)?%$/.test(clean)) {
          const positive = clean.startsWith("+") || (!clean.startsWith("-") && parseFloat(clean) > 0);
          return <span key={i} className={`font-mono ${positive ? "text-emerald-400" : "text-red-400"}`}>{tok}</span>;
        }
        return <span key={i}>{tok}</span>;
      })}
    </p>
  );
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

        <p className="text-base font-semibold text-white mb-3 leading-snug">
          {note.title}
        </p>
        <div className="space-y-1.5">
          {splitSentences(note.body).map((sentence, idx) => {
            const tone = classifySentence(sentence);
            return (
              <div key={idx} className={`rounded-r-md pl-3 pr-2 py-1.5 ${TONE_STYLES[tone]}`}>
                {renderRichSentence(sentence, idx)}
              </div>
            );
          })}
        </div>

        {note.edition && (
          <p className="text-[10px] text-gray-600 mt-3 font-mono">{note.edition}</p>
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
        <InteractiveChecklist
          storagePrefix="strategistAction"
          showResetButton={true}
          items={actionItems.map((item, idx) => {
            const style = PRIORITY_STYLES[item.priority] ?? PRIORITY_STYLES.medium;
            const dot = PRIORITY_DOT[item.priority] ?? PRIORITY_DOT.medium;
            return {
              id: `${item.priority}-${item.label.slice(0, 60)}-${idx}`,
              content: (
                <div className={`rounded-lg p-3 text-xs border ${style}`}>
                  <div className="flex items-start gap-2">
                    <span className={`mt-1 shrink-0 w-1.5 h-1.5 rounded-full ${dot}`} />
                    <p className="leading-relaxed">{item.label}</p>
                  </div>
                </div>
              ),
            };
          })}
        />
      </div>
    </>
  );
}
