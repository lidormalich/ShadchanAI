# ShadchanAI

> Matchmaking (Shidduch) management system for Dati-Leumi and Haredi/Dati communities.
> An all-in-one Node.js monorepo: candidate management, a deterministic matching engine,
> WhatsApp ingestion & messaging (Baileys), and advisory AI — served as a single web app.

![License](https://img.shields.io/badge/license-Proprietary-red) ![Node](https://img.shields.io/badge/node-%E2%89%A520-green) ![Status](https://img.shields.io/badge/status-pilot-yellow)

> ⚠️ **Proprietary software — source-available, NOT open-source.** The code is public for
> reference only. You may **not** use, copy, modify, or deploy it without written permission.
> See [LICENSE](./LICENSE). / **תוכנה קניינית** — הקוד גלוי לצפייה בלבד, אינו קוד פתוח. ראו [רישיון](#רישיון).

*(English quick-start first — the full, detailed guide in Hebrew follows below. / מדריך מלא ומפורט בעברית בהמשך.)*

---

## English — Quick Start

### What it is

ShadchanAI helps Shadchanim (matchmakers) collect candidate profiles, discover matches, and
communicate with families over WhatsApp. Key design principles:

- **Single monorepo, single process.** No microservices, no Python. One Node process serves
  both the REST API and the built React SPA from the same origin.
- **AI is advisory only.** It never writes to the database and never sends anything on its own.
- **The matching engine is deterministic** — rules + weighted scoring, not an LLM.
- **WhatsApp uses Baileys** (session/QR based) — no Meta Cloud API, no webhooks.
- **Single-instance by design.** WhatsApp sessions, the send-claim lock, and the notifications
  buffer are all in-process. Run **exactly one** replica.

### Tech stack

| Layer      | Tech                                                            |
|------------|----------------------------------------------------------------|
| Server     | Node ≥ 20, Express 4, TypeScript (strict), Mongoose 8, Pino, Zod |
| Client     | React 18, Vite 5, TailwindCSS 3, React Query, React Router      |
| Database   | MongoDB (local for dev, Atlas for production)                  |
| WhatsApp   | `@whiskeysockets/baileys`                                       |
| AI         | Groq (free, primary) with OpenAI fallback                      |
| Storage    | Local disk (dev) / Cloudflare R2 (durable photos, optional)    |

### Features at a glance

- **Dashboard** — pipeline overview and daily activity.
- **Candidates** — internal (managed) and external (WhatsApp-sourced) profiles, with an
  "original card" tab showing the source WhatsApp message.
- **Matching** — per-candidate discovery board ("לוח התאמה"), bulk Match Scan with caching,
  and vector-ranked **Smart Matches** (optional semantic add-on).
- **Proposals** — inbox, review queue, and a match pipeline with statuses & reasons.
- **WhatsApp** — channel pairing (QR), inbound ingestion, channel-role mappings, safe-mode gated outbound.
- **Insights & learning loop** — rejection-reason bank and AI-derived candidate insights.
- **Ops** — monitoring, AI cost tracking, tasks/notes, audit log.

*(Full screen-by-screen walkthrough in the Hebrew section below.)*

### Repository layout

```
ShadchanAI/
├── shared/            # types + Zod schemas shared by server & client
├── server/            # Express API, matching engine, WhatsApp (Baileys), AI
│   └── src/
│       ├── modules/   # domain modules (candidates, matches, channels, …)
│       ├── services/  # cross-cutting services (ai, whatsapp, embedding, notifications, media)
│       ├── config/    # env validation, db, boot-checks
│       └── scripts/   # seed + maintenance/backfill scripts
├── client/            # React + Vite SPA
├── docs/              # deployment, pilot runbook, QA checklist
├── render.yaml        # Render Blueprint (primary deploy path)
└── railway.json       # Railway config (see deployment notes)
```

### Prerequisites

- **Node.js ≥ 20** (Render uses 22) and npm.
- **MongoDB** — a local `mongod` for development, or a MongoDB Atlas cluster for production.
- **A Groq API key** (free at [console.groq.com](https://console.groq.com)) — or an OpenAI key,
  or run with `AI_DISABLED=true`.
- Optionally: a WhatsApp phone/account to pair, and Cloudflare R2 credentials for durable photos.

### Install & run (local development)

```bash
git clone <repo-url> ShadchanAI
cd ShadchanAI

npm install                 # installs all workspaces (shared, server, client)
cp .env.example .env        # then edit .env — set MONGODB_URI, GROQ_API_KEY, JWT_SECRET

# Create the first admin user (run once, needs MONGODB_URI reachable)
npm run seed:admin --workspace=server

npm run dev                 # runs server + client together (concurrently)
```

- **Client (Vite dev server):** http://localhost:5175
- **Server (Express API):** http://localhost:3000 (or the `PORT` you set) — health at `/api/health`

The Vite dev server proxies `/api` to the server, so you use the **client URL** in the browser.

### Useful scripts

| Command                                    | What it does                                         |
|--------------------------------------------|------------------------------------------------------|
| `npm run dev`                              | Server + client together (hot reload)                |
| `npm run dev:server` / `npm run dev:client`| Run just one side                                    |
| `npm run build`                            | Build shared → server → client (production build)    |
| `npm start`                                | Run the compiled server (`server/dist/server.js`)    |
| `npm run lint`                             | Type-check server and client                         |
| `npm run seed:admin --workspace=server`    | Create/seed the first admin user                     |
| `npm run test --workspace=server`          | Run the server test suite (Vitest)                   |
| `npm run wa:diagnose --workspace=server`   | Diagnose WhatsApp channels / sessions                |
| `npm run wa:unlock --workspace=server`     | Release a stuck channel lock                         |
| `npm run wa:rehome --workspace=server`     | Re-home messages orphaned by channel churn           |

### Deploy on Render (recommended)

The repo ships a [`render.yaml`](./render.yaml) Blueprint. One **Web Service** builds the
monorepo (`shared → server → client`) and runs **one** Node process serving both the API and
the SPA from the same origin.

1. **Push to GitHub**, then in Render: **New → Blueprint** and point it at this repo.
   Render reads `render.yaml` (region `frankfurt`, plan `starter`, `numInstances: 1`, a 1 GB
   persistent disk at `/data`, health check `/api/health`).
2. **Set the `sync: false` secrets** in the Render dashboard (they are intentionally not in the file):
   - `MONGODB_URI` — your MongoDB Atlas connection string (Render does not host MongoDB).
   - `CORS_ORIGINS` — the service's public URL, e.g. `https://shadchanai.onrender.com`
     (**must not contain `localhost`** in production — enforced).
   - `GROQ_API_KEY` — your AI key (or set an OpenAI key / `AI_DISABLED=true`).
   - *(recommended)* `WA_SESSION_ENCRYPTION_KEY` — 64 hex chars (`openssl rand -hex 32`).
   - `JWT_SECRET` is auto-generated by Render (`generateValue: true`).
3. **First deploy** builds via `npm ci --include=dev && npm run build` and starts with
   `node server/dist/server.js`.
4. **Seed the first admin** once (Render Shell): `npm run seed:admin --workspace=server`.
5. **Pair WhatsApp**: open `/channels` in the app and scan the QR per channel. The session
   files live on the persistent disk at `/data/wa-sessions` and survive redeploys.
6. **Outbound stays OFF** (`ENABLE_OUTBOUND_MESSAGES=false`) until you've verified pairing and
   ingestion end-to-end. Flip it to `true` only when operators are ready to send real proposals.

> **Why the persistent disk matters:** the files under `/data/wa-sessions` **are** the WhatsApp
> credentials. Without the mounted disk every channel must re-pair by QR on each deploy.

> **Why single-instance:** WhatsApp sessions, the send lock, and notifications are in-process.
> Keep `numInstances: 1`. Scaling horizontally would require Redis-backed equivalents first.

---
---

<div dir="rtl">

## עברית — מדריך מלא ומפורט

### מה זה ShadchanAI

ShadchanAI היא מערכת לניהול שידוכים עבור קהילות דתי-לאומי וחרדי/דתי. המערכת עוזרת לשדכנים
לאסוף פרופילים של מועמדים, לגלות התאמות, ולתקשר עם המשפחות דרך וואטסאפ.

עקרונות מרכזיים בארכיטקטורה:

- **מונו-רפו יחיד, תהליך יחיד.** אין מיקרו-שירותים, אין Python. תהליך Node אחד מגיש גם את
  ה-API (REST) וגם את אפליקציית ה-React הבנויה — מאותו מקור (same-origin).
- **ה-AI הוא ייעוצי בלבד.** הוא לעולם לא כותב למסד הנתונים ולעולם לא שולח כלום בעצמו.
- **מנוע ההתאמה דטרמיניסטי** — חוקים + ניקוד משוקלל, לא מודל שפה.
- **וואטסאפ עובד דרך Baileys** (מבוסס סשן/QR) — ללא Meta Cloud API וללא webhooks.
- **מופע יחיד (single-instance) בתכנון.** סשנים של וואטסאפ, נעילת השליחה (send-lock), ומאגר
  ההתראות — כולם בתוך התהליך. יש להריץ **מופע אחד בלבד**.

### מבנה הפרויקט (Monorepo)

הפרויקט מנוהל כ-npm workspaces עם שלושה חבילות:

| Workspace | תיאור                                                         |
|-----------|---------------------------------------------------------------|
| `shared`  | טיפוסים, סכמות Zod וקוד משותף בין השרת ללקוח                  |
| `server`  | שרת Express + Mongoose + מנוע ההתאמה + מנוע וואטסאפ + AI      |
| `client`  | אפליקציית React/Vite (ה-SPA)                                  |

סדר ה-build הוא תמיד: `shared → server → client` (הלקוח והשרת תלויים ב-shared).

#### מפת תיקיות מפורטת

```
ShadchanAI/
├── shared/                     # טיפוסים + סכמות Zod משותפים לשרת וללקוח
├── server/
│   └── src/
│       ├── modules/            # מודולי דומיין, כל אחד עם router + service + model:
│       │   ├── auth/           #   התחברות, JWT, משתמשים
│       │   ├── users/          #   ניהול משתמשי המערכת
│       │   ├── candidates/     #   מועמדים פנימיים + חיצוניים
│       │   ├── matches/        #   התאמות, ניקוד, pipeline
│       │   ├── pair-reviews/   #   ביקורת זוגות
│       │   ├── rejection-reasons/ # בנק סיבות דחייה (dedup מטושטש)
│       │   ├── channels/       #   ערוצי וואטסאפ
│       │   ├── chat-mappings/  #   מיפוי שיחות לתפקידים
│       │   ├── conversations/  #   שיחות והודעות
│       │   ├── extraction/     #   חילוץ שדות מהודעות (AI)
│       │   ├── insights/       #   תובנות ולולאת למידה
│       │   ├── dashboard/      #   נתוני לוח הבקרה
│       │   ├── notifications/  #   פעמון התראות (בזיכרון)
│       │   ├── realtime/       #   עדכונים בזמן אמת
│       │   ├── search/         #   חיפוש
│       │   ├── settings/       #   הגדרות ריצה (thresholds, מתגים)
│       │   ├── monitoring/     #   ניטור מערכת
│       │   ├── safe-mode/      #   שער בטיחות לשליחה יוצאת
│       │   ├── media/          #   הגשת תמונות (auth-gated + קישור ציבורי)
│       │   ├── tasks/ notes/   #   משימות והערות
│       │   ├── audit/          #   יומן ביקורת
│       │   └── health/         #   בדיקת בריאות
│       ├── services/           # שירותים חוצי-מודולים:
│       │   ├── ai/             #   ניתוב ספקי AI (groq/openai) + כלים
│       │   ├── whatsapp/       #   מנוע Baileys, נעילות, watchdog
│       │   ├── embedding/      #   הטמעות סמנטיות + שער הפעלה
│       │   ├── extraction/     #   orchestrator לחילוץ
│       │   ├── notifications/  #   feed ההתראות
│       │   └── media / storage #   דיסק / R2
│       ├── config/             # env.ts (ולידציית ENV), db, boot-checks
│       └── scripts/            # seed + סקריפטי תחזוקה/backfill
├── client/
│   └── src/pages/              # מסכי ה-SPA (ראו טבלת המסכים למטה)
├── docs/                       # DEPLOYMENT, PILOT-RUNBOOK, QA-CHECKLIST
├── render.yaml                 # Blueprint ל-Render (מסלול הפריסה הראשי)
└── railway.json                # קונפיג Railway (ראו הערות פריסה)
```

### מסכים ופיצ'רים (מה כל מסך עושה)

| מסך (נתיב)                        | תיאור                                                                                   |
|-----------------------------------|-----------------------------------------------------------------------------------------|
| לוח בקרה (`/`)                    | סקירת ה-pipeline, פעילות יומית ומדדים.                                                   |
| מועמדים פנימיים                   | פרופילים מנוהלים במערכת (רשימה + כרטיס מפורט).                                            |
| מועמדים חיצוניים                  | פרופילים שנקלטו מוואטסאפ; כולל טאב "כרטיס מקורי" עם הודעת המקור.                          |
| התאמות חכמות (`/smart-matches`)   | דירוג מבוסס וקטורים (סמנטי) + "סרוק עכשיו". תוסף אופציונלי.                                |
| Pipeline התאמות                   | ניהול התאמות לפי סטטוסים וסיבות.                                                         |
| כרטיס התאמה                       | פירוט התאמה בודדת, ניקוד לפי ממדים, והסבר AI ("הסבר AI").                                 |
| תור הצעות (Inbox)                 | הצעות שממתינות לטיפול השדכן.                                                              |
| תור ביקורת (Review Queue)         | פריטים לבדיקה ידנית (כולל כפילויות — ללא מיזוג אוטומטי).                                  |
| ערוצים (`/channels`)              | חיבור וואטסאפ, סריקת QR, סטטוס ערוצים.                                                    |
| מיפוי שיחות                       | מיפוי שיחות לתפקידים (למשל `profiles_source`).                                            |
| שיחות (Chats)                     | צפייה בהודעות נכנסות.                                                                     |
| תובנות (Insights)                 | פילוח, איכות נתונים ולולאת הלמידה.                                                        |
| ניטור (Monitoring)                | בריאות מערכת, סשנים, jobs.                                                                |
| משימות (Tasks)                    | מטלות מעקב לשדכן.                                                                        |
| הגדרות (Settings)                 | ספי ניקוד, מתגים (כולל הפעלת סמנטי), ומעקב עלויות AI.                                     |

### סקירת ה-API

תהליך Node יחיד מגיש את כל ה-API תחת `/api`, ובפרודקשן גם את ה-SPA מאותו מקור. סדר ה-middleware:
requestId → helmet → CORS → body parser → אימות אופציונלי → logger → rate limiter → routers.

- `GET /api/health` — בדיקת בריאות (**לא** מאחורי rate limiter — כדי שה-probe תמיד יענה).
- `POST /api/auth/...` — התחברות והנפקת JWT.
- `/api/ai/*` — **מוגן באימות חובה** (מחזיר PII אמיתי וקורא לספקי LLM בתשלום) + rate limiter ייעודי.
- `/api/public/photo/<token>` — הנתיב הציבורי היחיד: טוקן בלתי-ניתן-לניחוש לתמונת מועמד, לפתיחת קישור וואטסאפ ללא התחברות.
- קבוצות דומיין (כולן תחת `/api`, רובן דורשות אימות): `candidates/internal`, `candidates/external`,
  `matches`, `pair-reviews`, `rejection-reasons`, `conversations`, `channels`, `tasks`, `notes`,
  `extraction`, `audit-logs`, `users`, `realtime`, `dashboard`, `search`, `notifications`,
  `insights`, `settings`, `monitoring`, `safe-mode`, `media`.

### דרישות מקדימות

- **Node.js גרסה 20 ומעלה** (ב-Render רץ 22) ו-npm.
- **MongoDB** — התקנת `mongod` מקומית לפיתוח, או קלאסטר MongoDB Atlas לפרודקשן.
- **מפתח Groq API** (חינם ב-[console.groq.com](https://console.groq.com)) — או מפתח OpenAI,
  או הרצה עם `AI_DISABLED=true` (מצב מוגבל ללא AI).
- אופציונלי: מספר/חשבון וואטסאפ לצימוד (pairing), ופרטי Cloudflare R2 לאחסון תמונות עמיד.

#### הכנת השירותים החיצוניים

- **גרסת Node:** הפרויקט דורש `>=20` (מוגדר ב-`engines`). Render מריץ 22. מומלץ `nvm use 22`.
- **מפתח Groq (חינם):** להירשם ב-[console.groq.com](https://console.groq.com), ליצור API key,
  ולשים ב-`GROQ_API_KEY`. לחלופין מפתח OpenAI ב-`OPENAI_API_KEY`, או `AI_DISABLED=true`.
- **MongoDB מקומי:** להתקין MongoDB Community ולהריץ `mongod`; ה-URI יהיה
  `mongodb://localhost:27017/shadchanai`. לחלופין **Atlas free-tier (M0)** — ליצור קלאסטר,
  משתמש עם `readWrite`, ולהעתיק את מחרוזת ה-SRV (עם `/shadchanai` בסוף).
- **JWT_SECRET:** לפיתוח כל מחרוזת ≥16 תווים; לפרודקשן `openssl rand -hex 32` (≥32, נאכף).

### התקנה והרצה (פיתוח מקומי)

```bash
git clone <repo-url> ShadchanAI
cd ShadchanAI

npm install                 # מתקין את כל ה-workspaces (shared, server, client)
cp .env.example .env        # ואז לערוך את .env — למלא MONGODB_URI, GROQ_API_KEY, JWT_SECRET

# יצירת משתמש האדמין הראשון (פעם אחת, דורש חיבור פעיל ל-MONGODB_URI)
npm run seed:admin --workspace=server

npm run dev                 # מריץ שרת + לקוח יחד
```

לאחר ההרצה:

- **לקוח (שרת הפיתוח של Vite):** http://localhost:5175 ← **זו הכתובת שפותחים בדפדפן**
- **שרת (Express API):** http://localhost:3000 (או ה-`PORT` שהגדרת) — בדיקת בריאות ב-`/api/health`

שרת הפיתוח של Vite מעביר (proxy) בקשות `/api` לשרת, ולכן בדפדפן משתמשים בכתובת של **הלקוח**.

### סקריפטים שימושיים

| פקודה                                        | מה היא עושה                                          |
|----------------------------------------------|-----------------------------------------------------|
| `npm run dev`                                | שרת + לקוח יחד (עם רענון חם)                          |
| `npm run dev:server` / `npm run dev:client`  | הרצת צד אחד בלבד                                     |
| `npm run build`                              | בונה shared → server → client (build לפרודקשן)       |
| `npm start`                                  | מריץ את השרת המקומפל (`server/dist/server.js`)       |
| `npm run lint`                               | בדיקת טיפוסים לשרת וללקוח                             |
| `npm run seed:admin --workspace=server`      | יצירת/זריעת משתמש האדמין הראשון                       |
| `npm run test --workspace=server`            | הרצת מערך הבדיקות של השרת (Vitest)                   |
| `npm run wa:diagnose --workspace=server`     | אבחון ערוצי/סשני וואטסאפ                              |
| `npm run wa:unlock --workspace=server`       | שחרור נעילת ערוץ תקועה                                |
| `npm run wa:rehome --workspace=server`       | העברת הודעות שהתייתמו עקב החלפת ערוץ                  |

#### סקריפטי תחזוקה ו-Backfill (הרצה חד-פעמית)

הסקריפטים ב-[`server/src/scripts/`](./server/src/scripts/) רצים עם `tsx` מול ה-`MONGODB_URI`
המוגדר. **כל סקריפטי ה-backfill הם idempotent ותומכים ב-`DRY_RUN=true`** — תמיד להריץ קודם
עם `DRY_RUN=true` ולבדוק את הפלט לפני הרצה אמיתית. הרצה מקומית לדוגמה:

```bash
DRY_RUN=true npx tsx server/src/scripts/backfill-phones.ts   # הרצת יובש קודם
npx tsx server/src/scripts/backfill-phones.ts                # ואז אמיתי
```

| סקריפט                              | מה הוא עושה                                                     |
|-------------------------------------|----------------------------------------------------------------|
| `seed-admin.ts`                     | יצירת משתמש האדמין הראשון (זמין גם כ-`npm run seed:admin`).      |
| `backfill-owner.ts`                 | מילוי שדה בעלות (owner) על רשומות ישנות.                         |
| `backfill-phones.ts`               | נרמול/מילוי מספרי טלפון.                                        |
| `backfill-match-conversation-links.ts` | קישור התאמות לשיחות המקור.                                   |
| `fix-sender-phones.ts`              | תיקון טלפוני שולחים (כולל LID אנונימיים).                        |
| `fix-ai-attribution.ts`             | תיקון ייחוס פעולות AI.                                          |
| `recover-media.ts`                  | שחזור/מיפוי מדיה חסרה.                                          |
| `verify-r2.ts`                      | בדיקת חיבור והרשאות ל-Cloudflare R2.                            |
| `wa-diagnose.ts`                    | אבחון ערוצי/סשני וואטסאפ (`npm run wa:diagnose`).                |
| `wa-unlock.ts`                      | שחרור נעילת ערוץ תקועה (`npm run wa:unlock`).                    |
| `rehome-orphaned-channels.ts`       | העברת הודעות מיותמות (`npm run wa:rehome`).                     |
| `dns-preload.ts`                    | חימום DNS (עוקף בעיות DNS איטי באתחול).                         |
| `verification-pass.ts`              | מעבר אימות נתונים.                                              |

---

## הרצת וואטסאפ מקומית מול הענן (חשוב!)

מנוע הוואטסאפ (Baileys) הוא **single-instance** — רק תהליך אחד יכול להחזיק את סשני הערוצים
בו-זמנית, אחרת שני המופעים "נלחמים" על נעילות הערוץ. הדפוס המומלץ:

- **מכונה מקומית תמידית (always-on):** `WA_ENABLED=true` — היא זו שמריצה את סוקטי וואטסאפ,
  קולטת הודעות ושולחת.
- **הפריסה בענן (Render):** `WA_ENABLED=false` — אין סוקטים כלל, אבל ה-UI עדיין מציג את **כל**
  מה שהמכונה המקומית קולטת (כי מסד הנתונים משותף), והענן אינו מחויב על סוקט סרק.

אם אתה מריץ וואטסאפ **בענן בלבד** (ללא מכונה מקומית) — פשוט השאר `WA_ENABLED=true` ב-Render
וודא שהדיסק העמיד מחובר. אל תפעיל `WA_ENABLED=true` בשני מקומות במקביל על אותו DB.

מתגים נלווים: `WA_AUTO_START_SESSIONS` (הפעלה אוטומטית באתחול), `WA_WATCHDOG_ENABLED`
(החייאת סשנים שנפלו), `WA_INSTANCE_ID` (זהות יציבה לתביעת נעילות מהירה לאחר restart).

---

## פריסה (Deployment) על Render — מומלץ

הריפו כולל קובץ Blueprint בשם [`render.yaml`](./render.yaml). שירות **Web Service** אחד בונה
את המונו-רפו (`shared → server → client`) ומריץ תהליך Node **יחיד** שמגיש גם את ה-API וגם
את ה-SPA מאותו מקור.

### שלב אחר שלב

1. **דחיפה ל-GitHub**, ואז ב-Render: **New → Blueprint** ולכוון לריפו הזה.
   Render קורא את `render.yaml` (אזור `frankfurt` — הקרוב לישראל, תוכנית `starter`,
   `numInstances: 1`, דיסק עמיד של 1GB ב-`/data`, בדיקת בריאות `/api/health`).

2. **הגדרת הסודות (`sync: false`)** בלוח הבקרה של Render — הם בכוונה לא נמצאים בקובץ:
   - `MONGODB_URI` — מחרוזת ההתחברות ל-MongoDB Atlas (Render לא מארח MongoDB).
   - `CORS_ORIGINS` — כתובת ה-URL הציבורית של השירות, למשל `https://shadchanai.onrender.com`
     (**אסור שתכיל `localhost`** בפרודקשן — נאכף).
   - `GROQ_API_KEY` — מפתח ה-AI (או מפתח OpenAI / או `AI_DISABLED=true`).
   - *(מומלץ)* `WA_SESSION_ENCRYPTION_KEY` — 64 תווים הקסדצימליים (`openssl rand -hex 32`).
   - `JWT_SECRET` נוצר אוטומטית על ידי Render (`generateValue: true`).

3. **הפריסה הראשונה** בונה עם `npm ci --include=dev && npm run build` ומריצה עם
   `node server/dist/server.js`.
   *(ה-`--include=dev` נחוץ כי כלי הבנייה — vite, typescript — הם devDependencies, ו-NODE_ENV=production היה גורם ל-npm לדלג עליהם.)*

4. **זריעת האדמין הראשון** פעם אחת (דרך Render Shell): `npm run seed:admin --workspace=server`.

5. **צימוד וואטסאפ (Pairing):** לפתוח `/channels` באפליקציה ולסרוק את ה-QR לכל ערוץ. קבצי הסשן
   שוכנים על הדיסק העמיד ב-`/data/wa-sessions` ושורדים פריסות מחדש (redeploys).

6. **שליחה יוצאת נשארת כבויה** (`ENABLE_OUTBOUND_MESSAGES=false`) עד לאימות מלא של הצימוד
   וקליטת ההודעות מקצה לקצה. להעביר ל-`true` רק כשהשדכנים מוכנים לשלוח הצעות אמיתיות.

### נקודות קריטיות ב-Render

> **למה הדיסק העמיד חשוב:** הקבצים ב-`/data/wa-sessions` **הם** האישורים (credentials) של
> וואטסאפ. בלי הדיסק המחובר — כל ערוץ יצטרך להיצמד מחדש ב-QR בכל פריסה.

> **למה מופע יחיד:** סשני וואטסאפ, נעילת השליחה, וההתראות נמצאים בתוך התהליך. יש לשמור על
> `numInstances: 1`. הרחבה אופקית (scale-out) תדרוש קודם מקבילים מבוססי Redis.

> **מאגר ההתראות הוא בזיכרון** — פעמון ההתראות מתאפס בכל פריסה מחדש.

> **גיבוי:** להפעיל גיבויים ב-Atlas; לגבות את `/data/wa-sessions` לאחסון מוצפן חיצוני
> ולשמור את `WA_SESSION_ENCRYPTION_KEY` בנפרד מהם. לעולם לא לתעד (log) או לעשות commit לקבצים אלה.

### חתימת הצלחת אתחול (בלוגים)

```
[boot] checks passed (N warning(s))
[db] connected to <host>
[jobs] scheduler started
[server] listening on :<PORT> (production)
```

אם רואים אחד מאלה — השרת מסרב לקבל תעבורה, וצריך לתקן:
- `❌ Invalid environment variables:` — לתקן את המשתנים המפורטים.
- `[boot] ✖ wa_sessions_dir: …not writable…` — הדיסק לא מחובר.
- `[boot] ✖ ai_provider: …` — להגדיר `GROQ_API_KEY`/`OPENAI_API_KEY` או `AI_DISABLED=true`.

---

## מסלול פריסה חלופי — Railway / Docker

הריפו כולל גם [`railway.json`](./railway.json) (מגדיר `numReplicas: 1`, healthcheck `/api/health`,
מדיניות restart). התיעוד ב-[`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) מתאר פריסה מלאה ל-Railway.

> ⚠️ **שים לב:** `railway.json` מצפה ל-`Dockerfile` בשורש (`builder: DOCKERFILE`), אך **כרגע
> אין `Dockerfile` בריפו**. לכן מסלול ה-Railway דורש הוספת `Dockerfile` תחילה, בעוד ש-**Render
> הוא מסלול הפריסה העובד** (בנייה נייטיב ללא Docker). העקרונות זהים בשני המסלולים: תהליך יחיד,
> מופע יחיד, MongoDB חיצוני, ודיסק/Volume עמיד ל-`WA_SESSIONS_DIR`.

להרצה מקומית ב-Docker (כשיתווסף Dockerfile): `docker build -t shadchanai . && docker run ...`.

---

## פתרון תקלות (Troubleshooting)

| תסמין                                                   | סיבה סבירה ופתרון                                                                       |
|---------------------------------------------------------|-----------------------------------------------------------------------------------------|
| `❌ Invalid environment variables` באתחול                | משתנה ENV חסר/שגוי — הקונסול מפרט בדיוק איזה. תקן לפי טבלת ה-ENV למטה.                    |
| השרת עולה אבל האתר לא נטען (`Route not found` ב-`/`)      | אין build של הלקוח, או `CLIENT_DIST_DIR` שגוי. הרץ `npm run build` וודא ש-`client/dist` קיים. |
| שגיאות CORS בדפדפן                                       | `CORS_ORIGINS` לא כולל את מקור הלקוח. בפרודקשן — כתובת הענן (ללא `localhost`).            |
| קריאות AI נכשלות / 401                                    | מפתח AI חסר או שגוי. הגדר `GROQ_API_KEY`/`OPENAI_API_KEY`, או `AI_DISABLED=true`.        |
| ה-QR לא נסרק / הערוץ לא מגיע ל-`active`                   | `WA_ENABLED=true` נדרש במופע הזה; ודא שאין מופע נוסף שמחזיק את הסשן. נסה `wa:diagnose`.   |
| הסשן נמחק בכל deploy (מבקש QR מחדש)                       | אין דיסק עמיד ל-`WA_SESSIONS_DIR`. ב-Render ודא שהדיסק מחובר ל-`/data`.                   |
| ערוץ "תקוע" ולא מתחבר                                    | נעילה תקועה — `npm run wa:unlock`. בדוק `WA_INSTANCE_ID` יציב.                            |
| תמונות מועמדים נעלמות אחרי deploy                         | הדיסק ephemeral — הגדר את כל ארבעת ערכי R2 (ראו טבלת R2). בדוק עם `verify-r2.ts`.         |
| שליחת וואטסאפ נדחית למרות שהערוץ פעיל                     | `ENABLE_OUTBOUND_MESSAGES=false` (ברירת מחדל בטוחה), או שהשיחה לא מופתה במפורש.           |
| `[boot] ✖ wa_sessions_dir: not writable`                | הדיסק/Volume לא מחובר או ללא הרשאות כתיבה.                                                |
| חיבור ל-Mongo נכשל                                        | `MONGODB_URI` שגוי, או ש-Atlas חוסם את ה-IP (Network Access). ודא `/shadchanai` בסוף.     |

---

## מילון מונחים

- **מועמד פנימי** — פרופיל שמנוהל ישירות במערכת על ידי השדכן.
- **מועמד חיצוני** — פרופיל שנקלט אוטומטית מהודעת וואטסאפ (`sourceMessageIds` מקשר להודעה).
- **ערוץ (Channel)** — חשבון/מספר וואטסאפ מצומד; מזוהה ב-`channelId` (לעולם לא מספר טלפון גולמי).
- **שיחה (Conversation)** — קבוצה/צ'אט; יכולה לקבל תפקיד כמו `profiles_source` (מקור פרופילים).
- **זוג / התאמה (Pair / Match)** — שני מועמדים שהמנוע ניקד; אינדקס ייחודי מונע שתי התאמות פעילות לאותו זוג.
- **הצעה (Proposal)** — התאמה שעברה לשלב תקשורת עם המשפחות.
- **Safe-mode** — שער בטיחות שחוסם כל שליחה יוצאת אמיתית עד הפעלה מפורשת.

---

## בדיקות ואבטחה

**בדיקות:** לשרת יש מערך בדיקות ב-Vitest — `npm run test --workspace=server` (או `test:watch`).
`npm run lint` מריץ בדיקת טיפוסים (`tsc --noEmit`) לשרת וללקוח.

**אבטחה — כללי ברזל:**
- **לעולם לא לעשות commit** ל-`.env`, לתיקיית `WA_SESSIONS_DIR`, או למפתחות. הקבצים ב-`wa-sessions`
  **הם** אישורי הוואטסאפ — לגבות מוצפן, הרשאות `0600`, לא לתעד בלוגים.
- `AUTH_DEV_HEADER_ALLOWED` — לפיתוח בלבד; בפרודקשן חייב `false` (נאכף, מפיל אתחול).
- `JWT_SECRET` ≥32 תווים בפרודקשן; `WA_SESSION_ENCRYPTION_KEY` נשמר בנפרד מהדיסק.
- `/api/ai/*` מוגן באימות חובה (מחזיר PII וקורא ל-LLM בתשלום) — לעולם לא לחשוף ללא session.
- ה-AI **ייעוצי בלבד** — לא כותב ל-DB ולא שולח דבר.
- יומן הביקורת (`auditlogs`) גדל ללא TTL — לתכנן ארכוב תקופתי.

---

## משתני הסביבה (ENV) — הסבר מפורט לכל אחד

כל המשתנים נבדקים באתחול על ידי [`server/src/config/env.ts`](./server/src/config/env.ts) בעזרת
Zod. ערך חסר או שגוי **מפיל את האתחול בקול רם** — זה מכוון. ערכים לוגיים (boolean) מתפרשים
טקסטואלית: `true`/`false`/`1`/`0`/`yes`/`no`/`on`/`off`.

> **טיפ:** ערך `NOT SET` (וגם רווח/ריק) נחשב כ"לא הוגדר" עבור מפתחות אופציונליים — כך מפתח
> ריק פשוט מדלג על הספק במקום לשלוח `NOT SET` כמפתח ולקבל שגיאת 401.

### ליבה (Core)

| משתנה      | ברירת מחדל     | תיאור                                                            |
|------------|----------------|------------------------------------------------------------------|
| `NODE_ENV` | `development`  | `development` / `production` / `test`. `production` פותח את כל שערי הבטיחות הקשיחים. |
| `PORT`     | `3000`         | הפורט שהשרת מאזין עליו. ב-Render/Railway מוזרק אוטומטית — להשאיר ריק שם. |

### אבטחה ואימות (Auth / Security)

| משתנה                     | ברירת מחדל               | תיאור                                                                                 |
|---------------------------|--------------------------|---------------------------------------------------------------------------------------|
| `JWT_SECRET`              | *(חובה)*                 | מפתח לחתימת ה-JWT. בפרודקשן **חייב ≥ 32 תווים** (נאכף). ליצור: `openssl rand -hex 32`. |
| `JWT_EXPIRES_IN`          | `7d`                     | תוקף ה-token (למשל `7d`, `24h`).                                                       |
| `CORS_ORIGINS`            | `http://localhost:5175`  | רשימת מקורות מותרים מופרדת בפסיקים. בפרודקשן **אסור שיכיל `localhost`** (נאכף).         |
| `AUTH_DEV_HEADER_ALLOWED` | `false`                  | מאפשר אימות דרך כותרת `X-Dev-User` — **לפיתוח בלבד**. בפרודקשן חייב `false` (נאכף, מפיל אתחול). |
| `BODY_LIMIT`              | `2mb`                    | גודל מקסימלי של גוף בקשה.                                                              |
| `PUBLIC_BASE_URL`         | *(ריק)*                  | כתובת בסיס ציבורית של הפריסה, ליצירת קישורי תמונה משותפים (`/api/public/photo/<token>`) שעובדים מחוץ לאפליקציה. חייב להצביע על הענן, לא על localhost. ריק ← נופל חזרה למקור הבקשה. |
| `CLIENT_DIST_DIR`         | *(לא מוגדר)*             | כשמוגדר — Express מגיש את ה-SPA הבנוי מהתיקייה הזו (same-origin, נדרש ללקוח). בפיתוח מקומי להשאיר ריק (Vite מטפל). ב-Render: `/opt/render/project/src/client/dist`. |

### מסד נתונים (Database)

| משתנה         | ברירת מחדל | תיאור                                                                         |
|---------------|------------|-------------------------------------------------------------------------------|
| `MONGODB_URI` | *(חובה)*   | מחרוזת החיבור. פיתוח: `mongodb://localhost:27017/shadchanai`. פרודקשן: SRV של Atlas עם שם DB. |

### מנוע ה-AI (בחירת ספק)

| משתנה               | ברירת מחדל | תיאור                                                                                       |
|---------------------|------------|---------------------------------------------------------------------------------------------|
| `AI_ENGINE`         | `groq`     | איזה ספק הוא ה**ראשי**: `groq` (חינם/מהיר) או `openai` (בתשלום). הספק השני משמש אוטומטית כגיבוי אם יש לו מפתח. |
| `AI_DISABLED`       | `false`    | `true` = ריצה ללא AI כלל (חילוץ מידע וייעוץ במצב מוגבל). מבטל את דרישת מפתח ה-AI בפרודקשן.    |
| `AI_DAILY_REQUEST_BUDGET` | `2000` | תקרה יומית קשיחה של בקשות שפוגעות בספק (cache hits חינם). מגן מפני "בריחת" עלויות. `0` = ללא הגבלה. המונה בזיכרון (מתאפס באתחול). |

### Groq (ספק חינמי — ראשי כברירת מחדל)

| משתנה              | ברירת מחדל                            | תיאור                                              |
|--------------------|---------------------------------------|----------------------------------------------------|
| `GROQ_API_KEY`     | *(ריק)*                               | מפתח ה-API של Groq. ריק ← Groq מדולג.               |
| `GROQ_MODEL`       | `llama-3.3-70b-versatile`             | שם המודל.                                           |
| `GROQ_BASE_URL`    | `https://api.groq.com/openai/v1`      | כתובת ה-API (תואם OpenAI).                          |
| `GROQ_TIMEOUT_MS`  | `12000`                               | timeout קצר כדי שספק תקוע/מוגבל יעביר לגיבוי בשניות. |
| `GROQ_MAX_RETRIES` | `1`                                   | מספר ניסיונות חוזרים (0–5).                          |

### OpenAI (ספק בתשלום)

| משתנה                | ברירת מחדל                        | תיאור                                                                     |
|----------------------|-----------------------------------|---------------------------------------------------------------------------|
| `OPENAI_API_KEY`     | *(ריק)*                           | מפתח OpenAI (`sk-...`). המשתנה `OPENAI` מתקבל כשם חלופי.                    |
| `OPENAI_MODEL`       | `gpt-4o-mini`                     | שם המודל.                                                                  |
| `OPENAI_BASE_URL`    | `https://api.openai.com/v1`       | כתובת ה-API.                                                               |
| `OPENAI_TIMEOUT_MS`  | `25000`                           | timeout.                                                                   |
| `OPENAI_MAX_RETRIES` | `1`                               | ניסיונות חוזרים (0–5).                                                     |

### גיבוי מדור קודם (Legacy fallback — לתאימות לאחור)

| משתנה               | ברירת מחדל                    | תיאור                                                          |
|---------------------|-------------------------------|----------------------------------------------------------------|
| `FALLBACK_PROVIDER` | `openai`                      | `openai` / `anthropic`.                                         |
| `FALLBACK_API_KEY`  | *(ריק)*                       | נקרא כמפתח OpenAI כמוצא אחרון, כדי שהגדרות ישנות ימשיכו לעבוד.   |
| `FALLBACK_MODEL`    | `gpt-4o-mini`                 | מודל הגיבוי.                                                    |
| `FALLBACK_BASE_URL` | `https://api.openai.com/v1`   | כתובת ה-API של הגיבוי.                                          |

### וואטסאפ — סשנים ואחסון (Baileys)

| משתנה                            | ברירת מחדל           | תיאור                                                                                                    |
|----------------------------------|----------------------|----------------------------------------------------------------------------------------------------------|
| `WA_SESSIONS_DIR`                | `./data/wa-sessions` | תיקיית מצב האימות (credentials) של Baileys, ערוץ לכל תת-תיקייה. **רגיש כמו הסשן עצמו** — לא לתעד, לא לחשוף, הרשאות 0600, להצפין בגיבוי. בפרודקשן — על הדיסק העמיד. |
| `WA_MEDIA_DIR`                   | `./data/wa-media`    | תיקיית מדיה נכנסת (כרטיסי תמונה מורדים בזמן הקבלה כי מפתחות המדיה פגים). בפרודקשן — על אותו דיסק עמיד.       |
| `WA_MEDIA_MAX_BYTES`             | `8000000`            | גודל מקסימלי למדיה נכנסת (בתים).                                                                          |
| `WA_VISION_EXTRACT`              | `true`               | חילוץ מידע מכרטיסי תמונה בלבד באמצעות ראייה ממוחשבת (OpenAI multimodal). מדולג אוטומטית ללא מפתח OpenAI.     |
| `WA_PROFILES_SOURCE_DISPLAY_NAME`| *(ריק)*             | שם תצוגה ברירת מחדל לערוץ מסוג "מקור פרופילים" — משמש רק בנתיבי seed/script.                                |
| `WA_MATCH_SENDING_DISPLAY_NAME`  | *(ריק)*             | שם תצוגה ברירת מחדל לערוץ שליחת התאמות — משמש רק בנתיבי seed/script.                                        |

### וואטסאפ — בקרת המנוע והתחברות

| משתנה                       | ברירת מחדל | תיאור                                                                                                                                      |
|-----------------------------|------------|--------------------------------------------------------------------------------------------------------------------------------------------|
| `WA_ENABLED`                | `true`     | מתג ראשי למנוע וואטסאפ **במופע הזה**. `false` = אפס סוקטים של Baileys. יש להשאיר `true` על המכונה היחידה שמריצה וואטסאפ, ו-`false` בענן — כדי שהשניים לא יתנגשו על נעילות הערוץ. ה-DB משותף, כך שה-UI בענן עדיין רואה הכל. |
| `WA_AUTO_START_SESSIONS`    | `true`     | באתחול — הפעלה אוטומטית של סשנים לכל ערוץ פעיל. בטוח למופע יחיד. לריבוי מופעים חייב `false`.                                                     |
| `WA_INSTANCE_ID`            | *(אופ')*  | זהות יציבה לבעלות על נעילות ערוץ. מאפשר לתהליך שהופעל מחדש לתבוע מיד את נעילותיו. נופל חזרה ל-HOSTNAME ואז ל-UUID אקראי.                          |
| `WA_WATCHDOG_ENABLED`       | `true`     | שומר-ראש שמחייה סשנים שנפלו ולא התאוששו לבד (מעגל מנתק, או client חסר). "לשמור מחובר", לא "לסובב חיבור". מופע יחיד בלבד.                          |
| `WA_WATCHDOG_INTERVAL_MS`   | `120000`   | תדירות בדיקת שומר-הראש (מ"ש).                                                                                                                |
| `WA_RECONNECT_MAX_ATTEMPTS` | `10`       | מספר ניסיונות התחברות מחדש לפני פתיחת מעגל ההגנה.                                                                                            |
| `WA_SYNC_FULL_HISTORY`      | `false`    | `true` = בקשה מוואטסאפ להיסטוריה מלאה יותר בעת (re)connect. ברירת המחדל `false` שומרת על אחסון רזה. שינוי דורש **צימוד מחדש**.                    |

### וואטסאפ — הגבלות שליחה (rate limits)

| משתנה                          | ברירת מחדל | תיאור                                        |
|--------------------------------|------------|----------------------------------------------|
| `WA_SEND_PER_CHANNEL_PER_MIN`  | `20`       | תקרת הודעות יוצאות לערוץ לדקה.                |
| `WA_SEND_PER_USER_PER_MIN`     | `30`       | תקרת הודעות יוצאות למשתמש לדקה.               |

### שערי בטיחות טרום-פיילוט (חשוב!)

| משתנה                            | ברירת מחדל | תיאור                                                                                                                                  |
|----------------------------------|------------|----------------------------------------------------------------------------------------------------------------------------------------|
| `ENABLE_OUTBOUND_MESSAGES`       | `false`    | **מתג הרג ראשי לכל שליחה יוצאת אמיתית.** `false` = כל שליחה נדחית לפני שנוגעים בסוקט. להשאיר `false` עד אימות מלא של צימוד וקליטה. |
| `REQUIRE_EXPLICIT_SOURCE_MAPPING`| `true`     | `true` = קליטה מתבצעת רק משיחות שמופו במפורש כ-`profiles_source`. קבוצות אקראיות לא נקלטות. להעביר ל-`false` רק אחרי שכל שיחה פעילה מופתה.  |
| `WA_SESSION_ENCRYPTION_KEY`      | *(אופ')*  | הצפנת מצב Baileys על הדיסק (לגיבוי חיצוני). בפרודקשן חייב 64 תווים הקסדצימליים אם מוגדר. לאחסן **מחוץ** לדיסק (משתנה סביבה בלבד).            |

### הטמעות סמנטיות (Embeddings — אופציונלי)

תוסף מבוסס וקטורים לדירוג התאמות; מופעל על ידי הגדרת אדמין (`matching.semantic_enabled`) —
ה-ENV רק זורע את ברירת המחדל.

| משתנה                   | ברירת מחדל | תיאור                                                                        |
|-------------------------|------------|------------------------------------------------------------------------------|
| `EMBEDDINGS_ENABLED`    | `false`    | ברירת מחדל בזמן פריסה עבור הגדרת האדמין. השער בפועל = הגדרה + מפתח ספק.        |
| `EMBEDDINGS_PROVIDER`   | *(ריק)*   | ספק ההטמעות.                                                                  |
| `EMBEDDINGS_API_KEY`    | *(ריק)*   | מפתח ה-API של ספק ההטמעות.                                                     |
| `EMBEDDINGS_ENDPOINT_URL`| *(ריק)*  | כתובת HuggingFace Dedicated Endpoint (מומלץ לפרודקשן, במקום ה-Serverless).     |
| `EMBEDDINGS_MODEL`      | *(ריק)*   | שם המודל (למשל `BAAI/bge-m3`).                                                 |
| `EMBEDDINGS_DIMENSIONS` | `1024`     | מספר הממדים — חייב להתאים ל-numDimensions של אינדקס הווקטור ב-Atlas.           |
| `SEMANTIC_TOP_K`        | `150`      | כמה מועמדים מוחזרים מ-$rankFusion לפני שהמנוע רץ.                              |

### Cloudflare R2 — אחסון תמונות עמיד (אופציונלי)

הדיסק של Render הוא ephemeral (נמחק בכל פריסה), ולכן תמונות מועמדים ששמורות רק ב-`WA_MEDIA_DIR`
נאבדות. כאשר **כל ארבעת** ערכי R2 מוגדרים — צינור התמונות משכפל כל תמונה ל-R2 (תיקיות מחזור-חיים:
`candidates/`, `review/`, `junk/`) ומגיש אותה חזרה מאחורי אימות דרך `/api/media/candidate/*`.
אם חסר ולו ערך אחד — הפיצ'ר כבוי לחלוטין והתמונות מוגשות מהדיסק המקומי כרגיל.

| משתנה                   | ברירת מחדל | תיאור                                                     |
|-------------------------|------------|-----------------------------------------------------------|
| `R2_ACCOUNT_ID`         | *(ריק)*   | מזהה החשבון ב-Cloudflare.                                  |
| `R2_ACCESS_KEY_ID`      | *(ריק)*   | מפתח גישה.                                                 |
| `R2_SECRET_ACCESS_KEY`  | *(ריק)*   | מפתח סודי.                                                 |
| `R2_BUCKET`             | *(ריק)*   | שם ה-bucket.                                               |
| `R2_JUNK_RETENTION_DAYS`| `30`       | כמה ימים תמונה שנדחתה שוהה תחת `junk/` לפני מחיקה אוטומטית. |

### הגבלות קצב, לוגים וביקורת (Rate limits / Logging / Audit)

| משתנה                        | ברירת מחדל | תיאור                                                    |
|------------------------------|------------|----------------------------------------------------------|
| `RATE_LIMIT_AI_PER_MIN`      | `20`       | בקשות AI ל-IP לדקה.                                       |
| `RATE_LIMIT_AUTH_PER_MIN`    | `10`       | בקשות אימות ל-IP לדקה.                                    |
| `RATE_LIMIT_DEFAULT_PER_MIN` | `300`      | בקשות כלליות ל-IP לדקה.                                   |
| `LOG_LEVEL`                  | `info`     | `trace`/`debug`/`info`/`warn`/`error`/`fatal`.           |
| `STRICT_AUDIT`               | `false`    | מצב ביקורת קפדני יותר.                                    |

---

## תזרים עבודה טיפוסי (Workflow)

1. **התחברות** כאדמין (לאחר `seed:admin`).
2. **חיבור ערוצי וואטסאפ** ב-`/channels` — סריקת QR לכל ערוץ (מקור פרופילים / שליחת התאמות).
3. **קליטה אוטומטית** — פרופילים נכנסים דרך צינור הקליטה; ה-AI מחלץ שדות (ייעוצי בלבד).
4. **גילוי התאמות** — לוח ההתאמה ("לוח התאמה") לכל מועמד, או סריקה מרוכזת (Match Scan).
5. **בדיקה ואישור** — השדכן בודק הצעות; שום דבר לא נשלח אוטומטית.
6. **שליחה** — רק כאשר `ENABLE_OUTBOUND_MESSAGES=true` ולאחר מיפוי מפורש של השיחה.

---

## תיעוד נוסף בריפו

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — החלטות ואילוצי הארכיטקטורה.
- [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) — פריסה מפורטת (התייחסות ל-Railway; העקרונות זהים ל-Render).
- [`docs/PILOT-RUNBOOK.md`](./docs/PILOT-RUNBOOK.md) — ספר הרצה לפיילוט וסקריפטי backfill.
- [`docs/QA-CHECKLIST.md`](./docs/QA-CHECKLIST.md) — רשימת בדיקות QA לפני עלייה לאוויר.
- [`.env.example`](./.env.example) / [`.env.production.example`](./.env.production.example) — תבניות משתני סביבה.

---

## רישיון

**תוכנה קניינית — כל הזכויות שמורות © 2026 Lidor Maliach.**

הקוד ב-README זה גלוי לצפייה ולעיון בלבד (source-available), **ואינו קוד פתוח**. אסור להשתמש,
להריץ, להעתיק, לשנות, להפיץ או לארח את התוכנה או חלקים מהותיים ממנה — **ללא אישור בכתב** מבעל
הזכויות. תלויות צד-שלישי כפופות לרישיונות שלהן. הפרטים המלאים בקובץ [`LICENSE`](./LICENSE).

לפניות בנושא רישוי: lidormalich@gmail.com

</div>
