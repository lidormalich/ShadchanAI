import mongoose, { Schema, Document, Types } from 'mongoose';
import { buildIdentityKey } from '../../utils/identity.js';
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
  ExternalCandidateStatus,
  ExternalSourceType,
  AvailabilityStatus,
  ShareCardPhotoMode,
  AgeConfidence,
  Region,
  ChildrenPreference,
  CareerPriority,
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

// ── Multi-chunk embedding schema ──────────────────────────
// Identical structure to InternalCandidate — see that file for comments.
// External profiles are often partial, so more chunks may be absent.

const embeddingChunkSchema = new Schema(
  {
    vector:       { type: [Number], select: false },
    textSnapshot: { type: String,   select: false },
    embeddedAt:   { type: Date },
  },
  { _id: false },
);

const embeddingSchema = new Schema(
  {
    modelId:    { type: String },
    provider:   { type: String },
    dimensions: { type: Number },
    updatedAt:  { type: Date },
    religious:    { type: embeddingChunkSchema },
    expectations: { type: embeddingChunkSchema },
    personality:  { type: embeddingChunkSchema },
    background:   { type: embeddingChunkSchema },
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
    // Approved by default — the share card is editable/previewable in the
    // drawer, so we don't block sending behind a manual approval step.
    approvedForShare: { type: Boolean, default: true },
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
  // WhatsApp provenance: which group the profile was posted in, and the
  // ACTUAL sender (poster) — distinct from the profile's inquiry phone.
  sourceChatJid?: string;
  sourceGroupName?: string;
  sourceSenderName?: string;
  sourceSenderPhone?: string;
  sourceImportedAt: Date;
  lastSourceUpdateAt?: Date;
  // Contact phone as originally extracted from the profile card text
  // (may still carry dashes/spaces/country prefix variance).
  contactPhone?: string;
  // Canonical E.164-shape phone ("+972501234567") derived at write time.
  // This is the authoritative lookup key for duplicate detection.
  contactPhoneNormalized?: string;
  // EVERY phone number known for this candidate — the card's primary
  // phone plus numbers arriving from merged duplicate cards and manual
  // additions. Merges union into this list instead of discarding the
  // losing card's differing number. Each entry may carry a label
  // ("אמא", "שדכנית"...) and a source tag; deduped by normalized form.
  phones?: Array<{ number: string; normalized?: string; label?: string; source?: string }>;
  // Every Message._id that contributed to this candidate (first import
  // + re-posts). Enables the "view source messages" action on a candidate.
  sourceMessageIds?: Types.ObjectId[];

  // profile data (may be partial — comes from external sources)
  // NOTE: external mirrors the internal candidate's PROFILE field set —
  // same profile, different source. Only age (vs DOB) and the source/
  // availability/sharing metadata are external-specific.
  firstName?: string;
  lastName?: string;
  hebrewName?: string;
  fatherName?: string;
  motherName?: string;
  email?: string;
  gender?: Gender;
  age?: number;

  // demographics
  city?: string;
  region?: Region;
  neighborhood?: string;
  originCity?: string;
  originCountry?: string;
  ethnicity?: string;
  familyBackground?: string;
  height?: number;

  // religious identity
  sectorGroup?: SectorGroup;
  subSector?: SubSector;
  lifestyleTone?: LifestyleTone;
  religiousStyle?: ReligiousStyle;

  // personal
  personalStatus?: PersonalStatus;
  numberOfChildren?: number;
  lifeStage?: LifeStage;
  readinessForMarriage?: ReadinessForMarriage;

  // study / work
  studyWorkDirection?: StudyWorkDirection;
  // What they currently do (free text — "מהנדס תוכנה" / "לומד בישיבת X").
  // Informational only, never scored. Extracted from the card or typed.
  currentOccupation?: string;
  educationLevel?: string;
  educationInstitution?: string;
  torahStudyYears?: number;
  armyService?: string;

  // character / middot (informational, not scored)
  characterTraits?: string[];
  characterNotes?: string;

  // shared goals (informational + feeds mutual_expectations scoring)
  lifeGoals?: {
    childrenPreference?: ChildrenPreference;
    careerPriority?: CareerPriority;
    homeVision?: string;
  };

  // free text
  about?: string;
  whatSeeking?: string;
  additionalInfo?: string;
  referenceName?: string;
  referencePhone?: string;
  photoUrl?: string;
  // Exact R2 object key the photo lives at (e.g. review/external/<id>.jpg).
  // Persisted so serving/reconcile never has to guess folder or extension.
  photoStorageKey?: string;
  // Unguessable token for the PUBLIC (no-auth) photo link. Random, stable per
  // candidate, revocable by regenerating. Absent until a share link is created.
  photoShareToken?: string;

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

  // data-quality workflow: set when the operator pressed "מולא" on the
  // needs-details tab — everything knowable was filled in. Manual,
  // one-way marker; the tab filter excludes candidates that carry it.
  detailsCompletedAt?: Date;

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

  // Multi-chunk embedding for semantic search.
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
  importedBy?: Types.ObjectId;
  // ownership — the shadchan currently responsible for this external candidate
  ownerUserId?: Types.ObjectId;
  archivedAt?: Date;
  // Incremental match-scan change detection: hash of the engine-relevant
  // fields at last scan. The scan re-scores a candidate's pairs only when
  // this differs from the freshly-computed hash. See match-scan.service.
  scoringHash?: string;
  scoringHashAt?: Date;
  // Deterministic name+age identity key (see utils/identity). Maintained by
  // the pre-save hook; a partial unique index on it makes the concurrent-
  // repost race unable to mint a second identical candidate.
  identityKey?: string;
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
    sourceChatJid: { type: String, trim: true },
    sourceGroupName: { type: String, trim: true },
    sourceSenderName: { type: String, trim: true },
    sourceSenderPhone: { type: String, trim: true },
    sourceImportedAt: { type: Date, required: true, default: Date.now },
    lastSourceUpdateAt: { type: Date },
    contactPhone: { type: String, trim: true },
    contactPhoneNormalized: { type: String, trim: true, index: true, sparse: true },
    phones: {
      type: [new Schema({
        number: { type: String, required: true, trim: true },
        normalized: { type: String, trim: true },
        label: { type: String, trim: true, maxlength: 120 },
        source: { type: String, trim: true, maxlength: 40 },
      }, { _id: false })],
      default: undefined,
    },
    sourceMessageIds: [{ type: Schema.Types.ObjectId, ref: 'Message' }],

    // ── Profile data (may be partial) — mirrors internal profile ──
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    hebrewName: { type: String, trim: true },
    fatherName: { type: String, trim: true },
    motherName: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    gender: { type: String, enum: Object.values(Gender) },
    age: { type: Number, min: 16, max: 120 },

    // demographics
    city: { type: String, trim: true },
    region: { type: String, enum: Object.values(Region) },
    neighborhood: { type: String, trim: true },
    originCity: { type: String, trim: true },
    originCountry: { type: String, trim: true },
    ethnicity: { type: String, trim: true },
    familyBackground: { type: String, maxlength: 2000 },
    height: { type: Number, min: 100, max: 220 },

    // religious identity
    sectorGroup: { type: String, enum: Object.values(SectorGroup) },
    subSector: { type: String, enum: Object.values(SubSector) },
    lifestyleTone: { type: String, enum: Object.values(LifestyleTone) },
    religiousStyle: { type: String, enum: Object.values(ReligiousStyle) },

    // personal
    personalStatus: { type: String, enum: Object.values(PersonalStatus) },
    numberOfChildren: { type: Number, min: 0 },
    lifeStage: { type: String, enum: Object.values(LifeStage) },
    readinessForMarriage: { type: String, enum: Object.values(ReadinessForMarriage) },

    // study / work
    studyWorkDirection: {
      type: String,
      enum: Object.values(StudyWorkDirection),
    },
    currentOccupation: { type: String, trim: true, maxlength: 200 },
    educationLevel: { type: String, trim: true },
    educationInstitution: { type: String, trim: true },
    torahStudyYears: { type: Number, min: 0 },
    armyService: { type: String, trim: true },

    // character / middot (informational)
    characterTraits: { type: [String], default: undefined },
    characterNotes: { type: String, maxlength: 2000 },

    // shared goals (informational + scored)
    lifeGoals: {
      type: new Schema({
        childrenPreference: { type: String, enum: Object.values(ChildrenPreference) },
        careerPriority: { type: String, enum: Object.values(CareerPriority) },
        homeVision: { type: String, maxlength: 1000 },
      }, { _id: false }),
    },

    // free text
    about: { type: String, maxlength: 2000 },
    whatSeeking: { type: String, maxlength: 2000 },
    additionalInfo: { type: String, maxlength: 2000 },
    referenceName: { type: String, trim: true },
    referencePhone: { type: String, trim: true },
    photoUrl: { type: String },
    photoStorageKey: { type: String },
    photoShareToken: { type: String },

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
      default: () => ({ approvedForShare: true }),
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

    // ── Data-quality workflow ─────────────────────────────
    detailsCompletedAt: { type: Date },

    // ── Raw source data ───────────────────────────────────
    rawSourcePayload: { type: Schema.Types.Mixed },

    // ── AI enrichment ─────────────────────────────────────
    aiEnrichment: { type: aiEnrichmentSchema },

    // ── Embedding ─────────────────────────────────────────
    embedding: { type: embeddingSchema },

    // ── Audit ─────────────────────────────────────────────
    importedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    // ── Ownership ─────────────────────────────────────────
    ownerUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    archivedAt: { type: Date },

    // ── Match-scan change detection ───────────────────────
    scoringHash: { type: String },
    scoringHashAt: { type: Date },

    // ── Duplicate-guard identity key (name+age, hook-maintained) ──
    identityKey: { type: String },
  },
  {
    timestamps: true,
    collection: 'externalCandidates',
  },
);

// ── Indexes ─────────────────────────────────────────────

externalCandidateSchema.index({ status: 1, gender: 1 });
// Match-scan filter: { gender, status, availabilityStatus: { $in: [...] } }
externalCandidateSchema.index({ status: 1, gender: 1, availabilityStatus: 1 });
externalCandidateSchema.index({ status: 1, sectorGroup: 1 });
// Dedup external-system imports by (sourceType, sourceExternalId) — but ONLY
// when sourceExternalId is present. A plain `sparse` compound index does NOT
// work here: sourceType is always set, so manual/whatsapp candidates (which
// have no sourceExternalId) all collide on {sourceType, null}, allowing only
// ONE such candidate. A partial index keyed on sourceExternalId existence
// enforces uniqueness only for real source ids.
externalCandidateSchema.index(
  { sourceType: 1, sourceExternalId: 1 },
  { unique: true, partialFilterExpression: { sourceExternalId: { $exists: true } } },
);
externalCandidateSchema.index({ sourceChannelId: 1 }, { sparse: true });
externalCandidateSchema.index({ contactPhone: 1 }, { sparse: true });
externalCandidateSchema.index({ photoShareToken: 1 }, { unique: true, sparse: true });
externalCandidateSchema.index({ availabilityStatus: 1 });
externalCandidateSchema.index({ staleAt: 1 }, { sparse: true });
externalCandidateSchema.index({ lastSourceUpdateAt: 1 });
externalCandidateSchema.index({ createdAt: -1 });

// Text search
externalCandidateSchema.index({ firstName: 'text', lastName: 'text', sourceName: 'text' });

// ── Duplicate guard ──────────────────────────────────────
// Keep identityKey (normalized firstName|lastName|age) in sync on every save,
// so the create paths and manual edits all carry it. Cleared when the profile
// no longer has all three parts, so an incomplete card is never constrained.
externalCandidateSchema.pre('save', function (next) {
  // Archived candidates must NOT carry an identityKey: they'd occupy the unique
  // partial index and block re-creating a person after their old card was
  // archived. (We can't express "exclude archived" in the partial filter —
  // Mongo forbids $exists:false there — so we exclude them by clearing the key.)
  const key = this.archivedAt ? undefined : buildIdentityKey(this.firstName, this.lastName, this.age);
  if (key) this.identityKey = key;
  else this.set('identityKey', undefined);
  next();
});

// A profile re-posted 2-3× in the same burst used to race past the matcher's
// check-then-create (all copies read "no existing candidate" before any wrote)
// and mint identical twins. This partial unique index makes that impossible at
// the DB level: the 2nd/3rd concurrent create throws E11000, which the
// orchestrator turns into a link-to-existing. Excludes archived candidates so a
// genuinely re-available person can be re-created after their old card was
// archived. Only covers documents that actually HAVE a key (name+age present).
externalCandidateSchema.index(
  { identityKey: 1 },
  {
    unique: true,
    // Only `$exists:true` is allowed here (Mongo forbids $exists:false in
    // partial indexes). Archived candidates are kept OUT of this index by the
    // pre-save hook clearing their identityKey — see above.
    partialFilterExpression: { identityKey: { $exists: true } },
  },
);

export const ExternalCandidate = mongoose.model<IExternalCandidate>(
  'ExternalCandidate',
  externalCandidateSchema,
);
