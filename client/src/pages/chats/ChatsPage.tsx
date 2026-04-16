import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, Inbox, MessageSquare, RefreshCw, Send, UserCheck, UserPlus } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, CardBody, CardHeader, Divider, Textarea } from '@/components/ui/primitives';
import { EmptyState, LoadingSkeleton } from '@/components/states/states';
import { toast } from '@/components/ui/Toast';
import { conversationsApi } from '@/services/api/conversations';
import { channelsApi } from '@/services/api/channels';
import { extractionApi } from '@/services/api/extraction';
import { useRealtimeEvents } from '@/features/realtime/useRealtimeEvents';
import { useSafeMode } from '@/features/safe-mode/useSafeMode';
import { label } from '@/utils/labels';
import type { Conversation, Message } from '@/types/domain';

type RoleFilter = 'all' | 'profiles_source' | 'match_sending';

export function ChatsPage() {
  const [role, setRole] = useState<RoleFilter>('all');
  const [searchParams] = useSearchParams();
  const urlConversation = searchParams.get('conversation');
  const [selected, setSelected] = useState<string | null>(urlConversation);

  // Deep-link: open the conversation whose id is in ?conversation=
  useEffect(() => {
    if (urlConversation) setSelected(urlConversation);
  }, [urlConversation]);

  // Subscribe to server-side realtime events (SSE). New inbound
  // messages and review-queue arrivals invalidate the right caches
  // instantly instead of waiting on the 30s staleTime poll.
  useRealtimeEvents(true);

  const list = useQuery({
    queryKey: ['conversations', role],
    queryFn: () => role === 'all'
      ? conversationsApi.list({ limit: 100 })
      : conversationsApi.byRole(role, { limit: 100 }),
  });

  const thread = useQuery({
    queryKey: ['messages', selected],
    queryFn: () => conversationsApi.messages(selected!, { limit: 200 }),
    enabled: !!selected,
  });

  const activeConv = list.data?.data.find((c) => c._id === selected) ?? null;

  const chain = useQuery({
    queryKey: ['conversation', selected, 'chain'],
    queryFn: () => conversationsApi.chain(selected!),
    enabled: !!selected && !!activeConv?.supersedesConversationId,
  });

  return (
    <div className="grid grid-cols-12 gap-4 h-[calc(100vh-9rem)]">
      {/* Conversations list */}
      <Card className="col-span-4 xl:col-span-3 flex flex-col">
        <CardHeader>
          <h3 className="text-sm font-semibold">שיחות</h3>
          <div className="mt-2 flex gap-1 rounded-md bg-bg-subtle border border-border p-0.5">
            {([
              { id: 'all', label: 'הכול' },
              { id: 'profiles_source', label: 'מקור פרופילים' },
              { id: 'match_sending', label: 'שליחת הצעות' },
            ] as const).map((r) => (
              <button
                key={r.id}
                onClick={() => setRole(r.id as RoleFilter)}
                className={`flex-1 text-xs py-1 rounded ${role === r.id ? 'bg-white shadow-sm font-medium' : 'text-ink-muted'}`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </CardHeader>
        <div className="flex-1 overflow-y-auto">
          {list.isLoading ? <div className="p-4"><LoadingSkeleton rows={6} /></div> :
            list.data?.data.length ? (
              <ul className="divide-y divide-border">
                {list.data.data.map((c) => (
                  <ConversationListItem key={c._id} conv={c} active={c._id === selected} onClick={() => setSelected(c._id)} />
                ))}
              </ul>
            ) : (
              <EmptyState icon={<Inbox className="h-8 w-8 text-ink-faint" />} title="אין שיחות" />
            )}
        </div>
      </Card>

      {/* Thread */}
      <Card className="col-span-5 xl:col-span-6 flex flex-col">
        {!selected ? (
          <EmptyState
            icon={<MessageSquare className="h-10 w-10 text-ink-faint" />}
            title="בחר שיחה"
            description="בחר שיחה מימין כדי לראות את התוכן המלא."
          />
        ) : thread.isLoading ? (
          <div className="p-4"><LoadingSkeleton rows={8} /></div>
        ) : (
          <>
            {activeConv && <ThreadHeader conv={activeConv} chainLength={chain.data?.data.length ?? 0} />}
            <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-bg-subtle/40">
              {(thread.data?.data ?? []).map((m) => <MessageBubble key={m._id} msg={m} />)}
            </div>
            {activeConv && <Compose conv={activeConv} />}
          </>
        )}
      </Card>

      {/* Context rail */}
      <Card className="col-span-3 flex flex-col">
        <CardHeader><h3 className="text-sm font-semibold">הקשר</h3></CardHeader>
        <CardBody>
          {!activeConv ? (
            <div className="text-sm text-ink-muted">בחר שיחה לצפייה בפרטי ההקשר</div>
          ) : (
            <div className="space-y-3 text-sm">
              <div>
                <div className="text-xs text-ink-muted">חשבון</div>
                <div className="font-medium">{activeConv.accountDisplayName}</div>
                <Badge tone={activeConv.channelRole === 'profiles_source' ? 'info' : 'purple'} className="mt-1">
                  {label('channelRole', activeConv.channelRole)}
                </Badge>
              </div>
              <Divider />
              <div>
                <div className="text-xs text-ink-muted">מטרה</div>
                <div className="font-medium">{label('conversationPurpose', activeConv.purpose)}</div>
              </div>
              <div>
                <div className="text-xs text-ink-muted">נוצרה</div>
                <div>{new Date(activeConv.createdAt).toLocaleString('he-IL')}</div>
              </div>
              {activeConv.internalCandidateId && (
                <div>
                  <div className="text-xs text-ink-muted">מועמד פנימי</div>
                  <div className="font-mono text-xs">{activeConv.internalCandidateId.slice(-8)}</div>
                </div>
              )}
              {activeConv.matchSuggestionId && (
                <div>
                  <div className="text-xs text-ink-muted">הצעת שידוך</div>
                  <Link
                    to={`/matches/${activeConv.matchSuggestionId}`}
                    className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline"
                  >
                    פתח הצעה
                    <span className="font-mono text-ink-faint">#{activeConv.matchSuggestionId.slice(-6)}</span>
                  </Link>
                </div>
              )}
              {activeConv.supersedesConversationId && (
                <>
                  <Divider />
                  <div className="flex items-start gap-2 text-xs text-ink-muted">
                    <ArrowLeftRight className="h-4 w-4 mt-0.5" />
                    <div>
                      שיחה זו ממשיכה ערוץ קודם שהוחלף
                      {chain.data && <div className="mt-1">אורך שרשרת: {chain.data.data.length} שיחות</div>}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function ConversationListItem({ conv, active, onClick }: { conv: Conversation; active: boolean; onClick: () => void }) {
  return (
    <li>
      <button
        onClick={onClick}
        className={`w-full text-start px-4 py-3 transition-colors ${active ? 'bg-brand-50' : 'hover:bg-bg-hover'}`}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="font-medium text-sm truncate">{conv.participantName ?? 'ללא שם'}</div>
          {conv.unreadCount > 0 && <Badge tone="brand">{conv.unreadCount}</Badge>}
        </div>
        <div className="text-xs text-ink-muted mt-1 truncate">
          <Badge tone={conv.channelRole === 'profiles_source' ? 'info' : 'purple'}>{label('channelRole', conv.channelRole)}</Badge>
          <span className="ms-2">{conv.accountDisplayName}</span>
        </div>
        {conv.lastMessageAt && (
          <div className="text-xs text-ink-faint mt-1">
            {new Date(conv.lastMessageAt).toLocaleString('he-IL')}
          </div>
        )}
      </button>
    </li>
  );
}

function ThreadHeader({ conv, chainLength }: { conv: Conversation; chainLength: number }) {
  return (
    <div className="px-5 py-3 border-b border-border flex items-center justify-between gap-3 flex-wrap">
      <div>
        <div className="font-semibold">{conv.participantName ?? 'ללא שם'}</div>
        <div className="text-xs text-ink-muted">{conv.accountDisplayName} · {label('channelRole', conv.channelRole)}</div>
      </div>
      <div className="flex items-center gap-2">
        {conv.matchSuggestionId && (
          <Link
            to={`/matches/${conv.matchSuggestionId}`}
            className="inline-flex items-center gap-1 text-xs rounded-full bg-brand-50 text-brand-700 px-2 py-0.5 hover:bg-brand-100"
          >
            <MessageSquare className="h-3 w-3" />
            פתח הצעת שידוך
          </Link>
        )}
        {chainLength > 1 && <Badge tone="info">שרשרת {chainLength}</Badge>}
      </div>
    </div>
  );
}

function MessageBubble({ msg }: { msg: Message }) {
  const inbound = msg.direction === 'inbound';
  return (
    <div className={`flex flex-col ${inbound ? 'items-start' : 'items-end'}`}>
      <div className={`max-w-[70%] rounded-2xl px-3 py-2 text-sm ${inbound ? 'bg-white border border-border' : 'bg-brand text-white'}`}>
        {msg.body && <div className="whitespace-pre-wrap">{msg.body}</div>}
        {msg.mediaCaption && <div className="italic opacity-80 text-xs mt-1">[{label('messageContentType', msg.contentType)}] {msg.mediaCaption}</div>}
        <div className={`text-[10px] mt-1 ${inbound ? 'text-ink-faint' : 'text-white/70'}`}>
          {new Date(msg.createdAt).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}
          {!inbound && ` · ${label('messageDeliveryStatus', msg.deliveryStatus)}`}
        </div>
      </div>
      {inbound && msg.channelRole === 'profiles_source' && (
        <ExtractionBadge msg={msg} />
      )}
    </div>
  );
}

// ── Extraction status badge on profiles_source messages ──
//
// Surfaces the pipeline result per-message so the operator can see
// at a glance whether a profile card was recognized, matched to an
// existing candidate, created as new, or is waiting for review.
function ExtractionBadge({ msg }: { msg: Message }) {
  const qc = useQueryClient();
  const ex = msg.extraction;

  const rerun = useMutation({
    mutationFn: () => extractionApi.run(msg._id),
    onSuccess: () => {
      toast.success('החילוץ הורץ מחדש');
      qc.invalidateQueries({ queryKey: ['messages', msg.conversationId] });
    },
    onError: (e: Error) => toast.error('החילוץ נכשל', e.message),
  });

  const rerunBtn = (
    <button
      onClick={() => rerun.mutate()}
      disabled={rerun.isPending}
      className="text-[10px] underline text-ink-faint disabled:opacity-50 inline-flex items-center gap-1"
      title="עבד הודעה שוב"
    >
      <RefreshCw className="h-3 w-3" />
      {rerun.isPending ? 'מעבד…' : 'עבד מחדש'}
    </button>
  );

  // No extraction yet — show just a rerun button for operators.
  if (!ex) {
    return <div className="mt-1 text-[10px] text-ink-faint">{rerunBtn}</div>;
  }

  const status = ex.status;
  const candidateHref = ex.candidateId ? `/candidates/external/${ex.candidateId}` : undefined;

  if (status === 'created_new' && candidateHref) {
    return (
      <div className="mt-1 inline-flex items-center gap-2 text-[11px]">
        <Badge tone="success"><UserPlus className="h-3 w-3 ms-1 inline" /> נוצר מועמד חדש</Badge>
        <Link to={candidateHref} className="text-brand underline">צפייה בכרטיס</Link>
      </div>
    );
  }
  if (status === 'matched_existing' && candidateHref) {
    return (
      <div className="mt-1 inline-flex items-center gap-2 text-[11px]">
        <Badge tone="info"><UserCheck className="h-3 w-3 ms-1 inline" /> זוהה כמועמד קיים</Badge>
        <Link to={candidateHref} className="text-brand underline">צפייה בכרטיס</Link>
      </div>
    );
  }
  if (status === 'needs_review') {
    return (
      <div className="mt-1 inline-flex items-center gap-2 text-[11px]">
        <Badge tone="warning">ממתין לסקירה</Badge>
        <Link to="/review" className="text-brand underline">פתח תור סקירה</Link>
        {rerunBtn}
      </div>
    );
  }
  if (status === 'pending') {
    return <div className="mt-1 text-[11px] text-ink-muted">מעבד פרופיל…</div>;
  }
  if (status === 'skipped_not_profile') {
    return (
      <div className="mt-1 inline-flex items-center gap-2 text-[11px] text-ink-faint">
        <Badge tone="neutral">לא פרופיל</Badge>
        {rerunBtn}
      </div>
    );
  }
  if (status === 'skipped_template') {
    return (
      <div className="mt-1 inline-flex items-center gap-2 text-[11px] text-ink-faint">
        <Badge tone="neutral">תבנית ריקה</Badge>
      </div>
    );
  }
  if (status === 'failed') {
    return (
      <div className="mt-1 inline-flex items-center gap-2 text-[11px]">
        <Badge tone="danger">נכשל</Badge>
        {ex.failureReason && <span className="text-ink-faint">{ex.failureReason}</span>}
        {rerunBtn}
      </div>
    );
  }
  return null;
}

// ── Compose: visible ONLY for match_sending conversations ────────
//
// Reply from a profiles_source channel is rejected by the backend and
// is not offered in the UI. Additionally, the underlying channel must
// be ACTIVE — disconnected/replaced/suspended/rate_limited channels
// cannot dispatch a message even if the conversation row exists, so
// we render a clear blocked banner rather than a disabled button with
// no explanation.
//
// Outbound v1 boundary (also enforced server-side):
//   - requires an EXISTING conversation (i.e., a real participantPhone
//     captured from prior inbound activity)
//   - no free-form phone entry — admins cannot type a number to start
//     a brand-new thread from this UI
//   - safe first-contact / cold-start initiation is intentionally
//     deferred as a future feature; it requires its own approval flow,
//     compliance review, and rate-limit policy
function Compose({ conv }: { conv: Conversation }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');

  // Look up the channel record so we can gate on its current status.
  // Backend rejects sends on non-active channels, but the UI must
  // explain WHY rather than just disable the button.
  const channelQuery = useQuery({
    queryKey: ['channel', conv.channelId],
    queryFn: () => channelsApi.get(conv.channelId),
    enabled: !!conv.channelId,
  });
  const channel = channelQuery.data?.data;

  const send = useMutation({
    mutationFn: () => conversationsApi.sendMessage(conv._id, { body: text.trim() }),
    onSuccess: () => {
      toast.success('ההודעה נשלחה');
      setText('');
      qc.invalidateQueries({ queryKey: ['messages', conv._id] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
    },
    onError: (err) => toast.error('השליחה נכשלה', (err as Error).message),
  });

  // ── Gate 0: pre-pilot safe mode (kill-switch) ─────────
  const safeMode = useSafeMode();
  if (!safeMode.outboundEnabled) {
    return (
      <ComposeBlocked
        reason={`מצב בטיחות פעיל — שליחת הודעות מושבתת.${safeMode.reason ? ` (${safeMode.reason})` : ''}`}
      />
    );
  }

  // ── Gate 1: role must be match_sending ────────────────
  if (conv.channelRole !== 'match_sending') {
    return (
      <ComposeBlocked reason={`שליחת תגובות אפשרית רק מערוץ match_sending. שיחה זו היא על ערוץ ${label('channelRole', conv.channelRole)}.`} />
    );
  }

  // ── Gate 2: archived conversation ─────────────────────
  if (conv.isActive === false || (conv as Conversation & { archivedAt?: string }).archivedAt) {
    return <ComposeBlocked reason="השיחה הועברה לארכיון. לא ניתן לשלוח אליה." />;
  }

  // ── Gate 3: channel must be active + reachable ────────
  // Backend: channel.status must === 'active' AND Baileys client must
  // be in 'connected' state. We surface both situations clearly.
  if (channelQuery.isLoading) {
    return <ComposeBlocked reason="טוען מצב ערוץ…" tone="muted" />;
  }
  if (!channel) {
    return <ComposeBlocked reason="לא ניתן לאתר את הערוץ של השיחה." />;
  }
  if (channel.status !== 'active') {
    return (
      <ComposeBlocked
        reason={`הערוץ אינו פעיל (${label('channelStatus', channel.status)}). יש לחבר/לשחזר את הערוץ לפני שליחה.`}
      />
    );
  }
  if (channel.connectionHealth !== 'healthy') {
    return (
      <ComposeBlocked
        reason={`הערוץ פעיל אבל אינו בריא (${label('connectionHealth', channel.connectionHealth)}). ייתכן שהסשן בתהליך התחברות מחדש.`}
      />
    );
  }

  // ── All gates passed → render compose box ─────────────
  const disabled = !text.trim() || send.isPending;

  return (
    <div className="border-t border-border p-3 bg-white">
      <div className="flex items-end gap-2">
        <Textarea
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="כתוב הודעה — תישלח רק לאחר לחיצה על שלח"
          className="flex-1"
        />
        <Button
          onClick={() => send.mutate()}
          disabled={disabled}
          loading={send.isPending}
          leftIcon={<Send className="h-4 w-4" />}
        >
          שלח
        </Button>
      </div>
      <div className="text-[11px] text-ink-faint mt-1">
        {text.trim().length} תווים · השליחה מבוצעת ע״י Baileys בלבד, נרשמת ביומן הביקורת.
      </div>
    </div>
  );
}

function ComposeBlocked({ reason, tone = 'muted' }: { reason: string; tone?: 'muted' | 'warn' }) {
  const cls = tone === 'warn'
    ? 'bg-amber-50 text-amber-900 border-amber-200'
    : 'bg-bg-subtle/60 text-ink-muted';
  return (
    <div className={`px-5 py-3 border-t border-border text-xs ${cls}`}>
      {reason}
    </div>
  );
}
