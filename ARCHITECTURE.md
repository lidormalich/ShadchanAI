# ShadchanAI — Architecture

> Matchmaking management system for religious communities (Dati Leumi and Haredi/Dati).
> All services run inside a single Node.js monorepo. No external microservices.
>
> This document describes the **current, implemented** architecture. The
> server, client, and shared workspaces are all built and running.

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                      CLIENT (React)                     │
│  Candidates · Matches · Conversations · AI Assistant    │
└──────────────────────────┬──────────────────────────────┘
                           │ HTTP / WebSocket
┌──────────────────────────▼──────────────────────────────┐
│                   API GATEWAY (Express)                  │
│         Auth · Rate-limit · Validation · Routing        │
└──────┬──────────┬──────────┬──────────┬─────────────────┘
       │          │          │          │
  ┌────▼───┐ ┌───▼────┐ ┌───▼───┐ ┌───▼─────┐
  │Modules │ │   AI   │ │Match  │ │WhatsApp │
  │(CRUD)  │ │Service │ │Engine │ │Service  │
  └────┬───┘ └───┬────┘ └───┬───┘ └───┬─────┘
       │         │          │          │
  ┌────▼─────────▼──────────▼──────────▼─────┐
  │            DATABASE (MongoDB)             │
  │   Candidates · Matches · Messages · Logs │
  └──────────────────────────────────────────┘
```

### Core Principles

| Principle | Rule |
|---|---|
| Single process | Everything runs inside one Node.js server |
| AI is advisory | AI is limited to: explanation, drafting, summarization, classification, and Ask AI. It never executes actions or writes to DB. |
| Matching is deterministic | The matching engine is the source of truth. Rules + 8 scoring dimensions + matchType classification. No LLM in the engine. |
| WhatsApp via channelId | Never store or route by raw phone number |
| No uncontrolled side effects | Every write goes through a service layer with validation |

---

## 2. Folder Structure

The monorepo is built and live. Three npm workspaces: `client/`, `server/`, `shared/`.

```
ShadchanAI/
├── client/                          # React 18 + Vite frontend
│   ├── src/
│   │   ├── components/              # Reusable, domain-agnostic UI
│   │   │   ├── ui/                  # Primitives (Dialog, Drawer, Toast, Pagination, primitives.tsx)
│   │   │   ├── domain/             # Cross-page domain widgets (MatchCard, KpiCard, banners…)
│   │   │   ├── states/            # Empty/loading/error states
│   │   │   └── ErrorBoundary.tsx
│   │   ├── features/               # Feature-scoped UI + hooks (the main composition unit)
│   │   │   │                        #   auth, ai, dashboard, matching, compatibility,
│   │   │   │                        #   notes, tasks, users, ownership, safe-mode,
│   │   │   │                        #   realtime, notifications, history, search, forms
│   │   ├── pages/                   # Route-level pages mounted by the router
│   │   │   │                        #   candidates/, matches/, channels/, chats/,
│   │   │   │                        #   review/, tasks/, insights/, monitoring/,
│   │   │   │                        #   settings/, DashboardPage, NotFoundPage
│   │   │   ├── layouts/             # AppShell, Sidebar, Topbar
│   │   ├── services/api/            # Typed fetch wrappers, ONE file per backend module
│   │   │   ├── client.ts            #   shared fetch + envelope/error handling
│   │   │   └── *.ts                 #   matches, candidates, channels, settings, ai, …
│   │   ├── hooks/                   # Generic hooks (useMediaQuery, …)
│   │   ├── types/                   # Frontend-local types (api.ts, domain.ts)
│   │   ├── utils/                   # Frontend helpers (labels.ts, …)
│   │   ├── App.tsx                  # Router + QueryClientProvider + AuthProvider
│   │   └── main.tsx
│   ├── index.html
│   └── vite.config.ts
│
│   # NOTE: there is no `store/` folder. Server state lives in
│   # @tanstack/react-query; cross-cutting UI state uses React Context
│   # (AuthContext, Toast region). No Redux/Zustand.
│
├── server/                          # Express backend
│   ├── src/
│   │   ├── modules/                 # Domain modules — router → controller → service → model
│   │   │   ├── candidates/         #   split into internal-candidate.* and external-candidate.*
│   │   │   ├── matches/            #   match.* + pair-score.model, match-suggestion.model
│   │   │   ├── pair-reviews/  rejection-reasons/  conversations/  channels/
│   │   │   ├── chat-mappings/  tasks/  notes/  extraction/  audit/  users/
│   │   │   ├── auth/  health/  realtime/  dashboard/  search/  notifications/
│   │   │   ├── insights/  settings/  monitoring/  safe-mode/  ai/ (ai-request.model)
│   │   │   #  Typical module files: *.router.ts, *.controller.ts, *.service.ts,
│   │   │   #  *.model.ts, *.validator.ts (+ *.test.ts where covered).
│   │   │   #  Validators export both Zod schemas AND inferred input types,
│   │   │   #  so a separate *.types.ts is usually unnecessary.
│   │   │
│   │   ├── services/                # Cross-cutting services consumed by modules
│   │   │   ├── ai/                  # ai.service, ai.router, ai.types, ai.validators,
│   │   │   │   │                    #   ai.cache, ai.logger, ai.prompts, ai.tools
│   │   │   │   └── providers/       #   groq.provider, fallback.provider,
│   │   │   │                        #   embeddings.provider, _openai-compatible
│   │   │   ├── matching/            # Deterministic engine: matching.engine, matching.rules,
│   │   │   │                        #   matching.score, matching.penalties, matching.matrix,
│   │   │   │                        #   matching.constants, matching.types, matchable.mapper,
│   │   │   │                        #   match-scan.service
│   │   │   ├── whatsapp/            # Baileys-based: whatsapp.service, channel.manager,
│   │   │   │   │                    #   message.handler, conversation.linker,
│   │   │   │   │                    #   response.classifier, chat-discovery, send.rate-limiter,
│   │   │   │   │                    #   instance.lock, whatsapp.logger
│   │   │   │   └── providers/baileys/  # baileys.client, .events, .mapper, .session.store
│   │   │   ├── extraction/          # Profile extraction: orchestrator, ai.extractor,
│   │   │   │                        #   regex.extractor, internal.extractor, candidate.matcher,
│   │   │   │                        #   templates, queue
│   │   │   ├── compatibility/       # compatibility.service, explanation.builder
│   │   │   ├── embedding/           # embedding.service/provider/types, profile.serializer,
│   │   │   │                        #   similarity.service
│   │   │   ├── jobs/                # job.scheduler, jobs (background scheduling)
│   │   │   ├── monitoring/          # metrics.service
│   │   │   ├── notifications/       # notifications.service
│   │   │   ├── realtime/            # realtime.service (SSE/event stream)
│   │   │   ├── safe-mode/           # safe-mode.service (global send guard)
│   │   │   └── audit.service.ts     # audit log writer
│   │   │
│   │   ├── middleware/              # auth, error, permissions, rateLimiter,
│   │   │                            #   requestLogger, security, validate
│   │   ├── utils/                   # errors, response (envelope), pagination,
│   │   │                            #   ownership(.assert), phone, zod-bool
│   │   ├── config/                  # env (Zod-validated), db, constants, boot-checks
│   │   ├── scripts/                 # one-off maintenance scripts (backfills)
│   │   ├── models/index.ts          # central model registration barrel
│   │   ├── app.ts                   # Express app assembly (middleware + router mounting)
│   │   └── server.ts                # process entry point / bootstrap
│   │
│   └── package.json
│
├── shared/                          # @shadchanai/shared — types shared by client & server
│   └── types/
│       ├── enums.ts                 # MatchType, RiskLevel, ScoringDimension, sectors, …
│       ├── api.types.ts             # ApiEnvelope, ApiMeta, request/response shapes
│       └── index.ts                 # barrel re-export
│
├── .env.example
├── package.json                     # root workspace config
└── ARCHITECTURE.md                  # this file
```

> The lists above are representative, not exhaustive — modules and services are
> added over time. The invariant is the layering, not the exact file set.

---

## 3. Layer Responsibilities

### Modules (`server/src/modules/`)

Each module owns one domain entity end-to-end and is structured as a four-layer
pipeline: **router → controller → service → model**.

| File | Responsibility |
|---|---|
| `*.router.ts` | Declares Express routes. Mounts `requireAuth`/`validate` middleware and points each verb at a controller handler. No business logic. |
| `*.controller.ts` | HTTP adapter. Reads validated `req` data, enforces auth/ownership (`ensureUser`, `hasRole`), calls the service, and writes the response via the `ok/created/noContent` envelope helpers. Wraps everything in `try/catch → next(e)`. Holds no business logic and does not touch models. |
| `*.service.ts` | Business logic — the only layer that reads/writes the model. Stateless functions, HTTP-agnostic (no `req`/`res`). |
| `*.model.ts` | Mongoose schema + model definition. |
| `*.validator.ts` | Zod schemas for body/params/query, plus the inferred TypeScript input types the controller consumes. |

**Rules (intended invariants the codebase converges on):**
- Routers never reach into services or models — they only wire middleware to controllers.
- Controllers are thin: validate context, delegate to a service, shape the response. They must not query models directly or embed business rules.
- Services are the sole gateway to the model layer and the only place business logic lives.

> Where a module's logic is trivial, the controller may be a single delegating
> line — that is fine, but the layering still holds. (Historically a few
> controllers reached straight into models/queries; that pattern is being
> migrated back behind services and is not the target architecture.)

### Services (`server/src/services/`)

Cross-cutting capabilities that multiple modules consume. Unlike modules, these
are not 1:1 with a route group — modules' controllers/services call into them.

| Service | Responsibility |
|---|---|
| `ai/` | LLM orchestration: prompt building, provider selection + fallback, output validation, caching, logging. Advisory only (see Guardrails). |
| `matching/` | Deterministic matching: hard rules, 8-dimension scoring, penalties, confidence, matchType classification, and the incremental bulk `match-scan` service. No LLM. |
| `whatsapp/` | Baileys socket integration: dual-account send (by role), inbound message handling, conversation linking, response classification, chat discovery, send rate-limiting, instance locking. |
| `extraction/` | Turning free-text/WhatsApp content into structured candidate data (regex + AI extractors behind an orchestrator/queue). |
| `compatibility/` | Builds the human-readable compatibility explanation/workspace data from engine output. |
| `embedding/` | Vector embeddings + similarity for semantic candidate search. |
| `jobs/` | Background job scheduling. |
| `monitoring/`, `notifications/`, `realtime/`, `safe-mode/` | Metrics, in-app notifications, the realtime event stream (SSE), and the global send-guard ("safe mode"). |

**Rule:** Dependencies flow downward — `modules → services → utils/config` — and
services avoid circular imports between each other.

### Middleware (`server/src/middleware/`)

Express middleware that runs before route handlers:

| Middleware | Responsibility |
|---|---|
| `auth` | JWT verification, role extraction |
| `error` | Global error handler — catches thrown errors, returns structured JSON |
| `rateLimiter` | Per-IP and per-user rate limiting |
| `validate` | Runs Zod schemas from validators against `req.body/params/query` |

### Utils (`server/src/utils/`)

Stateless helpers with zero domain knowledge:

| Util | Responsibility |
|---|---|
| `errors.ts` | Custom error classes the error middleware maps to HTTP responses |
| `response.ts` | Standard response envelope helpers (`ok`, `created`, `noContent` → `{ success, data, meta }` / `{ success, error }`) |
| `pagination.ts` | Standard list pagination (page/limit/sort) shared by services |
| `ownership.ts`, `ownership.assert.ts` | Owner-scoping helpers for record-level access control |
| `phone.ts`, `zod-bool.ts` | Phone normalization; Zod coercion for boolean query params |

> There is currently **no single central logger module** in `utils/`. Logging is
> handled by `requestLogger.middleware.ts` for per-request lines and by
> purpose-built loggers inside the services that need them (e.g.
> `services/ai/ai.logger.ts`, `services/whatsapp/whatsapp.logger.ts`). A
> consolidated logger is a known gap (see §9).

### Config (`server/src/config/`)

| File | Responsibility |
|---|---|
| `env.ts` | Loads and validates environment variables (Zod) |
| `db.ts` | MongoDB connection setup |
| `constants.ts` | App-wide constants (limits, defaults) |
| `boot-checks.ts` | Startup sanity checks run during bootstrap |

---

## 4. Data Flow

### Flow A: Standard CRUD

```
User (browser)
  → React page/feature calls a React Query hook
    → hook calls services/api/<module>.ts → services/api/client.ts (fetch)
      → Express router receives request
        → auth + validate.middleware (Zod) run
          → module.controller reads validated data, enforces auth/ownership
            → module.service executes business logic
              → module.model reads/writes MongoDB
            → service returns data
          → controller wraps it via ok()/created() envelope helper
        → JSON response sent
      → client.ts unwraps the envelope (throws ApiError on failure)
  → React Query caches/updates; component re-renders
```

**Client state model:** there is no global store. Server data is owned by
`@tanstack/react-query` (queries/mutations keyed per resource), and the small
amount of cross-cutting UI state lives in React Context (`AuthContext`, the
toast region). Mutations invalidate the relevant query keys to refresh views.

### Flow B: Matching Request

```
User clicks "Find matches for candidate X"
  → POST /api/matches/... { internalCandidateId, mode }
    → match.router → match.controller → match.service
      → match.service loads the candidate + eligible pool, maps them to
        Matchable shapes (matchable.mapper), then for each pair calls the engine
        → matching.engine.evaluatePair(internal, external, context, weights):
            1. matching.rules  — hard eligibility (gender, active match, explicit blockers)
            2. matching.score  — 8 weighted dimensions (uses matching.matrix for sector closeness)
            3. matching.penalties — actionability adjustments
            4. confidence       — data-completeness score
            5. classification   — matchType + riskLevel + recommendedAction
        → engine returns a full MatchResult per pair (blocked pairs included, flagged ineligible)
      → match.service ranks/persists results (PairScore cache, draft suggestions)
    → returns ranked match list (envelope)
  → React renders MatchCards with matchScore, confidenceScore, matchType, riskLevel

Bulk path: services/matching/match-scan.service runs the same engine across
many pairs incrementally (scoringHash delta detection + PairScore cache),
auto-drafting suggestions above configurable Settings thresholds.
```

### Flow C: AI Assistant Query

```
User types "Who would be a good match for David?"
  → POST /api/ai/ask  (behind the stricter aiRateLimiter)
    → ai.router → ai.service
      → ai.service builds a prompt (pure function in ai.prompts)
      → fetches any needed read-only context via ai.tools (never raw model writes)
      → checks ai.cache (keyed by prompt hash)
      → calls the primary provider (groq); on invalid/failed output it
        retries once with a strict prompt, then falls back to the secondary provider
      → validates the structured output (Zod) before returning
      → logs metadata via ai.logger (provider/model/fallback/retry/latency)
    → returns { data, metadata } (envelope)
  → React renders the answer with any suggested actions
    → User clicks a suggestion → triggers Flow B (human-initiated)
```

**Key point:** The AI suggests, the user (or Shadchan) decides. AI never triggers writes.

### Flow D: WhatsApp Inbound Message

> **Transport note:** the system uses **Baileys (a persistent WhatsApp socket
> session), not the Meta Cloud API webhook**. There is no inbound HTTP endpoint
> for WhatsApp and no webhook signature verification — inbound messages arrive as
> socket events from the Baileys client and are normalized by the provider mapper.

```
Baileys socket emits an inbound message event
  → baileys.events → baileys.mapper normalizes it (extracts a stable channel/session id, NOT a phone number for routing)
    → message.handler (idempotent — unique externalMessageId, replay-safe):
        1. channel.manager resolves the Channel (and channelRole) by provider session id
        2. conversation.linker finds/creates the Conversation
        3. inserts the Message { channelId, channelRole, direction:'inbound', body, … }
           (raw payload stored with select:false; duplicates become a no-op)
        4. publishes a realtime event for live UI updates
        5. enqueues profile extraction; optionally runs AI classification
           and applies inbound responses to a pending MatchSuggestion
  → Shadchan reviews any draft → approves → sends via channel.manager (routed by channelRole)
```

---

## 5. AI Layer Design

### File Responsibilities

| File | What it does |
|---|---|
| `ai.service.ts` | Orchestrator — routes queries to correct prompt + provider, enforces guardrails |
| `ai.router.ts` | Express routes: `POST /ask`, `POST /summarize`, `POST /explain-match`, `POST /draft`, `POST /classify` |
| `ai.types.ts` | `AIRequest`, `AIResponse`, `Intent`, `ProviderConfig` interfaces |
| `ai.validators.ts` | Zod schemas for all AI endpoint inputs |
| `ai.cache.ts` | In-memory cache (Map or lru-cache) keyed by prompt hash — avoids duplicate LLM calls |
| `ai.logger.ts` | Logs every AI call: prompt, response, latency, tokens, provider used |

### Providers

```
ai.service calls → provider interface → concrete provider
```

**Provider interface:**

```typescript
interface AIProvider {
  name: string;
  chat(messages: ChatMessage[], options: ProviderOptions): Promise<AIResponse>;
  isAvailable(): Promise<boolean>;
}
```

| Provider | Purpose |
|---|---|
| `groq.provider.ts` | Primary provider — calls Groq API (LLaMA/Mixtral). Fast and cheap. |
| `fallback.provider.ts` | Wraps multiple providers in priority order. If Groq fails → tries next. |
| `embeddings.provider.ts` | Generates vector embeddings for semantic search (candidate similarity). |

### Fallback Logic

```
fallback.provider maintains ordered list: [groq, ...others]

On call:
  for each provider in list:
    if provider.isAvailable():
      try:
        result = await provider.chat(messages, options)
        return result
      catch (error):
        log error
        continue to next
  throw AllProvidersFailedError
```

### Retry Logic (inside each provider)

```
Each provider has:
  maxRetries: 3
  backoff: exponential (1s, 2s, 4s)
  retryOn: [429, 500, 502, 503]

On 429 (rate limit): respect Retry-After header
On timeout: retry with shorter max_tokens
On parse error: retry with stricter prompt
```

### Validation (ai.validators.ts)

- Input: Zod schema validates every request before it reaches ai.service
- Output: ai.service validates LLM response structure before returning
- Sanitization: strip any HTML/code from AI output before storage

### Prompt Management (prompts/)

Each prompt file exports a function that takes context and returns a `ChatMessage[]` array:

| Prompt | Use case |
|---|---|
| `matching.prompt.ts` | "Given candidate X and candidate Y, explain compatibility" |
| `summary.prompt.ts` | "Summarize this conversation thread" |
| `intent.prompt.ts` | "What is the user trying to do? Classify into: find_match, get_info, update_profile, other" |

Prompts are pure functions — they receive data, return message arrays. No side effects.

---

## 6. Matching Layer Design

### File Responsibilities

| File | What it does |
|---|---|
| `matching.engine.ts` | Orchestrator — runs rules, then scoring, classifies matchType, returns ranked list |
| `matching.rules.ts` | Hard filters — only explicit user constraints and logical impossibilities |
| `matching.score.ts` | Deterministic scoring across 8 approved dimensions |
| `matching.types.ts` | `MatchRule`, `ScoreWeight`, `MatchResult`, `MatchMode`, `MatchType`, `ConfidenceLevel` interfaces |

### Rules vs Scoring

**Rules (matching.rules.ts)** — Hard filters, boolean. A candidate either passes or is eliminated.

Only **explicit constraints** and **logical impossibilities** are hard rules:

```
Hard rules (always enforced):
  - Gender: must be opposite
  - Already matched: exclude existing active matches
  - Explicit user constraints: "will not consider X" — only when the user/candidate
    explicitly stated a hard blocker

NOT hard rules (these go into scoring):
  - Community / sector / sub-sector → scored via closeness matrix
  - Age range → scored with distance penalty
  - Location → scored with distance
```

**Key principle:** Community/sector/subSector are NEVER automatic hard blockers. They are scored
using a closeness matrix, risk level, and review flags. Only an explicit user-stated constraint
(e.g., "I will only date within Dati Leumi") becomes a hard rule for that specific candidate.

**Scoring (matching.score.ts)** — Deterministic weighted scoring on candidates that passed rules.

```
Approved scoring dimensions (0-100 each, multiplied by configurable weight):

  1. Age                           — proximity scoring with configurable delta
  2. Sector / Sub-sector           — closeness matrix (how compatible are the sectors)
  3. Lifestyle / Home style        — alignment on religious practice at home
  4. Study-work direction          — compatibility of career/learning priorities
  5. Location                      — geographic proximity / willingness to relocate
  6. Mutual expectations           — what each side is looking for in a partner
  7. Life stage / Maturity         — alignment on readiness and life phase
  8. Flexibility / Creative override — Shadchan's manual boost for non-obvious matches

Final matchScore = Σ (dimension_score × weight)
```

Weights are configurable per Shadchan preference. The "flexibility / creative override" dimension
allows a Shadchan to manually influence scoring for matches that don't look good on paper but
have potential.

### Two Separate Scores

| Score | What it measures | Source |
|---|---|---|
| `matchScore` | How well the two candidates fit across the 8 dimensions | Deterministic engine calculation |
| `confidenceScore` | How much data the engine had to work with, and how reliable the matchScore is | Computed from data completeness — if a candidate has empty fields, confidence drops |

These are **always separate**. A match can have high matchScore but low confidenceScore (good fit
on available data, but many fields are missing). The UI shows both.

### Match Type Classification

Every match result is classified into a `matchType`:

| matchType | Criteria | Use case |
|---|---|---|
| `safe` | matchScore ≥ 80, confidenceScore ≥ 70, no risk flags | High-confidence, conventional match |
| `balanced` | matchScore 60-79, confidenceScore ≥ 50 | Solid match with some differences |
| `creative` | matchScore 40-59 OR flexibility override applied | Non-obvious match worth exploring |
| `risky` | matchScore < 40 OR sector closeness is low OR confidence < 40 | Low compatibility or insufficient data — requires Shadchan review |

matchType is computed deterministically from matchScore, confidenceScore, and risk flags.
It is NOT an AI judgment.

### Strict vs Discovery Mode

| Mode | Behavior |
|---|---|
| **Strict** | Returns only `safe` and `balanced` matchTypes. Hard rules fully enforced. For Shadchanim who want high-confidence suggestions. |
| **Discovery** | Returns all matchTypes including `creative` and `risky`. Some soft thresholds relax (e.g., sector closeness tolerance widens). For exploring non-obvious matches. |

The mode is passed as a parameter to `matching.engine.findMatches()`. The engine adjusts which
matchTypes are returned and how aggressively it filters.

### Engine Flow

```typescript
// matching.engine.ts pseudocode
async function findMatches(
  candidateId: string,
  mode: MatchMode  // 'strict' | 'discovery'
): Promise<MatchResult[]> {
  const candidate = await candidateService.getById(candidateId);
  const pool = await candidateService.getEligible(candidate);

  // Step 1: Hard rules — only gender, active-match exclusion, explicit user constraints
  const filtered = matchingRules.apply(pool, candidate);

  // Step 2: Score across 8 dimensions
  const scored = matchingScore.score(filtered, candidate);

  // Step 3: Compute confidenceScore per result (based on data completeness)
  const withConfidence = matchingScore.computeConfidence(scored, candidate);

  // Step 4: Classify matchType (safe / balanced / creative / risky)
  const classified = withConfidence.map(r => ({
    ...r,
    matchType: matchingScore.classifyMatchType(r.matchScore, r.confidenceScore, r.riskFlags)
  }));

  // Step 5: Filter by mode
  const byMode = mode === 'strict'
    ? classified.filter(r => r.matchType === 'safe' || r.matchType === 'balanced')
    : classified;

  return byMode.sort((a, b) => b.matchScore - a.matchScore);
}
```

### Deterministic Engine as Source of Truth

The matching engine is the **single source of truth** for all match decisions. AI is never
involved in scoring, filtering, or classification. AI's role in the matching flow is limited to:

| AI task | When it runs | What it produces |
|---|---|---|
| **Explanation** | After engine returns results | "Why these two might work" text for Shadchan |
| **Drafting** | When Shadchan wants to send a proposal | Draft message text for review |
| **Summarization** | On demand | Summary of a candidate's profile or conversation history |
| **Classification** | On intake | Classify free-text fields into structured data (e.g., sector from description) |
| **Ask AI** | On demand in chat UI | Conversational Q&A about candidates/matches using read-only DB context |

---

## 7. WhatsApp Layer Design

### File Responsibilities

| File | What it does |
|---|---|
| `whatsapp.service.ts` | Public facade for the WhatsApp layer (connect, send, status) |
| `channel.manager.ts` | Manages the dual WhatsApp accounts, resolves a Channel/`channelRole` by provider session id, routes sends |
| `message.handler.ts` | Idempotent, replay-safe inbound persistence; fans out to extraction, realtime, classification |
| `conversation.linker.ts` | Finds or creates the Conversation a message belongs to |
| `response.classifier.ts` | Classifies inbound replies (e.g. interested/declined) to advance a suggestion |
| `chat-discovery.service.ts` | Discovers existing chats on a connected account |
| `send.rate-limiter.ts` | Throttles outbound sends per account |
| `instance.lock.ts` | Ensures a single active socket instance per session |
| `providers/baileys/*` | Baileys client, event handling, payload mapper, and session store |

> The earlier plan named a `webhook.controller.ts`; that no longer exists. The
> system moved from Meta Cloud API webhooks to a Baileys socket, so inbound
> traffic is event-driven rather than HTTP.

### Dual Account Logic — Split by Role, NOT by Sector

The system operates two WhatsApp Business accounts split by **functional role**:

| Account | channelRole | Purpose |
|---|---|---|
| Account A | `profiles_source` | Profile discovery, intake, source token usage — collecting candidate information |
| Account B | `match_sending` | Sending proposals, follow-ups, receiving proposal replies |

This split is **not** by religious sector. Both accounts serve all communities.

`channel.manager.ts` maintains a mapping:

```typescript
interface WhatsAppAccount {
  id: string;
  channelRole: 'profiles_source' | 'match_sending';
  accountDisplayName: string;  // human-readable label
  apiToken: string;            // from env
  phoneNumberId: string;       // WhatsApp Business phone number ID
}
```

When sending a message, the channel manager:
1. Looks up the candidate's `channelId`
2. Determines the `channelRole` required for this operation
3. Sends via the correct account's API token

### Routing Keys

All WhatsApp storage and routing uses three fields:

| Field | Purpose |
|---|---|
| `channelId` | Unique conversation identifier — primary routing key |
| `channelRole` | Which account owns this channel (`profiles_source` or `match_sending`) |
| `accountDisplayName` | Human-readable account name for UI and logs |

**Critical rule:** The system NEVER stores or routes by raw phone numbers.

- Each WhatsApp conversation has a `channelId` (WhatsApp's unique conversation identifier)
- The candidate record stores `whatsappChannelId`, not a phone number
- All message queries filter by `channelId` + `channelRole`
- Phone numbers only appear transiently in raw socket payloads (masked in logs) and are mapped to channelId before any storage or routing

### Message Storage Flow

```
Baileys socket delivers a normalized inbound message
  → message.handler (idempotent):
      1. Resolves the Channel/channelRole by provider session id
      2. Finds or creates the conversation (conversation.linker)
      3. Stores the message: { channelId, channelRole, direction:'inbound', body,
         timestamp, externalMessageId (unique), raw payload select:false }
         — a replayed event de-dupes to a single row
      4. Publishes a realtime event for live UI updates
      5. Enqueues profile extraction; optionally classifies the reply
```

### Outbound Flow

```
Shadchan composes a message in the UI (or approves an AI draft)
  → POST /api/channels/... send { channelId, channelRole, body }
    → channel.controller → channel.service
      → safe-mode check (global send guard) and send.rate-limiter
      → channel.manager resolves the account from channelRole
      → Baileys client sends over the live socket
      → message.handler stores { channelId, channelRole, direction:'outbound', body, timestamp }
    → returns confirmation (envelope)
```

---

## 8. Guardrails

| # | Rule | Enforcement |
|---|---|---|
| 1 | **AI cannot execute actions** | `ai.service` has no access to write methods on any model. It receives read-only data and returns text. |
| 2 | **Matching engine is deterministic** | `matching.rules` and `matching.score` use explicit formulas. No LLM calls inside the engine. AI enrichment happens after, separately. |
| 3 | **WhatsApp uses channelId + channelRole, not phone** | `message.handler` maps phone → channelId at ingestion. Routing uses `channelRole` (profiles_source / match_sending). Phone field does not exist on stored messages. |
| 4 | **No direct DB access from AI** | AI prompts receive pre-fetched data as context strings. The AI provider has no Mongoose model imports. |
| 5 | **No uncontrolled side effects** | All writes go through service layers with validation. No raw `Model.updateMany()` calls from routers or services/ai. |
| 6 | **Rate limiting on AI endpoints** | `rateLimiter.middleware` applies stricter limits to `/api/ai/*` routes (e.g., 20 req/min per user). |
| 7 | **AI output sanitization** | Every AI response is validated against expected schema and stripped of code/HTML before storage or display. |
| 8 | **Audit logging** | `ai.logger` records every LLM interaction. WhatsApp messages are stored with full metadata. Match decisions are logged with scores. |

---

## 9. Known Gaps & Intended Invariants

The system is built and running end-to-end (server, client, and shared workspace
all exist). This section is no longer a build plan — it records the
architectural **rules the codebase is meant to converge on** and the **gaps**
still being closed.

### Intended invariants (the rules that keep the layering honest)

| Invariant | What it means in practice |
|---|---|
| **Layering: router → controller → service → model** | Routers only wire middleware to controllers; controllers stay thin (validate context, delegate, shape the envelope); services own all business logic and are the only callers of models. |
| **Services own DB access** | Controllers must not query models directly. A few legacy controllers historically reached into queries; those are being migrated back behind services. |
| **AI is advisory-only** | The AI layer reads context (via `ai.tools`) and returns validated text/structured output. It never writes business entities or triggers actions. |
| **Matching is deterministic** | The engine (`rules → score → penalties → confidence → classify`) is the single source of truth. No LLM in the scoring path. |
| **WhatsApp routes by channelId / channelRole** | Never store or route by raw phone number; both accounts are split by role (`profiles_source` / `match_sending`), not by sector. |
| **Standard response envelope** | Every endpoint returns `{ success, data, meta }` or `{ success, error }` via the shared `ok/created/noContent` helpers, and the client unwraps it centrally in `client.ts`. |

### Current gaps (in progress)

| Gap | Notes |
|---|---|
| **Thin test coverage** | Tests exist for the highest-risk paths (matching, regex extraction, WhatsApp handlers/mapper, rate-limiter, ownership, audit) but coverage is uneven across modules. |
| **No central logger** | Logging is split between `requestLogger.middleware` and per-service loggers (`ai.logger`, `whatsapp.logger`). A single structured logger in `utils/` is intended but not yet present. |
| **Controllers bypassing services** | A handful of controllers still touch queries/models directly; the target is for every controller to delegate to a service. |
| **Shared layer is types-only** | `@shadchanai/shared` intentionally exports only enums and API/DTO shapes — no runtime/business logic is shared across workspaces. |

### Standing risks to keep in mind

| Risk | Mitigation |
|---|---|
| **Scope creep from AI features** | The advisory-only guardrail and the deterministic engine boundary keep AI out of decisions. |
| **WhatsApp socket reliability** | Baileys runs a long-lived socket; `instance.lock` enforces a single active session and inbound handling is idempotent/replay-safe. |
| **Sector closeness complexity** | Sector/subSector is scored via a closeness matrix, never hard-blocked. The matrix must be maintained and tuned over time. |
| **Hebrew / RTL content** | UI and AI prompts are Hebrew-first; UTF-8 and RTL handling must hold throughout. |
| **Data privacy** | Candidate data is sensitive; ownership scoping, role checks, and audit logging are the current controls. |

---

## Technology Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ |
| Language | TypeScript (strict mode) |
| Backend framework | Express.js |
| Database | MongoDB with Mongoose ODM |
| Validation | Zod |
| AI provider | Groq (primary), with fallback support |
| Frontend | React 18+ with Vite |
| Styling | Tailwind CSS (RTL-compatible) |
| Auth | JWT (jsonwebtoken); dev `X-Dev-User` fallback |
| Client server-state | @tanstack/react-query (no global store) |
| WhatsApp transport | Baileys socket session (not Meta Cloud API webhooks) |
| Logging | per-request + per-service loggers (no single central logger yet) |
| Testing | Vitest |
| Package management | npm workspaces |
