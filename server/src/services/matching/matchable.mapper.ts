// ═══════════════════════════════════════════════════════════
// ShadchanAI — Matchable Mapper (canonical)
//
// SINGLE source of truth for turning a raw candidate document
// (lean Mongoose object) into the engine-input shape, plus the
// per-internal MatchingContext the engine needs.
//
// These functions are PURE w.r.t. business state: the mappers do
// no I/O at all; buildEngineContext only READS MatchSuggestion rows
// to derive the active/decline context. No writes happen here.
//
// Previously these helpers were duplicated in match.service.ts AND
// compatibility.service.ts — two copies that could (silently) drift
// and score the same pair differently. Both now import from here.
// ═══════════════════════════════════════════════════════════

import { Types } from 'mongoose';
import type { SourceMode } from '@shadchanai/shared';
import { MatchSuggestion } from '../../models/index.js';
import type {
  MatchableInternal,
  MatchableExternal,
  MatchingContext,
} from './matching.types.js';

export function toMatchableInternal(doc: Record<string, unknown>): MatchableInternal {
  return {
    _id: String(doc['_id']),
    firstName: (doc['firstName'] as string) ?? '',
    lastName: (doc['lastName'] as string) ?? '',
    gender: doc['gender'] as MatchableInternal['gender'],
    dateOfBirth: doc['dateOfBirth'] as Date,
    city: doc['city'] as string | undefined,
    region: doc['region'] as MatchableInternal['region'],
    ethnicity: doc['ethnicity'] as string | undefined,
    childrenPreference: (doc['lifeGoals'] as { childrenPreference?: MatchableInternal['childrenPreference'] } | undefined)?.childrenPreference,
    careerPriority: (doc['lifeGoals'] as { careerPriority?: MatchableInternal['careerPriority'] } | undefined)?.careerPriority,
    height: doc['height'] as number | undefined,
    sectorGroup: doc['sectorGroup'] as MatchableInternal['sectorGroup'],
    subSector: doc['subSector'] as MatchableInternal['subSector'],
    lifestyleTone: doc['lifestyleTone'] as MatchableInternal['lifestyleTone'],
    religiousStyle: doc['religiousStyle'] as MatchableInternal['religiousStyle'],
    personalStatus: (doc['personalStatus'] as MatchableInternal['personalStatus']) ?? 'single',
    numberOfChildren: (doc['numberOfChildren'] as number) ?? 0,
    lifeStage: doc['lifeStage'] as MatchableInternal['lifeStage'],
    readinessForMarriage: (doc['readinessForMarriage'] as MatchableInternal['readinessForMarriage']) ?? 'open',
    studyWorkDirection: doc['studyWorkDirection'] as MatchableInternal['studyWorkDirection'],
    hardConstraints: (doc['hardConstraints'] as MatchableInternal['hardConstraints']) ?? [],
    softPreferences: (doc['softPreferences'] as MatchableInternal['softPreferences']) ?? [],
    agePreferences: doc['agePreferences'] as MatchableInternal['agePreferences'],
    locationPreferences: doc['locationPreferences'] as MatchableInternal['locationPreferences'],
    openness: (doc['openness'] as MatchableInternal['openness']) ?? {
      openToOtherSectors: false, openToConverts: false, openToDivorced: false,
      openToWithChildren: false, openToAgeDifference: false, openToLongDistance: false,
    },
    profileCompletion: (doc['profileCompletion'] as number) ?? 0,
    missingCriticalFields: (doc['missingCriticalFields'] as string[]) ?? [],
    sendReadinessBlockers: (doc['sendReadinessBlockers'] as string[]) ?? [],
    profileQualityScore: doc['profileQualityScore'] as number | undefined,
    dataReliabilityScore: doc['dataReliabilityScore'] as number | undefined,
    readinessScore: doc['readinessScore'] as number | undefined,
    status: (doc['status'] as MatchableInternal['status']) ?? 'active',
    lastVerifiedAt: doc['lastVerifiedAt'] as Date | undefined,
    lastActionAt: doc['lastActionAt'] as Date | undefined,
    datingPartnerCandidateId: doc['datingPartnerCandidateId']
      ? String(doc['datingPartnerCandidateId']) : undefined,
    deferredSuggestionsCount: (doc['deferredSuggestionsCount'] as number) ?? 0,
  };
}

export function toMatchableExternal(doc: Record<string, unknown>): MatchableExternal {
  return {
    _id: String(doc['_id']),
    firstName: doc['firstName'] as string | undefined,
    lastName: doc['lastName'] as string | undefined,
    gender: doc['gender'] as MatchableExternal['gender'],
    age: doc['age'] as number | undefined,
    city: doc['city'] as string | undefined,
    region: doc['region'] as MatchableExternal['region'],
    ethnicity: doc['ethnicity'] as string | undefined,
    childrenPreference: (doc['lifeGoals'] as { childrenPreference?: MatchableExternal['childrenPreference'] } | undefined)?.childrenPreference,
    careerPriority: (doc['lifeGoals'] as { careerPriority?: MatchableExternal['careerPriority'] } | undefined)?.careerPriority,
    height: doc['height'] as number | undefined,
    sectorGroup: doc['sectorGroup'] as MatchableExternal['sectorGroup'],
    subSector: doc['subSector'] as MatchableExternal['subSector'],
    lifestyleTone: doc['lifestyleTone'] as MatchableExternal['lifestyleTone'],
    personalStatus: doc['personalStatus'] as MatchableExternal['personalStatus'],
    lifeStage: doc['lifeStage'] as MatchableExternal['lifeStage'],
    studyWorkDirection: doc['studyWorkDirection'] as MatchableExternal['studyWorkDirection'],
    availabilityStatus: (doc['availabilityStatus'] as MatchableExternal['availabilityStatus']) ?? 'unknown',
    status: (doc['status'] as MatchableExternal['status']) ?? 'active',
    shareCard: (doc['shareCard'] as MatchableExternal['shareCard']) ?? { approvedForShare: false },
    ageReliability: doc['ageReliability'] as MatchableExternal['ageReliability'],
    // Bidirectional preferences (optional on external)
    hardConstraints: doc['hardConstraints'] as MatchableExternal['hardConstraints'],
    softPreferences: doc['softPreferences'] as MatchableExternal['softPreferences'],
    agePreferences: doc['agePreferences'] as MatchableExternal['agePreferences'],
    locationPreferences: doc['locationPreferences'] as MatchableExternal['locationPreferences'],
    openness: doc['openness'] as MatchableExternal['openness'],
    staleAt: doc['staleAt'] as Date | undefined,
    lastConfirmedAvailableAt: doc['lastConfirmedAvailableAt'] as Date | undefined,
    lastSourceUpdateAt: doc['lastSourceUpdateAt'] as Date | undefined,
    sourceImportedAt: (doc['sourceImportedAt'] as Date) ?? new Date(0),
  };
}

// ── Engine context for an internal candidate ──────────────
//
// Derives the active-match / recent-decline context the engine
// consults from the existing MatchSuggestion rows. Read-only.
export async function buildEngineContext(
  internalId: string,
  mode: SourceMode,
): Promise<MatchingContext> {
  const active = await MatchSuggestion.find({
    internalCandidateId: new Types.ObjectId(internalId),
    status: { $nin: ['closed', 'expired'] },
  }).select('externalCandidateId').lean().exec();

  const declines = await MatchSuggestion.find({
    internalCandidateId: new Types.ObjectId(internalId),
    status: { $in: ['declined_side_a', 'declined_side_b'] },
  }).select('externalCandidateId closedAt').lean().exec();

  const activeMatchExternalIds = new Set<string>(
    active.map((s) => String(s.externalCandidateId)),
  );
  const recentDeclines = new Map<string, Date>();
  for (const d of declines) {
    if (d.closedAt) recentDeclines.set(String(d.externalCandidateId), d.closedAt);
  }

  return {
    mode,
    activeMatchExternalIds,
    recentDeclines,
    activeSuggestionCount: active.length,
  };
}
