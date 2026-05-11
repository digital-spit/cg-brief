# cg-brief-v2 — Operating Doc

Read this before touching this repo. It encodes how the trading dashboard works, what's manual vs. computed, and the rules you've already decided about.

---

## What This Is

A Next.js trading dashboard hosted on Vercel with 5-minute ISR revalidation. Single source of personal market truth: positions, war status, wealth progress, strategist note, action items, watchlist. Live at https://cg-brief-v2.vercel.app.

Connects to: Yahoo Finance (market data), news APIs (live feed), fear-greed index, optional eToro live equity, AI strategist endpoint for analysis.

---

## Architecture

```
src/
├── app/
│   ├── page.tsx                       # Main dashboard
│   ├── layout.tsx
│   ├── globals.css
│   ├── refresh-button.tsx
│   ├── api/
│   │   ├── fear-greed/route.ts        # CNN fear-greed proxy
│   │   ├── news/route.ts              # Live news feed
│   │   ├── war-pulse/route.ts         # Geopolitical pulse
│   │   └── strategist/route.ts        # AI-generated analysis
│   └── components/
│       ├── LiveNewsFeed.tsx
│       ├── InteractiveChecklist.tsx   # Action items UI
│       └── StrategistPanel.tsx
├── lib/
│   ├── market.ts                      # Price + indicator fetching
│   ├── news.ts
│   ├── etoro.ts                       # eToro live equity (optional)
│   ├── wealth.ts                      # AED 1M progress math
│   └── types.ts                       # Full ManualInput schema
└── data/
    └── manual-input.json              # The brain
```

---

## The Brain — `src/data/manual-input.json`

This file is the **single source of truth** for everything the dashboard renders. Everything else is computed live around it.

Schema lives in `src/lib/types.ts`. Top-level shape:

```ts
interface ManualInput {
  lastUpdated: string;
  equity: { beginningRealized, endingRealized, endingUnrealized, cashIdle, periodPnl, statementPeriod, ... };
  strategistNote: { title, body, edition?, stalenessWarning? };
  positions: Position[];          // active positions w/ entry, SL, TP1, TP2, addZones
  copyPortfolio: CopyPortfolio;
  smartPortfolios?: SmartPortfolio[];
  closedPositions: ClosedPosition[];
  warStatus: WarStatus;           // triggers + deploymentLocked + deploymentAmountAED
  actionItems: ActionItem[];
  events: Event[];
  marketSymbols: string[];
  bullRunWatchlist?: BullRunPick[];
  wealthProgress?: WealthProgress; // AED 1M goal tracking
}
```

### When to update which field

| Update | Trigger |
|---|---|
| `lastUpdated` | Every manual change. ISO date. |
| `equity.*` | After eToro statement closes (start/mid/end of month). |
| `strategistNote` | When macro/regional context shifts materially OR weekly minimum. |
| `positions[]` | Open / close / partial / stop-move / TP-move / DCA. |
| `closedPositions[]` | On close, with reason. Move from `positions[]`. |
| `warStatus` | When a trigger flips. Hormuz / DXY / oil thresholds. Updates `deploymentLocked`. |
| `actionItems[]` | When a decision-pending item appears. Mark done in-line. |
| `events[]` | Add ahead of earnings, central bank meetings, OPEC, geopolitical milestones. |
| `bullRunWatchlist[]` | When a new conviction setup forms. Rate 1–10 with thesis + entry zone. |
| `wealthProgress` | Monthly minimum. Recompute components after major moves. |

### Conventions inside `manual-input.json`

- **Stops:** -8% from entry for ETFs, -15% to -20% for high-conviction equity, asset-specific for metals/crypto.
- **TPs:** TP1 = first profit-take level. TP2 = full thesis target. For DCA positions (VTI), TPs reduce, never fully exit.
- **Notes:** Always include qty, avg cost, current % from avg, the rationale, the SL/TP rationale. Future you needs to read the note and remember the trade.
- **Status flips:** `"active"` → `"closed"` requires moving the position to `closedPositions[]` with `closeDate`, `closePrice`, `pnl`, `reason`.

---

## Operating Rules

### Trading discipline (already decided)

- Risk appetite: **medium**. Medium-to-long horizon. No day trading unless exceptional setup.
- Position sizing: lean asymmetric. Core ETFs (VTI/QQQ) DCA. Single-name equity max ~5% of total. Crypto sized smaller given volatility.
- The Goal: **AED 1M across trading + bank accounts by Dec 2026.** Track in `wealthProgress`.
- **Never override `warStatus.deploymentLocked`** without updating triggers. The lock exists for a reason.

### Manual vs. AI strategistNote

- Default: manually maintained `strategistNote.body` with your own thesis.
- The "Regenerate Analysis" button hits `/api/strategist` for an AI-generated version.
- `stalenessWarning` shows when the manual note is older than N days — re-edit or regenerate.
- AI output is informational. **Final write goes to `manual-input.json` by hand.**

### Position alerts

- `Position.alert` is a per-position short string ("PINS earnings May 4") that surfaces in the UI as a red flag.
- Use for binary events (earnings, FDA, court rulings, central bank). Clear after the event.

---

## Schedule Integration

**`daily-cg-brief`** scheduled task (6 AM Dubai, `~/Documents/Claude/Scheduled/daily-cg-brief/SKILL.md`):

1. Checks https://cg-brief-v2.vercel.app status (200 OK).
2. Reviews current market conditions via `khaled-financial-analyst` skill.
3. Flags major events affecting positions.
4. Suggests `manual-input.json` updates if status changed.

This is monitoring only. Code/data changes happen by hand.

---

## Deployment

- Hosted: Vercel (auto-deploy from `main` on GitHub).
- ISR: 5-minute revalidation on the main page. Data routes use no-store where freshness matters.
- Env vars needed on Vercel:
  - eToro auth (if used) — see `src/lib/etoro.ts`
  - News API keys — see `src/lib/news.ts`
  - AI provider key for `/api/strategist`

To deploy a manual data change without touching code: commit `manual-input.json`, push to `main`, Vercel rebuilds.

---

## Failure Modes To Watch For

1. **Stale `lastUpdated` but live positions look fine.** Means market shifted but you haven't reconciled equity. Update equity block before next decision.
2. **Position with `status: "active"` and quantity 0.** Means a close didn't propagate to `closedPositions[]`. Fix manually.
3. **`warStatus.deploymentLocked: false` with no trigger met.** The lock got toggled by hand without a clear reason. Restore lock until trigger is documented.
4. **AI strategist note overwriting your manual note.** The button should append/replace into `strategistNote`. If your manual thesis disappears, check git history.
5. **`smartPortfoliosValue` drifting from eToro reality.** Pull a fresh number monthly; this is the slowest-decaying field.

---

## Conventions

- Next.js (breaking-changes version). Read `node_modules/next/dist/docs/` before assuming APIs.
- TypeScript strict.
- All `ManualInput` mutations must round-trip through `types.ts` — no untyped JSON edits.
- Components use Tailwind, accent palette intentionally minimal.
- Never add a new dashboard widget without first defining its data in `manual-input.json` schema.
