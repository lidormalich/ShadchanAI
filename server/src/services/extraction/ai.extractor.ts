// ═══════════════════════════════════════════════════════════
// ShadchanAI — AI Profile Extractor (Groq-primary, OpenAI fallback)
//
// Called ONLY when regex extraction's confidence is below threshold.
// Groq / Llama 3.3 70B handles Hebrew well enough for this task and
// is ~10-30x cheaper than GPT-4o. The strict Zod schema below is
// what lets us fall back automatically when Llama returns broken
// JSON — `executeWithFallback` retries in strict mode, then flips
// to OpenAI.
//
// Design notes:
//   - All enum fields are OPTIONAL. It is far better to get no value
//     than a hallucinated one; downstream uses undefined as the signal
//     for "ask a human".
//   - confidence in [0,1] is the MODEL's self-reported confidence,
//     NOT our pipeline confidence. Orchestrator combines them.
//   - isProfile=false short-circuits the whole pipeline: non-profile
//     chatter doesn't create candidates or land in review queue.
// ═══════════════════════════════════════════════════════════

import { z } from 'zod';
import {
  AIRequestType,
  Gender,
  PersonalStatus,
  SectorGroup,
} from '@shadchanai/shared';
import { executeWithFallback } from '../ai/ai.service.js';
import type { ChatMessage } from '../ai/ai.types.js';

// ── Output schema ────────────────────────────────────────
// Keep tolerant — any field the model can't confidently fill must
// come back undefined, not fabricated.

export const AIExtractedProfileSchema = z.object({
  isProfile: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(300).optional(),
  firstName: z.string().trim().min(1).max(50).optional(),
  lastName: z.string().trim().min(1).max(50).optional(),
  gender: z.enum([Gender.MALE, Gender.FEMALE]).optional(),
  age: z.number().int().min(15).max(99).optional(),
  height: z.number().int().min(130).max(220).optional(),
  city: z.string().trim().max(100).optional(),
  edah: z.string().trim().max(100).optional(),
  sectorGroup: z.enum([
    SectorGroup.DATI_LEUMI,
    SectorGroup.HAREDI,
    SectorGroup.DATI,
    SectorGroup.MASORTI,
    SectorGroup.HARDAL,
    SectorGroup.TORANI,
    SectorGroup.OTHER,
  ]).optional(),
  religiousLevelText: z.string().trim().max(200).optional(),
  personalStatus: z.enum([
    PersonalStatus.SINGLE,
    PersonalStatus.DIVORCED,
    PersonalStatus.WIDOWED,
    PersonalStatus.SEPARATED,
  ]).optional(),
  occupation: z.string().trim().max(300).optional(),
  about: z.string().trim().max(1500).optional(),
  whatSeeking: z.string().trim().max(1500).optional(),
  seekingAgeMin: z.number().int().min(15).max(99).optional(),
  seekingAgeMax: z.number().int().min(15).max(99).optional(),
  contactPhones: z.array(z.string().regex(/^0\d{9}$/)).max(5).optional(),
});

export type AIExtractedProfile = z.infer<typeof AIExtractedProfileSchema>;

// ── Prompt builder ───────────────────────────────────────

function buildPrompt(messageText: string, strictRetry: boolean): ChatMessage[] {
  const strictSuffix = strictRetry
    ? '\n\nCRITICAL: Your previous response was not valid JSON. Output ONLY a single JSON object, no prose, no markdown fences.'
    : '';

  const system = `You are a profile-extraction engine for a Hebrew matchmaking system.

TASK: Given a WhatsApp message, decide whether it is a shidduch profile card, and if so extract structured fields.

RULES:
- Output a SINGLE JSON object, no markdown, no commentary.
- If the message is NOT a profile (greeting, question, announcement, empty template form) → {"isProfile": false, "confidence": <0..1>, "reason": "..."}.
- Otherwise → {"isProfile": true, ...fields}.
- For any field you are not confident about, OMIT it entirely. Never guess.
- Hebrew-specific notes:
  * "רווק/ה" / "רווקה" → single ; "אלמן/אלמנה" → widowed ; "גרוש/ה" → divorced.
  * sectorGroup: "דתי לאומי/דתיה לאומית" → dati_leumi ; "חרדי/ת" → haredi ;
    "דתי/ה" (without לאומי) → dati ; "חרדל" → hardal ; "תורני/ת" → torani ;
    "מסורתי/ת" → masorti. Otherwise omit.
  * Gender inference: who is the profile ABOUT (not who is looking).
    "מחפש בחורה" → the profile is a male ; "מחפשת בחור" → female.
  * Height: normalize to integer centimeters. "1.65" → 165. "1.70 מ" → 170.
  * Age: round to nearest integer. "19.5" → 20 (also set in the input).
  * Phones: only Israeli mobile format normalized to 10 digits starting with 05.
- confidence is YOUR self-reported confidence in the whole extraction, in [0,1].${strictSuffix}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: messageText },
  ];
}

// ── Public API ───────────────────────────────────────────

export async function extractProfileWithAI(messageText: string, opts: { userId?: string; messageId?: string } = {}): Promise<{
  profile: AIExtractedProfile;
  providerUsed: string;
  fallbackUsed: boolean;
  latencyMs: number;
}> {
  const result = await executeWithFallback({
    requestType: AIRequestType.CLASSIFY,
    buildPrompt: (strict) => buildPrompt(messageText, strict),
    schema: AIExtractedProfileSchema,
    userId: opts.userId,
    relatedEntityType: 'message',
    relatedEntityId: opts.messageId,
  });

  return {
    profile: result.data,
    providerUsed: result.metadata.provider,
    fallbackUsed: result.metadata.fallbackUsed,
    latencyMs: result.metadata.latencyMs,
  };
}
