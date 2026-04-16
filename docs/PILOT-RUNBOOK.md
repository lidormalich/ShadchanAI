# ShadchanAI — Pilot Runbook

Single source of truth for running the first real-world pilot on a single
Node instance with up to 3 operators.

---

## 3.1  Required Environment Configuration

Every variable below is read by `server/src/config/env.ts`. Missing or
invalid values fail boot loudly (Zod + `runBootChecks`).

### Required
| Variable | Notes |
|---|---|
| `NODE_ENV` | `production` for the pilot. `development` is the only mode that allows `AUTH_DEV_HEADER_ALLOWED=true`. |
| `MONGODB_URI` | Pointing to a **dedicated** pilot DB, not a shared dev DB. Replica-set recommended; single-node acceptable only if backed by frequent snapshots. |
| `JWT_SECRET` | At least **32 characters** in production (enforced). Generate with `openssl rand -hex 32`. |
| `WA_SESSIONS_DIR` | Absolute path on a **persistent** volume. The Baileys auth files here ARE the WhatsApp credentials — back them up separately from Mongo. |
| `CORS_ORIGINS` | Must not include `localhost` in production (enforced). |
| `GROQ_API_KEY` **or** `FALLBACK_API_KEY` | At least one must be set (or set `AI_DISABLED=true` and accept degraded extraction + advisory). |

### Optional but advisable
| Variable | Notes |
|---|---|
| `FALLBACK_PROVIDER`, `FALLBACK_MODEL`, `FALLBACK_BASE_URL` | OpenAI-compatible fallback when the primary AI fails. |
| `WA_SESSION_ENCRYPTION_KEY` | 64 hex chars. Encrypts on-disk Baileys auth state. Strongly recommended for multi-user shared servers. |
| `GROQ_MODEL`, `GROQ_BASE_URL` | Default to `llama-3.3-70b-versatile` / Groq endpoint. |
| `EMBEDDINGS_PROVIDER` + `EMBEDDINGS_API_KEY` | Needed only if semantic-similarity scoring is used. |
| `RATE_LIMIT_DEFAULT_PER_MIN` | Default 300/min per IP. Increase only if the pilot proxy masks real IPs. |

### Dangerous defaults — explicit guard
- `AUTH_DEV_HEADER_ALLOWED=true` — **MUST BE `false` in production** (enforced, hard boot fail).
- `WA_AUTO_START_SESSIONS=true` — fine for single-instance pilot. For any multi-instance deploy this **MUST be `false`** and sessions started from a dedicated worker.
- `MONGODB_URI=mongodb://localhost:27017/…` — acceptable for dev only. Use auth + hostname in production.

---

## 3.2  Startup Checks

Launch with `npm start` (or however the Node process is supervised) and watch stdout.

### Success signature
```
[boot] checks passed (N warning(s))
[db] connected to <MONGODB_URI host>
[jobs] scheduler started
[server] listening on :<PORT> (<NODE_ENV>)
```

### Failure signatures — DO NOT ROUTE TRAFFIC
- `[boot] ✖ wa_sessions_dir: …not writable…` — Baileys creds directory is missing or read-only. Fix the volume mount before anything else.
- `[boot] ✖ ai_provider: No AI provider configured…` — extraction fallback + advisory services will fail. Set a key or `AI_DISABLED=true`.
- `❌ Invalid environment variables:` — Zod rejected at least one env. Fix the listed fields.
- `[server] startup failed:` stack trace — unhandled exception during `main()`. Capture the stack and investigate.

### Warnings — acceptable but note
- `[boot] ⚠ wa_auto_start: …single-instance only…` — reminder only. If you ever run >1 instance, set `WA_AUTO_START_SESSIONS=false`.
- `[boot] ⚠ auth_dev_header: …dev-only header auth is enabled…` — only possible in non-production.

### Post-boot smoke
1. `GET /api/health` → 200.
2. Log in as admin user; visit `/channels`. At least one channel auto-reconnects to `active`.
3. Visit `/` (dashboard). Queue loads within 2 s.

---

## 3.3  Daily Operation Flow (operator-facing)

### Start of shift
1. Log in → land on `/` (dashboard).
2. Set ownership filter to **"שלי"**.
3. Work through the queue top-to-bottom — it is ordered by urgency.

### Process categories, in priority order
- **תגובה חדשה (new_response)** — click the row → opens the chat (auto-acknowledges the response). Reply or take whatever action fits.
- **שיחה דורשת תשומת לב (inbound_action)** — click → `/chats?conversation=…`. Read, reply, or mark as handled.
- **ממתין לתגובה (awaiting_response)** — click → match detail. If the recipient has been silent past SLA, send a nudge or defer.
- **משימה באיחור (overdue_task)** — click "סמן בוצע" on the row to complete in-place, or click to open the task.
- **דורש סקירה (needs_review)** — click → review queue auto-scrolls to the extracted message. Correct fields if needed, then approve.
- **הצעה בציון גבוה (high_potential_draft)** — open the match, review the AI draft, and send.
- **מושהה — לבדוק שוב (deferred_recheck)** — old deferred matches; reopen or close.

### Handling candidates
1. `/candidates/internal` with filter `mine`. Create / edit / close as needed.
2. For any candidate: "חפש התאמות" to see eligible + blocked lists.
3. On a blocked candidate, only the **"ניתן לעקוף"** rows can be forced — and only with a real written justification ≥10 chars and an explicit acknowledgement.

### Sending proposals
1. Open a draft match. Click "צור עם AI" to generate a draft → it is saved on the match. Edit freely.
2. "שלח הצעה" → select match_sending channel + side. **Do not click twice** — the server enforces single-send but the first click is canonical.
3. Match status flips instantly to SENT_*. A linked conversation tile appears.

### Tracking responses
- New responses arrive automatically via the auto-detector. Dashboard shows the row; operator clicks → opens conversation → ack happens automatically.
- If the classifier was conservative (`considering`), read the reply and manually decline/defer/approve from the match page.

### End of shift
- Leave dashboard filter on `mine`. Ensure no critical `new_response` rows are unhandled.

---

## 3.4  Failure Handling (operator playbook)

### WhatsApp disconnects mid-shift
**Signal:** Channel card flips to `disconnected` (SSE pushes this). Outbound send attempts return `send_failed`.
**Fix:**
1. `/channels` → find the offline channel.
2. Click "חבר מחדש". Wait ~15 s.
3. If that fails, "התחל סשן" and scan a fresh QR.
4. If the session was logged out by WhatsApp itself, use "יציאה מהחשבון" then "התחל סשן".

### QR expires before scanning
The UI auto-polls every 10 s and replaces the QR. If the modal is stale (browser tab suspended), close and re-open the QR. If still stuck, click "רענן סטטוס" manually.

### Duplicate external detected
**Signal:** Toast "An external candidate with this phone already exists" with an `existingCandidateId`.
**Fix:**
1. Open the existing candidate.
2. Update its fields with any new info from the current message.
3. Reject the duplicate in the review queue (or if it was a manual create, no action needed).

Do NOT attempt to merge via raw DB writes — there is no merge UI yet; duplicates are a known pilot-time limitation.

### Send fails
**Signal:** Toast `Send failed: …`.
**Fix:**
1. Check the channel status (`/channels`). If not `active`, reconnect.
2. Check the match's "מצב שליחה" tile for blockers (e.g., external withdrew, share card not approved).
3. If the lock is held from a crashed previous attempt, wait 30 s — the lock goes stale automatically — then retry.

### Response not detected
**Signal:** Recipient replied but the dashboard has no `new_response` row after 30 s.
**Possible causes:**
1. The conversation isn't linked to the match (check match detail → "שיחות מקושרות"). If missing, it can be relinked by opening the conversation and using `/api/conversations/:id/link` from an admin console, or by running `backfill-match-conversation-links` from ops.
2. The reply text was ambiguous → status is `considering` (visible on match detail). This is not a failure; manually classify.
3. AI fallback was unavailable — check server logs for `ai_provider` errors.

---

## 3.5  Backup / Safety

### MongoDB
- Nightly `mongodump` of the pilot DB to offsite storage, minimum.
- Before every deploy that changes a schema, take a snapshot.
- Test the restore path at least once before onboarding the second operator. A backup that has never been restored is not a backup.

### Baileys session directory (`WA_SESSIONS_DIR`)
- This directory **IS** the WhatsApp credential. Protect it like a private key.
- On Linux: permissions `0700` on the directory, `0600` on files.
- Back it up to the same encrypted location as the Mongo dump.
- NEVER commit it. NEVER log its contents.
- If `WA_SESSION_ENCRYPTION_KEY` is set, the on-disk state is encrypted — store the key separately from the session files.

### Restart behavior
- On graceful shutdown (`SIGTERM`/`SIGINT`), Baileys sessions close cleanly, the job scheduler stops, DB disconnects.
- On restart with `WA_AUTO_START_SESSIONS=true`, every `active` channel attempts to reconnect. Operator action is only needed if a channel requires a fresh QR (logged out by WhatsApp).
- The notifications ring buffer (`server/src/services/notifications/notifications.service.ts`) is in-memory — it **resets on restart**. This is acceptable for the pilot; see Known Limitations.

---

## 3.6  Known Limitations (pilot)

- **`ownership=team` behaves like `all`.** No team/org model yet. If team semantics matter, use `mine` or `all` instead.
- **No duplicate-merge UI.** The backfill script produces a duplicates report; merging is manual DB work by an admin.
- **Notifications feed is in-memory.** Restart clears the bell's recent events for everyone.
- **Single Node instance only.** Horizontal scaling requires swapping the Baileys session store, the send-claim lock, and the notifications buffer for Redis-backed equivalents.
- **Matching weights are hardcoded in the engine** — the settings framework hosts dashboard thresholds only. Weight tuning requires a code change + redeploy.
- **Extraction auto-path creates unowned externals.** Run the owner-backfill script (or assign during the review step) if the auto-create rate is high.
- **WhatsApp media profiles without a caption are NOT ingested.** Operator must ask the sender for a text or caption version.
- **QR auto-refresh is a 10-second poll** — not a push. A QR that rotates sub-second before scanning may still be stale; re-open the modal if pairing fails.
- **Response AI confidence floor is 0.7.** Below this, the status stays `considering`. This is conservative by design; operators may need to manually classify ambiguous replies.
- **Force-match preserves blocker context in `overrideReasons`** but non-overridable blockers (same-gender, external-withdrew, external's own filter, internal-already-dating) cannot be forced at all.
- **Audit log has no TTL.** Expect the `auditlogs` collection to grow; plan for periodic archival before it dominates DB storage.

---

## 3.7  Backfill scripts

Run from `server/` before onboarding the first operator. All scripts are
idempotent and support `DRY_RUN=true`.

```bash
# 1. Owner backfill. FALLBACK_USER_ID must be an existing active user.
FALLBACK_USER_ID=<admin_user_id> DRY_RUN=true \
  npx tsx src/scripts/backfill-owner.ts
FALLBACK_USER_ID=<admin_user_id> \
  npx tsx src/scripts/backfill-owner.ts

# 2. Phone normalization + duplicate report.
DRY_RUN=true npx tsx src/scripts/backfill-phones.ts > /tmp/dup-preview.ndjson
             npx tsx src/scripts/backfill-phones.ts > ops/dup-report.ndjson
# Review ops/dup-report.ndjson manually before resolving duplicates.

# 3. Match ↔ conversation linkage repair.
DRY_RUN=true npx tsx src/scripts/backfill-match-conversation-links.ts
             npx tsx src/scripts/backfill-match-conversation-links.ts
# Review the printed JSON report — ambiguous/missing/orphan entries
# require manual intervention.
```

Always run the dry-run first and eyeball the counts. If a number is
wildly different from expectation, investigate before applying.
