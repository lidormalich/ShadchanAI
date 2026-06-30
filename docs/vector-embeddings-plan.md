# תוכנית הטמעה: מערכת וקטורים + RAG לשידוכים
**ShadchanAI — Vector Embeddings & RAG Pipeline — Implementation Plan**

> גרסה: 0.3 | תאריך: 2026-04-20 | מחבר: Claude + Lidor  
> **v0.3 — שינויים עיקריים מv0.2:**
> - מעבר מ-OpenAI לHuggingFace (BAAI/bge-m3 Phase 1 → bge-multilingual-gemma2 Phase 2)
> - Multi-Chunk embedding עם `$rankFusion` של Atlas (4 vectors per candidate)
> - RAG Pipeline חדש: Top-5 → PII Strip → LLM → Matchmaker Summary
> - ארכיטקטורת Latency: board מיידי + SSE streaming לRAG
>
> סטטוס: **טיוטה לסקירה** — לא התחיל פיתוח

---

## תוכן עניינים

1. [תמונת מצב — מה כבר קיים](#1-תמונת-מצב--מה-כבר-קיים)
2. [ארכיטקטורה מלאה v0.3](#2-ארכיטקטורה-מלאה-v03)
3. [בחירת מודל Embedding](#3-בחירת-מודל-embedding)
4. [Multi-Chunk Schema — 4 Vectors Per Candidate](#4-multi-chunk-schema--4-vectors-per-candidate)
5. [משקולות ואיך הן מיושמות](#5-משקולות-ואיך-הן-מיושמות)
6. [Atlas Vector Indexes ו-`$rankFusion`](#6-atlas-vector-indexes-ו-rankfusion)
7. [Hybrid Search Query — גרסה מלאה](#7-hybrid-search-query--גרסה-מלאה)
8. [מפרט: Serialization לפי Chunk](#8-מפרט-serialization-לפי-chunk)
9. [RAG Pipeline — Matchmaker Summary](#9-rag-pipeline--matchmaker-summary)
10. [PII Stripping — מניעת דליפת מידע](#10-pii-stripping--מניעת-דליפת-מידע)
11. [ארכיטקטורת Latency — Board מיידי + SSE](#11-ארכיטקטורת-latency--board-מיידי--sse)
12. [API Endpoints חדשים](#12-api-endpoints-חדשים)
13. [אינטגרציה עם ה-engine הקיים](#13-אינטגרציה-עם-ה-engine-הקיים)
14. [Backfill ועדכונים שוטפים](#14-backfill-ועדכונים-שוטפים)
15. [משתני סביבה](#15-משתני-סביבה)
16. [קבצים שנוצרים / משתנים](#16-קבצים-שנוצרים--משתנים)
17. [סיכום עלויות](#17-סיכום-עלויות)
18. [רשימת סיכונים](#18-רשימת-סיכונים)
19. [רשימת בדיקות (QA Checklist)](#19-רשימת-בדיקות-qa-checklist)
20. [סדר ביצוע מומלץ](#20-סדר-ביצוע-מומלץ)
21. [שאלות פתוחות](#21-שאלות-פתוחות)

---

## 1. תמונת מצב — מה כבר קיים

### מה מוכן בקוד (לא משתנה)

| קובץ | מה קיים |
|---|---|
| `internal-candidate.model.ts` | `embeddingSchema` עם `vector`, `modelId`, `provider`, `dimensions` — `select: false` |
| `external-candidate.model.ts` | אותו schema |
| `matching.types.ts` | `MatchingContext.semanticSimilarities?: Map<string, number>` |
| `matching.types.ts` | `MatchResult.semanticSimilarityScore?: number` |
| `matching.engine.ts:92` | קורא ומצרף `semanticSimilarityScore` לתוצאה |
| `env.ts` | `EMBEDDINGS_PROVIDER`, `EMBEDDINGS_API_KEY`, `EMBEDDINGS_MODEL` |
| `pair-review.model.ts` | `aiExplanation: { text, strengths[], concerns[], provider, model, generatedAt }` |

### מה ה-schema הקיים לא תומך בו (ייעדכן)

- שדה `embedding` מכיל vector בודד — צריך להרחיב ל-4 chunk vectors + composite
- אין שדה `ragAnalysis` / `matcherSummary` — ישב ב-`PairReview.aiExplanation` (כבר קיים)

---

## 2. ארכיטקטורה מלאה v0.3

```
┌──────────────────────────────────────────────────────────────────────┐
│                        API Request                                    │
│              GET /compatibility/:internalId/board                     │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ (מיידי — ללא חסימה)
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                   compatibility.service.ts                            │
│                                                                       │
│  1. טוען internal candidate                                          │
│  2. גוזר Pre-Filter: gender=opposite, age=[min..max]                 │
│  3. ← hybridSearch() → Top-K IDs + per-chunk scores                  │
│  4. מוסיף semanticSimilarities לMatchingContext                      │
│  5. מריץ matching.engine על Top-K                                    │
│  6. מחזיר board + ragStatus לכל שורה                                 │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ Response מיידי
                               ▼
                        ┌──────────────┐
                        │   הUI מציג   │  ← Board מלא ב-<300ms
                        │   הboard     │
                        │  ┌─────────┐ │
                        │  │ 🔄 RAG  │ │  ← כפתור "ניתוח שדכן"
                        │  └────┬────┘ │
                        └───────┼───────┘
                                │ (בקשה נפרדת, On-demand)
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│              POST /compatibility/:id/rag-summary  (SSE)               │
│                                                                       │
│  1. מקבל externalIds[] (Top-5 מה-board)                              │
│  2. pii.stripper → profiles אנונימיים                                │
│  3. בונה context: profiles + chunk similarity scores                 │
│  4. שולח ל-LLM (Groq / Claude Sonnet)                               │
│  5. Streams תשובה token-by-token דרך SSE                            │
│  6. שומר RAG summary ב-PairReview.aiExplanation (cache)             │
└──────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                  MongoDB Atlas (Hybrid Search)                        │
│                                                                       │
│  $rankFusion עם 4 sub-pipelines:                                      │
│  ┌─────────────────┐  ┌──────────────────┐                           │
│  │ religious_idx   │  │ expectations_idx │  weight: 0.30             │
│  │ weight: 0.40    │  │ Pre-Filter:      │                           │
│  │ Pre-Filter:     │  │ gender, age      │                           │
│  │ gender, age     │  └──────────────────┘                           │
│  └─────────────────┘  ┌──────────────────┐  ┌────────────────────┐  │
│                        │ personality_idx  │  │ background_idx     │  │
│                        │ weight: 0.20     │  │ weight: 0.10       │  │
│                        └──────────────────┘  └────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│              HuggingFace Inference Endpoint                           │
│         BAAI/bge-m3  (Phase 1 — T4 GPU, $0.50/hr)                   │
│     BAAI/bge-multilingual-gemma2  (Phase 2 — A10G, $1.00/hr)        │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 3. בחירת מודל Embedding

### ההמלצה: שתי שלבים

| | Phase 1 | Phase 2 |
|---|---|---|
| **מודל** | `BAAI/bge-m3` | `BAAI/bge-multilingual-gemma2` |
| **Dimensions** | **1024** | **3584** |
| **גודל מודל** | 1.2 GB (FP16) | ~9 GB (FP16) |
| **GPU נדרש** | T4 (16GB VRAM) | A10G (24GB VRAM) |
| **HuggingFace** | Dedicated Endpoint | Dedicated Endpoint |
| **עלות** | $0.50/hr | $1.00/hr |
| **עברית** | מצוין (SOTA MIRACL) | עדיף (SOTA MIRACL — מדויק יותר) |
| **מתי לעבור** | עכשיו | כשיש >2K מועמדים ורוצים דיוק גבוה יותר |

### למה לא OpenAI?

| | OpenAI text-embedding-3-small | BAAI/bge-m3 |
|---|---|---|
| שליטה | שרת חיצוני, לא שלך | HF Endpoint — שלך |
| Hebrew | טוב | מצוין (אימון ייעודי רב-לשוני) |
| עלות סקייל | Pay-per-token (גדל עם הגדילה) | Fixed compute cost |
| Vendor lock-in | גבוה | נמוך — מודל open source |
| Dims | 1536 | 1024 |

> **הערה חשובה על autoscale-to-zero:** HuggingFace Dedicated Endpoints **אינם** תומכים ב-autoscale-to-zero כסטנדרט.  
> **פתרון מעשי:** Scheduled scaling — הורדה ל-0 בלילה (22:00–07:00), העלאה ב-07:00.  
> **חישוב:** 15 שעות פעיל/יום × $0.50 × 30 ימים = **$225/חודש** (T4, Phase 1).  
> **חלופה זולה יותר:** HF Serverless Inference API אם המודל תומך (בדוק לפני דיפלוי).

### אופציה חלופית: self-hosted ב-Node.js

`BAAI/bge-m3` מגיע עם ONNX export — ניתן להריץ דרך `@huggingface/transformers` (Node.js).

| | Self-Hosted ONNX | HF Dedicated Endpoint |
|---|---|---|
| עלות | $0 (אותו שרת) | $225/חודש |
| זמן embedding | ~500ms per batch (CPU) | ~50ms per batch (GPU) |
| זיכרון שרת | +1.2GB RAM | לא משפיע |
| קולד סטארט | אין (מודל בזיכרון) | ~30 שניות |
| מתאים ל | מאגר <1K, בDev | Production עם 1K+ |

**המלצה:** Self-hosted ONNX לDev/Staging, HF Dedicated לProduction.

---

## 4. Multi-Chunk Schema — 4 Vectors Per Candidate

### עקרון: למה 4 vectors ולא 1?

וקטור בודד מממוצע את כל מאפייני המועמד יחד. בשידוכים, התאמה בהשקפה דתית שווה הרבה יותר מהתאמה בתחביבים — אבל וקטור בודד לא יודע זאת. 4 vectors עם משקולות שונות ב-Atlas מאפשר לחפש בדיוק לפי הפרופורציה הנכונה לדומיין.

### ה-4 Chunks

| Chunk | שם | שדות | משקל |
|---|---|---|---|
| `religious` | זהות דתית ואורח חיים | `sectorGroup`, `subSector`, `lifestyleTone`, `religiousStyle` | **0.40** |
| `expectations` | ציפיות מבן/בת זוג | `whatSeeking`, `softPreferences`, `hardConstraints`, `openness` | **0.30** |
| `personality` | אישיות ותיאור עצמי | `about`, `aiEnrichment.personalityTraits`, `aiEnrichment.values` | **0.20** |
| `background` | רקע ושלב חיים | `age`, `city`, `personalStatus`, `lifeStage`, `studyWorkDirection` | **0.10** |
| | **סה"כ** | | **1.00** |

> **למה background רק 0.10?** כי גיל, מיקום וסטטוס אישי כבר מכוסים ע"י ה-Pre-Filter הקשיח ב-Atlas. אין טעם לשקלל אותם כבדים גם בוקטור.

### עדכון Schema (MongoDB)

**הרחבת `embeddingSchema` הקיים:**

```typescript
// BEFORE (v0.2 — single vector):
embedding: {
  vector: number[],   // select: false
  modelId: string,
  version: string,
  provider: string,
  dimensions: number,
  updatedAt: Date,
}

// AFTER (v0.3 — 4 chunks):
embedding: {
  modelId: string,
  provider: string,
  dimensions: number,
  updatedAt: Date,

  // 4 chunk vectors — כל אחד indexed בנפרד ב-Atlas
  religious: {
    vector:       number[],   // select: false
    textSnapshot: string,     // הטקסט שממנו נוצר הוקטור
  },
  expectations: {
    vector:       number[],   // select: false
    textSnapshot: string,
  },
  personality: {
    vector:       number[],   // select: false
    textSnapshot: string,
  },
  background: {
    vector:       number[],   // select: false
    textSnapshot: string,
  },
}
```

> `textSnapshot` נשמר לשתי מטרות:
> 1. לדעת מה נכנס לוקטור (debug)
> 2. לשלוח ל-LLM ב-RAG pipeline (ה-LLM מקבל טקסט, לא וקטור)

---

## 5. משקולות ואיך הן מיושמות

### השאלה המרכזית שעלתה בפרומפט

> *"How will the MongoDB `$vectorSearch` query handle searching across multiple vectors per user to calculate an overall match score? How do we apply Vector Weights in the DB pipeline?"*

### התשובה: `$rankFusion` של Atlas

MongoDB Atlas תומך ב-`$rankFusion` — הרצת מספר sub-pipelines של `$vectorSearch` ואיחוד התוצאות לפי משקולות.  
**המשקולות מיושמות בתוך ה-DB, לא ב-Node.js.**

```
pipeline: {
  religionSearch:     { $vectorSearch ... },   weight: 0.40
  expectationsSearch: { $vectorSearch ... },   weight: 0.30
  personalitySearch:  { $vectorSearch ... },   weight: 0.20
  backgroundSearch:   { $vectorSearch ... },   weight: 0.10
}
→ $rankFusion מאחד לפי Reciprocal Rank Fusion עם משקולות
→ מחזיר rankScore מ-0 לאינסוף (לא 0-1)
```

> **Reciprocal Rank Fusion (RRF):** שיטת ranking fusion סטנדרטית. לכל מועמד: `score = Σ(weight_i / (rank_i + 60))`. מועמד שמדורג גבוה ברוב ה-pipelines מקבל ציון גבוה.

### השוואה: $rankFusion vs. Composite Vector

| | `$rankFusion` (גישת v0.3) | Composite Vector (גישת v0.2) |
|---|---|---|
| איך מיושמות משקולות | ב-Atlas בזמן query | בNode.js בזמן כתיבה |
| דיוק | גבוה יותר (כל chunk בנפרד) | קצת פחות (ממוצע מוקדם) |
| Indexes נדרשים | **4** (אחד לכל chunk) | **1** |
| מורכבות query | גבוהה | נמוכה |
| Explainability | **מצוין** (ציון לכל chunk) | בינוני |
| Atlas tier | M10+ | M10 |
| **המלצה** | **✅ Phase 1 ב-v0.3** | Fallback אם $rankFusion בעייתי |

---

## 6. Atlas Vector Indexes ו-`$rankFusion`

### 4 Indexes שיש להגדיר (Collection: `externalcandidates`)

```json
// Index 1: Religious & Lifestyle
{
  "name": "ext_embedding_religious",
  "type": "vectorSearch",
  "definition": {
    "fields": [
      { "type": "vector",  "path": "embedding.religious.vector", "numDimensions": 1024, "similarity": "cosine" },
      { "type": "filter",  "path": "gender" },
      { "type": "filter",  "path": "status" },
      { "type": "filter",  "path": "availabilityStatus" },
      { "type": "filter",  "path": "age" }
    ]
  }
}

// Index 2: Expectations
{
  "name": "ext_embedding_expectations",
  "type": "vectorSearch",
  "definition": {
    "fields": [
      { "type": "vector",  "path": "embedding.expectations.vector", "numDimensions": 1024, "similarity": "cosine" },
      { "type": "filter",  "path": "gender" },
      { "type": "filter",  "path": "status" },
      { "type": "filter",  "path": "availabilityStatus" },
      { "type": "filter",  "path": "age" }
    ]
  }
}

// Index 3: Personality
{
  "name": "ext_embedding_personality",
  "type": "vectorSearch",
  "definition": {
    "fields": [
      { "type": "vector",  "path": "embedding.personality.vector", "numDimensions": 1024, "similarity": "cosine" },
      { "type": "filter",  "path": "gender" },
      { "type": "filter",  "path": "status" },
      { "type": "filter",  "path": "availabilityStatus" },
      { "type": "filter",  "path": "age" }
    ]
  }
}

// Index 4: Background
{
  "name": "ext_embedding_background",
  "type": "vectorSearch",
  "definition": {
    "fields": [
      { "type": "vector",  "path": "embedding.background.vector", "numDimensions": 1024, "similarity": "cosine" },
      { "type": "filter",  "path": "gender" },
      { "type": "filter",  "path": "status" },
      { "type": "filter",  "path": "availabilityStatus" },
      { "type": "filter",  "path": "age" }
    ]
  }
}
```

> **חשוב:** `numDimensions: 1024` לbge-m3 (Phase 1).  
> אם עוברים ל-bge-multilingual-gemma2 (Phase 2): יש למחוק את ה-indexes, לשנות ל-`numDimensions: 3584`, ולהריץ backfill מחדש.

---

## 7. Hybrid Search Query — גרסה מלאה

```typescript
// ב-similarity.service.ts

export async function hybridSearch(params: HybridSearchParams): Promise<HybridSearchResult> {
  const { internalChunks, oppositeGender, ageMin, ageMax, topK } = params;

  const preFilter = {
    gender:             { $eq: oppositeGender },
    status:             { $eq: 'active' },
    availabilityStatus: { $in: ['available', 'unknown'] },
    age:                { $gte: ageMin, $lte: ageMax },
  };

  const results = await ExternalCandidate.aggregate([
    {
      $rankFusion: {
        input: {
          pipelines: {

            religionSearch: [
              {
                $vectorSearch: {
                  index: 'ext_embedding_religious',
                  path: 'embedding.religious.vector',
                  queryVector: internalChunks.religious,
                  numCandidates: topK * 10,
                  limit: topK * 3,
                  filter: preFilter,
                },
              },
            ],

            expectationsSearch: [
              {
                $vectorSearch: {
                  index: 'ext_embedding_expectations',
                  path: 'embedding.expectations.vector',
                  queryVector: internalChunks.expectations,
                  numCandidates: topK * 10,
                  limit: topK * 3,
                  filter: preFilter,
                },
              },
            ],

            personalitySearch: [
              {
                $vectorSearch: {
                  index: 'ext_embedding_personality',
                  path: 'embedding.personality.vector',
                  queryVector: internalChunks.personality,
                  numCandidates: topK * 10,
                  limit: topK * 3,
                  filter: preFilter,
                },
              },
            ],

            backgroundSearch: [
              {
                $vectorSearch: {
                  index: 'ext_embedding_background',
                  path: 'embedding.background.vector',
                  queryVector: internalChunks.background,
                  numCandidates: topK * 10,
                  limit: topK * 3,
                  filter: preFilter,
                },
              },
            ],
          },
        },
        combination: {
          weights: {
            religionSearch:     0.40,
            expectationsSearch: 0.30,
            personalitySearch:  0.20,
            backgroundSearch:   0.10,
          },
        },
      },
    },
    { $limit: topK },
    { $project: { _id: 1, rankScore: { $meta: 'rankFusionScore' } } },
  ]);

  const similarities = new Map<string, number>();
  const topKIds: string[] = [];

  for (const r of results) {
    const id = String(r._id);
    similarities.set(id, r.rankScore as number);
    topKIds.push(id);
  }

  return { similarities, topKIds };
}
```

> **`rankFusionScore`:** המספר שמוחזר אינו 0–1 אלא RRF score (מספר חיובי שגדל ככל שהמועמד מדורג גבוה יותר). הוא יישמר ב-`semanticSimilarityScore` כ-raw value — לא להציגו כ-"אחוז". אם רוצים להציג — normalize לפי הציון המקסימלי בsession.

---

## 8. מפרט: Serialization לפי Chunk

### Chunk 1 — Religious & Lifestyle

```
זהות דתית: {sectorGroup}. תת-עדה: {subSector}. סגנון: {lifestyleTone}. אורח חיים: {religiousStyle}.
```

דוגמה:
```
זהות דתית: דתי לאומי. תת-עדה: ציוני-דתי. סגנון: מסורתי-מודרני. אורח חיים: dati-modern.
```

---

### Chunk 2 — Expectations & Preferences

```
מה מחפש בבן/בת זוג: {whatSeeking}.
פתיחות: מגזרים אחרים={openToOtherSectors}, גרושים={openToDivorced}, ילדים={openToWithChildren}, מרחק={openToLongDistance}.
העדפות גיל: {ageMin}–{ageMax} ({flexibility}).
העדפות רכות: {softPreferences serialized}.
דרישות קשיחות: {hardConstraints serialized}.
```

---

### Chunk 3 — Personality & Self Description

```
על עצמי: {about}.
תכונות אישיות: {aiEnrichment.personalityTraits}.
ערכים: {aiEnrichment.values}.
```

> אם `aiEnrichment` ריק — chunk 3 מבוסס רק על `about`. אם גם `about` ריק — chunk 3 לא נוצר (וקטור ה-personality לא נשמר, sub-pipeline מושמט מ-`$rankFusion` והמשקולות מתחלקות מחדש).

---

### Chunk 4 — Background & Life Stage

```
גיל: {age}. עיר: {city}. מצב אישי: {personalStatus}. ילדים: {numberOfChildren}.
שלב חיים: {lifeStage}. כיוון תורה/עבודה: {studyWorkDirection}.
```

---

### כלל: שדות חסרים

```typescript
// ב-profile.serializer.ts
function field(label: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  return `${label}: ${value}. `;
}
// שדות ריקים נשמטים לגמרי מהטקסט — לא מופיעים כ-"undefined"
```

---

## 9. RAG Pipeline — Matchmaker Summary

### תיאור

לאחר שה-Atlas מחזיר Top-K ו-matching.engine מסנן לSuitable — ה-shadchan יכול לבקש "ניתוח שדכן" לTop-5 מהBoard.  
שירות ה-RAG שולח פרופילים אנונימיים + ציוני chunk לLLM, ומקבל בחזרה ניתוח קריא בעברית.

### זרימה מפורטת

```
Operator לוחץ "ניתוח שדכן" על Top-5
         ↓
POST /compatibility/:internalId/rag-summary
Body: { externalIds: ["id1", ..., "id5"] }
         ↓
1. בדוק cache: האם PairReview.aiExplanation קיים וטרי (<24h)?
   → כן: החזר מ-cache (0ms latency)
   → לא: המשך
         ↓
2. שלוף פרופילים מלאים + chunk vectors מה-DB
         ↓
3. pii.stripper: הסר כל PII
   → "מועמד א", "מועמד ב", ... "מועמד ה"
         ↓
4. בנה context לLLM:
   - פרופיל מבקש (אנונימי) + כל 4 textSnapshots
   - לכל אחד מה-5: פרופיל אנונימי + chunk similarities
   - ציון engine: matchScore, matchType, strengths, attentionPoints
         ↓
5. LLM call (Groq / Claude Sonnet) — ראה prompt בהמשך
         ↓
6. Stream tokens דרך SSE לClient
         ↓
7. כשמסיים — שמור ב-PairReview.aiExplanation (cache)
```

### LLM Context Structure

```typescript
const systemPrompt = `
אתה שדכן מנוסה המסייע לשדכנים לנתח התאמות.
קיבלת פרופיל של מבקש שידוך ו-5 מועמדים פוטנציאליים.
לכל מועמד יש:
- פרופיל (טקסט)
- ציוני דמיון לפי ממד (דת/אורח חיים, ציפיות, אישיות, רקע)
- ציון התאמה מהמנוע הדטרמיניסטי

הגב בעברית. עבור כל מועמד ספק:
1. נקודות חיבור (2-3 נקודות ספציפיות)
2. נקודות שדורשות שיחה/תשומת לב (1-2)
3. הצעה אחת לפתיחת שיחה לשדכן
כתוב בגוף ראשון כאילו אתה השדכן.
`;

const userContext = `
=== פרופיל מבקש השידוך ===
${serializeForRAG(seekerProfile)}

=== ציוני דמיון ממד לפי ממד ===
דת/אורח חיים: ${chunkSims.religious.toFixed(2)}
ציפיות: ${chunkSims.expectations.toFixed(2)}
אישיות: ${chunkSims.personality.toFixed(2)}
רקע: ${chunkSims.background.toFixed(2)}

=== מועמד א ===
${serializeForRAG(candidate1Profile)}
ציון מנוע: ${matchScore}/100 | סוג: ${matchType}
חוזקות: ${strengths.join(', ')}
נקודות לתשומת לב: ${attentionPoints.join(', ')}

... [חוזר על כל 5 מועמדים]
`;
```

### LLM Output Format (Structured)

```typescript
// ה-LLM מתבקש לענות ב-JSON (function calling / structured output):
{
  "analyses": [
    {
      "alias": "מועמד א",
      "connectionPoints": ["שניהם דתיים לאומיים עם גישה מסורתית-מודרנית", "..."],
      "frictionPoints": ["פער בכיוון לימודי-עבודה שכדאי לבדוק"],
      "conversationStarter": "אני ממליץ לפתוח בשיחה על הקשר בין עבודה לתורה..."
    },
    // ...
  ]
}
```

---

## 10. PII Stripping — מניעת דליפת מידע

### שדות שמוסרים לפני שליחה ל-LLM

| שדה | פעולה |
|---|---|
| `firstName`, `lastName`, `hebrewName` | הוחלף ב-alias (`מועמד א`) |
| `phone`, `email` | הוסר לחלוטין |
| `fatherName`, `motherName` | הוסר לחלוטין |
| `referenceName`, `referencePhone` | הוסר לחלוטין |
| `photoUrl` | הוסר לחלוטין |
| `_id` | הוחלף ב-alias |
| `city` (ספציפי) | הוחלף באזור גאוגרפי (`"ירושלים"` → `"אזור ירושלים"`) |
| `neighborhood` | הוסר |
| `about`, `whatSeeking` (free text) | נשאר — אבל מועבר דרך regex לזיהוי שמות |

### שדות שנשמרים

```
age, sectorGroup, subSector, lifestyleTone, religiousStyle,
personalStatus, numberOfChildren, lifeStage, studyWorkDirection,
softPreferences (ללא identifying info), openness flags,
agePreferences, about (after PII scan), whatSeeking (after PII scan)
```

### מימוש `pii.stripper.ts`

```typescript
export interface AnonymizedProfile {
  alias: string;             // "מועמד א"
  age?: number;
  regionHint?: string;       // "אזור ירושלים"
  sectorGroup?: string;
  subSector?: string;
  lifestyleTone?: string;
  religiousStyle?: string;
  personalStatus?: string;
  numberOfChildren?: number;
  lifeStage?: string;
  studyWorkDirection?: string;
  about?: string;            // free text — PII scanned
  whatSeeking?: string;      // free text — PII scanned
  softPreferencesText?: string;
  opennessText?: string;
  agePreferencesText?: string;
  // chunk textSnapshots (for RAG context)
  chunks?: {
    religious?: string;
    expectations?: string;
    personality?: string;
    background?: string;
  };
}

const CITY_TO_REGION: Record<string, string> = {
  'ירושלים': 'אזור ירושלים',
  'תל אביב': 'גוש דן',
  'פתח תקווה': 'גוש דן',
  // ... etc
};

// Regex לזיהוי שמות פרטיים בטקסט חופשי:
const HEBREW_NAME_PATTERN = /\b[א-ת]{2,3}\s[א-ת]{2,6}\b/g;
// (לא מושלם — משמש כשכבת safety נוספת)

export function stripPII(
  doc: IInternalCandidate | IExternalCandidate,
  alias: string
): AnonymizedProfile
```

### עקרון: LLM רואה רק AnonymizedProfile

```
DB Document (full PII) → pii.stripper → AnonymizedProfile → LLM
                                               ↑
                               לעולם לא מועברים: שם, טלפון, email,
                               ID, כתובת מלאה, שם אב/אם
```

---

## 11. ארכיטקטורת Latency — Board מיידי + SSE

### הבעיה

RAG LLM call לוקח 3–8 שניות.  
אין לחסום את טעינת ה-Board בשביל זה.

### פתרון: שכבות Latency

```
שכבה 1 — Board מיידי (<300ms):
  GET /compatibility/:id/board
  → מחזיר את כל השורות + ragStatus לכל שורה
  ragStatus: 'cached' | 'not_generated'
  → אם 'cached': כולל את ה-summary מוכן
  → אם 'not_generated': הUI מציג כפתור "ייצר ניתוח"

שכבה 2 — RAG On-Demand (3–8 שניות, streaming):
  POST /compatibility/:id/rag-summary  →  SSE Stream
  → token by token
  → הUI מציג ניתוח שגדל בזמן אמת
  → כשמסיים, נשמר ב-PairReview.aiExplanation

שכבה 3 — Cache (0ms בפעם הבאה):
  בכל פתיחה עתידית של ה-Board — הניתוח כבר שם
```

### SSE — Server-Sent Events

```
Client                         Server
  |                              |
  | POST /rag-summary            |
  |----------------------------->|
  |                              | בונה context
  |                              | קורא ל-LLM (streaming)
  | event: token                 |
  |<-----------------------------| "מועמד"
  | event: token                 |
  |<-----------------------------| " א"
  | event: token                 |
  |<-----------------------------| " מתאים"
  | ...                          | ...
  | event: analysis_complete     |
  |<-----------------------------| { alias, connectionPoints, ... }
  | event: done                  |
  |<-----------------------------|
```

```typescript
// Express SSE endpoint skeleton
router.post('/:internalId/rag-summary', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    for await (const token of streamRagAnalysis(req.params.internalId, req.body.externalIds)) {
      sendEvent('token', { text: token });
    }
    sendEvent('done', {});
  } catch (err) {
    sendEvent('error', { message: 'ניתוח לא הצליח' });
  } finally {
    res.end();
  }
});
```

### Cache Strategy

| תנאי | פעולה |
|---|---|
| `PairReview.aiExplanation` קיים + `generatedAt` < 24 שעות | שלח מ-cache, לא קרא ל-LLM |
| `aiExplanation` קיים + > 24 שעות | שלח מ-cache + הצג "מיושן — לחץ לרענון" |
| `aiExplanation` לא קיים | LLM call + שמור |
| פרופיל השתנה (hash שונה) | invalidate cache → LLM call |

---

## 12. API Endpoints חדשים

### קיים (לא משתנה)

```
GET  /api/v1/compatibility/:internalId/board
```

### חדש — RAG Summary (SSE)

```
POST /api/v1/compatibility/:internalId/rag-summary

Body:
{
  "externalIds": ["id1", "id2", "id3", "id4", "id5"]  // 1–5 IDs
}

Response: text/event-stream (SSE)
Events:
  token         → { text: string }
  analysis_done → { alias, connectionPoints, frictionPoints, conversationStarter }
  done          → {}
  error         → { message: string }
```

### חדש — Invalidate RAG Cache (Admin)

```
DELETE /api/v1/compatibility/:internalId/rag-summary/:externalId

Response: { invalidated: true }
```

---

## 13. אינטגרציה עם ה-engine הקיים

### עדכון `buildBoardForInternal()` (~40 שורות נוספות)

```typescript
if (env.EMBEDDINGS_ENABLED) {
  // 1. טוען 4 chunk vectors של ה-internal
  const internalChunks = await embeddingService.loadChunks(internalId, 'internal');

  // 2. Atlas $rankFusion Hybrid Search
  const { similarities, topKIds } = await hybridSearch({
    internalChunks,
    oppositeGender: internal.gender === 'male' ? 'female' : 'male',
    ageMin: internal.agePreferences?.min ?? 18,
    ageMax: internal.agePreferences?.max ?? 45,
    topK: env.SEMANTIC_TOP_K,
  });

  ctx.semanticSimilarities = similarities;

  // 3. מסנן pool — top-K + מועמדים עם היסטוריה תמיד נכנסים
  const allowedIds = new Set([...topKIds, ...historicalIds]);
  filteredPool = externalPool.filter(e => allowedIds.has(String(e._id)));
}

// 4. מוסיף ragStatus לכל שורה
for (const row of rows) {
  const review = reviewByExternal.get(row.externalCandidateId);
  row.ragStatus = review?.aiExplanation?.generatedAt ? 'cached' : 'not_generated';
}
```

### שדות חדשים ב-`CompatibilityRow`

```typescript
// הוספה ל-interface CompatibilityRow:
ragStatus?: 'cached' | 'not_generated';
chunkSimilarities?: {
  religious: number;
  expectations: number;
  personality: number;
  background: number;
};
```

---

## 14. Backfill ועדכונים שוטפים

### Backfill Script

```
npx tsx server/src/scripts/backfill-embeddings.ts [--type internal|external|all] [--force]
```

**אלגוריתם:**
1. שלוף מועמדים ללא embedding תקין (או עם modelId שונה)
2. לכל batch של 20 (קטן יותר מv0.2 — 4 vectors per candidate):
   - serialize לכל אחד מ-4 chunks
   - embed כל 4 × 20 = 80 texts בקריאה אחת
   - bulk write ל-MongoDB
   - המתן 300ms

**עלות (500 מועמדים, bge-m3):**

| פרמטר | ערך |
|---|---|
| טקסטים לembedding | 500 × 4 chunks = **2,000** |
| זמן T4 endpoint | ~15 שניות (batch processing) |
| עלות HF | ~0.001 שעות × $0.50 = **$0.0005** |
| זמן script | ~3 דקות (כולל MongoDB writes + delays) |

### Triggers לעדכון Chunks

| שינוי | Chunks שמתעדכנים |
|---|---|
| `sectorGroup`, `subSector`, `lifestyleTone`, `religiousStyle` | `religious` בלבד |
| `whatSeeking`, `softPreferences`, `hardConstraints`, `openness` | `expectations` בלבד |
| `about`, `aiEnrichment.personalityTraits/values` | `personality` בלבד |
| `city`, `personalStatus`, `lifeStage`, `studyWorkDirection` | `background` בלבד |
| **עדכון חבילה** (כמה שדות מסוגים שונים) | רק chunks רלוונטיים |

> **חסכון משמעותי:** אם שדכן מעדכן רק "עיר" — מתעדכן רק chunk ה-background. 3 chunks האחרים לא נגעים.

---

## 15. משתני סביבה

```env
# ── Embeddings ──────────────────────────────────────────
EMBEDDINGS_ENABLED=false
EMBEDDINGS_PROVIDER=huggingface

# HF Dedicated Endpoint URL (ייחודי לdeployment שלך)
EMBEDDINGS_ENDPOINT_URL=https://your-endpoint.aws.endpoints.huggingface.cloud

# או: HF Serverless API key (אם המודל נתמך)
EMBEDDINGS_API_KEY=hf_...

# מודל — bge-m3 (Phase 1) או bge-multilingual-gemma2 (Phase 2)
EMBEDDINGS_MODEL=BAAI/bge-m3

# מימד הוקטור — חייב להתאים למודל!
# bge-m3: 1024 | bge-multilingual-gemma2: 3584
EMBEDDINGS_DIMENSIONS=1024

# כמה מועמדים להחזיר מהAtlas search לפני ה-engine
SEMANTIC_TOP_K=150

# ── RAG Pipeline ────────────────────────────────────────
RAG_ENABLED=false
RAG_PROVIDER=groq           # groq | anthropic | openai
RAG_MODEL=llama-3.3-70b-versatile
RAG_CACHE_TTL_HOURS=24

# ── Atlas ───────────────────────────────────────────────
# (MONGODB_URI כבר קיים — רק מוודאים שמצביע ל-M10+)
ATLAS_VECTOR_INDEX_RELIGIOUS=ext_embedding_religious
ATLAS_VECTOR_INDEX_EXPECTATIONS=ext_embedding_expectations
ATLAS_VECTOR_INDEX_PERSONALITY=ext_embedding_personality
ATLAS_VECTOR_INDEX_BACKGROUND=ext_embedding_background
```

---

## 16. קבצים שנוצרים / משתנים

### קבצים חדשים

```
server/src/services/embedding/
├── embedding.provider.ts       ← HuggingFace client + interface
├── profile.serializer.ts       ← candidate → 4 chunk texts
├── embedding.service.ts        ← generate chunks / load / invalidate
├── similarity.service.ts       ← Atlas $rankFusion hybrid search
└── pii.stripper.ts             ← [חדש v0.3] anonymize profiles for LLM

server/src/services/rag/
├── rag.service.ts              ← [חדש v0.3] builds context + streams LLM
└── rag.prompts.ts              ← [חדש v0.3] system/user prompt templates

server/src/modules/compatibility/
└── rag-summary.router.ts       ← [חדש v0.3] SSE endpoint

server/src/scripts/
└── backfill-embeddings.ts
```

### קבצים שמשתנים

```
server/src/services/compatibility/compatibility.service.ts
  → hybridSearch pre-filter + ragStatus לכל שורה (~50 שורות)

server/src/modules/compatibility/compatibility.router.ts (?)
  → רישום ה-SSE endpoint החדש

server/src/modules/candidates/internal-candidate.model.ts
  → הרחבת embeddingSchema ל-4 chunks (~30 שורות)

server/src/modules/candidates/external-candidate.model.ts
  → זהה

server/src/modules/candidates/internal-candidate.controller.ts
  → invalidate נכון per-chunk (~10 שורות)

server/src/modules/candidates/external-candidate.controller.ts
  → זהה

server/src/config/env.ts
  → הוסף משתנים חדשים (~10 שורות)
```

### קבצים שלא משתנים בכלל

```
matching.engine.ts | matching.types.ts | matching.score.ts
matching.rules.ts  | matching.penalties.ts | matching.matrix.ts
```

---

## 17. סיכום עלויות

### Phase 1 (bge-m3, Atlas M10)

| שירות | חישוב | עלות חודשית |
|---|---|---|
| MongoDB Atlas M10 | קבוע | **$57** |
| HF Dedicated Endpoint (T4) | 15 שעות/יום × $0.50 × 30 | **$225** |
| RAG LLM (Groq) | ~100 calls/יום × ~2K tokens = 6M tokens/חודש | **~$3** (Groq זול מאוד) |
| **סה"כ Phase 1** | | **~$285/חודש** |

> **הפחתת עלות HF:** אם embedding calls הם בעיקר בשעות פעילות (08:00–22:00), scheduled scaling יוריד ל-14 שעות/יום = **$210/חודש**. עם בקשות נמוכות — ניתן להוריד ל-T4 שפועל רק כשיש בקשות (serverless-like) אם HF יתמוך.

### Phase 2 (bge-multilingual-gemma2, Atlas M10)

| שירות | עלות חודשית |
|---|---|
| MongoDB Atlas M10 | $57 |
| HF Dedicated Endpoint (A10G) | $1.00/hr × 15hr × 30 = **$450** |
| RAG LLM (Groq / Claude) | $3–15 |
| **סה"כ Phase 2** | **~$510/חודש** |

### אופציה חלופית: Self-Hosted bge-m3 (Node.js ONNX)

| שירות | עלות חודשית |
|---|---|
| MongoDB Atlas M10 | $57 |
| HF Endpoint | $0 (רץ על אותו שרת) |
| Extra RAM | $0–10 (1.2GB נוספים) |
| **סה"כ Self-Hosted** | **~$57–67/חודש** |

> Tradeoff: embedding latency ~300–500ms (CPU) במקום ~30ms (GPU). מקובל לbackfill ולupdate. אולי קצת איטי לreal-time אם embedding נדרש בקשה per-request. לcache embeddings ב-DB — ברוב המקרים embedding כבר קיים.

---

## 18. רשימת סיכונים

| סיכון | הסתברות | השפעה | מיטיגציה |
|---|---|---|---|
| `$rankFusion` לא תומך ב-4 sub-pipelines | בינוני | גבוה | לבדוק ב-Atlas docs/playground לפני קוד; fallback: composite vector (v0.2) |
| HF Endpoint cold start (30–60 שניות) | גבוה | בינוני | Scheduled warmup; embedding cached ב-DB — לא קורא ל-HF בזמן query |
| bge-m3 לא על HF Serverless | ידוע | בינוני | Dedicated Endpoint — תוספת עלות $225/חודש |
| PII דולף ל-LLM בטקסט חופשי | בינוני | גבוה | regex scan + field-level stripping; LLM output לא נשמר עם PII |
| SSE connection timeout ב-nginx/proxy | בינוני | בינוני | הגדרת `proxy_read_timeout 120;` ב-nginx + keepalive events כל 15 שניות |
| RAG cache stale אחרי עדכון פרופיל | בינוני | נמוך | hash comparison בין textSnapshot לפרופיל נוכחי |
| 4 Atlas indexes — עלות / תחזוקה | נמוך | בינוני | M10 תומך במספר indexes; לפקח על Atlas Index Metrics |
| מועמד ב-top-K ללא embedding לchunk personality | גבוה | נמוך | sub-pipeline מושמט אם קיים chunk — משקולות מחושבות מחדש |

---

## 19. רשימת בדיקות (QA Checklist)

### Unit Tests

- [ ] `serializeChunk('religious', doc)` — לא מחזיר "undefined"
- [ ] `serializeChunk('personality', doc)` עם `about` ריק — מחזיר string ריק (לא זורק)
- [ ] `stripPII(doc, 'מועמד א')` — לא מכיל שם פרטי, טלפון, email
- [ ] `stripPII(doc, 'מועמד א').regionHint` — מוחזר אזור גאוגרפי, לא עיר ספציפית

### Integration Tests (נגד Atlas Staging)

- [ ] `hybridSearch` מחזיר רק externals עם `gender=female` כשמחפשים male
- [ ] `hybridSearch` לא מחזיר מחוץ לטווח גיל
- [ ] `hybridSearch` מחזיר `topKIds.length <= SEMANTIC_TOP_K`
- [ ] `hybridSearch` עם internal שלchunk `personality` חסר — לא קורס

### RAG Tests

- [ ] SSE endpoint שולח `event: token` לפני `event: done`
- [ ] לאחר RAG — `PairReview.aiExplanation` נשמר ב-DB
- [ ] בקשה שנייה לאותו pair — מגיעה מ-cache, לא מ-LLM (בדוק ב-logs)
- [ ] `AnonymizedProfile` שנשלח ל-LLM — ריצת assertion שלא מכיל שם/טלפון

### Smoke Test ידני (pre-production)

- [ ] Board טוען ב-<300ms גם עם EMBEDDINGS_ENABLED=true
- [ ] כפתור "ניתוח שדכן" מוצג על Top-5
- [ ] SSE streaming עובד בbrowser (test עם EventSource)
- [ ] ניתוח RAG מוחזר בעברית קריאה
- [ ] `matchScore` ו-`confidenceScore` לא השתנו (engine לא נגע)
- [ ] מועמד עם `pairReview` היסטורי מוצג גם אם לא ב-top-K

---

## 20. סדר ביצוע מומלץ

```
שלב 0 — תשתית (לפני קוד):
  □ שדרג MongoDB Atlas ל-M10
  □ בדוק ש-$rankFusion תומך ב-4 sub-pipelines (Atlas playground)
  □ הקם HF Dedicated Endpoint עם bge-m3
  □ בדוק שה-endpoint מגיב (curl test)

שלב 1 — Schema (שינוי DB):
  □ הרחב embeddingSchema ל-4 chunks ב-internal + external models
  □ בדיקת compile TypeScript

שלב 2 — Embedding Layer:
  □ embedding.provider.ts (HuggingFace client)
  □ profile.serializer.ts (4 chunk serializers)
  □ בדיקה ידנית: serialize 5 פרופילים — בדוק Hebrew טקסט סביר
  □ embedding.service.ts (generate 4 chunks + save + invalidate per chunk)

שלב 3 — Atlas Indexes:
  □ הגדר 4 Atlas Vector Search indexes (סעיף 6)
  □ בדוק שה-indexes פעילים לפני המשך

שלב 4 — Search Layer:
  □ similarity.service.ts ($rankFusion hybrid search)
  □ בדיקה: query test מול Atlas — רק gender נכון + גיל בטווח

שלב 5 — אינטגרציה:
  □ שינויים ב-compatibility.service.ts (pre-filter + ragStatus)
  □ smoke test: board עובד עם EMBEDDINGS_ENABLED=true

שלב 6 — Backfill:
  □ backfill-embeddings.ts (מאגר קיים)
  □ הרצה על staging — בדוק שכל 4 chunks נשמרים

שלב 7 — RAG Pipeline:
  □ pii.stripper.ts
  □ rag.prompts.ts
  □ rag.service.ts (build context + LLM streaming)
  □ rag-summary.router.ts (SSE endpoint)
  □ בדיקה: SSE streaming עובד ב-Postman/browser

שלב 8 — Controller Hooks:
  □ per-chunk invalidation ב-PATCH controllers

שלב 9 — QA + דיפלוי:
  □ כל ה-QA checklist
  □ דיפלוי עם EMBEDDINGS_ENABLED=false + RAG_ENABLED=false
  □ הפעלה הדרגתית — embeddings ראשון, RAG אחר כך
```

---

## 21. שאלות פתוחות

| # | שאלה | אפשרויות | ברירת מחדל מוצעת |
|---|---|---|---|
| 1 | **HF model provider** — Dedicated Endpoint או Self-hosted ONNX? | A: HF Dedicated ($225/חודש, 30ms) / B: ONNX Self-hosted ($0, 300ms) | **B תחילה** — Dev/Staging, **A** ל-Production |
| 2 | **$rankFusion weight format** — האם Atlas מקבל weights עשרוניים 0.0–1.0? | לבדוק ב-Atlas playground לפני קוד | טעון בדיקה |
| 3 | **RAG LLM** — Groq (כבר מוגדר) או Claude Sonnet (חדש)? | Groq: זול, מהיר / Claude: טוב יותר לעברית | **Groq תחילה** — אפשר להחליף |
| 4 | **RAG Cache TTL** — 24 שעות מספיק? | 12h / 24h / 72h | **24h** |
| 5 | **bge-m3 Self-hosted** — האם יש ONNX export תקין לNode.js? | לבדוק `@huggingface/transformers` README | טעון בדיקה |
| 6 | **SSE vs WebSocket** — SSE מספיק או צריך bidirectional? | SSE: פשוט, חד-כיווני / WS: מורכב, דו-כיווני | **SSE** — אין צורך ב-bidirectional לRAG |
| 7 | **Chunk weights** — האם 40/30/20/10 נכון לדומיין? | לבדוק עם שדכנים אמיתיים | **לאשר לפני קוד** |
| 8 | **PII — city masking** — רשימת עיר→אזור מלאה? | לבנות מיפוי ישוב→מחוז ב-profile.serializer | **לבנות מפורש** |
| 9 | **Analytics** — האם לשמור chunk similarity scores ב-DB? | A: שמור לניתוח עתידי / B: cache בלבד | **A** — יעזור לכייל משקולות בעתיד |

---

*תוכנית זו מבוססת על קריאת קוד ב-2026-04-20.*  
*v0.3 תוקנה ב-2026-04-20: Atlas Hybrid Search עם `$rankFusion`, 4 chunks, RAG Pipeline, PII stripping, SSE latency architecture.*  
*כל שדה, type ו-hook מוזכר קיים בקוד בפועל. טכנולוגיות חדשות (HF, $rankFusion) מסומנות ל-בדיקה לפני קוד.*
