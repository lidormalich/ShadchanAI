import { api } from './client';
import type { AskAIResult, ExternalCandidate, InternalCandidate } from '@/types/domain';

// Compact candidate payload for the AI API. Keep this lean so AI
// requests stay under the backend's prompt length cap. Optional
// fields (age, profileCompletion, …) are included only when the
// candidate carries them, so the same helper serves internal and
// external candidates.
export function buildCandidateBrief(c: InternalCandidate | ExternalCandidate) {
  const brief: Record<string, unknown> = {
    id: c._id,
    firstName: c.firstName,
    lastName: c.lastName,
    gender: c.gender,
    city: c.city,
    sectorGroup: c.sectorGroup,
    subSector: c.subSector,
    lifestyleTone: c.lifestyleTone,
    personalStatus: c.personalStatus,
    lifeStage: c.lifeStage,
    studyWorkDirection: c.studyWorkDirection,
    about: c.about,
    whatSeeking: c.whatSeeking,
  };
  if ('age' in c && c.age != null) brief['age'] = c.age;
  if ('profileCompletion' in c) brief['profileCompletion'] = c.profileCompletion;
  if ('missingCriticalFields' in c) brief['missingCriticalFields'] = c.missingCriticalFields;
  return brief;
}

// The unified superset the AI lifts out of a free-text candidate card.
// Mirrors the server's ProfileExtractionSchema. One shape for both the
// internal and external intake forms — each form maps the fields it
// needs. Every field is optional: a missing value means "not confident".
export interface ProfileExtraction {
  confidence: number;
  warnings: string[];
  // identity
  firstName?: string;
  lastName?: string;
  hebrewName?: string;
  gender?: 'male' | 'female';
  age?: number;
  dateOfBirth?: string;
  height?: number;
  city?: string;
  neighborhood?: string;
  ethnicity?: string;
  // contact
  candidatePhone?: string;
  contactName?: string;
  contactPhone?: string;
  // religious identity
  sectorGroup?: string;
  subSector?: string;
  lifestyleTone?: string;
  religiousStyle?: string;
  religiousLevelText?: string;
  // status & stage
  personalStatus?: string;
  numberOfChildren?: number;
  lifeStage?: string;
  readinessForMarriage?: string;
  // study / work
  studyWorkDirection?: string;
  currentOccupation?: string;
  educationLevel?: string;
  educationInstitution?: string;
  armyService?: string;
  // misc card fields (no dedicated column → additionalInfo)
  headCovering?: string;
  smoking?: string;
  // free text
  about?: string;
  whatSeeking?: string;
  familyBackground?: string;
  // preferences
  seekingAgeMin?: number;
  seekingAgeMax?: number;
  openToOtherSectors?: boolean;
  openToConverts?: boolean;
  openToDivorced?: boolean;
  openToWithChildren?: boolean;
  openToAgeDifference?: boolean;
  openToLongDistance?: boolean;
}

export const aiApi = {
  explainMatch: (body: Record<string, unknown>) =>
    api.post<Record<string, unknown>>('/ai/explain-match', body),
  summarizeCandidate: (body: Record<string, unknown>) =>
    api.post<Record<string, unknown>>('/ai/summarize-candidate', body),
  classifyMessage: (body: { text: string; context?: Record<string, unknown> }) =>
    api.post<Record<string, unknown>>('/ai/classify-message', body),
  suggestNextStep: (body: Record<string, unknown>) =>
    api.post<Record<string, unknown>>('/ai/suggest-next-step', body),
  generateMessage: (body: Record<string, unknown>) =>
    api.post<Record<string, unknown>>('/ai/generate-message', body),
  ask: (body: { query: string; forceIntent?: string }) =>
    api.post<AskAIResult>('/ai/ask', body),
  extractProfile: (body: { text: string; target: 'internal' | 'external' }) =>
    api.post<ProfileExtraction>('/ai/extract-profile', body),
};
