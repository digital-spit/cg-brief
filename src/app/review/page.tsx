// Sunday Review — the 10-minute decision page.
//
// Goal: walk in, skim, take 3 actions, walk out. No JSON editing, no reconciliation.
// Inputs: manual-input.json (positions metadata, events, allocation targets) +
//         live Yahoo prices + live eToro portfolio (when available).
// Output: a single scrollable page with action blocks in priority order.

import { fetchMarketData, calculateTrend, getRSIZone } from "@/lib/market";
import { fetchEtoroPortfolio } from "@/lib/etoro";
import { reconcilePositions, computeAllocation } from "@/lib/wealth";
import type { ManualInput, PositionWithLive, MarketData } from "@/lib/types";
import manualInput from "@/data/manual-input.json";
import InteractiveChecklist from "../components/InteractiveChecklist";
import Link from "next/link";

// Always render fresh — Sunday Review is rare/manual traffic, so caching adds risk
// (stale action recommendations) for negligible perf gain. Bypass CDN entirely.
export const dynamic = "force-dynamic";
export const revalidate = 0;

// ─── Helpers ───────────────────────────────────────────────────────────

function daysOldDubai(dateStr?: string): number | null {
  if (!dateStr) return null;
  const today = new Date(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Dubai" }));
  const then = new Date(dateStr);
  if (isNaN(then.getTime())) return null;
  return Math.floor((today.getTime() - then.getTime()) / (1000 * 60 * 60 * 24));
}

function fmtUSD(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}
function fmtPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}
function fmtPrice(n: number): string {
  if (n === 0) return "—";
  if (n > 100) return `$${n.toFixed(2)}`;
  if (n > 10) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

// ─── Action classification ─────────────────────────────────────────────

interface Action {
  kind: "TRIM_HARD" | "TRIM" | "CUT" | "ADD_CONVICTION" | "ADD_LIGHT" | "EARNINGS";
  symbol: string;
  label: string;
  livePrice: number;
  refPrice: number;        // SL or TP being measured against
  pctToRef: number;        // signed % distance to ref
  unrealizedPnlPct: number;
  thesis: string;
  recommendation: string;
  positionUSD: number;
}

function classifyPositions(positions: PositionWithLive[], rawPositions: any[]): Action[] {
  const out: Action[] = [];

  for (const p of positions) {
    if (!p.livePrice || p.livePrice === 0) continue;
    const raw = rawPositions.find((rp) => rp.symbol === p.symbol);

    // TRIM_HARD: hit TP2 — major trim
    if (p.takeProfit2 && p.livePrice >= p.takeProfit2) {
      out.push({
        kind: "TRIM_HARD", symbol: p.symbol, label: p.label,
        livePrice: p.livePrice, refPrice: p.takeProfit2,
        pctToRef: ((p.livePrice - p.takeProfit2) / p.takeProfit2) * 100,
        unrealizedPnlPct: p.unrealizedPnlPercent,
        thesis: `TP2 hit — full thesis achieved`,
        recommendation: `Trim 50%, trail stop on rest`,
        positionUSD: p.currentValue,
      });
      continue;
    }

    // TRIM: hit TP1 or past
    if (p.takeProfit && p.livePrice >= p.takeProfit) {
      const pctPast = ((p.livePrice - p.takeProfit) / p.takeProfit) * 100;
      out.push({
        kind: "TRIM", symbol: p.symbol, label: p.label,
        livePrice: p.livePrice, refPrice: p.takeProfit,
        pctToRef: pctPast,
        unrealizedPnlPct: p.unrealizedPnlPercent,
        thesis: pctPast > 5 ? `${pctPast.toFixed(1)}% past TP1 — riding house money` : `at TP1`,
        recommendation: pctPast > 5
          ? `Trim 25-30%, raise stop to entry. Don't let it round-trip.`
          : `Pre-stage trim order. Decide if scaling or full exit.`,
        positionUSD: p.currentValue,
      });
      continue;
    }

    // CUT: within 6% of stop
    if (p.stopLoss && p.livePrice <= p.stopLoss * 1.06) {
      const distPct = ((p.livePrice - p.stopLoss) / p.stopLoss) * 100;
      out.push({
        kind: "CUT", symbol: p.symbol, label: p.label,
        livePrice: p.livePrice, refPrice: p.stopLoss,
        pctToRef: distPct,
        unrealizedPnlPct: p.unrealizedPnlPercent,
        thesis: distPct <= 0 ? `STOPPED OUT — below ${fmtPrice(p.stopLoss)}` : `${distPct.toFixed(1)}% above stop`,
        recommendation: distPct <= 0
          ? `Honour the stop. Cut now. No averaging down.`
          : `Decide: cut at stop or widen the leash (only if thesis intact).`,
        positionUSD: p.currentValue,
      });
      continue;
    }

    // ADD_CONVICTION: in dipConviction zone
    const az = raw?.addZones;
    if (az?.dipConviction && p.livePrice >= az.dipConviction.min && p.livePrice <= az.dipConviction.max) {
      out.push({
        kind: "ADD_CONVICTION", symbol: p.symbol, label: p.label,
        livePrice: p.livePrice, refPrice: (az.dipConviction.min + az.dipConviction.max) / 2,
        pctToRef: 0,
        unrealizedPnlPct: p.unrealizedPnlPercent,
        thesis: az.dipConviction.note ?? "In conviction add zone",
        recommendation: `Back up the truck. Deploy from idle cash.`,
        positionUSD: p.currentValue,
      });
      continue;
    }
    // ADD_LIGHT: in dipMedium / dipLight zone
    const lightZone = az?.dipMedium ?? az?.dipLight;
    if (lightZone && p.livePrice >= lightZone.min && p.livePrice <= lightZone.max) {
      out.push({
        kind: "ADD_LIGHT", symbol: p.symbol, label: p.label,
        livePrice: p.livePrice, refPrice: (lightZone.min + lightZone.max) / 2,
        pctToRef: 0,
        unrealizedPnlPct: p.unrealizedPnlPercent,
        thesis: lightZone.note ?? "In add zone",
        recommendation: `Light add (¼ of normal size). Save firepower for conviction zone.`,
        positionUSD: p.currentValue,
      });
    }
  }
  return out;
}

// Priority order for rendering
const ACTION_ORDER: Record<Action["kind"], number> = {
  CUT: 0, TRIM_HARD: 1, TRIM: 2, ADD_CONVICTION: 3, ADD_LIGHT: 4, EARNINGS: 5,
};

const ACTION_STYLE: Record<Action["kind"], { badge: string; ring: string; label: string }> = {
  CUT:             { badge: "bg-red-900/50 text-red-200 border-red-700",       ring: "border-red-800",     label: "🚨 CUT or DECIDE" },
  TRIM_HARD:       { badge: "bg-emerald-900/50 text-emerald-200 border-emerald-700", ring: "border-emerald-800", label: "💰 TRIM 50% (TP2 hit)" },
  TRIM:            { badge: "bg-emerald-900/40 text-emerald-200 border-emerald-700", ring: "border-emerald-800", label: "✂️ TRIM (TP1)" },
  ADD_CONVICTION:  { badge: "bg-sky-900/50 text-sky-200 border-sky-700",       ring: "border-sky-800",     label: "🛒 ADD (conviction)" },
  ADD_LIGHT:       { badge: "bg-sky-900/30 text-sky-300 border-sky-800",       ring: "border-sky-900",     label: "🛒 ADD (light)" },
  EARNINGS:        { badge: "bg-amber-900/40 text-amber-200 border-amber-700", ring: "border-amber-800",   label: "📅 CATALYST" },
};

// ─── Catalysts (this week) ─────────────────────────────────────────────

interface Catalyst {
  date: string;
  daysAway: number;
  label: string;
  symbol: string;
  priority?: string;
  hasPosition: boolean;
}

function nextWeekCatalysts(events: ManualInput["events"], heldSymbols: Set<string>): Catalyst[] {
  const today = new Date(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Dubai" }));
  const horizonDays = 7;
  const out: Catalyst[] = [];
  for (const e of events) {
    const d = new Date(e.date);
    if (isNaN(d.getTime())) continue;
    const daysAway = Math.floor((d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    if (daysAway < 0 || daysAway > horizonDays) continue;
    out.push({
      date: e.date,
      daysAway,
      label: e.label,
      symbol: e.symbol,
      priority: e.priority,
      hasPosition: heldSymbols.has(e.symbol),
    });
  }
  return out.sort((a, b) => a.daysAway - b.daysAway);
}

// ─── Page ──────────────────────────────────────────────────────────────

export default async function ReviewPage() {
  const data = manualInput as unknown as ManualInput;
  const [marketData, etoroData] = await Promise.all([
    fetchMarketData(data.marketSymbols),
    fetchEtoroPortfolio(),
  ]);

  const isEtoroLive = etoroData !== null;
  const reconciliation = reconcilePositions(data.positions as any, etoroData?.aggregated, marketData);
  const positions = reconciliation.livePositions;

  // Actions (sorted by priority)
  const actions = classifyPositions(positions, data.positions as any[]).sort(
    (a, b) => ACTION_ORDER[a.kind] - ACTION_ORDER[b.kind]
  );

  // Catalysts this week
  const heldSymbols = new Set(positions.map((p) => p.symbol));
  const catalysts = nextWeekCatalysts(data.events, heldSymbols);

  // Allocation drift
  const cashIdle = etoroData?.cashAvailable ?? data.equity.cashIdle;
  const usdToAed = (data as any).wealthProgress?.usdToAed ?? 3.6725;
  const targetAlloc = (data as any).wealthProgress?.targetAllocationPct;
  const wp = (data as any).wealthProgress;
  const pinsPrice = marketData.get("PINS")?.price ?? 0;
  const snapPrice = marketData.get("SNAP")?.price ?? 0;
  const liveComponents = (wp?.components ?? []).map((c: any) => {
    if (c.label === "eToro Portfolio" && etoroData) {
      const totalUSD = positions.reduce((s, p) => s + p.currentValue, 0) +
                       (etoroData.mirrorsValue ?? 0) + cashIdle;
      return { ...c, valueAED: Math.round(totalUSD * usdToAed) };
    }
    if (c.label?.startsWith("PINS RSU") && pinsPrice > 0) return { ...c, valueAED: Math.round(pinsPrice * 1429 * usdToAed) };
    if (c.label?.startsWith("SNAP RSU") && snapPrice > 0) return { ...c, valueAED: Math.round(snapPrice * 1798 * usdToAed) };
    return c;
  });
  const allocation = targetAlloc
    ? computeAllocation(liveComponents, positions, cashIdle * usdToAed, targetAlloc)
    : null;

  // Health checks
  const manualAge = daysOldDubai(data.lastUpdated);
  const todayDubai = new Date(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Dubai" }));
  const dateLabel = todayDubai.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "Asia/Dubai" });

  // Status pill
  const cutCount = actions.filter((a) => a.kind === "CUT").length;
  const totalActions = actions.length;
  const status =
    !isEtoroLive ? { color: "bg-red-700 text-red-100", text: "🔴 DO NOT TRADE — eToro disconnected" }
    : cutCount > 0 ? { color: "bg-red-700 text-red-100", text: `🚨 ${cutCount} positions need a CUT decision` }
    : totalActions > 0 ? { color: "bg-amber-700 text-amber-100", text: `⚠ ${totalActions} actions to review` }
    : { color: "bg-emerald-700 text-emerald-100", text: "✅ All clear — no actions this week" };

  // Discipline checklist
  const disciplineItems = [
    { id: "reviewed-positions", content: <span>Walked through every active position</span> },
    { id: "rsu-reconciled",     content: <span>PINS + SNAP RSU shares reconciled at Schwab</span> },
    { id: "cash-checked",       content: <span>Cash drag accounts checked (Wio, ENBD, eToro idle)</span> },
    { id: "screenshot",         content: <span>Weekly screenshot saved (positions + net worth)</span> },
    { id: "etoro-health",       content: <span>eToro API connectivity verified</span> },
    { id: "next-week-cal",      content: <span>Next week's catalysts noted (earnings / macro)</span> },
  ];

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-5">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-bold text-emerald-400 uppercase tracking-widest mb-1">Sunday Review</p>
            <h1 className="text-3xl font-bold tracking-tight">{dateLabel}</h1>
          </div>
          <Link href="/" className="text-xs text-gray-500 hover:text-gray-300 font-mono">← full dashboard</Link>
        </div>

        {/* Status pill */}
        <div className={`mb-6 rounded-xl px-4 py-3 ${status.color} flex items-center justify-between`}>
          <p className="font-bold text-sm">{status.text}</p>
          <p className="text-xs font-mono opacity-80">
            data {manualAge === null ? "?" : manualAge === 0 ? "today" : `${manualAge}d old`} · {positions.length} positions
          </p>
        </div>

        {/* Actions */}
        <section className="mb-8">
          <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest mb-3 flex items-baseline justify-between">
            <span>This Week's Actions</span>
            <span className="text-xs font-mono text-gray-600">est. {Math.max(5, totalActions * 3)} min review</span>
          </h2>
          {totalActions === 0 ? (
            <div className="rounded-xl border border-emerald-900 bg-emerald-950/20 p-5 text-emerald-200 text-sm">
              No trim, cut, or add actions triggered by current prices. Hold the book. Verify next week's catalysts below.
            </div>
          ) : (
            <div className="space-y-3">
              {actions.map((a, i) => {
                const style = ACTION_STYLE[a.kind];
                const etoroLink = `https://www.etoro.com/markets/${a.symbol.toLowerCase().replace(/[-=].*/, "")}`;
                return (
                  <div key={i} className={`rounded-xl border ${style.ring} bg-gray-900/50 p-5`}>
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div>
                        <span className={`inline-block text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded border ${style.badge}`}>
                          {style.label}
                        </span>
                        <p className="text-lg font-bold mt-2">{a.label}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-xl font-mono font-bold">{fmtPrice(a.livePrice)}</p>
                        <p className={`text-xs font-mono ${a.unrealizedPnlPct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {fmtPct(a.unrealizedPnlPct)} unrealized
                        </p>
                        <p className="text-[10px] text-gray-500 font-mono mt-0.5">≈ {fmtUSD(a.positionUSD)}</p>
                      </div>
                    </div>
                    <p className="text-xs text-gray-400 mb-1">
                      <span className="font-mono">{fmtPrice(a.refPrice)}</span> ref · <span className="font-mono">{fmtPct(a.pctToRef)}</span> from there
                    </p>
                    <p className="text-sm text-gray-300 mb-2">{a.thesis}</p>
                    <p className="text-sm font-semibold text-gray-100 mb-3">→ {a.recommendation}</p>
                    <a href={etoroLink} target="_blank" rel="noopener" className="inline-block text-xs px-3 py-1.5 rounded-md bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-gray-500 text-gray-200 transition-colors">
                      Open {a.symbol} in eToro ↗
                    </a>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Catalysts this week */}
        <section className="mb-8">
          <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest mb-3">Catalysts — Next 7 Days</h2>
          {catalysts.length === 0 ? (
            <div className="rounded-xl border border-gray-800 bg-gray-900/30 p-4 text-gray-500 text-sm">
              No events scheduled in the next 7 days.
            </div>
          ) : (
            <div className="space-y-2">
              {catalysts.map((c, i) => (
                <div key={i} className={`rounded-lg border p-3 ${c.hasPosition ? "border-amber-800 bg-amber-950/20" : "border-gray-800 bg-gray-900/30"}`}>
                  <div className="flex items-start gap-3">
                    <div className="shrink-0 text-center min-w-[3rem]">
                      <p className="text-[10px] font-mono text-gray-500 uppercase">{c.daysAway === 0 ? "Today" : c.daysAway === 1 ? "Tomorrow" : `+${c.daysAway}d`}</p>
                      <p className="text-xs font-mono text-gray-400">{c.date.slice(5)}</p>
                    </div>
                    <div className="flex-1">
                      <p className="text-sm text-gray-200">{c.label}</p>
                      {c.hasPosition && (
                        <p className="text-[10px] text-amber-400 font-mono mt-1">🎯 you hold {c.symbol}</p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Allocation drift */}
        {allocation && (
          <section className="mb-8">
            <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest mb-3">Allocation Drift</h2>
            <div className="rounded-xl border border-gray-800 bg-gray-900/30 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-900/60">
                  <tr className="text-left text-[10px] uppercase tracking-widest text-gray-500">
                    <th className="px-4 py-2 font-bold">Bucket</th>
                    <th className="px-4 py-2 font-bold text-right">Current</th>
                    <th className="px-4 py-2 font-bold text-right">Target</th>
                    <th className="px-4 py-2 font-bold text-right">Drift</th>
                  </tr>
                </thead>
                <tbody>
                  {allocation.slices.map((r, i) => {
                    const drift = r.deviationPct;
                    const outOfBand = Math.abs(drift) > allocation.bandPct;
                    return (
                      <tr key={i} className="border-t border-gray-900">
                        <td className="px-4 py-2 text-gray-300">{r.label}</td>
                        <td className="px-4 py-2 text-right font-mono text-gray-200">{r.actualPct.toFixed(1)}%</td>
                        <td className="px-4 py-2 text-right font-mono text-gray-500">{r.targetPct}%</td>
                        <td className={`px-4 py-2 text-right font-mono ${outOfBand ? (drift > 0 ? "text-amber-400" : "text-sky-400") : "text-gray-500"}`}>
                          {drift > 0 ? "+" : ""}{drift.toFixed(1)}{outOfBand ? " ⚠" : ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="text-[10px] text-gray-600 font-mono px-4 py-2 border-t border-gray-900">
                Rebalance band: ±{allocation.bandPct}%. Items flagged ⚠ are outside the band.
              </p>
            </div>
          </section>
        )}

        {/* Discipline checklist */}
        <section className="mb-8">
          <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest mb-3">Sunday Discipline Checklist</h2>
          <div className="rounded-xl border border-gray-800 bg-gray-900/30 p-4">
            <InteractiveChecklist
              storagePrefix={`reviewDiscipline-${todayDubai.toISOString().slice(0,10)}`}
              showResetButton={false}
              items={disciplineItems.map((it) => ({
                id: it.id,
                content: <div className="text-sm text-gray-300 py-1">{it.content}</div>,
              }))}
            />
          </div>
        </section>

        {/* Health (only shown if anything is wrong) */}
        {(!isEtoroLive || (manualAge ?? 0) > 1) && (
          <section className="mb-8">
            <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest mb-3">⚠ Health Issues</h2>
            <div className="rounded-xl border border-red-900 bg-red-950/20 p-4 space-y-2 text-sm">
              {!isEtoroLive && (
                <p className="text-red-200">
                  <span className="font-bold">🔴 eToro API disconnected.</span> Positions shown above are from manual snapshot in <code className="font-mono text-xs bg-gray-900 px-1 rounded">manual-input.json</code> — qty + avg cost may not reflect reality. Reconnect before trading.
                </p>
              )}
              {manualAge !== null && manualAge > 1 && (
                <p className={manualAge > 3 ? "text-red-200" : "text-amber-200"}>
                  <span className="font-bold">{manualAge > 3 ? "🔴" : "⚠"} Manual data is {manualAge} days old.</span> Strategist note + position notes may be outdated. Refresh before acting.
                </p>
              )}
            </div>
          </section>
        )}

        {/* Footer */}
        <p className="text-[10px] text-gray-600 font-mono text-center mt-8">
          Sunday Review · {dateLabel} · ISR 15min · <Link href="/" className="hover:text-gray-400">Open full dashboard →</Link>
        </p>
      </div>
    </div>
  );
}
