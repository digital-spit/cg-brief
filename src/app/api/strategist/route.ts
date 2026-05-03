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

// ─── Rule-based fallback (no API credits needed) ──────────────────────────────
function generateRuleBasedAnalysis(body: StrategistRequest, now: string) {
  const { portfolioValue, cashIdle, totalPnL, positions, events, warStatus, marketContext } = body;

  const criticalEvents = (events ?? []).filter((e) => e.priority === "critical");
  const highEvents = (events ?? []).filter((e) => e.priority === "high").slice(0, 3);

  const nearStop = (positions ?? []).filter(
    (p) => p.livePrice > 0 && p.stopLoss > 0 && p.livePrice <= p.stopLoss * 1.06
  );
  const atTP = (positions ?? []).filter(
    (p) => p.livePrice > 0 && p.takeProfit > 0 && p.livePrice >= p.takeProfit * 0.97
  );
  const bigWinners = (positions ?? [])
    .filter((p) => p.unrealizedPnlPercent >= 20)
    .sort((a, b) => b.unrealizedPnlPercent - a.unrealizedPnlPercent);
  const bigLosers = (positions ?? [])
    .filter((p) => p.unrealizedPnlPercent <= -10)
    .sort((a, b) => a.unrealizedPnlPercent - b.unrealizedPnlPercent);

  // Build title from the most urgent signal
  let title: string;
  if (criticalEvents.length > 0) {
    const raw = criticalEvents[0].label.replace(/^[^\w]*/, "").split("—")[0].trim();
    title = raw.length > 80 ? raw.substring(0, 77) + "..." : raw;
  } else if (nearStop.length > 0) {
    title = `${nearStop[0].symbol} approaching stop loss — review position`;
  } else if (atTP.length > 0) {
    title = `${atTP[0].symbol} near take profit — consider partial exit`;
  } else {
    title = `Portfolio $${portfolioValue?.toFixed(0)} — ${now}`;
  }

  // Build body paragraphs
  const parts: string[] = [];

  if (criticalEvents.length > 0) {
    parts.push(
      `🚨 Critical catalyst: ${criticalEvents[0].label.split("—")[0].trim()} on ${criticalEvents[0].date}. Ensure you have a decision plan before the open.`
    );
  }

  if (nearStop.length > 0) {
    parts.push(
      `⚠️ Stop loss alert: ${nearStop.map((p) => `${p.symbol} at $${p.livePrice.toFixed(2)} vs SL $${p.stopLoss}`).join(", ")}. Review these positions — consider tightening or exiting.`
    );
  }

  if (atTP.length > 0) {
    parts.push(
      `✅ Take-profit zone: ${atTP.map((p) => `${p.symbol} +${p.unrealizedPnlPercent.toFixed(1)}%`).join(", ")}. Consider booking partial profits or trailing your stop.`
    );
  }

  if (bigWinners.length > 0) {
    parts.push(
      `📈 Strongest positions: ${bigWinners.slice(0, 3).map((p) => `${p.symbol} +${p.unrealizedPnlPercent.toFixed(1)}%`).join(", ")}. Hold conviction — let winners run.`
    );
  }

  if (bigLosers.length > 0) {
    parts.push(
      `📉 Underwater: ${bigLosers.slice(0, 2).map((p) => `${p.symbol} ${p.unrealizedPnlPercent.toFixed(1)}%`).join(", ")}. Check thesis vs stop loss levels.`
    );
  }

  const warLine = warStatus?.status ? `War: ${warStatus.status}.` : "";
  const cashLine = cashIdle > 500 ? `Cash idle: $${cashIdle.toFixed(2)}.` : "";
  if (warLine || cashLine) parts.push([warLine, cashLine].filter(Boolean).join(" "));

  if (parts.length === 0) {
    parts.push(
      `Portfolio value $${portfolioValue?.toFixed(2)}, P&L $${totalPnL?.toFixed(2)}. No critical signals detected — monitor upcoming events.`
    );
  }

  // Build action items
  const actionItems: Array<{ label: string; priority: string; done: boolean }> = [];

  for (const evt of criticalEvents) {
    const clean = evt.label.replace(/^[^\w]*/, "").substring(0, 90);
    actionItems.push({ label: `🚨 ${evt.date}: ${clean}`, priority: "critical", done: false });
  }
  for (const p of nearStop) {
    actionItems.push({
      label: `⚠️ ${p.symbol} near SL $${p.stopLoss} — current $${p.livePrice.toFixed(2)} (${p.unrealizedPnlPercent.toFixed(1)}%)`,
      priority: "high",
      done: false,
    });
  }
  for (const p of atTP) {
    actionItems.push({
      label: `✅ ${p.symbol} near TP $${p.takeProfit} — consider partial exit (+${p.unrealizedPnlPercent.toFixed(1)}%)`,
      priority: "high",
      done: false,
    });
  }
  for (const evt of highEvents) {
    const clean = evt.label.replace(/^[^\w]*/, "").substring(0, 85);
    actionItems.push({ label: `📊 ${evt.date}: ${clean}`, priority: "high", done: false });
  }
  if (cashIdle > 1000) {
    actionItems.push({
      label: `💰 $${cashIdle.toFixed(2)} idle cash — deploy or park in stables for yield`,
      priority: "medium",
      done: false,
    });
  }

  return {
    title,
    body: parts.join(" "),
    actionItems: actionItems.slice(0, 7),
    edition: `Rule-Based Analysis — ${now} (add Anthropic credits for AI analysis)`,
    generatedAt: Date.now(),
    _fallback: true,
  };
}

// ─── Route handler ────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  let body: StrategistRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const now = new Date().toLocaleString("en-US", {
    timeZone: "Asia/Dubai",
    dateStyle: "medium",
    timeStyle: "short",
  });

  const apiKey = process.env.ANTHROPIC_API_KEY;

  // No key configured → fall back immediately, no error shown
  if (!apiKey) {
    return NextResponse.json(generateRuleBasedAnalysis(body, now));
  }

  const { portfolioValue, cashIdle, totalPnL, positions, events, warStatus, marketContext } = body;

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

    // Billing or quota error → fall back to rule-based, don't surface as error
    if (response.status === 400 || response.status === 429) {
      const errText = await response.text();
      if (errText.includes("credit balance") || errText.includes("rate_limit") || errText.includes("quota")) {
        console.warn("Anthropic billing/rate limit — using rule-based fallback");
        return NextResponse.json(generateRuleBasedAnalysis(body, now));
      }
      throw new Error(`Anthropic API 400: ${errText}`);
    }

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Anthropic API ${response.status}: ${err}`);
    }

    const data = await response.json();
    const text = (data.content?.[0]?.text ?? "").trim();
    const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(cleaned);

    return NextResponse.json({ ...parsed, generatedAt: Date.now() });
  } catch (err) {
    console.error("Strategist generation failed:", err);
    // Even on unexpected errors, return rule-based rather than failing completely
    return NextResponse.json(generateRuleBasedAnalysis(body, now));
  }
}
