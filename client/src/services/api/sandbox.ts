// ═══════════════════════════════════════════════════════════
// Client API — "בדוק מועמדים" (ad-hoc free-text pair check).
// Mirrors server SandboxCheckResult (matches/sandbox.service.ts).
// ═══════════════════════════════════════════════════════════

import { api } from './client';

export interface ExtractedProfileDTO {
  firstName?: string;
  lastName?: string;
  gender?: 'male' | 'female';
  age?: number;
  height?: number;
  city?: string;
  edah?: string;
  sectorGroup?: string;
  religiousLevelText?: string;
  personalStatus?: string;
  occupation?: string;
  about?: string;
  family?: string;
  service?: string;
  yeshiva?: string;
  whatSeeking?: string;
  seekingAgeMin?: number;
  seekingAgeMax?: number;
  contactPhones?: string[];
}

export interface SandboxDimension {
  dimension: string;
  score: number;
  weight: number;
  weightedScore: number;
  detail: string;
}

export interface SandboxEngine {
  eligible: boolean;
  blockers: Array<{ code: string; message: string; overridable?: string }>;
  matchScore: number;
  rawScore: number;
  confidenceScore: number;
  matchType: 'safe' | 'balanced' | 'creative' | 'risky';
  riskLevel: 'none' | 'low' | 'medium' | 'high';
  scoreBreakdown: SandboxDimension[];
  strengths: string[];
  attentionPoints: string[];
  overrideReasons: string[];
  recommendedAction: string;
  semanticSimilarityScore?: number;
}

export type ChunkType = 'religious' | 'expectations' | 'personality' | 'background';

export interface SandboxSemantic {
  enabled: boolean;
  score?: number;
  perChunk?: Partial<Record<ChunkType, number>>;
}

export interface SandboxAI {
  summary: string;
  strengths: string[];
  concerns: string[];
  nuance: string;
  recommendedApproach: string;
  notMatchReasons: string[];
  provider?: string;
}

export interface SandboxSide {
  profile: ExtractedProfileDTO;
  extractionConfidence: number;
  usedAI: boolean;
}

export interface SandboxCheckResult {
  engine: SandboxEngine;
  semantic: SandboxSemantic;
  ai?: SandboxAI;
  sides: { a: SandboxSide; b: SandboxSide };
  warnings: string[];
}

export const sandboxApi = {
  check: (body: { sideA: string; sideB: string; mode?: 'strict' | 'discovery' }) =>
    api.post<SandboxCheckResult>('/matches/sandbox-check', body),
};
