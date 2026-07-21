import mongoose, { Schema, Document, Types } from 'mongoose';
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

// ── Sub-schemas ───────────────────────────────────────────

const hardConstraintSchema = new Schema(
  {
    field: { type: String, required: true },
    operator: {
      type: String,
      enum: ['eq', 'neq', 'in', 'not_in', 'gt', 'lt', 'gte', 'lte', 'between'],
      required: true,
    },
    value: { type: Schema.Types.Mixed, required: true },
    reason: { type: String },
  },
  { _id: false },
);

const softPreferenceSchema = new Schema(
  {
    field: { type: String, required: true },
    value: { type: Schema.Types.Mixed, required: true },
    importance: {
      type: String,
      enum: ['must_have', 'important', 'nice_to_have', 'flexible'],
      required: true,
    },
    note: { type: String },
  },
  { _id: false },
);

const agePreferenceSchema = new Schema(
  {
    min: { type: Number },
    max: { type: Number },
    flexibility: {
      type: String,
      enum: ['strict', 'somewhat_flexible', 'very_flexible'],
      default: 'somewhat_flexible',
    },
  },
  { _id: false },
);

const locationPreferenceSchema = new Schema(
  {
    cities: [{ type: String }],
    regions: [{ type: String }],
    willingToRelocate: { type: Boolean, default: false },
    maxDistanceKm: { type: Number },
  },
  { _id: false },
);

const opennessSchema = new Schema(
  {
    openToOtherSectors: { type: Boolean, default: false },
    openToConverts: { type: Boolean, default: false },
    // Tri-state, NOT defaulted: undefined = unknown, false = explicit "לא"
    // (hard-blocks divorced), true = explicit "כן". A default here would
    // erase the operator's intent and wrongly block divorced pairs.
    openToDivorced: { type: Boolean },
    openToWithChildren: { type: Boolean, default: false },
    openToAgeDifference: { type: Boolean, default: false },
    openToLongDistance: { type: Boolean, default: false },
  },
  { _id: false },
);

const aiEnrichmentSchema = new Schema(
  {
    summary: { type: String },
    personalityTraits: [{ type: String }],
    values: [{ type: String }],
    communicationStyle: { type: String },
    enrichedAt: { type: Date },
    enrichmentVersion: { type: String },
    provider: { type: String },
    model: { type: String },
  },
  { _id: false },
);

// ── Multi-chunk embedding schema ──────────────────────────
//
// A candidate's profile is split into 4 semantic chunks, each
// with its own vector.  Atlas $rankFusion searches all 4 in
// parallel and merges the results with per-chunk weights:
//   religious (0.40) | expectations (0.30) | personality (0.20) | background (0.10)
//
// vector and textSnapshot are select:false — they are large and
// must be explicitly requested with select('+embedding.*.vector').
// embeddedAt is always loaded so staleness can be checked cheaply.

const embeddingChunkSchema = new Schema(
  {
    vector:       { type: [Number], select: false },   // the actual embedding
    textSnapshot: { type: String,   select: false },   // source text (for RAG + debug)
    embeddedAt:   { type: Date },                       // when this chunk was last generated
  },
  { _id: false },
);

const embeddingSchema = new Schema(
  {
    // Model metadata — shared across all chunks on this document.
    // modelId is used to detect when re-embedding is needed after a model upgrade.
    modelId:    { type: String },   // e.g. 'BAAI/bge-m3'
    provider:   { type: String },   // e.g. 'huggingface'
    dimensions: { type: Number },   // 1024 for bge-m3; 3584 for bge-multilingual-gemma2
    updatedAt:  { type: Date },     // timestamp of the most recent chunk update

    // The 4 semantic chunks — each maps to one Atlas vector index.
    religious:    { type: embeddingChunkSchema },
    expectations: { type: embeddingChunkSchema },
    personality:  { type: embeddingChunkSchema },
    background:   { type: embeddingChunkSchema },
  },
  { _id: false },
);

// ── Main Schema ───────────────────────────────────────────

export interface IInternalCandidate extends Document {
  // identity
  firstName: string;
  lastName: string;
  gender: Gender;
  dateOfBirth: Date;
  hebrewName?: string;
  fatherName?: string;
  motherName?: string;
  phone?: string;
  email?: string;
  photoUrl?: string;
  photoApproved: boolean;
  // Exact R2 object key the photo lives at (see candidate-photo.service).
  photoStorageKey?: string;
  // Unguessable token for the PUBLIC (no-auth) photo link.
  photoShareToken?: string;

  // demographics
  city?: string;
  region?: Region;
  neighborhood?: string;
  originCity?: string;
  originCountry?: string;
  ethnicity?: string;
  familyBackground?: string;
  height?: number;

  // character / middot (operator impression — informational, not scored)
  characterTraits?: string[];
  characterNotes?: string;

  // shared goals (informational + feeds mutual_expectations scoring)
  lifeGoals?: {
    childrenPreference?: ChildrenPreference;
    careerPriority?: CareerPriority;
    homeVision?: string;
  };

  // religious identity
  sectorGroup: SectorGroup;
  subSector?: SubSector;
  lifestyleTone?: LifestyleTone;
  religiousStyle?: ReligiousStyle;

  // personal
  personalStatus: PersonalStatus;
  numberOfChildren: number;
  lifeStage?: LifeStage;
  readinessForMarriage: ReadinessForMarriage;

  // study/work direction
  studyWorkDirection?: StudyWorkDirection;
  currentOccupation?: string;
  educationLevel?: string;
  educationInstitution?: string;
  torahStudyYears?: number;
  armyService?: string;

  // free text
  about?: string;
  whatSeeking?: string;
  referenceName?: string;
  referencePhone?: string;
  additionalInfo?: string;

  // preferences
  hardConstraints: Array<{
    field: string;
    operator: string;
    value: unknown;
    reason?: string;
  }>;
  softPreferences: Array<{
    field: string;
    value: unknown;
    importance: string;
    note?: string;
  }>;
  agePreferences?: {
    min?: number;
    max?: number;
    flexibility?: string;
  };
  locationPreferences?: {
    cities?: string[];
    regions?: string[];
    willingToRelocate?: boolean;
    maxDistanceKm?: number;
  };
  openness: {
    openToOtherSectors: boolean;
    openToConverts: boolean;
    /** Tri-state: true/false explicit, undefined = unknown. See opennessSchema. */
    openToDivorced?: boolean;
    openToWithChildren: boolean;
    openToAgeDifference: boolean;
    openToLongDistance: boolean;
  };

  // profile completion & send readiness
  profileCompletion: number;
  missingCriticalFields: string[];
  sendReadinessBlockers: string[];

  // quality scores (0-100)
  profileQualityScore?: number;
  dataReliabilityScore?: number;
  readinessScore?: number;

  // verification
  lastVerifiedAt?: Date;
  lastActionAt?: Date;

  // status
  status: CandidateStatus;

  // dating state
  datingPartnerCandidateId?: Types.ObjectId;
  datingStartedAt?: Date;
  datingSourceMatchId?: Types.ObjectId;

  // stats
  deferredSuggestionsCount: number;

  // closure
  closureReason?: ClosureReason;
  closureNote?: string;
  closedAt?: Date;
  closedBy?: Types.ObjectId;

  // AI enrichment (advisory only — never source of truth)
  aiEnrichment?: {
    summary?: string;
    personalityTraits?: string[];
    values?: string[];
    communicationStyle?: string;
    enrichedAt?: Date;
    enrichmentVersion?: string;
    provider?: string;
    model?: string;
  };

  // Multi-chunk embedding for semantic search.
  // Each chunk is independently indexed in Atlas and searched via $rankFusion.
  // Vectors are select:false — use select('+embedding.*.vector') to load them.
  embedding?: {
    modelId?:    string;
    provider?:   string;
    dimensions?: number;
    updatedAt?:  Date;
    religious?:    { vector?: number[]; textSnapshot?: string; embeddedAt?: Date };
    expectations?: { vector?: number[]; textSnapshot?: string; embeddedAt?: Date };
    personality?:  { vector?: number[]; textSnapshot?: string; embeddedAt?: Date };
    background?:   { vector?: number[]; textSnapshot?: string; embeddedAt?: Date };
  };

  // audit
  createdBy?: Types.ObjectId;
  // ownership — the shadchan currently responsible for this candidate
  ownerUserId?: Types.ObjectId;
  archivedAt?: Date;
  // Incremental match-scan change detection: hash of the engine-relevant
  // fields at last scan. The scan re-scores a candidate's pairs only when
  // this differs from the freshly-computed hash. See match-scan.service.
  scoringHash?: string;
  scoringHashAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const internalCandidateSchema = new Schema<IInternalCandidate>(
  {
    // ── Identity ──────────────────────────────────────────
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    gender: { type: String, enum: Object.values(Gender), required: true },
    dateOfBirth: { type: Date, required: true },
    hebrewName: { type: String, trim: true },
    fatherName: { type: String, trim: true },
    motherName: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    photoUrl: { type: String },
    photoApproved: { type: Boolean, default: false },
    photoStorageKey: { type: String },
    photoShareToken: { type: String },

    // ── Demographics ──────────────────────────────────────
    city: { type: String, trim: true },
    region: { type: String, enum: Object.values(Region) },
    neighborhood: { type: String, trim: true },
    originCity: { type: String, trim: true },
    originCountry: { type: String, trim: true },
    ethnicity: { type: String, trim: true },
    familyBackground: { type: String, maxlength: 2000 },
    height: { type: Number, min: 100, max: 220 },

    // ── Character / middot (informational) ────────────────
    characterTraits: { type: [String], default: undefined },
    characterNotes: { type: String, maxlength: 2000 },

    // ── Shared goals (informational + scored) ─────────────
    lifeGoals: {
      type: new Schema({
        childrenPreference: { type: String, enum: Object.values(ChildrenPreference) },
        careerPriority: { type: String, enum: Object.values(CareerPriority) },
        homeVision: { type: String, maxlength: 1000 },
      }, { _id: false }),
    },

    // ── Religious identity ────────────────────────────────
    sectorGroup: {
      type: String,
      enum: Object.values(SectorGroup),
      required: true,
    },
    subSector: { type: String, enum: Object.values(SubSector) },
    lifestyleTone: { type: String, enum: Object.values(LifestyleTone) },
    religiousStyle: { type: String, enum: Object.values(ReligiousStyle) },

    // ── Personal ──────────────────────────────────────────
    personalStatus: {
      type: String,
      enum: Object.values(PersonalStatus),
      required: true,
      default: PersonalStatus.SINGLE,
    },
    numberOfChildren: { type: Number, default: 0, min: 0 },
    lifeStage: { type: String, enum: Object.values(LifeStage) },
    readinessForMarriage: {
      type: String,
      enum: Object.values(ReadinessForMarriage),
      required: true,
    },

    // ── Study / Work direction ────────────────────────────
    studyWorkDirection: {
      type: String,
      enum: Object.values(StudyWorkDirection),
    },
    currentOccupation: { type: String, trim: true },
    educationLevel: { type: String, trim: true },
    educationInstitution: { type: String, trim: true },
    torahStudyYears: { type: Number, min: 0 },
    armyService: { type: String, trim: true },

    // ── Free text ─────────────────────────────────────────
    about: { type: String, maxlength: 2000 },
    whatSeeking: { type: String, maxlength: 2000 },
    referenceName: { type: String, trim: true },
    referencePhone: { type: String, trim: true },
    additionalInfo: { type: String, maxlength: 2000 },

    // ── Preferences ───────────────────────────────────────
    hardConstraints: { type: [hardConstraintSchema], default: [] },
    softPreferences: { type: [softPreferenceSchema], default: [] },
    agePreferences: { type: agePreferenceSchema },
    locationPreferences: { type: locationPreferenceSchema },
    openness: {
      type: opennessSchema,
      default: () => ({}),
    },

    // ── Profile completion & send readiness ────────────────
    profileCompletion: { type: Number, min: 0, max: 100, default: 0 },
    missingCriticalFields: { type: [String], default: [] },
    sendReadinessBlockers: { type: [String], default: [] },

    // ── Quality scores (0–100) ────────────────────────────
    profileQualityScore: { type: Number, min: 0, max: 100 },
    dataReliabilityScore: { type: Number, min: 0, max: 100 },
    readinessScore: { type: Number, min: 0, max: 100 },

    // ── Verification ──────────────────────────────────────
    lastVerifiedAt: { type: Date },
    lastActionAt: { type: Date },

    // ── Status ────────────────────────────────────────────
    status: {
      type: String,
      enum: Object.values(CandidateStatus),
      required: true,
      default: CandidateStatus.ACTIVE,
    },

    // ── Dating state ──────────────────────────────────────
    datingPartnerCandidateId: { type: Schema.Types.ObjectId },
    datingStartedAt: { type: Date },
    datingSourceMatchId: { type: Schema.Types.ObjectId, ref: 'MatchSuggestion' },

    // ── Stats ─────────────────────────────────────────────
    deferredSuggestionsCount: { type: Number, default: 0, min: 0 },

    // ── Closure ───────────────────────────────────────────
    closureReason: { type: String, enum: Object.values(ClosureReason) },
    closureNote: { type: String, maxlength: 1000 },
    closedAt: { type: Date },
    closedBy: { type: Schema.Types.ObjectId, ref: 'User' },

    // ── AI enrichment (advisory — never source of truth) ──
    aiEnrichment: { type: aiEnrichmentSchema },

    // ── Embedding ─────────────────────────────────────────
    embedding: { type: embeddingSchema },

    // ── Audit ─────────────────────────────────────────────
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    // ── Ownership ─────────────────────────────────────────
    ownerUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    archivedAt: { type: Date },

    // ── Match-scan change detection ───────────────────────
    scoringHash: { type: String },
    scoringHashAt: { type: Date },
  },
  {
    timestamps: true,
    collection: 'internalCandidates',
  },
);

// ── Indexes ─────────────────────────────────────────────

// Primary query patterns
internalCandidateSchema.index({ status: 1, gender: 1 });
internalCandidateSchema.index({ photoShareToken: 1 }, { unique: true, sparse: true });
internalCandidateSchema.index({ status: 1, sectorGroup: 1 });
internalCandidateSchema.index({ status: 1, city: 1 });
internalCandidateSchema.index({ gender: 1, sectorGroup: 1, status: 1 });

// Matching engine pre-filter: eligible candidates of opposite gender
internalCandidateSchema.index({ gender: 1, status: 1, readinessForMarriage: 1 });

// Date-based queries
internalCandidateSchema.index({ lastVerifiedAt: 1 });
internalCandidateSchema.index({ lastActionAt: 1 });
internalCandidateSchema.index({ createdAt: -1 });

// Dating lookups
internalCandidateSchema.index(
  { datingPartnerCandidateId: 1 },
  { sparse: true },
);

// Phone/email uniqueness — sparse so null values don't conflict
internalCandidateSchema.index({ phone: 1 }, { unique: true, sparse: true });
internalCandidateSchema.index({ email: 1 }, { unique: true, sparse: true });

// Text search on name
internalCandidateSchema.index({ firstName: 'text', lastName: 'text', hebrewName: 'text' });

export const InternalCandidate = mongoose.model<IInternalCandidate>(
  'InternalCandidate',
  internalCandidateSchema,
);
