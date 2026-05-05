import { NextResponse } from "next/server";

export const revalidate = 3600; // 1h server cache (override per call with cache: 'no-store')

interface YahooNewsItem {
  title?: string;
  publisher?: string;
  link?: string;
  providerPublishTime?: number;
}

interface WarTrigger {
  label: string;
  state: "met" | "not_met" | "partial";
  detail: string;
}

interface WarPulseResponse {
  status: string;
  statusKey: string;
  description: string;
  triggers: WarTrigger[];
  deploymentLocked: boolean;
  deploymentAmountAED: number;
  lastUpdated: string;          // ISO timestamp of this synthesis
  source: "live-ai" | "live-rule" | "fallback";
  oilSpotUSD?: number;          // Brent for context
  oilDailyChangePct?: number;
  headlinesUsed: Array<{ title: string; publisher: string; ageMinutes: number; link: string }>;
  generatedAt: number;
}

const QUERIES = [
  "Iran Hormuz strait blockade",
  "Iran ceasefire oil",
  "Brent crude Iran tensions",
];

async function fetchHeadlines(): Promise<Array<{ title: string; publisher: string; ageMinutes: number; link: string; ts: number }>> {
  const nowSec = Math.floor(Date.now() / 1000);
  const out: Array<{ title: string; publisher: string; ageMinutes: number; link: string; ts: number }> = [];

  for (const q of QUERIES) {
    try {
      const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&newsCount=8&lang=en-US&region=US&quotesCount=0`;
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; cg-brief/1.0)" },
        next: { revalidate: 1800 },
      });
      if (!res.ok) continue;
      const data = await res.json();
      for (const item of (data.news ?? []) as YahooNewsItem[]) {
        if (!item.title || !item.providerPublishTime) continue;
        out.push({
          title: item.title,
          publisher: item.publisher ?? "Yahoo",
          link: item.link ?? "",
          ts: item.providerPublishTime,
          ageMinutes: Math.max(0, Math.floor((nowSec - item.providerPublishTime) / 60)),
        });
      }
    } catch {
      // skip query
    }
  }

  // Dedupe by title, sort newest first, top 12
  const seen = new Set<string>();
  return out
    .filter((h) => { const k = h.title.toLowerCase().trim(); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 12);
}

async function fetchBrent(): Promise<{ price: number; changePct: number } | null> {
  try {
    const res = await fetch(
      "https://query1.finance.yahoo.com/v8/finance/chart/BZ=F?interval=1d&range=5d",
      { next: { revalidate: 900 } } as RequestInit
    );
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) return null;
    return {
      price: meta.regularMarketPrice,
      changePct: meta.regularMarketChangePercent ?? 0,
    };
  } catch {
    return null;
  }
}

// Heuristic synthesis when no Anthropic key available — keyword scan over headlines.
function ruleBasedSynthesis(
  headlines: Array<{ title: string; ageMinutes: number }>,
  brent: { price: number; changePct: number } | null
): { status: string; statusKey: string; description: string; triggers: WarTrigger[] } {
  const text = headlines.map((h) => h.title.toLowerCase()).join(" | ");

  const reopened   = /(reopen|reopened|hormuz reopens|fully open|resume(d)? traffic)/i.test(text);
  const ceasefire  = /(ceasefire|peace deal|truce)/i.test(text);
  const escalation = /(strike|attack|seize|seized|missile|escalat|blockade|shut)/i.test(text);
  const stalled    = /(stall|stalemate|impasse|talks fail|breakdown)/i.test(text);

  let status: string;
  let statusKey: string;
  let description: string;

  if (reopened) {
    status = "HORMUZ REOPENED — DEPLOYMENT TRIGGER ACTIVE";
    statusKey = "hormuz_reopened";
    description = `Headlines indicate Strait of Hormuz traffic resuming. Brent at $${brent?.price.toFixed(2) ?? "?"} (${(brent?.changePct ?? 0).toFixed(2)}%). Verify with 2 confirmed weeks before deploying.`;
  } else if (escalation) {
    status = "ESCALATION — HORMUZ BLOCKED, OIL BID";
    statusKey = "escalation";
    description = `Recent headlines flag escalation. Brent $${brent?.price.toFixed(2) ?? "?"} ${(brent?.changePct ?? 0) >= 0 ? "up" : "down"} ${Math.abs(brent?.changePct ?? 0).toFixed(2)}%. Hold 115K AED dry powder. Re-read top headlines below.`;
  } else if (ceasefire && !stalled) {
    status = "CEASEFIRE HOLDING — MONITORING";
    statusKey = "ceasefire_holding";
    description = `Recent headlines suggest ceasefire still in place. Brent $${brent?.price.toFixed(2) ?? "?"} (${(brent?.changePct ?? 0).toFixed(2)}%). No deployment trigger yet — wait for 2 confirmed weeks of full traffic resumption.`;
  } else {
    status = "STATUS QUO — HORMUZ SITUATION UNCHANGED";
    statusKey = "unchanged";
    description = `No clear catalyst in last news scan. Brent $${brent?.price.toFixed(2) ?? "?"} (${(brent?.changePct ?? 0).toFixed(2)}%). 115K AED stays parked.`;
  }

  const triggers: WarTrigger[] = [
    { label: "Hormuz fully reopened", state: reopened ? "met" : "not_met", detail: reopened ? "Confirmed via headline scan" : "No clear reopening signal" },
    { label: "Ceasefire holding", state: (ceasefire && !stalled) ? "met" : (escalation ? "not_met" : "partial"), detail: ceasefire ? "Truce in headlines" : escalation ? "Escalation signals detected" : "Mixed signals" },
    { label: "Brent crude trend (deflation = de-escalation)", state: brent && brent.changePct < -1 ? "met" : "not_met", detail: brent ? `Brent ${brent.changePct >= 0 ? "+" : ""}${brent.changePct.toFixed(2)}% over recent session` : "Price unavailable" },
    { label: "2 confirmed weeks of normal traffic", state: "not_met", detail: "Manual confirmation required — check daily for 14 consecutive days post-reopening" },
    { label: "New deployment thesis defined", state: "not_met", detail: "40% BTC/ETH + 30% quality tech (TSM/AVGO) + 20% stables + 10% SOL staking" },
  ];

  return { status, statusKey, description, triggers };
}

async function aiSynthesis(
  headlines: Array<{ title: string; publisher: string; ageMinutes: number }>,
  brent: { price: number; changePct: number } | null,
  apiKey: string
): Promise<{ status: string; statusKey: string; description: string; triggers: WarTrigger[] } | null> {
  const headlinesBlock = headlines
    .slice(0, 10)
    .map((h, i) => `${i + 1}. [${h.ageMinutes < 60 ? `${h.ageMinutes}m` : `${Math.floor(h.ageMinutes / 60)}h`} · ${h.publisher}] ${h.title}`)
    .join("\n");

  const prompt = `You synthesize the current Iran/Hormuz geopolitical state for a Dubai-based investor's dashboard. He has 115,000 AED locked dry powder waiting for the Strait of Hormuz to fully reopen + 2 confirmed weeks before deploying.

CONTEXT:
- Brent crude: $${brent?.price.toFixed(2) ?? "?"} (${(brent?.changePct ?? 0) >= 0 ? "+" : ""}${(brent?.changePct ?? 0).toFixed(2)}%)
- Today: ${new Date().toISOString().slice(0, 10)}

LATEST HEADLINES (most recent first):
${headlinesBlock}

Synthesize CURRENT war status. Return ONLY valid JSON:
{
  "status": "ALL CAPS one-line status (under 60 chars)",
  "statusKey": "short_snake_case_key",
  "description": "2-3 sentences. Specific. What changed in last 24-72h. Implication for the 115K AED deployment.",
  "triggers": [
    {"label": "Hormuz fully reopened", "state": "met|not_met|partial", "detail": "based on the headlines"},
    {"label": "Ceasefire holding", "state": "met|not_met|partial", "detail": "..."},
    {"label": "Brent crude trend", "state": "met|not_met|partial", "detail": "current price + direction"},
    {"label": "2 confirmed weeks of normal traffic", "state": "met|not_met|partial", "detail": "..."},
    {"label": "New deployment thesis defined", "state": "met|not_met|partial", "detail": "..."}
  ]
}

Be cautious — if headlines are stale or unclear, say so. Prefer 'partial' over false positives. Do not invent events not in the headlines.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 800,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = (data.content?.[0]?.text ?? "").trim();
    const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(cleaned);
    return {
      status: parsed.status,
      statusKey: parsed.statusKey,
      description: parsed.description,
      triggers: parsed.triggers,
    };
  } catch {
    return null;
  }
}

export async function GET() {
  const [headlines, brent] = await Promise.all([fetchHeadlines(), fetchBrent()]);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  let synthesis = apiKey ? await aiSynthesis(headlines, brent, apiKey) : null;
  let source: WarPulseResponse["source"] = synthesis ? "live-ai" : "live-rule";
  if (!synthesis) {
    synthesis = ruleBasedSynthesis(headlines, brent);
  }

  const payload: WarPulseResponse = {
    status: synthesis.status,
    statusKey: synthesis.statusKey,
    description: synthesis.description,
    triggers: synthesis.triggers,
    deploymentLocked: !synthesis.statusKey.includes("reopened"),
    deploymentAmountAED: 115000,
    lastUpdated: new Date().toISOString(),
    source,
    oilSpotUSD: brent?.price,
    oilDailyChangePct: brent?.changePct,
    headlinesUsed: headlines.slice(0, 8).map((h) => ({
      title: h.title,
      publisher: h.publisher,
      ageMinutes: h.ageMinutes,
      link: h.link,
    })),
    generatedAt: Date.now(),
  };

  return NextResponse.json(payload);
}
