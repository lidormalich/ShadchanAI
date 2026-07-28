// ═══════════════════════════════════════════════════════════
// DiscoverySessionsPanel — operator view of "היכרות חכמה" links
// for one internal candidate: mint/copy/QR a public swipe link,
// track sessions, and review what the candidate revealed (verdicts
// with real identities, trait picks, AI summaries).
// ═══════════════════════════════════════════════════════════

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { QRCodeCanvas } from 'qrcode.react';
import {
  Link2, Copy, RefreshCw, Ban, ChevronDown, ChevronUp, Heart, X, Sparkles, SkipForward,
} from 'lucide-react';
import { Badge, Button, Card, CardBody, CardHeader, Spinner } from '@/components/ui/primitives';
import { toast } from '@/components/ui/Toast';
import {
  createDiscoverySession,
  listDiscoverySessions,
  getDiscoverySession,
  revokeDiscoverySession,
  regenerateDiscoverySession,
  type DiscoverySessionRow,
} from '@/services/api/discovery';

const STATUS_LABEL: Record<DiscoverySessionRow['status'], { label: string; tone: 'brand' | 'success' | 'neutral' | 'warning' | 'danger' }> = {
  pending_traits: { label: 'ממתין לפתיחה', tone: 'neutral' },
  active: { label: 'פעיל', tone: 'brand' },
  completed: { label: 'הסתיים', tone: 'success' },
  revoked: { label: 'בוטל', tone: 'danger' },
  expired: { label: 'פג תוקף', tone: 'warning' },
};

function copyLink(url: string) {
  void navigator.clipboard.writeText(url).then(
    () => toast.success('הקישור הועתק'),
    () => toast.error('העתקת הקישור נכשלה'),
  );
}

const VERDICT_META = {
  like: { label: 'מתאים', tone: 'success' as const, icon: <Heart className="h-3 w-3" /> },
  reject: { label: 'לא מתאים', tone: 'danger' as const, icon: <X className="h-3 w-3" /> },
  skip: { label: 'דילג/ה', tone: 'neutral' as const, icon: <SkipForward className="h-3 w-3" /> },
};

function SessionDetail({ sessionId }: { sessionId: string }) {
  const detail = useQuery({
    queryKey: ['discovery-session', sessionId],
    queryFn: () => getDiscoverySession(sessionId),
  });

  if (detail.isLoading) return <div className="py-4 flex justify-center"><Spinner className="h-5 w-5 text-brand" /></div>;
  if (!detail.data) return <p className="text-sm text-ink-muted py-2">טעינת הפירוט נכשלה</p>;
  const d = detail.data;
  const decided = d.cards.filter((c) => c.verdict);

  return (
    <div className="space-y-4 pt-3 border-t border-border mt-3">
      {d.aiSummaries.length > 0 && (
        <div className="bg-brand-50 rounded-lg p-3 space-y-1">
          <p className="text-xs font-semibold text-brand-700 flex items-center gap-1">
            <Sparkles className="h-3.5 w-3.5" />
            מה ה-AI הבין מההחלקות
          </p>
          <p className="text-sm text-ink leading-relaxed">{d.aiSummaries.at(-1)?.summary}</p>
          {(d.aiSummaries.at(-1)?.negativeSignals.length ?? 0) > 0 && (
            <p className="text-xs text-ink-muted">
              נמנע/ת מ: {d.aiSummaries.at(-1)?.negativeSignals.join(' · ')}
            </p>
          )}
        </div>
      )}

      {d.traitPicks && (
        <div className="text-xs text-ink-muted flex flex-wrap gap-x-3 gap-y-1">
          {d.traitPicks.ageMin !== undefined && (
            <span className="num">גיל {d.traitPicks.ageMin}–{d.traitPicks.ageMax}</span>
          )}
          {d.traitPicks.freeText && <span>"{d.traitPicks.freeText}"</span>}
        </div>
      )}

      {decided.length === 0 ? (
        <p className="text-sm text-ink-muted">אין עדיין החלקות בסשן הזה.</p>
      ) : (
        <ul className="space-y-2">
          {decided.map((c) => {
            const meta = VERDICT_META[c.verdict!];
            const reasons = [...(c.reasonChips ?? []), ...(c.reasonText ? [c.reasonText] : [])];
            return (
              <li key={c.cardId} className="flex items-start justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <Link
                    to={`/candidates/external/${c.externalCandidateId}`}
                    className="font-medium text-brand-700 hover:underline"
                  >
                    {[c.firstName, c.lastName].filter(Boolean).join(' ') || 'מועמד/ת'}
                  </Link>
                  <span className="text-ink-muted text-xs ms-2 num">
                    {[c.age, c.city].filter(Boolean).join(' · ')}
                  </span>
                  {reasons.length > 0 && (
                    <p className="text-xs text-ink-muted mt-0.5">{reasons.join(' · ')}</p>
                  )}
                </div>
                <Badge tone={meta.tone} icon={meta.icon}>{meta.label}</Badge>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function DiscoverySessionsPanel({ internalCandidateId }: { internalCandidateId: string }) {
  const qc = useQueryClient();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [freshLink, setFreshLink] = useState<string | null>(null);

  const sessions = useQuery({
    queryKey: ['discovery-sessions', internalCandidateId],
    queryFn: () => listDiscoverySessions(internalCandidateId),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['discovery-sessions', internalCandidateId] });
  };

  const create = useMutation({
    mutationFn: () => createDiscoverySession(internalCandidateId),
    onSuccess: (data) => {
      setFreshLink(data.url);
      copyLink(data.url);
      invalidate();
    },
    onError: () => toast.error('יצירת הקישור נכשלה'),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => revokeDiscoverySession(id),
    onSuccess: () => { toast.success('הקישור בוטל'); setFreshLink(null); invalidate(); },
    onError: () => toast.error('ביטול הקישור נכשל'),
  });

  const regenerate = useMutation({
    mutationFn: (id: string) => regenerateDiscoverySession(id),
    onSuccess: (data) => {
      setFreshLink(data.url);
      copyLink(data.url);
      invalidate();
    },
    onError: () => toast.error('חידוש הקישור נכשל'),
  });

  const rows = sessions.data ?? [];
  const activeRow = rows.find((r) => r.status === 'active' || r.status === 'pending_traits');
  const shownLink = freshLink ?? activeRow?.url ?? null;

  return (
    <Card>
      <CardHeader
        actions={
          <Button
            size="sm"
            leftIcon={<Link2 className="h-4 w-4" />}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            {activeRow ? 'קישור חדש' : 'צור קישור'}
          </Button>
        }
      >
        <h3 className="text-sm font-semibold">היכרות חכמה</h3>
        <p className="text-xs text-ink-muted mt-0.5">
          קישור ציבורי שבו המועמד/ת מחליק/ה על הצעות אנונימיות — והמערכת לומדת מה באמת מתאים
        </p>
      </CardHeader>
      <CardBody className="space-y-4">
        {shownLink && (
          <div className="flex items-center gap-4 bg-bg-subtle rounded-lg p-3">
            <div className="bg-white p-2 rounded-lg border border-border shrink-0">
              <QRCodeCanvas value={shownLink} size={88} />
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              <p dir="ltr" className="text-xs text-ink-muted break-all text-left">{shownLink}</p>
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<Copy className="h-3.5 w-3.5" />}
                onClick={() => copyLink(shownLink)}
              >
                העתקה
              </Button>
            </div>
          </div>
        )}

        {sessions.isLoading ? (
          <div className="flex justify-center py-4"><Spinner className="h-5 w-5 text-brand" /></div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-ink-muted">
            עדיין לא נוצר קישור למועמד/ת. צרו קישור ושלחו בוואטסאפ — ההחלקות יזינו את הלמידה.
          </p>
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => {
              const meta = STATUS_LABEL[row.status];
              const expanded = expandedId === row.id;
              const canManage = row.status !== 'completed';
              return (
                <li key={row.id} className="border border-border rounded-lg p-3">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                      {row.pendingReview && <Badge tone="warning">ממתין לסקירה</Badge>}
                      <span className="text-xs text-ink-muted num">
                        {row.counters.served} כרטיסים · {row.counters.liked} מתאים · {row.counters.rejected} לא
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      {canManage && (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            title="חידוש קישור (טוקן חדש)"
                            onClick={() => regenerate.mutate(row.id)}
                          >
                            <RefreshCw className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            title="ביטול הקישור"
                            onClick={() => revoke.mutate(row.id)}
                          >
                            <Ban className="h-3.5 w-3.5 text-danger" />
                          </Button>
                        </>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setExpandedId(expanded ? null : row.id)}
                      >
                        {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>
                  <p className="text-[11px] text-ink-subtle mt-1">
                    נוצר {new Date(row.createdAt).toLocaleString('he-IL')}
                    {' · '}
                    בתוקף עד {new Date(row.expiresAt).toLocaleDateString('he-IL')}
                  </p>
                  {expanded && <SessionDetail sessionId={row.id} />}
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
