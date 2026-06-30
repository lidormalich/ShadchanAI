// ═══════════════════════════════════════════════════════════
// Global search service (Phase 5).
//
// Compact, actionable results across the operator's main domains.
// Uses straightforward case-insensitive regex against already-
// indexed fields — no new collections, no query-plan surprises.
// Each result carries an explicit route into the surface where
// the operator can act on it.
// ═══════════════════════════════════════════════════════════

import {
  InternalCandidate,
  ExternalCandidate,
  MatchSuggestion,
  Conversation,
  Task,
} from '../../models/index.js';
import type { SearchQuery } from './search.validator.js';

type ResultKind =
  | 'internal_candidate'
  | 'external_candidate'
  | 'match'
  | 'conversation'
  | 'task';

export interface SearchResult {
  type: ResultKind;
  id: string;
  title: string;
  subtitle?: string;
  route: string;
}

// Escape regex special chars so e.g. "(" doesn't throw.
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function search(query: SearchQuery): Promise<SearchResult[]> {
  const { q, limit } = query;
  const rx = new RegExp(escapeRegex(q), 'i');
  const per = Math.max(3, Math.floor(limit / 5));

  const [internals, externals, matches, conversations, tasks] = await Promise.all([
    InternalCandidate.find({
      archivedAt: { $exists: false },
      $or: [
        { firstName: rx }, { lastName: rx }, { hebrewName: rx },
        { city: rx }, { phone: rx }, { email: rx },
      ],
    }).select('_id firstName lastName city status').limit(per).lean().exec(),

    ExternalCandidate.find({
      archivedAt: { $exists: false },
      $or: [
        { firstName: rx }, { lastName: rx },
        { city: rx }, { contactPhone: rx },
      ],
    }).select('_id firstName lastName city availabilityStatus').limit(per).lean().exec(),

    // Match text search is thin — titles are derived, so we match
    // by status/matchType string fallback. Restricted to non-closed.
    MatchSuggestion.find({
      status: { $nin: ['closed', 'expired'] },
      $or: [{ matchType: rx }, { status: rx }],
    }).select('_id matchType status matchScore').limit(per).lean().exec(),

    Conversation.find({
      isActive: true,
      $or: [{ participantName: rx }, { accountDisplayName: rx }, { participantPhone: rx }],
    }).select('_id participantName accountDisplayName channelRole').limit(per).lean().exec(),

    Task.find({
      $or: [{ title: rx }, { description: rx }],
    }).select('_id title status priority').limit(per).lean().exec(),
  ]);

  const results: SearchResult[] = [];

  for (const c of internals) {
    results.push({
      type: 'internal_candidate',
      id: String(c._id),
      title: `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || 'מועמד פנימי',
      subtitle: [c.city, c.status].filter(Boolean).join(' · '),
      route: `/candidates/internal/${String(c._id)}`,
    });
  }
  for (const c of externals) {
    results.push({
      type: 'external_candidate',
      id: String(c._id),
      title: `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || 'מועמד חיצוני',
      subtitle: [c.city, c.availabilityStatus].filter(Boolean).join(' · '),
      route: `/candidates/external?id=${String(c._id)}`,
    });
  }
  for (const m of matches) {
    results.push({
      type: 'match',
      id: String(m._id),
      title: `הצעה ${m.matchType} · ציון ${m.matchScore}`,
      subtitle: m.status,
      route: `/matches/${String(m._id)}`,
    });
  }
  for (const c of conversations) {
    results.push({
      type: 'conversation',
      id: String(c._id),
      title: c.participantName ?? 'שיחה',
      subtitle: [c.accountDisplayName, c.channelRole].filter(Boolean).join(' · '),
      route: `/chats?conversation=${String(c._id)}`,
    });
  }
  for (const t of tasks) {
    results.push({
      type: 'task',
      id: String(t._id),
      title: t.title,
      subtitle: [t.priority, t.status].filter(Boolean).join(' · '),
      route: '/tasks',
    });
  }

  return results.slice(0, limit);
}
