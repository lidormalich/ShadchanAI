// ═══════════════════════════════════════════════════════════
// ShadchanAI — Internal Candidate validators (Zod)
// ═══════════════════════════════════════════════════════════

import { z } from 'zod';
import {
  Gender,
  SectorGroup,
  SubSector,
  LifestyleTone,
  ReligiousStyle,
  PersonalStatus,
  LifeStage,
  ReadinessForMarriage,
  StudyWorkDirection,
  CandidateStatus,
  ClosureReason,
  Region,
  ChildrenPreference,
  CareerPriority,
} from '@shadchanai/shared';
import { PaginationQuerySchema } from '../../utils/pagination.js';

const ObjectIdString = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');

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

const OpennessSchema = z.object({
  openToOtherSectors: z.boolean().default(false),
  openToConverts: z.boolean().default(false),
  openToDivorced: z.boolean().default(false),
  openToWithChildren: z.boolean().default(false),
  openToAgeDifference: z.boolean().default(false),
  openToLongDistance: z.boolean().default(false),
}).default({
  openToOtherSectors: false,
  openToConverts: false,
  openToDivorced: false,
  openToWithChildren: false,
  openToAgeDifference: false,
  openToLongDistance: false,
});

// ── Create ────────────────────────────────────────────────

export const CreateInternalCandidateSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  gender: z.nativeEnum(Gender),
  dateOfBirth: z.coerce.date(),
  hebrewName: z.string().max(100).optional(),
  fatherName: z.string().max(100).optional(),
  motherName: z.string().max(100).optional(),
  phone: z.string().max(30).optional(),
  email: z.string().email().max(200).optional(),
  photoUrl: z.string().url().optional(),
  photoApproved: z.boolean().optional(),

  city: z.string().max(100).optional(),
  region: z.nativeEnum(Region).optional(),
  neighborhood: z.string().max(100).optional(),
  originCity: z.string().max(100).optional(),
  originCountry: z.string().max(100).optional(),
  ethnicity: z.string().max(100).optional(),
  familyBackground: z.string().max(2000).optional(),
  height: z.number().int().min(100).max(220).optional(),

  characterTraits: z.array(z.string().max(60)).max(20).optional(),
  characterNotes: z.string().max(2000).optional(),
  lifeGoals: z.object({
    childrenPreference: z.nativeEnum(ChildrenPreference).optional(),
    careerPriority: z.nativeEnum(CareerPriority).optional(),
    homeVision: z.string().max(1000).optional(),
  }).optional(),

  sectorGroup: z.nativeEnum(SectorGroup),
  subSector: z.nativeEnum(SubSector).optional(),
  lifestyleTone: z.nativeEnum(LifestyleTone).optional(),
  religiousStyle: z.nativeEnum(ReligiousStyle).optional(),

  personalStatus: z.nativeEnum(PersonalStatus).default(PersonalStatus.SINGLE),
  numberOfChildren: z.number().int().min(0).default(0),
  lifeStage: z.nativeEnum(LifeStage).optional(),
  readinessForMarriage: z.nativeEnum(ReadinessForMarriage),

  studyWorkDirection: z.nativeEnum(StudyWorkDirection).optional(),
  currentOccupation: z.string().max(200).optional(),
  educationLevel: z.string().max(200).optional(),
  educationInstitution: z.string().max(200).optional(),
  torahStudyYears: z.number().int().min(0).max(60).optional(),
  armyService: z.string().max(200).optional(),

  about: z.string().max(2000).optional(),
  whatSeeking: z.string().max(2000).optional(),
  referenceName: z.string().max(200).optional(),
  referencePhone: z.string().max(30).optional(),
  additionalInfo: z.string().max(2000).optional(),

  hardConstraints: z.array(HardConstraintSchema).max(20).optional(),
  softPreferences: z.array(SoftPreferenceSchema).max(30).optional(),
  agePreferences: AgePreferenceSchema,
  locationPreferences: LocationPreferenceSchema,
  openness: OpennessSchema,
});

export type CreateInternalCandidateInput = z.infer<typeof CreateInternalCandidateSchema>;

// ── Update (all fields optional) ─────────────────────────

export const UpdateInternalCandidateSchema = CreateInternalCandidateSchema.partial();
export type UpdateInternalCandidateInput = z.infer<typeof UpdateInternalCandidateSchema>;

// ── List / filters ───────────────────────────────────────

export const ListInternalCandidatesQuerySchema = PaginationQuerySchema.extend({
  status: z.nativeEnum(CandidateStatus).optional(),
  gender: z.nativeEnum(Gender).optional(),
  // Data-quality filter: when true, return only candidates with no gender
  // set. Gender is required on create, so this surfaces legacy/bad rows.
  missingGender: z.coerce.boolean().optional(),
  sectorGroup: z.nativeEnum(SectorGroup).optional(),
  city: z.string().optional(),
  search: z.string().max(200).optional(),
  ownership: z.enum(['mine', 'team', 'all']).optional(),
});

export type ListInternalCandidatesQuery = z.infer<typeof ListInternalCandidatesQuerySchema>;

// ── ID params ────────────────────────────────────────────

export const IdParamSchema = z.object({ id: ObjectIdString });

// ── Lifecycle actions ────────────────────────────────────

export const CloseCandidateSchema = z.object({
  reason: z.nativeEnum(ClosureReason),
  note: z.string().max(1000).optional(),
});

export const MarkDatingSchema = z.object({
  partnerCandidateId: ObjectIdString,
  sourceMatchId: ObjectIdString.optional(),
});

export const ReopenCandidateSchema = z.object({
  fromDatingMatchId: ObjectIdString.optional(),
  reason: z.enum(['did_not_match', 'requested', 'other']).default('did_not_match'),
  note: z.string().max(1000).optional(),
});
