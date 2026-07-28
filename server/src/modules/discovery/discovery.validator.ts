// ═══════════════════════════════════════════════════════════
// Discovery — Zod validators (operator + public surfaces)
// ═══════════════════════════════════════════════════════════

import { z } from 'zod';

const ObjectIdString = z.string().regex(/^[a-f\d]{24}$/i);

// ── Operator ─────────────────────────────────────────────

export const CreateSessionSchema = z.object({
  internalCandidateId: ObjectIdString,
});

export const ListSessionsQuerySchema = z.object({
  internalCandidateId: ObjectIdString,
});

export const IdParamSchema = z.object({ id: ObjectIdString });

export const ApplyProposalSchema = z.object({
  internalCandidateId: ObjectIdString,
  // Keys only — the server rebuilds the proposal and applies ITS values.
  accept: z.array(z.string().max(60)).min(1).max(20),
});

// ── Public ───────────────────────────────────────────────

// Token grammar is checked again inside resolveActiveSession; this
// keeps garbage from even reaching the DB lookup.
export const TokenParamSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
});

// Loose on purpose: sanitizeTraitPicks() is the real gate — anything
// not in the vocabulary is dropped there. This schema only bounds size.
export const SubmitTraitsSchema = z.object({
  ageMin: z.number().optional(),
  ageMax: z.number().optional(),
  regions: z.array(z.string().max(40)).max(10).optional(),
  openness: z.record(z.string(), z.boolean()).optional(),
  softPreferences: z
    .array(z.object({
      field: z.string().max(40),
      value: z.string().max(80),
      importance: z.string().max(20).optional(),
    }))
    .max(12)
    .optional(),
  freeText: z.string().max(300).optional(),
});

export const SubmitVerdictSchema = z.object({
  cardId: z.string().regex(/^[A-Za-z0-9_-]{8,24}$/),
  verdict: z.enum(['like', 'reject', 'skip']),
  reasonChips: z.array(z.string().max(100)).max(6).optional(),
  reasonText: z.string().max(300).optional(),
});

export const PhotoParamSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  cardId: z.string().regex(/^[A-Za-z0-9_-]{8,24}$/),
});
