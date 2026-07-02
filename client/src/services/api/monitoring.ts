import { api } from './client';

export interface MonitoringOverview {
  generatedAt: string;
  windowHours: number;
  whatsappSessions: Array<{
    channelId: string;
    role: string;
    status: string;
    connectionHealth: string;
    lastActivityAt?: string;
  }>;
  ingestion: {
    messagesLastHour: number;
    profilesDetected: number;
    profilesSkippedNoText: number;
    duplicatesDetected: number;
  };
  extraction: {
    successCount: number;
    failureCount: number;
    reviewQueueSize: number;
  };
  matching: {
    matchesCreated: number;
    blockedCount: number;
    overrideCount: number;
    avgScore: number | null;
  };
  communication: {
    proposalsSent: number;
    responsesReceived: number;
    acceptedCount: number;
    declinedCount: number;
    consideringCount: number;
  };
  risks: {
    duplicatePhoneEvents: number;
    notOwnerAttempts: number;
    alreadySendingErrors: number;
    forceMatchCount: number;
    sendBlockedSafeModeCount: number;
  };
  safeMode: {
    outboundEnabled: boolean;
    envEnabled: boolean;
    settingEnabled: boolean;
    reason?: string;
    requireExplicitMapping: boolean;
  };
  alerts: {
    highDuplicateRate: boolean;
    highReviewQueue: boolean;
    noResponses: boolean;
    manyNotOwnerAttempts: boolean;
    safeModeActive: boolean;
  };
}

export interface MonitoringEvent {
  type: 'MATCH_CREATED' | 'PROPOSAL_SENT' | 'RESPONSE_DETECTED' | 'FORCE_MATCH' | 'SEND_BLOCKED' | 'ERROR';
  timestamp: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

// ── AI usage / cost report (admin-only) ──────────────────

export interface AiUsageBucket {
  requests: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
  unpricedRequests: number;
}

export interface AiUsageReport {
  days: number;
  totals: AiUsageBucket;
  byModel: Array<AiUsageBucket & { provider: string; model: string }>;
  byRequestType: Array<AiUsageBucket & { requestType: string }>;
  byDay: Array<AiUsageBucket & { day: string }>;
  budget: { limit: number; usedToday: number; day: string };
}

export const monitoringApi = {
  overview: (windowHours = 24) =>
    api.get<MonitoringOverview>('/monitoring/overview', { windowHours }),
  events: (limit = 100) =>
    api.get<MonitoringEvent[]>('/monitoring/events', { limit }),
  aiUsage: (days = 30) =>
    api.get<AiUsageReport>('/monitoring/ai-usage', { days }),
};
