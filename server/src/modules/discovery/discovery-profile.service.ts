// ═══════════════════════════════════════════════════════════
// Apply revealed preferences to the profile — the operator-approved
// bridge from "what the candidate showed us" to "what the profile
// says".
//
// Flow: buildProfileProposal diffs the latest discovery trait picks
// against the candidate's stored preferences and returns a list of
// human-readable proposed changes. The operator ticks the ones they
// accept; applyProfileProposal REBUILDS the proposal server-side
// (the client sends only keys, never values — no tampering surface)
// and routes the patch through updateInternalCandidate so readiness,
// audit and embedding invalidation all fire exactly like a manual
// edit. Nothing is ever auto-applied.
// ═══════════════════════════════════════════════════════════

import { Types } from 'mongoose';
import { InternalCandidate, DiscoverySession } from '../../models/index.js';
import { updateInternalCandidate } from '../candidates/internal-candidate.service.js';
import type { AuthUser } from '../../middleware/auth.middleware.js';
import { NotFoundError, BusinessRuleError } from '../../utils/errors.js';
import { REGION_HE, SOFT_FIELD_VALUES } from './discovery-vocab.js';
import { PREF_FIELD_LABEL_HE, IMPORTANCE_HE } from '../../services/embedding/profile.serializer.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('discovery.profile');

const OPENNESS_LABEL_HE: Record<string, string> = {
  openToOtherSectors: 'פתיחות למגזרים אחרים',
  openToDivorced: 'פתיחות לגרושים/ות',
  openToWithChildren: 'פתיחות להורים לילדים',
  openToLongDistance: 'פתיחות למרחק גיאוגרפי',
};

export interface ProfileChange {
  /** Stable key the client echoes back on apply. */
  key: string;
  label: string;
  currentDisplay: string;
  proposedDisplay: string;
  /** The exact patch fragment this change contributes. */
  patch: Record<string, unknown>;
}

export interface ProfileProposal {
  available: boolean;
  reason?: 'no_sessions' | 'no_changes' | undefined;
  /** Context shown above the checklist. */
  basedOn?: {
    sessionFinishedAt?: string | undefined;
    likes: number;
    rejects: number;
    learnedSummary?: string | undefined;
  } | undefined;
  changes: ProfileChange[];
}

function fmtRegions(regions: string[] | undefined): string {
  if (!regions?.length) return '—';
  return regions.map((r) => REGION_HE[r as keyof typeof REGION_HE] ?? r).join(', ');
}

function fmtSoftPrefs(
  prefs: Array<{ field: string; value: unknown; importance: string }> | undefined,
): string {
  if (!prefs?.length) return '—';
  return prefs.map((p) => {
    const field = PREF_FIELD_LABEL_HE[p.field] ?? p.field;
    const value = SOFT_FIELD_VALUES[p.field]?.[String(p.value)] ?? String(p.value);
    return `${field}: ${value} (${IMPORTANCE_HE[p.importance] ?? p.importance})`;
  }).join(' · ');
}

export async function buildProfileProposal(internalId: string): Promise<ProfileProposal> {
  const internal = await InternalCandidate.findById(internalId).lean().exec();
  if (!internal) throw new NotFoundError('InternalCandidate', internalId);

  // Latest session that actually collected preferences.
  const session = await DiscoverySession.findOne({
    internalCandidateId: new Types.ObjectId(internalId),
    traitPicks: { $exists: true },
  })
    .sort({ createdAt: -1 })
    .select('traitPicks aiSummaries counters finishedAt')
    .lean()
    .exec();
  if (!session?.traitPicks) return { available: false, reason: 'no_sessions', changes: [] };

  const picks = session.traitPicks;
  const changes: ProfileChange[] = [];

  // ── Age range ──
  if (picks.ageMin !== undefined || picks.ageMax !== undefined) {
    const cur = internal.agePreferences;
    const proposed = {
      min: picks.ageMin ?? cur?.min,
      max: picks.ageMax ?? cur?.max,
      flexibility: cur?.flexibility ?? 'somewhat_flexible',
    };
    if (proposed.min !== cur?.min || proposed.max !== cur?.max) {
      changes.push({
        key: 'agePreferences',
        label: 'טווח גיל מועדף',
        currentDisplay: cur?.min || cur?.max ? `${cur?.min ?? '?'}–${cur?.max ?? '?'}` : '—',
        proposedDisplay: `${proposed.min ?? '?'}–${proposed.max ?? '?'}`,
        patch: { agePreferences: proposed },
      });
    }
  }

  // ── Regions (additive union — the swipe never removes stated regions) ──
  if (picks.regions?.length) {
    const current = internal.locationPreferences?.regions ?? [];
    const union = [...new Set([...current, ...picks.regions])];
    if (union.length !== current.length) {
      changes.push({
        key: 'regions',
        label: 'אזורים מועדפים',
        currentDisplay: fmtRegions(current as string[]),
        proposedDisplay: fmtRegions(union as string[]),
        patch: { locationPreferences: { ...internal.locationPreferences, regions: union } },
      });
    }
  }

  // ── Openness flags (each its own decision — they differ in weight) ──
  if (picks.openness) {
    for (const [flag, value] of Object.entries(picks.openness)) {
      if (typeof value !== 'boolean' || !(flag in OPENNESS_LABEL_HE)) continue;
      const current = (internal.openness as Record<string, unknown> | undefined)?.[flag];
      if (current === value) continue;
      // Fragment carries ONLY the changed flag — expanding onto the
      // full openness object happens ONCE at apply time, otherwise two
      // accepted flags would clobber each other (each fragment would
      // re-assert the original values of the other flags).
      changes.push({
        key: `openness.${flag}`,
        label: OPENNESS_LABEL_HE[flag]!,
        currentDisplay: current === undefined ? 'לא צוין' : current ? 'כן' : 'לא',
        proposedDisplay: value ? 'כן' : 'לא',
        patch: { openness: { [flag]: value } },
      });
    }
  }

  // ── Soft preferences (session replaces same-field, keeps the rest) ──
  if (picks.softPreferences?.length) {
    const current = (internal.softPreferences ?? []) as Array<{ field: string; value: unknown; importance: string }>;
    const overridden = new Set(picks.softPreferences.map((p) => p.field));
    const merged = [
      ...current.filter((p) => !overridden.has(p.field)),
      ...picks.softPreferences,
    ];
    const changed = JSON.stringify(merged) !== JSON.stringify(current);
    if (changed) {
      changes.push({
        key: 'softPreferences',
        label: 'העדפות רכות',
        currentDisplay: fmtSoftPrefs(current),
        proposedDisplay: fmtSoftPrefs(merged as Array<{ field: string; value: unknown; importance: string }>),
        patch: { softPreferences: merged },
      });
    }
  }

  if (changes.length === 0) return { available: false, reason: 'no_changes', changes: [] };

  const latestSummary = session.aiSummaries?.at(-1);
  return {
    available: true,
    basedOn: {
      sessionFinishedAt: session.finishedAt ? new Date(session.finishedAt).toISOString() : undefined,
      likes: session.counters?.liked ?? 0,
      rejects: session.counters?.rejected ?? 0,
      learnedSummary: latestSummary?.summary,
    },
    changes,
  };
}

export async function applyProfileProposal(
  internalId: string,
  acceptKeys: string[],
  user: AuthUser,
): Promise<{ applied: string[] }> {
  // Rebuild server-side — accepted KEYS select from OUR proposal;
  // client-supplied values are never trusted.
  const proposal = await buildProfileProposal(internalId);
  if (!proposal.available) {
    throw new BusinessRuleError('אין שינויים זמינים להחלה מהיכרות חכמה');
  }

  const accepted = proposal.changes.filter((c) => acceptKeys.includes(c.key));
  if (accepted.length === 0) {
    throw new BusinessRuleError('לא נבחר אף שינוי להחלה');
  }

  // Merge patch fragments. Same-object fragments (e.g. two openness
  // flags) deep-merge on the shared top-level key.
  const patch: Record<string, unknown> = {};
  for (const change of accepted) {
    for (const [k, v] of Object.entries(change.patch)) {
      const existing = patch[k];
      patch[k] = existing && typeof existing === 'object' && typeof v === 'object'
        ? { ...(existing as object), ...(v as object) }
        : v;
    }
  }

  // Openness fragments are partial (flag-only) — expand onto the full
  // stored object so the sub-document replace keeps untouched flags.
  if (patch['openness']) {
    const internal = await InternalCandidate.findById(internalId).select('openness').lean().exec();
    patch['openness'] = { ...internal?.openness, ...(patch['openness'] as object) };
  }

  await updateInternalCandidate(internalId, patch, user.id, user);

  log.info(
    { internalId, applied: accepted.map((c) => c.key), by: user.id },
    'discovery_profile_applied',
  );
  return { applied: accepted.map((c) => c.key) };
}
