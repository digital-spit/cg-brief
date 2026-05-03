import { NextRequest, NextResponse } from "next/server";

interface PositionSnapshot {
  symbol: string;
  livePrice: number;
  avgCost: number;
  unrealizedPnlPercent: number;
  stopLoss: number;
  takeProfit: number;
}

interface StrategistRequest {
  portfolioValue: number;
  cashIdle: number;
  totalPnL: number;
  isEtoroLive: boolean;
  positions: PositionSnapshot[];
  events: Array<{ date: string; label: string; priority: string }>;
  warStatus: { status: string; description: string };
  marketContext: Array<{ symbol: string; price: number; changePercent: number }>;
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "ANTHROPIC_API_KEY not configured — add it to Vercel environment variables to enable live AI analysis",
      },
      { status: 503 }
    );
  }

  let body: StrategistRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const {
    portfolioValue,
    cashIdle,
    totalPnL,
    positions,
    events,
    warStatus,
    marketContext,
  } = body;

  const now = new Date().toLocaleString("en-US", {
    timeZone: "Asia/Dubai",
    dateStyle: "medium",
    timeStyle: "short",
  });

  const positionsSummary = positions
    ?.map(
      (p) =>
        `${p.symbol}: price=$${p.livePrice?.toFixed(2)} avg=$${p.avgCost?.toFixed(2)} P&L=${p.unrealizedPnlPercent?.toFixed(1)}% SL=$${p.stopLoss}`
    )
    .join("\n") ?? "Not provided";

  const marketSummary = marketContext
    ?.map((m) => `${m.symbol}: $${m.price?.toFixed(2)} (${m.changePercent >= 0 ? "+" : ""}${m.changePercent?.toFixed(2)}%)`)
    .join(" | ") ?? "Not provided";

  const eventsSummary = events
    ?.slice(0, 6)
    .map((e) => `[${e.priority.toUpperCase()}] ${e.date}: ${e.label}`)
    .join("\n") ?? "None";

  const prompt = `You are the financial strategist for Khaled Halwani, a Dubai-based investor (UAE resident, zero capital gains tax) working toward an AED 1,000,000 goal (currently ~36.6% tracked). Medium risk appetite. No day trading.

Current time (Dubai): ${now}

PORTFOLIO STATE:
- Total value: $${portfolioValue?.toFixed(2)}
- Cash idle: $${cashIdle?.toFixed(2)}
- Direct P&L: $${totalPnL?.toFixed(2)}
- AED locked (Hormuz war thesis): 115,000 AED

POSITIONS:
${positionsSummary}

MARKET:
${marketSummary}

WAR STATUS: ${warStatus?.status}
${warStatus?.description}

UPCOMING EVENTS:
${eventsSummary}

KEY FACTS YOU MUST REFLECT:
1. PINS earnings Monday May 4 after close — RSU shares should be sold before open (UAE = zero CGT, full value deployable)
2. No FOMC meeting on May 7 — next FOMC is June 16-17
3. Powell exits May 15, Kevin Warsh takes over — bullish for gold/BTC, USD weakness expected
4. Hormuz is an active war (5% normal traffic), NOT priced-in tail risk
5. BTC stuck below $80K despite +14% April rally — MSTR reports May 5 as next catalyst
6. Gold at ~$4,612 is the portfolio's strongest position — conviction hold
7. QQQ at 52-week high $674 — TP1 $729 is 8% away, do not chase, buy on pullback only

Generate a fresh strategist note. Return ONLY valid JSON, no markdown, no explanation:
{
  "title": "One sharp sentence max 15 words — the single most important thing right now",
  "body": "3-5 sentences. Specific price levels. No fluff. Actionable. Cover the top 2-3 things Khaled should act on today.",
  "actionItems": [
    {"label": "emoji + specific action with price levels", "priority": "critical|high|medium", "done": false}
  ],
  "edition": "Live Analysis — ${now}"
}

Include 5-7 action items. Priority 'critical' for same-day decisions only.`;

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
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Anthropic API ${response.status}: ${err}`);
    }

    const data = await response.json();
    const text = (data.content?.[0]?.text ?? "").trim();

    // Strip markdown code fences if present
    const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(cleaned);

    return NextResponse.json({ ...parsed, generatedAt: Date.now() });
  } catch (err) {
    console.error("Strategist generation failed:", err);
    return NextResponse.json(
      { error: `Generation failed: ${err instanceof Error ? err.message : "unknown error"}` },
      { status: 500 }
    );
  }
}
