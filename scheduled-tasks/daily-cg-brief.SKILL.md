---
name: daily-cg-brief
description: Morning auto-reconciliation + staleness gating of the C&G Brief dashboard (6 AM Dubai / 2 AM UTC). Pulls eToro live, reconciles manual-input.json positions to ground truth, commits + pushes. Drafts judgment-call updates as pending review.
---

You are running unattended at 6 AM Dubai. Your job is to make sure that **the next time Khaled looks at https://cg-brief-v2.vercel.app, the position book matches live eToro reality and any failure mode is visible above the fold**.

Project root: `~/Projects/cg-brief-v2/`. Data file: `~/Projects/cg-brief-v2/src/data/manual-input.json`. Repo: `digital-spit/cg-brief` on GitHub (single branch `main`). Vercel auto-deploys from `main`.

## Principle: separate objective broker state from human discipline

| Field | Source of truth | Auto-write? |
|---|---|---|
| `positions[].quantity` | eToro live (`get_portfolio`) | **YES** |
| `positions[].avgCost` | eToro live (units-weighted `openRate`) | **YES** |
| `positions[].status` | eToro live (closed if not held) | **YES** |
| `equity.cashIdle` | eToro `credit` field | **YES** |
| `positions[].stopLoss` / `takeProfit` / `takeProfit2` | Human framework (discipline triggers) | NO — propose only |
| `positions[].addZones` | Human framework | NO — propose only |
| `positions[].notes` | Mixed — auto-append a "RECONCILED" line, never overwrite the discipline notes | append only |
| `strategistNote.body` | Human judgment | NO — propose only |
| `warStatus.*` | Mixed — `lastUpdated` auto, status text propose only | partial |

This principle is the cure for phantom-position drift. Broker state belongs to the broker.

## Run order

### 1. Site reachability
```bash
curl -sI -o /dev/null -w "%{http_code}\n" https://cg-brief-v2.vercel.app
```
Must be 200. If not, stop and flag.

### 2. Pull eToro live
Call `mcp__etoro-mcp__get_portfolio`. If it 401s or fails:
- Skip to step 5 with `eToroLive: false` and flag eToro disconnect as critical blocker
- Do NOT touch positions[] in this case — fallback is what the dashboard will serve

If success, capture:
- `credit` (cash idle USD)
- positions[] array with `instrumentID`, `units`, `openRate`, `amount`, `stopLossRate`

### 3. Unknown instrumentID handling
For each eToro position, check if `instrumentID` is mapped in `~/Projects/cg-brief-v2/src/lib/etoro.ts` `INSTRUMENT_SYMBOL_MAP`.

For any unmapped IDs:
1. Call `mcp__etoro-mcp__get_instruments` with the array of unmapped IDs
2. Extract `symbolFull` from each result
3. Auto-append to `INSTRUMENT_SYMBOL_MAP` in `lib/etoro.ts` with a comment indicating the date discovered
4. Add a position entry to `manual-input.json > positions[]` with:
   - Live qty + avgCost from eToro
   - Placeholder SL/TP (use eToro's own `stopLossRate` if non-zero; otherwise 0)
   - `notes`: "OPENED <date> · auto-discovered from eToro live · ⚠ SL/TP need human review"
   - `status`: "active"
5. Flag the new symbol in the morning briefing under "NEEDS REVIEW: set SL/TP for X"

### 4. Reconcile positions[]
For each currently-mapped symbol in `manual-input.json`:

**a. Aggregate eToro lots by symbol:**
- Group eToro positions by `INSTRUMENT_SYMBOL_MAP[instrumentID]`
- Sum `units` per symbol
- Compute units-weighted `avgCost = Σ(units × openRate) / Σunits`
- Sum `amount` per symbol → `totalInvested`

**b. Compare to current manual:**
- If `|liveQty - manualQty| > 0.001` OR `|liveAvgCost - manualAvgCost| > 0.01`:
  - Update `quantity` and `avgCost` to live values
  - Append a `\n· RECONCILED <date>: qty X → Y, avg $A → $B` line to `notes`
- If symbol is in manual but NOT in eToro live (closed position):
  - Set `quantity: 0`, `avgCost: 0`, `status: "closed"`
  - Append `\n· CLOSED <date>: position no longer held on eToro` to `notes`

**c. Update `equity.cashIdle`:** set to eToro `credit` value, rounded to 2 decimals.

**d. Bump `lastUpdated`:** today's Dubai date `YYYY-MM-DD`.

### 5. Market scan + flag detection (the existing morning brief job)
Use the khaled-financial-analyst skill context for current market state.

For each active position, check:
- **Hit SL**: `livePrice <= stopLoss` → flag as critical action
- **Past TP1**: `livePrice >= takeProfit` → flag as trim signal
- **Past TP2**: `livePrice >= takeProfit2` → flag as strong-trim signal
- **RSI > 75 or < 30**: flag for review
- **Earnings/macro print today**: surface

Geopolitical scan: Iran/Hormuz status, Brent crude vs $109 reference, gold spot vs $4,530, BTC vs $74K floor.

### 6. Decide and act — three buckets

**A. SAFE AUTO-WRITES (commit + push automatically):**
- Step 4 reconciliation diffs (quantity, avgCost, status, cashIdle, lastUpdated)
- Step 3 INSTRUMENT_SYMBOL_MAP additions
- New auto-discovered position entries with placeholder SL/TP
- `bullRunWatchlistUpdatedAt` bump if scanning watchlist made today

Commit message template:
```
data: daily reconcile <YYYY-MM-DD> · <changes summary>

<bullet list of what changed: e.g.>
- PINS qty 42.52 → 21.97 (eToro live)
- AVGO avgCost $428.64 → $431.22 (new lot added)
- ICLN status active → closed (no longer on eToro)
- cashIdle $2,200 → $0.50
- Auto-mapped instrumentID 1555 → FCX
```

Push:
```bash
cd ~/Projects/cg-brief-v2
git add src/data/manual-input.json src/lib/etoro.ts
git commit -m "data: daily reconcile $(date -u +%Y-%m-%d)"
git push origin main
```

Vercel redeploys within ~30s of push.

**B. PROPOSE-DON'T-WRITE (judgment calls — draft into `.pending-review/<date>.json`):**
- New strategist note body (any meaningful narrative change)
- War status flips (`statusKey` change, trigger state changes)
- SL/TP/addZones changes on existing positions
- Wealth progress component changes

Write proposed patches as JSON-patch documents under `~/Projects/cg-brief-v2/.pending-review/<YYYY-MM-DD>.json`. Do NOT commit these — Khaled reviews and merges manually.

**C. FLAG-ONLY (must be in morning report):**
- eToro 401 / disconnect → "ETORO: disconnected — reconnect via Claude Desktop config or Vercel env vars"
- Vercel build failure → link to latest failed deploy
- Secret rotation needed (GitHub PAT, eToro keys)

### 7. Output format — exactly this structure, ≤ 250 words

```
STATUS: ✅ site 200 / reconciled / pushed · OR ⚠ warnings · OR 🔴 broken
LAST_UPDATED: <today> (auto-bumped)
ETORO: live (<N positions, $X cash>) / disconnected (<reason>)

RECONCILED (auto-applied):
- <each diff in one line>

MARKET MOVES (only if material):
- <ticker>: <% move> → <flag triggered>

NEEDS REVIEW (drafted in .pending-review/<date>.json):
- <strategist note rewrite>
- <new position X needs SL/TP>

OPEN BLOCKERS:
- <eToro 401 / build fail / etc, if any>
```

### Discipline rules (the non-negotiables)
1. **Auto-write quantity / avgCost / status / cashIdle from eToro live every run.** Without this, the file drifts and the dashboard lies.
2. **Never overwrite SL/TP/addZones/strategistNote.body automatically.** These are human framework.
3. **Never flip `warStatus.deploymentLocked` automatically.** Locked stays locked until Khaled approves.
4. **If eToro is offline, write nothing to positions[].** Better to keep last-known-truthful values than blank them.
5. **Append to notes, don't overwrite.** Reconciliation appends a `· RECONCILED <date>` line preserving the discipline note above it.
6. **One commit per run, even if no changes.** Bumping `lastUpdated` daily proves the task ran. Empty-diff days commit only the timestamp + 7-day MarketSymbols ISR refresh.

### Schedule
- Primary: 06:00 Dubai (02:00 UTC) — pre-Asian-open
- Secondary: 18:00 Dubai (14:00 UTC) — post US close, captures overnight closes/SLs/dividend events. If this second schedule doesn't exist yet, create it.
