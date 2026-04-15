# ShadchanAI — Architecture Plan

> Matchmaking management system for religious communities (Dati Leumi and Haredi/Dati).
> All services run inside a single Node.js monorepo. No external microservices.

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

## 2. Folder Structure Plan

```
ShadchanAI/
├── client/                          # React frontend (Vite)
│   ├── public/
│   ├── src/
│   │   ├── components/              # Shared UI components
│   │   ├── pages/                   # Route-level pages
│   │   ├── hooks/                   # Custom React hooks
│   │   ├── services/                # API client functions
│   │   ├── store/                   # State management
│   │   ├── types/                   # Shared frontend types
│   │   ├── utils/                   # Frontend utilities
│   │   ├── App.tsx
│   │   └── main.tsx
│   ├── index.html
│   ├── tsconfig.json
│   └── vite.config.ts
│
├── server/                          # Express backend
│   ├── src/
│   │   ├── modules/                 # Domain modules (CRUD + routes)
│   │   │   ├── candidates/
│   │   │   │   ├── candidate.model.ts
│   │   │   │   ├── candidate.router.ts
│   │   │   │   ├── candidate.service.ts
│   │   │   │   ├── candidate.types.ts
│   │   │   │   └── candidate.validator.ts
│   │   │   ├── matches/
│   │   │   │   ├── match.model.ts
│   │   │   │   ├── match.router.ts
│   │   │   │   ├── match.service.ts
│   │   │   │   ├── match.types.ts
│   │   │   │   └── match.validator.ts
│   │   │   ├── users/
│   │   │   │   ├── user.model.ts
│   │   │   │   ├── user.router.ts
│   │   │   │   ├── user.service.ts
│   │   │   │   ├── user.types.ts
│   │   │   │   └── user.validator.ts
│   │   │   └── families/              # (FUTURE — not in initial build)
│   │   │       ├── family.model.ts
│   │   │       ├── family.router.ts
│   │   │       ├── family.service.ts
│   │   │       ├── family.types.ts
│   │   │       └── family.validator.ts
│   │   │
│   │   ├── services/                # Cross-cutting services
│   │   │   ├── ai/                  # AI integration layer
│   │   │   │   ├── ai.service.ts
│   │   │   │   ├── ai.router.ts
│   │   │   │   ├── ai.types.ts
│   │   │   │   ├── ai.validators.ts
│   │   │   │   ├── ai.cache.ts
│   │   │   │   ├── ai.logger.ts
│   │   │   │   ├── providers/
│   │   │   │   │   ├── groq.provider.ts
│   │   │   │   │   ├── fallback.provider.ts
│   │   │   │   │   └── embeddings.provider.ts
│   │   │   │   └── prompts/
│   │   │   │       ├── matching.prompt.ts
│   │   │   │       ├── summary.prompt.ts
│   │   │   │       └── intent.prompt.ts
│   │   │   │
│   │   │   ├── matching/            # Matching engine
│   │   │   │   ├── matching.engine.ts
│   │   │   │   ├── matching.rules.ts
│   │   │   │   ├── matching.score.ts
│   │   │   │   └── matching.types.ts
│   │   │   │
│   │   │   ├── whatsapp/            # WhatsApp integration
│   │   │   │   ├── channel.manager.ts
│   │   │   │   ├── message.handler.ts
│   │   │   │   └── webhook.controller.ts
│   │   │   │
│   │   │   └── tasks/               # Background tasks
│   │   │       ├── task.scheduler.ts
│   │   │       └── task.registry.ts
│   │   │
│   │   ├── middleware/              # Express middleware
│   │   │   ├── auth.middleware.ts
│   │   │   ├── error.middleware.ts
│   │   │   ├── rateLimiter.middleware.ts
│   │   │   └── validate.middleware.ts
│   │   │
│   │   ├── utils/                   # Shared utilities
│   │   │   ├── logger.ts
│   │   │   ├── errors.ts
│   │   │   ├── response.ts
│   │   │   └── helpers.ts
│   │   │
│   │   ├── config/                  # Configuration
│   │   │   ├── env.ts
│   │   │   ├── db.ts
│   │   │   └── constants.ts
│   │   │
│   │   ├── app.ts                   # Express app setup
│   │   └── server.ts                # Entry point
│   │
│   ├── tsconfig.json
│   └── package.json
│
├── shared/                          # Types shared between client & server
│   └── types/                       # DTOs, shared enums, API-safe interfaces ONLY
│       ├── candidate.dto.ts         # No internal DB/model details
│       ├── match.dto.ts
│       ├── enums.ts                 # Shared enums (sector, matchType, etc.)
│       └── api.types.ts             # Request/response shapes
│
├── .env.example
├── .gitignore
├── package.json                     # Root package.json (workspaces)
├── tsconfig.base.json
└── ARCHITECTURE.md                  # This file
```

---

## 3. Layer Responsibilities

### Modules (`server/src/modules/`)

Each module owns one domain entity end-to-end:

| File | Responsibility |
|---|---|
| `*.model.ts` | Mongoose schema and model definition |
| `*.router.ts` | Express routes — maps HTTP verbs to service calls |
| `*.service.ts` | Business logic — the only layer that touches the model |
| `*.types.ts` | TypeScript interfaces for the entity |
| `*.validator.ts` | Zod schemas for request validation |

**Rule:** Routers never call models directly. Always go through the service.

### Services (`server/src/services/`)

Cross-cutting capabilities that multiple modules consume:

| Service | Responsibility |
|---|---|
| `ai/` | LLM calls, prompt management, caching, intent parsing |
| `matching/` | Deterministic matching rules + scoring engine |
| `whatsapp/` | Dual-account messaging (by role: profiles_source / match_sending), webhook handling, channel routing |
| `tasks/` | Scheduled background jobs (reminders, batch scoring) |

**Rule:** Services never import from each other circularly. Dependencies flow downward: `modules → services → utils/config`.

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
| `logger.ts` | Structured logging (pino or winston) |
| `errors.ts` | Custom error classes (`AppError`, `NotFoundError`, `ValidationError`) |
| `response.ts` | Standard response envelope (`{ success, data, error }`) |
| `helpers.ts` | Date formatting, string normalization, etc. |

### Config (`server/src/config/`)

| File | Responsibility |
|---|---|
| `env.ts` | Loads and validates environment variables (Zod) |
| `db.ts` | MongoDB connection setup |
| `constants.ts` | App-wide constants (enums, limits, defaults) |

---

## 4. Data Flow

### Flow A: Standard CRUD

```
User (browser)
  → React page calls API client
    → Express router receives request
      → validate.middleware checks Zod schema
        → module.service executes business logic
          → module.model reads/writes MongoDB
        → service returns data
      → response.ts wraps in envelope
    → JSON response sent
  → React updates UI
```

### Flow B: Matching Request

```
User clicks "Find matches for candidate X"
  → POST /api/matches/find { candidateId }
    → match.router → match.service
      → match.service calls matching.engine.findMatches(candidate, mode, matchType)
        → matching.engine loads candidate from DB
        → matching.rules filters candidates (hard rules: gender, explicit user constraints)
        → matching.score scores remaining candidates (8 weighted dimensions)
        → matching.engine classifies matchType + computes confidenceScore
        → matching.engine returns sorted scored list
      → match.service optionally calls ai.service for enrichment/summary
      → match.service saves top matches to DB
    → returns ranked match list
  → React renders match cards with scores + AI notes
```

### Flow C: AI Assistant Query

```
User types "Who would be a good match for David?"
  → POST /api/ai/ask { message, context }
    → ai.router → ai.service.processQuery(message)
      → ai.service calls intent prompt → determines intent: "find_match"
      → ai.service reads candidate "David" from DB (read-only)
      → ai.service builds context prompt with David's profile
      → ai.service calls groq.provider (or fallback)
      → ai.service validates response format
      → ai.service logs the interaction
    → returns { answer, suggestedActions }
  → React renders AI response with clickable action suggestions
    → User clicks suggestion → triggers Flow B (human-initiated)
```

**Key point:** The AI suggests, the user (or Shadchan) decides. AI never triggers writes.

### Flow D: WhatsApp Inbound Message

```
WhatsApp Cloud API sends webhook
  → POST /api/whatsapp/webhook
    → webhook.controller verifies signature
      → message.handler.process(payload)
        → extracts channelId (NOT phone number)
        → channel.manager identifies channelRole from originating account
        → message.handler stores message in DB: { channelId, channelRole, accountDisplayName }
        → message.handler optionally triggers AI summary
      → returns 200 OK (must respond fast)
  → Background: AI processes and prepares response draft
  → Shadchan reviews draft → approves → sends via channel.manager (routed by channelRole)
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
| `channel.manager.ts` | Manages dual WhatsApp Business accounts, routes messages by channelId |
| `message.handler.ts` | Processes inbound messages, stores them, triggers downstream logic |
| `webhook.controller.ts` | Express controller for WhatsApp webhook verification and payload reception |

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
- Phone numbers only appear transiently in webhook payloads and are immediately mapped to channelId

### Message Storage Flow

```
Webhook receives message
  → webhook.controller extracts: channelId, messageBody, timestamp, mediaUrls
  → message.handler:
      1. Finds or creates conversation record by channelId
      2. Stores message in messages collection:
         { channelId, channelRole, accountDisplayName, direction: 'inbound', body, timestamp, metadata }
      3. Updates conversation.lastMessageAt
      4. Emits event: 'message:received' (for real-time UI updates via WebSocket)
      5. Optionally queues AI summary if conversation is long
  → Returns 200 to WhatsApp (within 5 seconds — hard requirement)
```

### Outbound Flow

```
Shadchan composes message in UI (or approves AI draft)
  → POST /api/whatsapp/send { channelId, channelRole, body }
    → message.handler validates content
    → channel.manager resolves account from channelRole
    → channel.manager calls WhatsApp Cloud API
    → message.handler stores: { channelId, channelRole, accountDisplayName, direction: 'outbound', body, timestamp }
    → returns confirmation
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

## 9. Identified Gaps

### Missing Folders / Files (to create in next steps)

| What | Priority | Notes |
|---|---|---|
| Entire `server/` directory | P0 | Nothing exists yet — project was just initialized |
| Entire `client/` directory | P0 | Frontend does not exist |
| `shared/types/` | P1 | Needed before any module work |
| `.env.example` | P0 | Document required environment variables |
| `.gitignore` | P0 | Must exclude node_modules, dist, .env |
| `package.json` (root) | P0 | Workspace configuration |
| Database schemas | P1 | Mongoose models for all entities |
| Auth system | P1 | JWT-based auth is not yet designed in detail |

### Missing Abstractions

| Abstraction | Why it's needed |
|---|---|
| **Base service class** | Shared CRUD methods (`getById`, `getAll`, `create`, `update`, `delete`) to reduce repetition across modules |
| **Response envelope** | Consistent `{ success: boolean, data?: T, error?: string }` across all endpoints |
| **Event bus** | In-process event emitter for decoupled communication (e.g., `message:received` → trigger summary, `match:created` → log) |
| **Provider interface** | Formal TypeScript interface that all AI providers must implement |
| **Pagination helper** | Standard pagination for list endpoints (`page`, `limit`, `sort`, `filter`) |

### Risks in Current State

| Risk | Mitigation |
|---|---|
| **No code exists** | This architecture doc ensures structured implementation from day one |
| **Scope creep from AI features** | Guardrails above enforce AI-as-advisor pattern. Strict interface boundaries. |
| **WhatsApp webhook latency** | Must respond to WhatsApp within 5s. Message processing should be async after the 200 response. |
| **Sector closeness complexity** | Sector/subSector compatibility is scored via a closeness matrix, not blocked. The matrix must be maintained and tuned over time. |
| **Hebrew/RTL content** | Frontend must handle RTL text. AI prompts may include Hebrew. Ensure UTF-8 throughout. |
| **Data privacy** | Candidate personal data is sensitive. Need encryption at rest, access logging, and role-based access. |

### Things to Create in Next Steps (Ordered)

1. **Step 1:** Initialize project — `package.json`, `tsconfig`, `.gitignore`, `.env.example`
2. **Step 2:** Server skeleton — Express app, config, middleware, error handling, DB connection
3. **Step 3:** Shared types — DTOs, shared enums, API-safe interfaces (no DB internals)
4. **Step 4:** Candidate module — full CRUD as the reference module
5. **Step 5:** Matching engine — rules + scoring (no AI dependency)
6. **Step 6:** AI layer — providers, prompts, caching, logging
7. **Step 7:** Match module — integrates matching engine + optional AI enrichment
8. **Step 8:** WhatsApp layer — webhook, channel manager, message handler
9. **Step 9:** Client skeleton — React app, routing, API client
10. **Step 10:** Client pages — candidates list, match view, AI assistant chat

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
| Auth | JWT (jsonwebtoken) |
| Logging | Pino |
| Testing | Vitest |
| Package management | npm workspaces |
