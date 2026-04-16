// ═══════════════════════════════════════════════════════════
// ShadchanAI — External Candidate Validators
// ═══════════════════════════════════════════════════════════

import { z } from 'zod';
import {
  Gender,
  SectorGroup,
  SubSector,
  LifestyleTone,
  PersonalStatus,
  LifeStage,
  StudyWorkDirection,
  ExternalCandidateStatus,
  ExternalSourceType,
  AvailabilityStatus,
  ShareCardPhotoMode,
  AgeConfidence,
} from '@shadchanai/shared';
import { PaginationQuerySchema } from '../../utils/pagination.js';

const ObjectIdString = z.string().regex(/^[a-f\d]{24}$/i);

const HardConstraintSchema = z.object({
  field: z.string().min(1),
  operator: z.enum(['eq', 'neq', 'in', 'not_in', 'gt', 'lt', 'gte', 'lte', 'between']),
  value: z.unknown(),
  reason: z.string().max(500).optional(),
});
const SoftPreferenceSchema = z.object({
  field: z.string().min(1),
  value: z.unknown(),
  importance: z.enum(['must_have', 'important', 'nice_to_have', 'flexible']),
  note: z.string().max(500).optional(),
});
const AgePreferenceSchema = z.object({
  min: z.number().int().min(15).max(120).optional(),
  max: z.number().int().min(15).max(120).optional(),
  flexibility: z.enum(['strict', 'somewhat_flexible', 'very_flexible']).optional(),
}).optional();
const LocationPreferenceSchema = z.object({
  cities: z.array(z.string()).max(20).optional(),
  regions: z.array(z.string()).max(10).optional(),
  willingToRelocate: z.boolean().optional(),
  maxDistanceKm: z.number().nonnegative().optional(),
}).optional();
const OpennessExternalSchema = z.object({
  openToOtherSectors: z.boolean().optional(),
  openToConverts: z.boolean().optional(),
  openToDivorced: z.boolean().optional(),
  openToWithChildren: z.boolean().optional(),
  openToAgeDifference: z.boolean().optional(),
  openToLongDistance: z.boolean().optional(),
}).optional();

export const CreateExternalCandidateSchema = z.object({
  // Preferences are optional on external — they're only present when a
  // referring shadchan or source provided them. When set, the engine
  // applies them as hard rules + soft scoring on the reverse direction.
  hardConstraints: z.array(HardConstraintSchema).max(20).optional(),
  softPreferences: z.array(SoftPreferenceSchema).max(30).optional(),
  agePreferences: AgePreferenceSchema,
  locationPreferences: LocationPreferenceSchema,
  openness: OpennessExternalSchema,

  sourceType: z.nativeEnum(ExternalSourceType),
  sourceName: z.string().max(200).optional(),
  sourceExternalId: z.string().max(200).optional(),
  sourceMatchmakerName: z.string().max(200).optional(),
  sourceChannelId: z.string().max(100).optional(),

  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  gender: z.nativeEnum(Gender).optional(),
  age: z.number().int().min(18).max(120).optional(),
  city: z.string().max(100).optional(),
  sectorGroup: z.nativeEnum(SectorGroup).optional(),
  subSector: z.nativeEnum(SubSector).optional(),
  lifestyleTone: z.nativeEnum(LifestyleTone).optional(),
  personalStatus: z.nativeEnum(PersonalStatus).optional(),
  lifeStage: z.nativeEnum(LifeStage).optional(),
  studyWorkDirection: z.nativeEnum(StudyWorkDirection).optional(),
  height: z.number().int().min(100).max(220).optional(),
  about: z.string().max(2000).optional(),
  whatSeeking: z.string().max(2000).optional(),
  photoUrl: z.string().url().optional(),

  sharePhoto: z.boolean().default(false),
  availabilityStatus: z.nativeEnum(AvailabilityStatus).default(AvailabilityStatus.UNKNOWN),

  ageReliability: z.object({
    reportedAgeAt: z.coerce.date().optional(),
    ageConfidence: z.nativeEnum(AgeConfidence).default(AgeConfidence.UNKNOWN),
    approximateBirthYear: z.number().int().min(1900).max(2100).optional(),
  }).optional(),
});

export type CreateExternalCandidateInput = z.infer<typeof CreateExternalCandidateSchema>;

export const UpdateExternalCandidateSchema = CreateExternalCandidateSchema.partial();
export type UpdateExternalCandidateInput = z.infer<typeof UpdateExternalCandidateSchema>;

export const ListExternalCandidatesQuerySchema = PaginationQuerySchema.extend({
  status: z.nativeEnum(ExternalCandidateStatus).optional(),
  gender: z.nativeEnum(Gender).optional(),
  sectorGroup: z.nativeEnum(SectorGroup).optional(),
  city: z.string().optional(),
  availabilityStatus: z.nativeEnum(AvailabilityStatus).optional(),
  search: z.string().max(200).optional(),
  ownership: z.enum(['mine', 'team', 'all']).optional(),
});

export type ListExternalCandidatesQuery = z.infer<typeof ListExternalCandidatesQuerySchema>;

export const UpdateShareCardSchema = z.object({
  title: z.string().max(200).optional(),
  summary: z.string().max(1000).optional(),
  visibleFields: z.array(z.string()).max(40).optional(),
  photoMode: z.nativeEnum(ShareCardPhotoMode).optional(),
  approvedForShare: z.boolean().optional(),
});

export const UpdateAvailabilitySchema = z.object({
  availabilityStatus: z.nativeEnum(AvailabilityStatus),
  staleReason: z.string().max(500).optional(),
  confirmAvailable: z.boolean().optional(),
});

export const FindMatchingInternalsQuerySchema = PaginationQuerySchema.extend({
  mode: z.enum(['strict', 'discovery']).default('strict'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const IdParamSchema = z.object({ id: ObjectIdString });
