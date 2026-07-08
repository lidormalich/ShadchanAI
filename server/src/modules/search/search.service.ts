// ═══════════════════════════════════════════════════════════
// Global search service (Phase 5).
//
// Compact, actionable results across the operator's main domains.
// Uses straightforward case-insensitive regex against already-
// indexed fields — no new collections, no query-plan surprises.
// Each result carries an explicit route into the surface where
// the operator can act on it.
// ═══════════════════════════════════════════════════════════

import { MessageExtractionStatus } from '@shadchanai/shared';
import {
  InternalCandidate,
  ExternalCandidate,
  MatchSuggestion,
  Conversation,
  Task,
  Message,
} from '../../models/index.js';
import type { SearchQuery } from './search.validator.js';

type ResultKind =
  | 'internal_candidate'
  | 'external_candidate'
  | 'pending_review'
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

// Multi-word match: split the query into words and require EACH word to hit at
// least one of the given fields (AND across words, OR across fields). Without
// this, a full "first last" name (e.g. "אפרת חנימוב") was regex-tested as one
// string against each field individually — and since firstName holds only
// "אפרת" and lastName only "חנימוב", it matched NOTHING. Returns a `$and`
// clause (or {} for an empty query) to spread into the collection filter.
export function wordsMatch(q: string, fields: string[]): Record<string, unknown> {
  const terms = q.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return {};
  return {
    $and: terms.map((t) => {
      const rx = new RegExp(escapeRegex(t), 'i');
      return { $or: fields.map((f) => ({ [f]: rx })) };
    }),
  };
}

export async function search(query: SearchQuery): Promise<SearchResult[]> {
  const { q, limit } = query;
  const per = Math.max(3, Math.floor(limit / 5));

  const [internals, externals, pendingReviews, matches, conversations, tasks] = await Promise.all([
    InternalCandidate.find({
      archivedAt: { $exists: false },
      ...wordsMatch(q, ['firstName', 'lastName', 'hebrewName', 'city', 'phone', 'email']),
    }).select('_id firstName lastName city status').limit(per).lean().exec(),

    ExternalCandidate.find({
      archivedAt: { $exists: false },
      ...wordsMatch(q, ['firstName', 'lastName', 'hebrewName', 'sourceName', 'city', 'contactPhone']),
    }).select('_id firstName lastName city availabilityStatus').limit(per).lean().exec(),

    // Profiles still awaiting review (no ExternalCandidate yet) — so a person
    // stuck in the review queue is still findable, tagged "ממתין לסקירה" with
    // the reason, linking straight into their review card.
    Message.find({
      'extraction.status': MessageExtractionStatus.NEEDS_REVIEW,
      ...wordsMatch(q, [
        'extraction.extractedProfile.firstName',
        'extraction.extractedProfile.lastName',
        'body',
        'mediaCaption',
      ]),
    }).select('_id extraction.extractedProfile extraction.reviewReason body mediaCaption').limit(per).lean().exec(),

    // Match text search is thin — titles are derived, so we match
    // by status/matchType string fallback. Restricted to non-closed.
    MatchSuggestion.find({
      status: { $nin: ['closed', 'expired'] },
      ...wordsMatch(q, ['matchType', 'status']),
    }).select('_id matchType status matchScore').limit(per).lean().exec(),

    Conversation.find({
      isActive: true,
      ...wordsMatch(q, ['participantName', 'accountDisplayName', 'participantPhone']),
    }).select('_id participantName accountDisplayName channelRole').limit(per).lean().exec(),

    Task.find({
      ...wordsMatch(q, ['title', 'description']),
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
  for (const p of pendingReviews) {
    const prof = (p.extraction?.extractedProfile ?? {}) as { firstName?: string; lastName?: string };
    const name = `${prof.firstName ?? ''} ${prof.lastName ?? ''}`.trim();
    const snippet = (p.body || p.mediaCaption || '').replace(/\s+/g, ' ').slice(0, 40);
    results.push({
      type: 'pending_review',
      id: String(p._id),
      title: name || snippet || 'פרופיל ממתין לסקירה',
      subtitle: ['ממתין לסקירה', p.extraction?.reviewReason].filter(Boolean).join(' · '),
      route: `/review?messageId=${String(p._id)}`,
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
