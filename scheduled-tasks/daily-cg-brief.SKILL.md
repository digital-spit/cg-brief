---
name: daily-cg-brief
description: Morning check + active staleness gating of the C&G Brief dashboard (6 AM Dubai / 2 AM UTC). Auto-writes safe refreshes when possible; otherwise drafts a pending review.
---

You are running unattended. Your job is to make sure that **the next time Khaled looks at https://cg-brief-v2.vercel.app, the data is not stale and the failure modes are visible**.

The real Next.js app is at `~/Projects/cg-brief-v2/` (NOT `~/Projects/cg-brief/` — that's the dead v1). Manual data lives at `~/Projects/cg-brief-v2/src/data/manual-input.json`. The repo is `digital-spit/cg-brief` on GitHub; Vercel auto-deploys from `main`.

## Run order

### 1. Site reachability
- `curl -sI -o /dev/null -w "%{http_code}\n" https://cg-brief-v2.vercel.app` — must be 200.
- If non-200, stop and report.

### 2. Read current manual-input.json state
- Read `~/Projects/cg-brief-v2/src/data/manual-input.json`.
- Compute `daysOld(lastUpdated)`. Note the value.
- Note `etoro.currentSnapshot.date` and `etoro.statementPeriod` ages.
- Check `actionItems[]` for any item containing "eToro MCP" or "401" — if present, eToro is known broken.

### 3. Health probe the deployed APIs
- `curl -s https://cg-brief-v2.vercel.app/api/snapshot | jq '.lastUpdated, (.positionsLive | length)'` — verify the live snapshot matches what's in the repo.
- `curl -s https://cg-brief-v2.vercel.app/api/war-pulse | jq '.source, .lastUpdated'` — should be `live-ai` or `live-rule`, not `fallback`.

### 4. Market scan (the existing job)
- Use the khaled-financial-analyst skill context.
- Identify any moves on the active book (VTI, QQQ, GC=F, PINS, BTC-USD, ICLN, ETH-USD, TSM) that flip a flag: hit SL, near TP1/TP2, RSI >75 or <30, gap day, earnings beat/miss, macro print.
- Check geopolitical: Iran/Hormuz status, USD moves, Brent crude level vs $109 reference, gold spot vs $4,530.

### 5. Decide and act — three buckets

**A. SAFE AUTO-WRITES (do automatically, then commit + push):**
- Bump `lastUpdated` to today's Dubai date (YYYY-MM-DD) — proves the dashboard was reviewed today.
- If a position has flipped status in the deployed snapshot (e.g., stop hit, TP hit), update its `notes` field to reflect the current live %. Keep edits minimal and factual.
- Refresh any obvious passed-event status: in `events[]`, if `date < today` and `status` is "today" or missing, leave it (history is fine) — but if there's stale "today expected" copy, remove it.

To commit + push, use the existing flow:
```bash
cd ~/Projects/cg-brief-v2
git add src/data/manual-input.json
git commit -m "data: daily refresh $(date -u +%Y-%m-%d) — bumped lastUpdated, [other changes]"
# Push via the GITHUB_TOKEN in ~/Projects/cg-brief/.env (v1 folder, where the token lives)
TOKEN=$(grep GITHUB_TOKEN ~/Projects/cg-brief/.env | cut -d= -f2)
git push https://${TOKEN}@github.com/digital-spit/cg-brief.git main
```
Vercel will redeploy within ~30s.

**B. PROPOSE-DON'T-WRITE (judgment calls — draft into a pending-review file):**
- Strategist note rewrite (any meaningful body change).
- War status flips (statusKey change, trigger state changes).
- Opening/closing positions.
- Wealth progress snapshot updates.

For these, write a proposed JSON patch to `~/Projects/cg-brief-v2/.pending-review/$(date +%Y-%m-%d).json` with a clear before/after diff and reasoning. Do NOT commit these.

**C. FLAG-ONLY (cannot be fixed by you, must be in the report):**
- eToro API returning 401 → reconnect needed in Vercel env (`ETORO_API_KEY` + `ETORO_USER_KEY`).
- AI strategist endpoint failing.
- Vercel build failures.
- Any secret rotation needed (GitHub PAT expiry, etc.).

### 6. Output format

Produce a single concise briefing (≤ 200 words) with these sections:

```
STATUS: ✅ site 200 / ⚠ warnings / 🔴 broken
LAST_UPDATED: <age in days> · <auto-bumped today? yes/no>
ETORO: live / disconnected (reason)

MARKET MOVES (only if material):
- <ticker>: <move> → <flag triggered>

AUTO-APPLIED:
- <changes committed + pushed, if any>

NEEDS YOUR REVIEW (in .pending-review/):
- <judgment calls drafted, if any>

OPEN BLOCKERS (you must fix):
- <eToro 401 / build failure / etc.>
```

### Discipline rules

- Never edit `positions[]` SL/TP/quantity automatically — those are discipline levels.
- Never flip `warStatus.deploymentLocked` — locked stays locked until Khaled approves.
- Never rewrite `strategistNote.body` automatically — propose only.
- If unsure, choose to report rather than write.
- Run twice daily: this 6 AM Dubai run + an 18:00 Dubai run (after US market close) — create the second schedule if it doesn't exist.
