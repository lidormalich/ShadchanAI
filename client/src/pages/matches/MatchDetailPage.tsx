import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, CheckCircle2, Clock, Heart, Loader2, MessageSquare, Send, Shield, Sparkles, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { matchesApi, type MatchExplanation } from '@/services/api/matches';
import { internalCandidatesApi, externalCandidatesApi } from '@/services/api/candidates';
import { channelsApi } from '@/services/api/channels';
import { aiApi, buildCandidateBrief } from '@/services/api/ai';
import { toast } from '@/components/ui/Toast';
import type { MatchSuggestion } from '@/types/domain';
import { Avatar, Badge, Button, Card, CardBody, CardHeader, Divider, Select, Textarea } from '@/components/ui/primitives';
import { ErrorState, LoadingSkeleton, NotFoundState } from '@/components/states/states';
import { BlockedBanner } from '@/components/domain/banners';
import { ConfirmActionModal, Dialog } from '@/components/ui/Dialog';
import { AskAIPanel } from '@/features/ai/AskAIPanel';
import { StatusReasonDialog } from '@/features/matches/StatusReasonDialog';
import { NotesRail } from '@/features/notes/NotesRail';
import { TasksRail } from '@/features/tasks/TasksRail';
import { EntityTimeline } from '@/features/history/EntityTimeline';
import { conversationsApi } from '@/services/api/conversations';
import { OwnerChip } from '@/features/users/OwnerChip';
import { useSafeMode } from '@/features/safe-mode/useSafeMode';
import { useSetPageTitle } from '@/layouts/PageTitleContext';
import { isNotFoundError } from '@/utils/apiError';
import { label, matchTypeTone } from '@/utils/labels';
import { formatDateTime } from '@/utils/format';
import type { SendPreview } from '@/types/domain';

export function MatchDetailPage() {
  const { id } = useParams<{ id: string }>();
  const safeMode = useSafeMode();
  const qc = useQueryClient();
  const match = useQuery({
    queryKey: ['match', id],
    queryFn: () => matchesApi.get(id!),
    enabled: !!id,
  });
  const sendPreview = useQuery({
    queryKey: ['match', id, 'send-preview'],
    queryFn: () => matchesApi.sendPreview(id!),
    enabled: !!id && !match.isLoading,
  });

  const internalId = match.data?.data.internalCandidateId;
  const externalId = match.data?.data.externalCandidateId;

  const internal = useQuery({
    queryKey: ['internal', internalId],
    queryFn: () => internalCandidatesApi.get(internalId!),
    enabled: !!internalId,
  });
  const external = useQuery({
    queryKey: ['external', externalId],
    queryFn: () => externalCandidatesApi.get(externalId!),
    enabled: !!externalId,
  });

  // Breadcrumb shows the pair's names ("internal × external") instead of
  // the raw suggestion id from the URL, once both sides have loaded.
  const i = internal.data?.data;
  const e = external.data?.data;
  const pairTitle = i && e
    ? `${i.firstName} ${i.lastName} × ${`${e.firstName ?? ''} ${e.lastName ?? ''}`.trim() || 'ללא שם'}`
    : undefined;
  useSetPageTitle(pairTitle);

  const approve = useMutation({
    mutationFn: (reason?: string) => matchesApi.approve(id!, reason ? { reason } : {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['match', id] });
      toast.success('ההצעה אושרה');
    },
    onError: (err) => toast.error('האישור נכשל', (err as Error).message),
  });
  // Persisted, staleness-aware explanation. The server returns the stored
  // answer untouched when nothing scoring-relevant changed, or regenerates
  // and reports which inputs changed. `force` ignores the stored answer.
  // Result is rendered in the ExplainAIModal; no toast.
  const explain = useMutation({
    mutationFn: (opts: { force?: boolean } = {}) => matchesApi.explain(id!, opts),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['match', id] }),
    onError: (err) => toast.error('ההסבר נכשל', (err as Error).message),
  });

  // Advisory only: AI suggests the next operational step the
  // Shadchan might take. Does NOT take any action.
  const suggestStep = useMutation({
    mutationFn: async () => {
      const m = match.data!.data;
      return aiApi.suggestNextStep({
        matchStatus: m.status,
        matchType: m.matchType,
        recommendedAction: m.recommendedAction,
        sideAResponse: m.sideAResponse?.status,
        sideBResponse: m.sideBResponse?.status,
      });
    },
    onSuccess: (r) => {
      const d = r.data as { action?: string; reason?: string; urgency?: string; alternatives?: string[] };
      toast.info(
        `המלצה: ${d.action ?? '—'}`,
        [d.reason, d.alternatives && d.alternatives.length > 0 ? `אלטרנטיבות: ${d.alternatives.join(' · ')}` : undefined]
          .filter(Boolean).join('\n'),
      );
    },
    onError: (err) => toast.error('הצעה נכשלה', (err as Error).message),
  });

  // Active side for the persisted draft textarea. Also drives
  // which draft is prefilled into the send modal on open.
  const [draftSide, setDraftSide] = useState<'a' | 'b'>('a');

  // Persist the draft textarea to match.drafts[side] so it survives
  // navigation and prefills the send modal.
  const saveDraft = useMutation({
    mutationFn: (payload: { body: string; source: 'ai' | 'manual' }) =>
      matchesApi.saveDraft(id!, { side: draftSide, body: payload.body, source: payload.source }),
    onSuccess: (r) => {
      qc.setQueryData(['match', id], r);
    },
    onError: (err) => toast.error('שמירת הטיוטה נכשלה', (err as Error).message),
  });

  // Generate via AI → persist to match.drafts[side] (no more toast-only).
  const draftMessage = useMutation({
    mutationFn: async () => {
      const i = internal.data!.data;
      const e = external.data!.data;
      const r = await aiApi.generateMessage({
        purpose: 'intro',
        tone: 'warm',
        language: 'he',
        recipient: buildCandidateBrief(i),
        aboutCandidate: buildCandidateBrief(e),
      });
      const d = r.data as { message?: string; reviewFlags?: string[] };
      const text = (d.message ?? '').trim();
      if (!text) throw new Error('AI did not return a message');
      await matchesApi.saveDraft(id!, { side: draftSide, body: text, source: 'ai' });
      return { text, reviewFlags: d.reviewFlags ?? [] };
    },
    onSuccess: ({ reviewFlags }) => {
      qc.invalidateQueries({ queryKey: ['match', id] });
      if (reviewFlags.length > 0) {
        toast.warning('טיוטה נוצרה — דורשת בדיקה', reviewFlags.join(' · '));
      } else {
        toast.success('טיוטה נוצרה', 'הטיוטה נשמרה ותופיע בעת השליחה');
      }
    },
    onError: (err) => toast.error('הכנת טיוטה נכשלה', (err as Error).message),
  });

  const defer = useMutation({
    mutationFn: (reason: string) => matchesApi.defer(id!, { reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['match', id] }),
  });
  const close = useMutation({
    mutationFn: (reason: string) => matchesApi.close(id!, { reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['match', id] }),
  });

  const [confirm, setConfirm] = useState<null | { type: 'defer' | 'close'; title: string; desc?: string }>(null);
  const [approveReasonOpen, setApproveReasonOpen] = useState(false);
  const [explainOpen, setExplainOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [sendSide, setSendSide] = useState<'a' | 'b'>('a');
  const [sendChannelId, setSendChannelId] = useState('');
  const [sendBody, setSendBody] = useState('');

  // Fetch only match_sending channels — the backend rejects the rest,
  // but the UI should never even offer them.
  const sendingChannels = useQuery({
    queryKey: ['channels', 'role', 'match_sending'],
    queryFn: () => channelsApi.list({ role: 'match_sending', limit: 50 }),
  });

  const sendProposal = useMutation({
    mutationFn: () => matchesApi.sendProposal(id!, {
      side: sendSide,
      channelId: sendChannelId,
      body: sendBody.trim(),
    }),
    onSuccess: (r) => {
      toast.success('ההצעה נשלחה', `מצב הצעה: ${label('matchStatus', r.data.matchStatus)}`);
      setSendOpen(false);
      setSendBody('');
      // Reflect the new match status in the UI immediately instead of
      // waiting for the invalidated query to refetch — the page would
      // otherwise show the old status for a beat after a successful send.
      qc.setQueryData<{ data: MatchSuggestion; meta?: unknown } | undefined>(
        ['match', id],
        (prev) => prev
          ? { ...prev, data: { ...prev.data, status: r.data.matchStatus as MatchSuggestion['status'] } }
          : prev,
      );
      qc.invalidateQueries({ queryKey: ['match', id, 'send-preview'] });
    },
    onError: (err) => toast.error('השליחה נכשלה', (err as Error).message),
  });

  // When opening the send modal, prefill body from the persisted draft
  // for the chosen side. Also re-prefill when the user switches side.
  useEffect(() => {
    if (!sendOpen) return;
    const m = match.data?.data;
    if (!m) return;
    const draft = sendSide === 'a' ? m.drafts?.sideA?.body : m.drafts?.sideB?.body;
    setSendBody(draft ?? '');
  }, [sendOpen, sendSide, match.data]);

  // Auto-acknowledge any unacked responses when the operator lands
  // on this match. The dashboard "new_response" row for this match
  // dismisses on the next refresh. Fire-and-forget; errors are silent.
  useEffect(() => {
    const m = match.data?.data;
    if (!m || !id) return;
    const sides: Array<'a' | 'b'> = [];
    const a = m.sideAResponse;
    const b = m.sideBResponse;
    if (a?.respondedAt && (!a.acknowledgedAt || new Date(a.acknowledgedAt) < new Date(a.respondedAt))) sides.push('a');
    if (b?.respondedAt && (!b.acknowledgedAt || new Date(b.acknowledgedAt) < new Date(b.respondedAt))) sides.push('b');
    if (sides.length === 0) return;
    Promise.all(sides.map((side) => matchesApi.acknowledgeResponse(id, { side })))
      .then(() => {
        qc.invalidateQueries({ queryKey: ['match', id] });
        qc.invalidateQueries({ queryKey: ['dashboard', 'queue'] });
      })
      .catch(() => { /* silent — acknowledgement is a best-effort UX signal */ });
    // Depend on id + the presence/timing of responses so we don't
    // re-ack on every unrelated re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, match.data?.data.sideAResponse?.respondedAt, match.data?.data.sideBResponse?.respondedAt]);

  if (match.isLoading) return <div className="p-6"><LoadingSkeleton rows={8} /></div>;
  if (match.isError) {
    return isNotFoundError(match.error)
      ? <NotFoundState title="הצעה לא נמצאה" description="הצעת השידוך המבוקשת לא קיימת או נמחקה." backTo="/matches" backLabel="חזרה להצעות" />
      : <ErrorState description={(match.error as Error).message} onRetry={() => match.refetch()} />;
  }
  if (!match.data) return null;

  const m = match.data.data;
  const preview = sendPreview.data?.data;
  const activeDraftBody = draftSide === 'a' ? m.drafts?.sideA?.body ?? '' : m.drafts?.sideB?.body ?? '';
  const activeDraftMeta = draftSide === 'a' ? m.drafts?.sideA : m.drafts?.sideB;

  return (
    <div className="space-y-4">
      {/* Header */}
      <Card>
        <CardBody className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <MatchTypeBadge type={m.matchType} />
            {m.isDeferred && <Badge tone="warning">מושהה</Badge>}
            {m.riskLevel !== 'none' && <Badge tone={m.riskLevel === 'high' ? 'danger' : 'warning'}>סיכון {label('riskLevel', m.riskLevel)}</Badge>}
            {m.flexibilityOverrideApplied && <Badge tone="purple">גמישות הופעלה</Badge>}
            {m.forcedOverride && (
              <Badge tone="danger" title="הצעה זו נכפתה על-ידי שדכן למרות חסימות של המנוע. ראו היסטוריה לנימוק מלא.">
                נכפתה
              </Badge>
            )}
            <OwnerChip userId={m.ownerUserId} />
          </div>
          <div className="ms-auto flex items-center gap-2">
            <Button
              variant="secondary"
              leftIcon={<Sparkles className="h-4 w-4" />}
              disabled={!internal.data || !external.data}
              onClick={() => { setExplainOpen(true); explain.mutate({}); }}
            >
              הסבר AI
            </Button>
            <Button
              variant="secondary"
              loading={suggestStep.isPending}
              onClick={() => suggestStep.mutate()}
              title="AI מייעץ בלבד — לא מבצע פעולה"
            >
              הצע צעד הבא
            </Button>
            <Button
              variant="secondary"
              loading={draftMessage.isPending}
              disabled={!internal.data || !external.data}
              onClick={() => draftMessage.mutate()}
              title="טיוטה לבדיקה — לא נשלח אוטומטית"
            >
              טיוטת הודעה
            </Button>
            <Button
              variant="subtle"
              leftIcon={<Sparkles className="h-4 w-4" />}
              disabled={!internalId}
              onClick={() => setAskOpen(true)}
              title="Ask AI מייעץ בלבד"
            >
              שאל על ההצעה
            </Button>
            <Button
              variant="secondary"
              leftIcon={<Clock className="h-4 w-4" />}
              onClick={() => setConfirm({ type: 'defer', title: 'השהה הצעה', desc: 'ההצעה תעבור לתור ההצעות המושהות. ניתן לפתוח בעתיד.' })}
            >
              השהה
            </Button>
            <Button
              variant="secondary"
              leftIcon={<CheckCircle2 className="h-4 w-4" />}
              onClick={() => setApproveReasonOpen(true)}
              loading={approve.isPending}
            >
              אשר
            </Button>
            <Button
              variant="danger"
              leftIcon={<XCircle className="h-4 w-4" />}
              onClick={() => setConfirm({ type: 'close', title: 'סגור הצעה' })}
            >
              סגור
            </Button>
          </div>
        </CardBody>
      </Card>

      {preview && !preview.canSend && <BlockedBanner blockers={preview.blockers} />}

      {/* Two-column summaries + central analysis */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        {/* Internal summary */}
        <Card>
          <CardHeader><h3 className="text-sm font-semibold">מועמד פנימי</h3></CardHeader>
          <CardBody>
            {internal.isLoading ? <LoadingSkeleton rows={4} /> : internal.data ? (
              <SummaryBlock
                name={`${internal.data.data.firstName} ${internal.data.data.lastName}`}
                photo={internal.data.data.photoApproved ? internal.data.data.photoUrl : undefined}
                lines={[
                  [internal.data.data.city, internal.data.data.region ? label('region', internal.data.data.region) : undefined].filter(Boolean).join(' · ') || undefined,
                  label('sectorGroup', internal.data.data.sectorGroup),
                  label('studyWorkDirection', internal.data.data.studyWorkDirection),
                  internal.data.data.currentOccupation,
                  label('personalStatus', internal.data.data.personalStatus),
                ]}
              />
            ) : <div className="text-sm text-ink-muted">לא נמצא</div>}
          </CardBody>
        </Card>

        {/* Central analysis */}
        <Card className="xl:col-span-1">
          <CardHeader><h3 className="text-sm font-semibold">ניתוח מנוע ההתאמות</h3></CardHeader>
          <CardBody>
            <ScoreTriad matchScore={m.matchScore} confidenceScore={m.confidenceScore} riskLevel={m.riskLevel} />
            <Divider className="my-4" />
            <div className="space-y-2">
              {m.scoreBreakdown.map((d) => (
                <div key={d.dimension} className="flex items-center gap-2">
                  <div className="w-36 text-xs text-ink-muted">{label('scoringDimension', d.dimension)}</div>
                  <div className="flex-1 h-1.5 bg-bg-subtle rounded-full overflow-hidden">
                    <div className="h-full rounded-full bg-brand" style={{ width: `${d.score}%` }} />
                  </div>
                  <div className="w-8 text-xs num text-end">{d.score}</div>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>

        {/* External summary */}
        <Card>
          <CardHeader><h3 className="text-sm font-semibold">מועמד חיצוני</h3></CardHeader>
          <CardBody>
            {external.isLoading ? <LoadingSkeleton rows={4} /> : external.data ? (
              <SummaryBlock
                name={`${external.data.data.firstName ?? ''} ${external.data.data.lastName ?? ''}`.trim() || 'ללא שם'}
                photo={external.data.data.photoUrl}
                lines={[
                  [external.data.data.city, external.data.data.region ? label('region', external.data.data.region) : undefined].filter(Boolean).join(' · ') || undefined,
                  label('sectorGroup', external.data.data.sectorGroup),
                  label('studyWorkDirection', external.data.data.studyWorkDirection),
                  external.data.data.currentOccupation,
                  label('personalStatus', external.data.data.personalStatus),
                ]}
              />
            ) : <div className="text-sm text-ink-muted">לא נמצא</div>}
          </CardBody>
        </Card>

        {/* Strengths / Attention / Hard blockers — full width */}
        <Card className="xl:col-span-2">
          <CardHeader><h3 className="text-sm font-semibold">נקודות חוזק ונקודות לב</h3></CardHeader>
          <CardBody className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <div className="text-xs font-medium text-success uppercase tracking-wide mb-2">חוזקות</div>
              {m.strengths.length === 0 ? <div className="text-xs text-ink-muted">—</div> :
                <ul className="text-sm space-y-1 list-disc ps-4">{m.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>}
            </div>
            <div>
              <div className="text-xs font-medium text-warning uppercase tracking-wide mb-2">נקודות לב</div>
              {m.attentionPoints.length === 0 ? <div className="text-xs text-ink-muted">—</div> :
                <ul className="text-sm space-y-1 list-disc ps-4">{m.attentionPoints.map((s, i) => <li key={i}>{s}</li>)}</ul>}
            </div>
            {m.overrideReasons.length > 0 && (
              <div className="md:col-span-2">
                <div className="text-xs font-medium text-purple-700 uppercase tracking-wide mb-2">עקיפות שהוחלו</div>
                <ul className="text-sm space-y-1 list-disc ps-4">{m.overrideReasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
              </div>
            )}
          </CardBody>
        </Card>

        {/* Background, goals & character — the richer "פרטי שידוך" detail */}
        {internal.data && (
          <Card className="xl:col-span-3">
            <CardHeader><h3 className="text-sm font-semibold">רקע, מטרות ואופי</h3></CardHeader>
            <CardBody>
              <BackgroundGoals internal={internal.data.data} external={external.data?.data} />
            </CardBody>
          </Card>
        )}

        {/* Send preview + action bar */}
        <Card>
          <CardHeader><h3 className="text-sm font-semibold">מצב שליחה</h3></CardHeader>
          <CardBody>
            {sendPreview.isLoading ? <LoadingSkeleton rows={4} /> : preview ? (
              <SendPreviewBlock preview={preview} onSend={() => setSendOpen(true)} safeMode={safeMode} />
            ) : null}
          </CardBody>
        </Card>
      </div>

      {/* Persisted proposal drafts — AI fills this, operator edits, send modal prefills from it */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h3 className="text-sm font-semibold">טיוטת הצעה</h3>
            <div className="flex items-center gap-2">
              <Select value={draftSide} onChange={(e) => setDraftSide(e.target.value as 'a' | 'b')}>
                <option value="a">צד א (פנימי)</option>
                <option value="b">צד ב (חיצוני)</option>
              </Select>
              <Button
                variant="secondary"
                loading={draftMessage.isPending}
                disabled={!internal.data || !external.data}
                onClick={() => draftMessage.mutate()}
                leftIcon={<Sparkles className="h-4 w-4" />}
                title="AI יוצר טיוטה ושומר אותה על ההצעה"
              >
                צור עם AI
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardBody className="space-y-2">
          <Textarea
            key={draftSide /* reset controlled value when side flips */}
            rows={6}
            defaultValue={activeDraftBody}
            placeholder="טיוטה תישמר על ההצעה ותופיע בחלון השליחה"
            onBlur={(e) => {
              const next = e.target.value;
              if (next !== activeDraftBody) {
                saveDraft.mutate({ body: next, source: 'manual' });
              }
            }}
          />
          <div className="text-[11px] text-ink-faint flex items-center gap-2">
            {activeDraftMeta?.updatedAt
              ? <>עודכן {formatDateTime(activeDraftMeta.updatedAt)} · מקור: {activeDraftMeta.source ?? 'manual'}</>
              : 'אין טיוטה שמורה לצד זה.'}
            {saveDraft.isPending && <span>· שומר…</span>}
          </div>
        </CardBody>
      </Card>

      {/* Linked conversations per side (populated when a proposal is sent) */}
      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold">שיחות מקושרות</h3>
        </CardHeader>
        <CardBody className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <LinkedConversation side="a" conversationId={m.conversationIds?.sideA} />
          <LinkedConversation side="b" conversationId={m.conversationIds?.sideB} />
        </CardBody>
      </Card>

      {/* Real timeline from audit-logs */}
      <EntityTimeline entityType="match_suggestion" entityId={m._id} title="ציר זמן" />

      {/* Tasks + notes for this match */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <TasksRail related={{ type: 'match_suggestion', id: m._id }} />
        <NotesRail entityType="match_suggestion" entityId={m._id} />
      </div>

      <ConfirmActionModal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm?.title ?? ''}
        description={confirm?.desc}
        onConfirm={() => {
          if (!confirm) return;
          if (confirm.type === 'defer') defer.mutate('הוחלט להשהות');
          if (confirm.type === 'close') close.mutate('החלטת שדכן');
          setConfirm(null);
        }}
      />

      <StatusReasonDialog
        open={approveReasonOpen}
        title="אשר הצעה"
        onClose={() => setApproveReasonOpen(false)}
        onConfirm={(reason) => {
          setApproveReasonOpen(false);
          approve.mutate(reason);
        }}
      />

      <ExplainAIModal
        open={explainOpen}
        onClose={() => setExplainOpen(false)}
        loading={explain.isPending}
        error={explain.isError ? (explain.error as Error).message : null}
        data={explain.data?.data}
        onRetry={() => explain.mutate({})}
        onRefresh={() => explain.mutate({ force: true })}
      />

      <AskAIPanel
        open={askOpen}
        onClose={() => setAskOpen(false)}
        initialQuery="הצעת שידוך לכרטיס זה — איזה צעדים שווה לשקול? מה נקודות הלב העיקריות?"
        contextId={internalId}
      />

      <Dialog
        open={sendOpen}
        onClose={() => setSendOpen(false)}
        title="שליחת הצעת שידוך"
        description="כל שליחה מתבצעת מערוץ match_sending בלבד, נרשמת ביומן הביקורת, ודורשת אישור שלך."
        primaryAction={{
          label: safeMode.outboundEnabled ? 'שלח' : 'שליחה מושבתת (מצב בטיחות)',
          onClick: () => sendProposal.mutate(),
          loading: sendProposal.isPending,
          disabled: !safeMode.outboundEnabled,
        }}
        secondaryAction={{ label: 'ביטול', onClick: () => setSendOpen(false) }}
      >
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium mb-1">צד</label>
            <Select value={sendSide} onChange={(e) => setSendSide(e.target.value as 'a' | 'b')}>
              <option value="a">צד א (מועמד פנימי)</option>
              <option value="b">צד ב (מועמד חיצוני)</option>
            </Select>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">ערוץ שליחה</label>
            <Select
              value={sendChannelId}
              onChange={(e) => setSendChannelId(e.target.value)}
              disabled={sendingChannels.isLoading}
            >
              <option value="">בחר ערוץ</option>
              {(sendingChannels.data?.data ?? [])
                .filter((c) => c.status === 'active')
                .map((c) => (
                  <option key={c.channelId} value={c.channelId}>
                    {c.accountDisplayName}
                    {c.connectionHealth !== 'healthy' ? ` · ${label('connectionHealth', c.connectionHealth)}` : ''}
                  </option>
                ))
              }
            </Select>
            {sendingChannels.data && sendingChannels.data.data.length === 0 && (
              <div className="text-xs text-warning mt-1">אין ערוצי match_sending מוגדרים.</div>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">תוכן ההודעה</label>
            <Textarea
              rows={5}
              value={sendBody}
              onChange={(e) => setSendBody(e.target.value)}
              placeholder="טקסט ההודעה לשליחה — יישלח בדיוק כפי שנכתב כאן"
            />
            <div className="text-[11px] text-ink-faint mt-1">
              {sendBody.trim().length} תווים · ⓘ AI לא שולח בעצמו. השליחה נשלחת רק לאחר לחיצה על "שלח".
            </div>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

// AI match-explanation modal. Opens immediately on click and shows a
// "מנתח מידע ובודק…" loading state until the answer arrives, then renders
// the structured explanation (summary, strengths, concerns, nuance,
// recommended approach). The explanation is persisted on the suggestion:
// it is reused as-is until something scoring-relevant changes, at which
// point it refreshes and reports WHAT changed.
function ExplainAIModal({
  open,
  onClose,
  loading,
  error,
  data,
  onRetry,
  onRefresh,
}: {
  open: boolean;
  onClose: () => void;
  loading: boolean;
  error: string | null;
  data?: MatchExplanation;
  onRetry: () => void;
  onRefresh: () => void;
}) {
  const r = data?.explanation;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-brand-700" />
          הסבר AI להתאמה
        </span>
      }
      secondaryAction={{ label: 'סגור', onClick: onClose }}
    >
      <div className="max-h-[60vh] overflow-y-auto pe-1">
        {loading ? (
          <div className="flex flex-col items-center justify-center gap-3 py-10 text-ink-muted">
            <Loader2 className="h-7 w-7 animate-spin text-brand-700" />
            <div className="text-sm font-medium">מנתח מידע ובודק…</div>
            <div className="text-xs text-ink-faint">ה-AI עובר על הנתונים ומכין הסבר מפורט</div>
          </div>
        ) : error ? (
          <div className="space-y-3 py-4 text-center">
            <div className="text-sm text-danger">ההסבר נכשל: {error}</div>
            <Button variant="secondary" onClick={onRetry}>נסה שוב</Button>
          </div>
        ) : r ? (
          <div className="space-y-4 text-sm">
            {/* Score movement — the engine was re-evaluated on open */}
            {data?.rescored && data.score.direction !== 'same' && (
              <div className={`rounded-md border p-2.5 text-xs font-medium ${
                data.score.direction === 'up'
                  ? 'border-success/30 bg-success/10 text-success'
                  : 'border-warning/30 bg-warning/10 text-warning'
              }`}>
                {data.score.direction === 'up' ? '↑ ההתאמה השתפרה' : '↓ ההתאמה נחלשה'} — הציון
                {' '}{data.score.direction === 'up' ? 'עלה' : 'ירד'} מ-{data.score.previous} ל-{data.score.current}
                {' '}({data.score.delta > 0 ? '+' : ''}{data.score.delta})
              </div>
            )}

            {/* Freshness banner — refreshed vs reused, and what changed */}
            {data && (data.changedFields.length > 0 ? (
              <div className="rounded-md border border-brand-200 bg-brand-50 p-2.5 text-xs text-brand-800">
                ההסבר עודכן כי השתנה: {data.changedFields.join(' · ')}
              </div>
            ) : data.fromCache ? (
              <div className="text-[11px] text-ink-faint flex items-center justify-between gap-2">
                <span>
                  מבוסס על ניתוח שמור
                  {r.generatedAt ? ` · עודכן ${formatDateTime(r.generatedAt)}` : ''}
                </span>
                <button type="button" onClick={onRefresh} className="text-brand-700 hover:underline">רענן</button>
              </div>
            ) : null)}

            {r.summary && <p className="text-ink leading-relaxed">{r.summary}</p>}
            {r.strengths.length > 0 && (
              <div>
                <div className="text-xs font-medium text-success uppercase tracking-wide mb-1">חוזקות</div>
                <ul className="list-disc ps-4 space-y-1">{r.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
              </div>
            )}
            {r.concerns.length > 0 && (
              <div>
                <div className="text-xs font-medium text-warning uppercase tracking-wide mb-1">נקודות לב</div>
                <ul className="list-disc ps-4 space-y-1">{r.concerns.map((s, i) => <li key={i}>{s}</li>)}</ul>
              </div>
            )}
            {r.nuance && (
              <div>
                <div className="text-xs font-medium text-ink-muted uppercase tracking-wide mb-1">ניואנס</div>
                <p className="text-ink-muted leading-relaxed">{r.nuance}</p>
              </div>
            )}
            {r.recommendedApproach && (
              <div className="rounded-md bg-bg-subtle p-3">
                <div className="text-xs font-medium text-brand-700 uppercase tracking-wide mb-1">גישה מומלצת</div>
                <p className="text-ink leading-relaxed">{r.recommendedApproach}</p>
              </div>
            )}
            {r.notMatchReasons.length > 0 && (
              <div>
                <div className="text-xs font-medium text-danger uppercase tracking-wide mb-1">סיבות אפשריות לאי-התאמה</div>
                <ul className="list-disc ps-4 space-y-1">{r.notMatchReasons.map((s, i) => <li key={i}>{s}</li>)}</ul>
              </div>
            )}
          </div>
        ) : (
          <div className="py-6 text-center text-sm text-ink-muted">אין הסבר זמין.</div>
        )}
      </div>
    </Dialog>
  );
}

function MatchTypeBadge({ type }: { type: string }) {
  const iconMap: Record<string, React.ReactNode> = {
    safe: <Shield className="h-3.5 w-3.5" />,
    balanced: <Heart className="h-3.5 w-3.5" />,
    creative: <Sparkles className="h-3.5 w-3.5" />,
    risky: <AlertTriangle className="h-3.5 w-3.5" />,
  };
  const icon = iconMap[type] ?? iconMap['balanced'];
  return <Badge tone={matchTypeTone(type)} icon={icon}>{label('matchType', type)}</Badge>;
}

function ScoreTriad({ matchScore, confidenceScore, riskLevel }: { matchScore: number; confidenceScore: number; riskLevel: string }) {
  return (
    <div className="grid grid-cols-3 gap-3 text-center">
      <div>
        <div className="text-xs text-ink-muted uppercase tracking-wide">ציון</div>
        <div className="text-3xl font-semibold num text-brand-700">{matchScore}</div>
      </div>
      <div>
        <div className="text-xs text-ink-muted uppercase tracking-wide">ביטחון</div>
        <div className="text-3xl font-semibold num text-ink">{confidenceScore}</div>
      </div>
      <div>
        <div className="text-xs text-ink-muted uppercase tracking-wide">סיכון</div>
        <div className="text-xl font-semibold">{riskLevel}</div>
      </div>
    </div>
  );
}

function BackgroundGoals({
  internal,
  external,
}: {
  internal: import('@/types/domain').InternalCandidate;
  external?: import('@/types/domain').ExternalCandidate;
}) {
  const traits = internal.characterTraits ?? [];
  const goals = internal.lifeGoals;
  const hasGoals = Boolean(goals?.childrenPreference || goals?.careerPriority || goals?.homeVision);
  const hasFamily = Boolean(internal.ethnicity || internal.familyBackground);
  const hasCharacter = traits.length > 0 || Boolean(internal.characterNotes);

  if (!hasGoals && !hasFamily && !hasCharacter && !internal.region && !external?.region) {
    return <div className="text-xs text-ink-muted">אין מידע רקע/מטרות נוסף. ניתן להוסיף בעריכת המועמד.</div>;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-5 text-sm">
      {/* Goals */}
      <div className="space-y-2">
        <div className="text-xs font-medium text-brand-700 uppercase tracking-wide">מטרות משותפות</div>
        {hasGoals ? (
          <dl className="space-y-1">
            {goals?.childrenPreference && <InfoRow k="גודל משפחה" v={label('childrenPreference', goals.childrenPreference)} />}
            {goals?.careerPriority && <InfoRow k="תורה / קריירה" v={label('careerPriority', goals.careerPriority)} />}
            {goals?.homeVision && <InfoRow k="חזון הבית" v={goals.homeVision} />}
          </dl>
        ) : <div className="text-xs text-ink-muted">—</div>}
      </div>

      {/* Family background */}
      <div className="space-y-2">
        <div className="text-xs font-medium text-brand-700 uppercase tracking-wide">רקע משפחתי</div>
        {hasFamily ? (
          <dl className="space-y-1">
            {internal.ethnicity && <InfoRow k="עדה / מוצא" v={internal.ethnicity} />}
            {internal.familyBackground && <InfoRow k="רקע" v={internal.familyBackground} />}
          </dl>
        ) : <div className="text-xs text-ink-muted">—</div>}
      </div>

      {/* Character / middot */}
      <div className="space-y-2">
        <div className="text-xs font-medium text-brand-700 uppercase tracking-wide">מידות ואופי</div>
        {hasCharacter ? (
          <div className="space-y-2">
            {traits.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {traits.map((t) => (
                  <span key={t} className="px-2 py-0.5 rounded-full text-xs bg-bg-subtle border border-border text-ink-muted">{t}</span>
                ))}
              </div>
            )}
            {internal.characterNotes && <p className="text-xs text-ink-muted">{internal.characterNotes}</p>}
          </div>
        ) : <div className="text-xs text-ink-muted">—</div>}
      </div>
    </div>
  );
}

function InfoRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2">
      <dt className="text-xs text-ink-faint min-w-[5.5rem]">{k}</dt>
      <dd className="text-xs text-ink flex-1">{v}</dd>
    </div>
  );
}

function SummaryBlock({ name, photo, lines }: { name: string; photo?: string; lines: Array<string | undefined> }) {
  return (
    <div className="flex items-start gap-3">
      <Avatar name={name} size={48} src={photo} />
      <div>
        <div className="font-semibold">{name}</div>
        <div className="text-xs text-ink-muted mt-1 space-y-0.5">
          {lines.filter(Boolean).map((l, i) => <div key={i}>{l}</div>)}
        </div>
      </div>
    </div>
  );
}

function SendPreviewBlock({
  preview,
  onSend,
  safeMode,
}: {
  preview: SendPreview;
  onSend: () => void;
  safeMode: ReturnType<typeof useSafeMode>;
}) {
  return (
    <div className="space-y-3">
      <div className={`text-sm font-medium ${preview.canSend ? 'text-success' : 'text-warning'}`}>
        {preview.canSend ? '✓ מוכן לשליחה' : '⚠ חסמים לפני שליחה'}
      </div>
      {preview.blockers.length > 0 && (
        <ul className="text-xs text-ink-muted list-disc ps-4 space-y-0.5">
          {preview.blockers.map((b, i) => <li key={i}>{b}</li>)}
        </ul>
      )}
      <Divider />
      <div className="text-xs text-ink-muted">
        פעולה מומלצת: <span className="text-ink font-medium">{label('recommendedAction', preview.engineRecommendedAction)}</span>
      </div>
      <Button
        disabled={!preview.canSend}
        leftIcon={<Send className="h-4 w-4" />}
        onClick={onSend}
      >
        התחל שליחה {!preview.canSend && '(חסום)'} {safeMode.outboundEnabled ? '' : '(מצב בטיחות)'}
      </Button>
      <div className="text-[11px] text-ink-faint">
        כל שליחה דורשת אישור אנושי ונכתבת ביומן הביקורת.
      </div>
    </div>
  );
}

function LinkedConversation({ side, conversationId }: { side: 'a' | 'b'; conversationId?: string }) {
  const sideLabel = side === 'a' ? 'צד א (פנימי)' : 'צד ב (חיצוני)';
  const conv = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => conversationsApi.get(conversationId!),
    enabled: !!conversationId,
  });

  if (!conversationId) {
    return (
      <div className="rounded-md border border-dashed border-border p-3 text-xs text-ink-muted">
        <div className="font-medium text-ink mb-1">{sideLabel}</div>
        אין שיחה מקושרת. השיחה תיווצר עם שליחת ההצעה.
      </div>
    );
  }

  const c = conv.data?.data;
  const participant = c?.participantName ?? 'משתתף';

  return (
    <Link
      to={`/chats?conversation=${conversationId}`}
      className="rounded-md border border-border bg-white p-3 text-sm hover:bg-bg-hover flex items-start gap-2"
    >
      <MessageSquare className="h-4 w-4 mt-0.5 text-brand-700" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{sideLabel}</div>
        <div className="text-xs text-ink-muted truncate">
          {conv.isLoading ? 'טוען…' : c ? `${participant} · ${c.accountDisplayName}` : 'לא נמצאה שיחה'}
        </div>
        {c?.lastMessageAt && (
          <div className="text-[11px] text-ink-faint mt-0.5">
            הודעה אחרונה {formatDateTime(c.lastMessageAt)}
          </div>
        )}
      </div>
    </Link>
  );
}

