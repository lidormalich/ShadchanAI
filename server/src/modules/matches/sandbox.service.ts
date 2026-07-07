// ═══════════════════════════════════════════════════════════
// ShadchanAI — Sandbox Pair Check ("בדוק מועמדים")
//
// Ad-hoc compatibility check between two people pasted as FREE TEXT,
// with NO persistence. Nobody has to be a saved candidate.
//
// Pipeline (per request):
//   1. Extract each side's free text → ExtractedProfile
//      (regex pre-parse + AI extractor, merged; AI failure → regex only).
//   2. Map profiles → engine inputs (MatchableInternal / MatchableExternal)
//      with synthetic ObjectIds and safe defaults for required fields.
//   3. Vectors (when the semantic add-on is ON): embed both sides' chunk
//      texts on the fly, compute the weighted cosine, and inject it into
//      the engine context so the flexibility boost applies.
//   4. Deterministic engine: evaluatePair(...) — source of truth for the
//      score / eligibility / classification.
//   5. AI narrative: explainMatch(...) grounds a Hebrew summary in the
//      engine result. Advisory only — never a competing score.
//
// This wires together existing persistence-free building blocks; the only
// new surface is the free-text input path (not tied to a Message/Candidate).
// ═══════════════════════════════════════════════════════════

import { Types } from 'mongoose';
import { Gender, SourceMode } from '@shadchanai/shared';

import {
  extractProfileFromText,
  type ExtractedProfile,
} from '../../services/extraction/regex.extractor.js';
import { extractProfileWithAI } from '../../services/extraction/ai.extractor.js';

import { evaluatePair as engineEvaluatePair } from '../../services/matching/matching.engine.js';
import type {
  MatchableInternal,
  MatchableExternal,
  MatchingContext,
  MatchResult,
} from '../../services/matching/matching.types.js';

import {
  serializeInternalChunks,
  serializeExternalChunks,
} from '../../services/embedding/profile.serializer.js';
import type { IInternalCandidate } from '../candidates/internal-candidate.model.js';
import type { IExternalCandidate } from '../candidates/external-candidate.model.js';
import {
  ALL_CHUNK_TYPES,
  type ChunkTexts,
  type CandidateChunks,
  type ChunkType,
} from '../../services/embedding/embedding.types.js';
import { getEmbeddingProvider } from '../../services/embedding/embedding.provider.js';
import { isSemanticEnabled } from '../../services/embedding/embedding.gate.js';
import {
  weightedChunkSimilarity,
  perChunkSimilarities,
} from '../../services/embedding/semantic-similarity.service.js';

import { explainMatch } from '../../services/ai/ai.service.js';
import type { CandidateBrief, ExplainMatchOutput } from '../../services/ai/ai.types.js';

import { createLogger } from '../../utils/logger.js';

const log = createLogger('matches.sandbox');

// ── Public shapes ─────────────────────────────────────────

export interface SandboxCheckInput {
  sideA: string;
  sideB: string;
  mode: SourceMode;
  userId?: string;
}

export interface SandboxSideResult {
  /** Structured fields we understood from the free text. */
  profile: ExtractedProfile;
  /** Rough 0..1 extraction confidence (higher = clearer card). */
  extractionConfidence: number;
  /** Whether the AI extractor contributed (false = regex only). */
  usedAI: boolean;
}

export interface SandboxSemanticResult {
  /** Semantic add-on active for this request. */
  enabled: boolean;
  /** Weighted cosine 0..1 across the chunks BOTH sides have. */
  score?: number;
  /** Per-domain cosine breakdown (religious / expectations / ...). */
  perChunk?: Partial<Record<ChunkType, number>>;
}

export interface SandboxAIResult {
  summary: string;
  strengths: string[];
  concerns: string[];
  nuance: string;
  recommendedApproach: string;
  notMatchReasons: string[];
  provider?: string;
}

export interface SandboxCheckResult {
  engine: MatchResult;
  semantic: SandboxSemanticResult;
  ai?: SandboxAIResult;
  sides: { a: SandboxSideResult; b: SandboxSideResult };
  /** Non-fatal issues surfaced to the operator (missing gender, sparse text, AI down…). */
  warnings: string[];
}

// ── Entry point ───────────────────────────────────────────

export async function checkPairFromText(input: SandboxCheckInput): Promise<SandboxCheckResult> {
  const warnings: string[] = [];

  // 1. Extract both sides (in parallel).
  const [sideA, sideB] = await Promise.all([
    extractSide(input.sideA, input.userId),
    extractSide(input.sideB, input.userId),
  ]);

  if (sideA.extractionConfidence < 0.35 || isSparse(sideA.profile)) {
    warnings.push('הטקסט של צד א׳ דל מאוד — ההתאמה מבוססת על מעט מידע, קחו את התוצאה בערבון מוגבל.');
  }
  if (sideB.extractionConfidence < 0.35 || isSparse(sideB.profile)) {
    warnings.push('הטקסט של צד ב׳ דל מאוד — ההתאמה מבוססת על מעט מידע, קחו את התוצאה בערבון מוגבל.');
  }

  // 2. Resolve genders (A=internal, B=external). Fill the missing side as the
  //    opposite of the known one; warn when neither is known.
  const { genderA, genderB } = resolveGenders(sideA.profile.gender, sideB.profile.gender, warnings);

  const internalId = new Types.ObjectId().toString();
  const externalId = new Types.ObjectId().toString();

  const internal = toMatchableInternal(sideA.profile, genderA, internalId);
  const external = toMatchableExternal(sideB.profile, genderB, externalId);

  // 3. Vectors (best-effort — never blocks the engine result).
  const semantic = await computeSemantic(sideA.profile, genderA, sideB.profile, genderB, externalId, warnings);

  // 4. Deterministic engine (source of truth). Inject semantic map so the
  //    flexibility dimension can pick up a high-similarity boost.
  const context: MatchingContext = {
    mode: input.mode,
    activeMatchExternalIds: new Set<string>(),
    recentDeclines: new Map<string, Date>(),
    activeSuggestionCount: 0,
    ...(semantic.score !== undefined
      ? { semanticSimilarities: new Map<string, number>([[externalId, semantic.score]]) }
      : {}),
  };

  const engine = engineEvaluatePair(internal, external, context);

  // 5. AI narrative (advisory). A provider outage must not fail the check.
  let ai: SandboxAIResult | undefined;
  try {
    ai = await explainNarrative(internal, external, sideA.profile, sideB.profile, engine, input.userId);
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'sandbox explainMatch failed');
    warnings.push('הסיכום החכם (AI) אינו זמין כרגע — מוצג ניתוח המנוע בלבד.');
  }

  return { engine, semantic, ai, sides: { a: sideA, b: sideB }, warnings };
}

// ── Extraction ────────────────────────────────────────────

async function extractSide(text: string, userId?: string): Promise<SandboxSideResult> {
  const regex = extractProfileFromText(text);
  let profile = regex.profile;
  let usedAI = false;
  let confidence = regex.confidence;

  try {
    const ai = await extractProfileWithAI(text, { userId });
    if (ai.profile.isProfile) {
      profile = mergeProfiles(regex.profile, ai.profile);
      usedAI = true;
      confidence = Math.max(confidence, ai.profile.confidence);
    }
  } catch (err) {
    // AI extraction is enrichment only — regex result stands on its own.
    log.warn({ err: (err as Error).message }, 'sandbox AI extraction failed — using regex only');
  }

  return { profile, extractionConfidence: confidence, usedAI };
}

/**
 * Merge regex + AI profiles: regex wins field-by-field (deterministic),
 * AI fills gaps; for narrative free text the fuller value wins.
 * Mirrors orchestrator.mergeProfiles (kept local to avoid exporting it).
 */
function mergeProfiles(
  regexP: ExtractedProfile,
  ai: { [K in keyof ExtractedProfile]?: ExtractedProfile[K] },
): ExtractedProfile {
  const out: ExtractedProfile = { ...regexP };
  const fillScalar = <K extends keyof ExtractedProfile>(k: K) => {
    if (out[k] === undefined && ai[k] !== undefined) out[k] = ai[k] as ExtractedProfile[K];
  };
  (['firstName', 'lastName', 'gender', 'age', 'height', 'city', 'edah', 'sectorGroup',
    'religiousLevelText', 'personalStatus', 'service', 'yeshiva',
    'seekingAgeMin', 'seekingAgeMax'] as Array<keyof ExtractedProfile>).forEach(fillScalar);

  out.occupation = pickFuller(out.occupation, ai.occupation);
  out.family = pickFuller(out.family, ai.family);
  out.about = pickFuller(out.about, ai.about);
  out.whatSeeking = pickFuller(out.whatSeeking, ai.whatSeeking);
  if ((!out.contactPhones || out.contactPhones.length === 0) && ai.contactPhones?.length) {
    out.contactPhones = ai.contactPhones;
  }
  return out;
}

function pickFuller(a?: string, b?: string): string | undefined {
  if (!b) return a;
  if (!a) return b;
  return b.length > a.length ? b : a;
}

/** Consider a profile too sparse to trust when it has almost no scored signal. */
function isSparse(p: ExtractedProfile): boolean {
  const signals = [p.age, p.sectorGroup, p.city, p.personalStatus, p.about, p.whatSeeking]
    .filter((v) => v !== undefined && v !== '');
  return signals.length < 2;
}

// ── Gender resolution ─────────────────────────────────────

function resolveGenders(
  a: Gender | undefined,
  b: Gender | undefined,
  warnings: string[],
): { genderA: Gender; genderB: Gender } {
  if (a && b) return { genderA: a, genderB: b };
  if (a && !b) return { genderA: a, genderB: opposite(a) };
  if (!a && b) return { genderA: opposite(b), genderB: b };
  // Neither known — assume opposite-gender pair so the engine can still score,
  // but tell the operator the result is unreliable.
  warnings.push('לא זוהה מגדר באף אחד מהצדדים — הנחנו זוג הפכי. ציינו מגדר לתוצאה אמינה.');
  return { genderA: Gender.MALE, genderB: Gender.FEMALE };
}

function opposite(g: Gender): Gender {
  return g === Gender.MALE ? Gender.FEMALE : Gender.MALE;
}

// ── Profile → engine inputs ───────────────────────────────

function ageToDob(age?: number): Date {
  // A representative Jan-1 birth year. When age is unknown we fall back to a
  // neutral ~28 so the age dimension degrades gracefully rather than crashing.
  const year = new Date().getFullYear() - (age ?? 28);
  return new Date(year, 0, 1);
}

/** Free-text side fields collapsed into one "extra" blob for embedding/brief. */
function extraText(p: ExtractedProfile): string | undefined {
  const parts = [p.occupation, p.yeshiva, p.service, p.family].filter(Boolean);
  return parts.length ? parts.join('. ') : undefined;
}

function toMatchableInternal(p: ExtractedProfile, gender: Gender, id: string): MatchableInternal {
  return {
    _id: id,
    firstName: p.firstName ?? 'צד א׳',
    lastName: p.lastName ?? '',
    gender,
    dateOfBirth: ageToDob(p.age),
    city: p.city,
    sectorGroup: (p.sectorGroup ?? 'other') as MatchableInternal['sectorGroup'],
    personalStatus: (p.personalStatus ?? 'single') as MatchableInternal['personalStatus'],
    numberOfChildren: 0,
    readinessForMarriage: 'open' as MatchableInternal['readinessForMarriage'],
    hardConstraints: [],
    softPreferences: [],
    openness: {
      openToOtherSectors: false, openToConverts: false, openToDivorced: false,
      openToWithChildren: false, openToAgeDifference: false, openToLongDistance: false,
    },
    profileCompletion: 0,
    missingCriticalFields: [],
    sendReadinessBlockers: [],
    status: 'active' as MatchableInternal['status'],
    deferredSuggestionsCount: 0,
  };
}

function toMatchableExternal(p: ExtractedProfile, gender: Gender, id: string): MatchableExternal {
  return {
    _id: id,
    firstName: p.firstName ?? 'צד ב׳',
    lastName: p.lastName ?? '',
    gender,
    age: p.age,
    city: p.city,
    sectorGroup: p.sectorGroup as MatchableExternal['sectorGroup'],
    personalStatus: p.personalStatus as MatchableExternal['personalStatus'],
    availabilityStatus: 'available' as MatchableExternal['availabilityStatus'],
    status: 'active' as MatchableExternal['status'],
    shareCard: { approvedForShare: true },
    sourceImportedAt: new Date(),
  };
}

// ── Vectors (on-the-fly embedding) ────────────────────────

async function computeSemantic(
  profileA: ExtractedProfile,
  genderA: Gender,
  profileB: ExtractedProfile,
  genderB: Gender,
  externalId: string,
  warnings: string[],
): Promise<SandboxSemanticResult> {
  if (!(await isSemanticEnabled())) return { enabled: false };

  try {
    const textsA = serializeInternalChunks(toSerializerDocInternal(profileA, genderA));
    const textsB = serializeExternalChunks(toSerializerDocExternal(profileB, genderB));

    const [chunksA, chunksB] = await Promise.all([embedChunks(textsA), embedChunks(textsB)]);

    const score = weightedChunkSimilarity(chunksA, chunksB);
    const perChunk = perChunkSimilarities(chunksA, chunksB);
    return { enabled: true, score, perChunk };
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'sandbox embedding failed');
    warnings.push('חישוב הדמיון הווקטורי נכשל — מוצג ניתוח המנוע וה-AI בלבד.');
    return { enabled: true };
  }
}

/** Embed every non-empty chunk text in ONE provider call; map vectors back. */
async function embedChunks(texts: ChunkTexts): Promise<CandidateChunks> {
  const present = ALL_CHUNK_TYPES
    .map((t) => [t, texts[t]] as const)
    .filter((e): e is readonly [ChunkType, string] => Boolean(e[1]));

  if (present.length === 0) return {};

  const vectors = await getEmbeddingProvider().embed(present.map(([, text]) => text));
  const out: CandidateChunks = {};
  present.forEach(([type], i) => { out[type] = vectors[i]; });
  return out;
}

// The chunk serializers read a small set of plain fields off the candidate
// document. We build a lean object with only those fields and cast — nothing
// downstream touches Mongoose-specific members.
function toSerializerDocInternal(p: ExtractedProfile, gender: Gender): IInternalCandidate {
  return {
    gender,
    dateOfBirth: ageToDob(p.age),
    city: p.city,
    sectorGroup: p.sectorGroup,
    personalStatus: p.personalStatus,
    about: p.about,
    additionalInfo: extraText(p),
    whatSeeking: p.whatSeeking,
    numberOfChildren: 0,
  } as unknown as IInternalCandidate;
}

function toSerializerDocExternal(p: ExtractedProfile, gender: Gender): IExternalCandidate {
  return {
    gender,
    age: p.age,
    city: p.city,
    sectorGroup: p.sectorGroup,
    personalStatus: p.personalStatus,
    about: p.about,
    additionalInfo: extraText(p),
    whatSeeking: p.whatSeeking,
  } as unknown as IExternalCandidate;
}

// ── AI narrative ──────────────────────────────────────────

async function explainNarrative(
  internal: MatchableInternal,
  external: MatchableExternal,
  profileA: ExtractedProfile,
  profileB: ExtractedProfile,
  engine: MatchResult,
  userId?: string,
): Promise<SandboxAIResult> {
  const res = await explainMatch(
    {
      internal: toBrief(internal._id, profileA, internal.gender, ageFromDob(internal.dateOfBirth)),
      external: toBrief(external._id, profileB, external.gender, external.age),
      matchScore: engine.matchScore,
      confidenceScore: engine.confidenceScore,
      matchType: engine.matchType,
      riskLevel: engine.riskLevel,
      strengths: engine.strengths,
      attentionPoints: engine.attentionPoints,
      scoreBreakdown: engine.scoreBreakdown,
      eligible: engine.eligible,
      blockers: engine.blockers.map((b) => ({ code: b.code, message: b.message, overridable: b.overridable })),
    },
    { userId },
  );
  const out: ExplainMatchOutput = res.data;
  return { ...out, provider: res.metadata.provider };
}

function toBrief(id: string, p: ExtractedProfile, gender: Gender | undefined, age?: number): CandidateBrief {
  return {
    id,
    firstName: p.firstName,
    lastName: p.lastName,
    gender,
    age,
    city: p.city,
    sectorGroup: p.sectorGroup,
    personalStatus: p.personalStatus,
    about: joinAbout(p),
    whatSeeking: p.whatSeeking,
  };
}

function joinAbout(p: ExtractedProfile): string | undefined {
  const parts = [p.about, extraText(p), p.religiousLevelText].filter(Boolean);
  return parts.length ? parts.join('. ') : undefined;
}

function ageFromDob(dob: Date): number {
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
  return age;
}
