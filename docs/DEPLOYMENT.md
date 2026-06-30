# ShadchanAI — Production Deployment (Railway)

This app deploys as **one Railway service** running a single Node process
that serves both the API and the built client SPA from the same origin.

> **Single-instance only.** Baileys WhatsApp sessions, the send-claim lock,
> and the notifications buffer are all in-process. Run **exactly 1 replica**
> (`railway.json` pins `numReplicas: 1`). Scaling horizontally requires
> Redis-backed equivalents first — see the Pilot Runbook "Known Limitations".

---

## 1. Topology

```
        ┌─────────────────────── Railway service (1 replica) ───────────────────────┐
Browser │  Express  ──/api/*──▶  domain routers                                      │
  ──────┼──▶ same   ──/*─────▶  static client SPA (CLIENT_DIST_DIR=/app/client/dist) │
 origin │  origin                                                                    │
        │      │                                                                     │
        │      ├──▶ MongoDB Atlas (external)                                         │
        │      └──▶ Volume mounted at /data/wa-sessions  ← Baileys credentials       │
        └────────────────────────────────────────────────────────────────────────────┘
```

The client calls a **hardcoded relative `/api`**, so client and API MUST be
same-origin. The Dockerfile bakes the client build into the image and
`CLIENT_DIST_DIR` makes Express serve it.

---

## 2. One-time provisioning

### 2.1 MongoDB Atlas
1. Create a **dedicated** cluster for the pilot (M10+ recommended; M0/M2 only
   for a throwaway test). Not a shared dev DB.
2. Create a DB user with `readWrite` on the `shadchanai` database.
3. Network access: allow Railway egress (or `0.0.0.0/0` for the pilot, then
   tighten). Prefer Atlas Private Endpoint if available.
4. Copy the SRV connection string → `MONGODB_URI` (append `/shadchanai`).

### 2.2 Railway service
1. New Project → Deploy from this GitHub repo. Railway auto-detects
   `railway.json` → builds the `Dockerfile`.
2. **Add a Volume** and mount it at `/data` (so `WA_SESSIONS_DIR=/data/wa-sessions`
   persists). Without this, every channel must re-pair by QR on each deploy.
3. Generate the public domain → use it for `CORS_ORIGINS`.

### 2.3 Secrets (generate real values)
```bash
openssl rand -hex 32   # JWT_SECRET (64 hex chars)
openssl rand -hex 32   # WA_SESSION_ENCRYPTION_KEY (64 hex chars)
```

### 2.4 Environment variables
Set every variable from [`.env.production.example`](../.env.production.example)
as Railway service variables. Critical gotchas:
- `NODE_ENV=production` — unlocks all the hard boot gates.
- `CORS_ORIGINS` = your Railway public URL. **No `localhost`** (hard-fail).
- `WA_SESSIONS_DIR=/data/wa-sessions` (on the mounted volume).
- `ENABLE_OUTBOUND_MESSAGES=false` until you've verified pairing + ingestion.
  > Booleans are parsed textually (`true`/`false`/`1`/`0`/`yes`/`no`/`on`/`off`).
  > `=false` reliably means false. (Older `z.coerce.boolean` treated `"false"`
  > as `true` — fixed in `server/src/utils/zod-bool.ts`.)

---

## 3. Deploy

```bash
# Optional: catch image issues locally before pushing (Railway builds remotely).
docker build -t shadchanai .

git push        # Railway auto-builds + deploys on push to the deploy branch
```

### Boot success signature (Railway logs)
```
[boot] checks passed (N warning(s))
[db] connected to <host>
[jobs] scheduler started
[server] listening on :<PORT> (production)
```

### Refuse to route traffic if you see
- `❌ Invalid environment variables:` — fix the listed vars.
- `[boot] ✖ wa_sessions_dir: …not writable…` — the volume isn't mounted.
- `[boot] ✖ ai_provider: …` — set `GROQ_API_KEY`/`FALLBACK_API_KEY` or `AI_DISABLED=true`.

---

## 4. Post-deploy smoke test
1. `GET https://<app>/api/health` → `200`.
2. Open `https://<app>/` → SPA loads (same origin, no CORS errors in console).
3. Log in as admin (run `npm run seed:admin` against the prod DB first, once).
4. `/channels` → pair one `profiles_source` channel by QR; confirm it reaches
   `active` and survives a redeploy (volume works).
5. Run the full [QA-CHECKLIST](./QA-CHECKLIST.md) before onboarding operators.
   Block the pilot on any ❌ in sections 2.1, 2.5, 2.6, 2.9.

---

## 5. Backups & safety
- **MongoDB:** enable Atlas continuous/daily backups. Snapshot before any
  schema-changing deploy. Test a restore once before onboarding operator #2.
- **WA session volume:** the files under `/data/wa-sessions` ARE the WhatsApp
  credentials. Back them up to encrypted offsite storage; store
  `WA_SESSION_ENCRYPTION_KEY` separately from them. Never log or commit them.
- **Audit log growth:** `auditlogs` has no TTL — plan periodic archival.
- **Notifications buffer is in-memory** — the bell resets on every redeploy.

---

## 6. Backfill scripts (run once, before first operator)
Run from a Railway one-off shell (`railway run`) or locally against the prod
`MONGODB_URI`. All are idempotent and support `DRY_RUN=true` — always dry-run
first. See [PILOT-RUNBOOK §3.7](./PILOT-RUNBOOK.md) for the exact commands:
`backfill-owner.ts`, `backfill-phones.ts`, `backfill-match-conversation-links.ts`.

---

## 7. Rollback
Railway keeps prior deploys — use "Redeploy" on the last-good build. Because
the WA session volume and Mongo are external to the image, a code rollback does
not touch credentials or data. If a deploy changed a schema, restore the
pre-deploy Mongo snapshot as well.
```
