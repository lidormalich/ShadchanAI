import mongoose, { Schema, Document, Types } from 'mongoose';
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

// ── Sub-schemas ───────────────────────────────────────────

const aiEnrichmentSchema = new Schema(
  {
    summary: { type: String },
    personalityTraits: [{ type: String }],
    values: [{ type: String }],
    classifiedSector: { type: String },
    classifiedSubSector: { type: String },
    enrichedAt: { type: Date },
    enrichmentVersion: { type: String },
    provider: { type: String },
    model: { type: String },
  },
  { _id: false },
);

const embeddingSchema = new Schema(
  {
    vector: { type: [Number], select: false },
    modelId: { type: String },
    version: { type: String },
    provider: { type: String },
    dimensions: { type: Number },
    updatedAt: { type: Date },
  },
  { _id: false },
);

const shareCardSchema = new Schema(
  {
    title: { type: String, trim: true },
    summary: { type: String, maxlength: 1000 },
    visibleFields: [{ type: String }],
    photoMode: {
      type: String,
      enum: Object.values(ShareCardPhotoMode),
      default: ShareCardPhotoMode.NONE,
    },
    approvedForShare: { type: Boolean, default: false },
    lastReviewedAt: { type: Date },
  },
  { _id: false },
);

const ageReliabilitySchema = new Schema(
  {
    reportedAgeAt: { type: Date },
    ageConfidence: {
      type: String,
      enum: Object.values(AgeConfidence),
      default: AgeConfidence.UNKNOWN,
    },
    approximateBirthYear: { type: Number },
  },
  { _id: false },
);

// ── Interface ─────────────────────────────────────────────

export interface IExternalCandidate extends Document {
  // source identity
  sourceType: ExternalSourceType;
  sourceName?: string;
  sourceExternalId?: string;
  sourceMatchmakerName?: string;
  sourceChannelId?: string;
  sourceImportedAt: Date;
  lastSourceUpdateAt?: Date;
  // Contact phone (normalized Israeli format, no separators). Populated
  // by the extraction pipeline from the profile card text. Used as the
  // primary lookup key when deciding "is this the same candidate?".
  contactPhone?: string;
  // Every Message._id that contributed to this candidate (first import
  // + re-posts). Enables the "view source messages" action on a candidate.
  sourceMessageIds?: Types.ObjectId[];

  // profile data (may be partial — comes from external sources)
  firstName?: string;
  lastName?: string;
  gender?: Gender;
  age?: number;
  city?: string;
  sectorGroup?: SectorGroup;
  subSector?: SubSector;
  lifestyleTone?: LifestyleTone;
  personalStatus?: PersonalStatus;
  lifeStage?: LifeStage;
  studyWorkDirection?: StudyWorkDirection;
  height?: number;
  about?: string;
  whatSeeking?: string;
  photoUrl?: string;

  // sharing permissions
  sharePhoto: boolean;
  shareCard: {
    title?: string;
    summary?: string;
    visibleFields?: string[];
    photoMode?: ShareCardPhotoMode;
    approvedForShare: boolean;
    lastReviewedAt?: Date;
  };

  // availability
  availabilityStatus: AvailabilityStatus;
  status: ExternalCandidateStatus;

  // age reliability
  ageReliability?: {
    reportedAgeAt?: Date;
    ageConfidence?: AgeConfidence;
    approximateBirthYear?: number;
  };

  // stale tracking
  staleAt?: Date;
  staleReason?: string;
  lastConfirmedAvailableAt?: Date;

  // preferences — OPTIONAL on external side (often partial data)
  // Present when the external source supplied them (e.g., a referring
  // shadchan's notes). Used for bidirectional matching: the engine
  // evaluates "A fits B" AND "B fits A", so external preferences,
  // when known, are applied as hard rules + soft scoring on the
  // reverse direction.
  hardConstraints?: Array<{
    field: string;
    operator: string;
    value: unknown;
    reason?: string;
  }>;
  softPreferences?: Array<{
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
  openness?: {
    openToOtherSectors?: boolean;
    openToConverts?: boolean;
    openToDivorced?: boolean;
    openToWithChildren?: boolean;
    openToAgeDifference?: boolean;
    openToLongDistance?: boolean;
  };

  // raw source data (preserved as-is for audit)
  rawSourcePayload?: Record<string, unknown>;

  // AI enrichment
  aiEnrichment?: {
    summary?: string;
    personalityTraits?: string[];
    values?: string[];
    classifiedSector?: string;
    classifiedSubSector?: string;
    enrichedAt?: Date;
    enrichmentVersion?: string;
    provider?: string;
    model?: string;
  };

  // embedding
  embedding?: {
    vector?: number[];
    modelId?: string;
    version?: string;
    provider?: string;
    dimensions?: number;
    updatedAt?: Date;
  };

  // audit
  importedBy?: Types.ObjectId;
  archivedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// ── Schema ────────────────────────────────────────────────

const externalCandidateSchema = new Schema<IExternalCandidate>(
  {
    // ── Source identity ────────────────────────────────────
    sourceType: {
      type: String,
      enum: Object.values(ExternalSourceType),
      required: true,
    },
    sourceName: { type: String, trim: true },
    sourceExternalId: { type: String, trim: true },
    sourceMatchmakerName: { type: String, trim: true },
    sourceChannelId: { type: String, trim: true },
    sourceImportedAt: { type: Date, required: true, default: Date.now },
    lastSourceUpdateAt: { type: Date },
    contactPhone: { type: String, trim: true },
    sourceMessageIds: [{ type: Schema.Types.ObjectId, ref: 'Message' }],

    // ── Profile data (may be partial) ─────────────────────
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    gender: { type: String, enum: Object.values(Gender) },
    age: { type: Number, min: 18, max: 120 },
    city: { type: String, trim: true },
    sectorGroup: { type: String, enum: Object.values(SectorGroup) },
    subSector: { type: String, enum: Object.values(SubSector) },
    lifestyleTone: { type: String, enum: Object.values(LifestyleTone) },
    personalStatus: { type: String, enum: Object.values(PersonalStatus) },
    lifeStage: { type: String, enum: Object.values(LifeStage) },
    studyWorkDirection: {
      type: String,
      enum: Object.values(StudyWorkDirection),
    },
    height: { type: Number, min: 100, max: 220 },
    about: { type: String, maxlength: 2000 },
    whatSeeking: { type: String, maxlength: 2000 },
    photoUrl: { type: String },

    // ── Preferences (optional — bidirectional matching) ───
    hardConstraints: {
      type: [{
        field: { type: String, required: true },
        operator: { type: String, required: true },
        value: { type: Schema.Types.Mixed, required: true },
        reason: { type: String },
      }],
      default: undefined,
      _id: false,
    },
    softPreferences: {
      type: [{
        field: { type: String, required: true },
        value: { type: Schema.Types.Mixed, required: true },
        importance: { type: String, required: true },
        note: { type: String },
      }],
      default: undefined,
      _id: false,
    },
    agePreferences: {
      type: new Schema({
        min: { type: Number },
        max: { type: Number },
        flexibility: { type: String },
      }, { _id: false }),
    },
    locationPreferences: {
      type: new Schema({
        cities: [{ type: String }],
        regions: [{ type: String }],
        willingToRelocate: { type: Boolean },
        maxDistanceKm: { type: Number },
      }, { _id: false }),
    },
    openness: {
      type: new Schema({
        openToOtherSectors: { type: Boolean },
        openToConverts: { type: Boolean },
        openToDivorced: { type: Boolean },
        openToWithChildren: { type: Boolean },
        openToAgeDifference: { type: Boolean },
        openToLongDistance: { type: Boolean },
      }, { _id: false }),
    },

    // ── Sharing permissions ───────────────────────────────
    sharePhoto: { type: Boolean, default: false },
    shareCard: {
      type: shareCardSchema,
      default: () => ({ approvedForShare: false }),
    },

    // ── Availability ──────────────────────────────────────
    availabilityStatus: {
      type: String,
      enum: Object.values(AvailabilityStatus),
      default: AvailabilityStatus.UNKNOWN,
    },
    status: {
      type: String,
      enum: Object.values(ExternalCandidateStatus),
      required: true,
      default: ExternalCandidateStatus.ACTIVE,
    },

    // ── Age reliability ────────────────────────────────────
    ageReliability: { type: ageReliabilitySchema },

    // ── Stale tracking ────────────────────────────────────
    staleAt: { type: Date },
    staleReason: { type: String },
    lastConfirmedAvailableAt: { type: Date },

    // ── Raw source data ───────────────────────────────────
    rawSourcePayload: { type: Schema.Types.Mixed },

    // ── AI enrichment ─────────────────────────────────────
    aiEnrichment: { type: aiEnrichmentSchema },

    // ── Embedding ─────────────────────────────────────────
    embedding: { type: embeddingSchema },

    // ── Audit ─────────────────────────────────────────────
    importedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    archivedAt: { type: Date },
  },
  {
    timestamps: true,
    collection: 'externalCandidates',
  },
);

// ── Indexes ─────────────────────────────────────────────

externalCandidateSchema.index({ status: 1, gender: 1 });
externalCandidateSchema.index({ status: 1, sectorGroup: 1 });
externalCandidateSchema.index({ sourceType: 1, sourceExternalId: 1 }, { unique: true, sparse: true });
externalCandidateSchema.index({ sourceChannelId: 1 }, { sparse: true });
externalCandidateSchema.index({ contactPhone: 1 }, { sparse: true });
externalCandidateSchema.index({ availabilityStatus: 1 });
externalCandidateSchema.index({ staleAt: 1 }, { sparse: true });
externalCandidateSchema.index({ lastSourceUpdateAt: 1 });
externalCandidateSchema.index({ createdAt: -1 });

// Text search
externalCandidateSchema.index({ firstName: 'text', lastName: 'text', sourceName: 'text' });

export const ExternalCandidate = mongoose.model<IExternalCandidate>(
  'ExternalCandidate',
  externalCandidateSchema,
);
