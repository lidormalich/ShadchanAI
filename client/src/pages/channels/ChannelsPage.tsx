import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity, AlertTriangle, CheckCircle2, KeyRound, LogOut, Plug, PlugZap, QrCode, RefreshCcw, Replace, Shield, Unplug, PlayCircle, Link2, Lock,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { channelsApi, type AdminSessionView } from '@/services/api/channels';
import {
  Badge, Button, Card, CardBody, CardHeader, Divider, Input, Select, Spinner,
} from '@/components/ui/primitives';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/states/states';
import { ConfirmActionModal, Dialog } from '@/components/ui/Dialog';
import { toast } from '@/components/ui/Toast';
import { useRealtimeEvents } from '@/features/realtime/useRealtimeEvents';
import { label, statusTone } from '@/utils/labels';
import { formatDateTime } from '@/utils/format';
import type { BaileysChannelStatus, Channel } from '@/types/domain';

// ─────────────────────────────────────────────────────────────
// Hebrew maps for session states & reason codes
// ─────────────────────────────────────────────────────────────

const STATE_EXPLAIN: Record<BaileysChannelStatus['state'], string> = {
  idle: 'הערוץ רשום אך הסשן לא הופעל. לחץ "התחל סשן" כדי להתחיל.',
  connecting: 'מתחבר לשרתי WhatsApp…',
  pending_pairing: 'סרוק את קוד ה-QR מתוך WhatsApp במכשיר שמחזיק בחשבון זה.',
  connected: 'הערוץ פעיל ומחובר.',
  reconnecting: 'החיבור אבד, מתחבר מחדש אוטומטית.',
  disconnected: 'הערוץ מנותק. ניתן לחבר מחדש.',
  logged_out: 'הסשן נותק בצד WhatsApp. נדרש QR חדש — לחץ "התחל סשן".',
};

const STATUS_REASON_MAP: Record<string, string> = {
  reconnect_circuit_open: 'חוגה שבורה — נדרשת התערבות ידנית',
};

// States that are still "in motion" toward a connected session. While in
// any of these the pairing modal keeps polling so it can advance from
// scan → connecting → connected without the operator clicking refresh.
const PAIRING_IN_PROGRESS: BaileysChannelStatus['state'][] = ['pending_pairing', 'connecting', 'reconnecting'];

function connectionHealthTone(h: string): 'success' | 'warning' | 'danger' {
  if (h === 'healthy') return 'success';
  if (h === 'degraded') return 'warning';
  return 'danger';
}

function webhookTone(w: string): 'success' | 'warning' | 'danger' {
  if (w === 'verified') return 'success';
  if (w === 'pending') return 'warning';
  return 'danger';
}

function maskPhone(p: string): string {
  if (!p) return '—';
  const digits = p.replace(/\D/g, '');
  return `•••${digits.slice(-4)}`;
}

// Short Hebrew relative time for the auto-recovery indicator.
function relTime(iso?: string): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'ממש עכשיו';
  if (m < 60) return `לפני ${m} דק׳`;
  const h = Math.round(m / 60);
  if (h < 24) return `לפני ${h} שע׳`;
  return `לפני ${Math.round(h / 24)} ימים`;
}

// ─────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────

export function ChannelsPage() {
  // Push channel state changes into the cache so operators see
  // disconnects / reconnects without clicking refresh.
  useRealtimeEvents(true);

  const list = useQuery({ queryKey: ['channels'], queryFn: () => channelsApi.list({ limit: 100 }) });
  const health = useQuery({ queryKey: ['channels', 'health'], queryFn: () => channelsApi.health() });
  const [connectOpen, setConnectOpen] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">ערוצים</h2>
          <p className="text-sm text-ink-muted">ערוצי WhatsApp מחולקים לפי תפקיד: מקור פרופילים ושליחת הצעות.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link to="/channels/mappings" className="text-sm text-brand-700 hover:underline">
            מיפוי שיחות לתפקיד →
          </Link>
          <Button leftIcon={<Plug className="h-4 w-4" />} onClick={() => setConnectOpen(true)}>חבר ערוץ חדש</Button>
        </div>
      </div>

      {/* Health summary */}
      <Card>
        <CardHeader><h3 className="text-sm font-semibold inline-flex items-center gap-2"><Activity className="h-4 w-4" /> מצב מערכתי</h3></CardHeader>
        <CardBody>
          {health.isLoading ? <LoadingSkeleton rows={2} /> : health.data ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {health.data.data.map((h) => (
                <div key={h.channelId} className="rounded-md border border-border p-3">
                  <div className="text-xs text-ink-muted">{label('channelRole', h.role)}</div>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <Badge tone={statusTone(h.status)}>{label('channelStatus', h.status)}</Badge>
                    <Badge tone={connectionHealthTone(h.connectionHealth)}>{label('connectionHealth', h.connectionHealth)}</Badge>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </CardBody>
      </Card>

      {/* Multi-account admin: per-channel session + lock state */}
      <SessionsAdminPanel />

      {/* Channel grid */}
      {list.isError ? (
        <ErrorState description={(list.error as Error).message} onRetry={() => list.refetch()} />
      ) : list.isLoading ? (
        <LoadingSkeleton rows={4} />
      ) : list.data?.data.length ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {list.data.data.map((ch) => (
            <ChannelStatusCard key={ch.channelId} channel={ch} />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<PlugZap className="h-10 w-10 text-ink-faint" />}
          title="אין ערוצים מחוברים"
          description="חבר ערוץ WhatsApp כדי להתחיל לקבל ולשלוח הודעות."
          action={<Button onClick={() => setConnectOpen(true)}>חבר ערוץ</Button>}
        />
      )}

      <ConnectChannelModal open={connectOpen} onClose={() => setConnectOpen(false)} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Channel card
// ─────────────────────────────────────────────────────────────

function ChannelStatusCard({ channel }: { channel: Channel }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<null | 'disconnect' | 'logout' | 'replace' | 'delete'>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [chainOpen, setChainOpen] = useState(false);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['channels'] });

  // Session status lives in the React Query cache under the same key
  // the realtime channel.updated handler invalidates, so live
  // disconnect/reconnect events refresh it without polling.
  const sessionKey = ['channel', channel.channelId, 'session-status'] as const;
  const statusQuery = useQuery({
    queryKey: sessionKey,
    queryFn: () => channelsApi.sessionStatus(channel.channelId),
    // Phase 7: while pairing, QR rotates on the Baileys side every
    // ~20s. Auto-poll status so the UI picks up the fresh QR before
    // the operator scans an expired one. Keep polling through the
    // post-scan connecting handshake so the card lands on "connected"
    // on its own; stop once the session settles.
    refetchInterval: (q) => {
      const st = q.state.data?.data?.state;
      return st && PAIRING_IN_PROGRESS.includes(st) ? 10_000 : false;
    },
  });
  const session = statusQuery.data?.data ?? null;
  const setSession = (s: BaileysChannelStatus) => qc.setQueryData(sessionKey, { data: s });
  const refreshStatus = () => { void statusQuery.refetch(); };

  const startMut = useMutation({
    mutationFn: () => channelsApi.sessionStart(channel.channelId),
    onSuccess: (r) => {
      setSession(r.data);
      toast.success('הסשן הופעל');
      invalidate();
      if (r.data.state === 'pending_pairing' && r.data.qr) setQrOpen(true);
    },
    onError: (e: Error) => toast.error('הפעלת הסשן נכשלה', e.message),
  });

  const reconnectMut = useMutation({
    mutationFn: () => channelsApi.reconnect(channel.channelId),
    onSuccess: () => { toast.success('בקשת חיבור מחדש נשלחה'); invalidate(); refreshStatus(); },
    onError: (e: Error) => toast.error('החיבור נכשל', e.message),
  });

  const disconnectMut = useMutation({
    mutationFn: () => channelsApi.disconnect(channel.channelId),
    onSuccess: () => { toast.success('הערוץ נותק'); invalidate(); refreshStatus(); },
    onError: (e: Error) => toast.error('הניתוק נכשל', e.message),
  });

  const logoutMut = useMutation({
    mutationFn: () => channelsApi.sessionLogout(channel.channelId),
    // logout returns 204 (no body), so DON'T seed the session cache with
    // undefined — re-fetch instead. The server now reports 'logged_out'.
    onSuccess: () => { toast.success('היציאה מהחשבון הושלמה'); invalidate(); refreshStatus(); },
    onError: (e: Error) => toast.error('היציאה נכשלה', e.message),
  });

  const replaceMut = useMutation({
    mutationFn: () => channelsApi.replace(channel.channelId, {
      newChannel: {
        channelRole: channel.role,
        accountDisplayName: channel.accountDisplayName,
        phoneNumber: channel.phoneNumber,
      },
    }),
    onSuccess: () => { toast.success('הערוץ סומן כהוחלף'); invalidate(); },
    onError: (e: Error) => toast.error('ההחלפה נכשלה', e.message),
  });

  const deleteMut = useMutation({
    mutationFn: () => channelsApi.deleteChannel(channel.channelId),
    onSuccess: () => { toast.success('הערוץ נמחק'); invalidate(); },
    onError: (e: Error) => toast.error('המחיקה נכשלה', e.message),
  });

  const pending =
    startMut.isPending || reconnectMut.isPending || disconnectMut.isPending ||
    logoutMut.isPending || replaceMut.isPending || deleteMut.isPending || statusQuery.isFetching;

  const state: BaileysChannelStatus['state'] = session?.state ?? 'idle';
  const status = channel.status;

  const showStart = ['idle', 'disconnected', 'logged_out'].includes(state) || status === 'suspended';
  const showQr = state === 'pending_pairing' && !!session?.qr;
  const showReconnect = status !== 'active' && state !== 'connected' && state !== 'pending_pairing';
  const showDisconnect = status === 'active' || state === 'connected';
  const showLogout = showDisconnect;
  const showReplace = status !== 'replaced';
  // Delete allowed only when the channel is already inert. Server re-checks.
  const showDelete = ['disconnected', 'suspended', 'replaced'].includes(status);

  const reasonHe = channel.statusReason ? (STATUS_REASON_MAP[channel.statusReason] ?? channel.statusReason) : null;

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold">{channel.accountDisplayName}</h3>
            <span className="text-xs text-ink-muted font-mono">{maskPhone(channel.phoneNumber)}</span>
          </div>
          <div className="flex items-center gap-2 flex-wrap mt-1">
            <Badge tone={channel.role === 'profiles_source' ? 'info' : 'purple'}>{label('channelRole', channel.role)}</Badge>
            <Badge tone={statusTone(status)}>{label('channelStatus', status)}</Badge>
            <span className="text-xs text-ink-faint font-mono">{channel.channelId}</span>
          </div>
        </CardHeader>

        <CardBody className="space-y-3 text-sm">
          {/* Info grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
            <InfoCell label="תקינות חיבור" value={
              <Badge tone={connectionHealthTone(channel.connectionHealth)}>
                {label('connectionHealth', channel.connectionHealth)}
              </Badge>
            } />
            <InfoCell label="סטטוס Webhook" value={
              <Badge tone={webhookTone(channel.webhookStatus)}>
                {label('webhookStatus', channel.webhookStatus)}
              </Badge>
            } />
            <InfoCell label="חיבור אחרון" value={formatDateTime(channel.lastConnectedAt)} />
            <InfoCell label="הודעה אחרונה נכנסת" value={formatDateTime(channel.lastInboundAt)} />
            <InfoCell label="הודעה אחרונה יוצאת" value={formatDateTime(channel.lastOutboundAt)} />
            <InfoCell label="סטטוס סשן" value={<Badge tone="neutral">{label('pairingStatus', state)}</Badge>} />
            {typeof channel.autoReconnectCount === 'number' && channel.autoReconnectCount > 0 && (
              <InfoCell
                label="החלמה אוטומטית"
                value={
                  <span className="inline-flex items-center gap-1 text-emerald-700">
                    <Activity className="h-3 w-3" />
                    {channel.autoReconnectCount}× · {relTime(channel.lastAutoReconnectAt)}
                  </span>
                }
              />
            )}
          </div>

          {/* Reason banner */}
          {reasonHe && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">
              סיבה: {reasonHe}
            </div>
          )}

          {/* Chain banners */}
          {channel.replacedByChannelId && (
            <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900 flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1"><Shield className="h-3.5 w-3.5" /> הערוץ הוחלף בערוץ חדש</span>
              <button className="text-xs underline" onClick={() => setChainOpen(true)}>צפייה בשרשרת</button>
            </div>
          )}
          {channel.replacesChannelId && (
            <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900 flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1"><Shield className="h-3.5 w-3.5" /> הערוץ ממשיך ערוץ קודם</span>
              <button className="text-xs underline" onClick={() => setChainOpen(true)}>צפייה בשרשרת</button>
            </div>
          )}

          <Divider />

          {/* State explanation */}
          <div className="text-xs text-ink-muted">{STATE_EXPLAIN[state]}</div>
          {session?.lastError && (
            <div className="text-xs text-red-700">שגיאה אחרונה: {session.lastError}</div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" variant="secondary" onClick={refreshStatus} disabled={pending}
              loading={statusQuery.isFetching} leftIcon={<RefreshCcw className="h-3.5 w-3.5" />}>
              רענן סטטוס
            </Button>
            {showStart && (
              <Button size="sm" variant="primary" onClick={() => startMut.mutate()} disabled={pending}
                loading={startMut.isPending} leftIcon={<PlayCircle className="h-3.5 w-3.5" />}>
                התחל סשן
              </Button>
            )}
            {showQr && (
              <Button size="sm" variant="secondary" onClick={() => setQrOpen(true)} disabled={pending}
                leftIcon={<QrCode className="h-3.5 w-3.5" />}>
                הצג QR
              </Button>
            )}
            {showReconnect && (
              <Button size="sm" variant="secondary" onClick={() => reconnectMut.mutate()} disabled={pending}
                loading={reconnectMut.isPending} leftIcon={<RefreshCcw className="h-3.5 w-3.5" />}>
                חבר מחדש
              </Button>
            )}
            {showDisconnect && (
              <Button size="sm" variant="secondary" onClick={() => setConfirm('disconnect')} disabled={pending}
                leftIcon={<Unplug className="h-3.5 w-3.5" />}>
                נתק (שמור היסטוריה)
              </Button>
            )}
            {showLogout && (
              <Button size="sm" variant="danger" onClick={() => setConfirm('logout')} disabled={pending}
                leftIcon={<LogOut className="h-3.5 w-3.5" />}>
                יציאה מהחשבון (ניקוי הרשאות)
              </Button>
            )}
            {showReplace && (
              <Button size="sm" variant="secondary" onClick={() => setConfirm('replace')} disabled={pending}
                leftIcon={<Replace className="h-3.5 w-3.5" />}>
                החלפת חשבון
              </Button>
            )}
            {(channel.replacesChannelId || channel.replacedByChannelId) && (
              <Button size="sm" variant="ghost" onClick={() => setChainOpen(true)} disabled={pending}
                leftIcon={<Link2 className="h-3.5 w-3.5" />}>
                צפייה בשרשרת
              </Button>
            )}
            {showDelete && (
              <Button size="sm" variant="danger" onClick={() => setConfirm('delete')} disabled={pending}>
                מחק ערוץ
              </Button>
            )}
          </div>
        </CardBody>
      </Card>

      {/* Confirms */}
      <ConfirmActionModal
        open={confirm === 'disconnect'}
        onClose={() => setConfirm(null)}
        title="ניתוק ערוץ"
        description="הערוץ לא יקבל או ישלח הודעות. ההיסטוריה תישמר במלואה."
        variant="danger"
        confirmLabel="נתק"
        loading={disconnectMut.isPending}
        onConfirm={() => { disconnectMut.mutate(); setConfirm(null); }}
      />
      <ConfirmActionModal
        open={confirm === 'logout'}
        onClose={() => setConfirm(null)}
        title="יציאה מהחשבון — ניקוי הרשאות"
        description="פעולה זו תמחק את הרשאות Baileys לערוץ זה. לאחר מכן נדרש סריקת QR חדשה כדי להתחבר. ההיסטוריה תישמר."
        variant="danger"
        confirmLabel="כן, צא מהחשבון"
        loading={logoutMut.isPending}
        onConfirm={() => { logoutMut.mutate(); setConfirm(null); }}
      />
      <ConfirmActionModal
        open={confirm === 'replace'}
        onClose={() => setConfirm(null)}
        title="החלפת חשבון"
        description="פעולה זו תסמן את הערוץ כהוחלף ותשמור הפניה לערוץ החדש. ההיסטוריה נשמרת."
        variant="primary"
        confirmLabel="סמן כהוחלף"
        loading={replaceMut.isPending}
        onConfirm={() => { replaceMut.mutate(); setConfirm(null); }}
      />
      <ConfirmActionModal
        open={confirm === 'delete'}
        onClose={() => setConfirm(null)}
        title="מחיקת ערוץ"
        description="הערוץ יוסר מהרשימה. ההרשאות של Baileys מנוקות בצעד יציאה־מחשבון נפרד, לפני המחיקה. היסטוריית שיחות נשמרת ואינה נמחקת. מיפויי תפקידים (ChatMapping) של הערוץ יימחקו."
        variant="danger"
        confirmLabel="מחק לצמיתות"
        loading={deleteMut.isPending}
        onConfirm={() => { deleteMut.mutate(); setConfirm(null); }}
      />

      <QRPairingModal
        open={qrOpen}
        onClose={() => setQrOpen(false)}
        channelId={channel.channelId}
      />

      <ChainModal open={chainOpen} onClose={() => setChainOpen(false)} channelId={channel.channelId} />
    </>
  );
}

function InfoCell({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border/60 pb-1">
      <span className="text-xs text-ink-muted">{label}</span>
      <span className="text-xs text-end">{value}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Connect modal
// ─────────────────────────────────────────────────────────────

function ConnectChannelModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [accountDisplayName, setName] = useState('');
  const [phoneNumber, setPhone] = useState('');
  const [role, setRole] = useState<'profiles_source' | 'match_sending'>('profiles_source');

  const connect = useMutation({
    mutationFn: () => channelsApi.connect({
      channelRole: role,
      accountDisplayName: accountDisplayName.trim(),
      phoneNumber: phoneNumber.trim(),
    }),
    onSuccess: () => {
      toast.success('ערוץ חובר', "לחץ 'התחל סשן' כדי להתחיל סנכרון.");
      qc.invalidateQueries({ queryKey: ['channels'] });
      setName(''); setPhone(''); setRole('profiles_source');
      onClose();
    },
    onError: (e: Error) => toast.error('חיבור הערוץ נכשל', e.message),
  });

  const canSubmit = accountDisplayName.trim().length > 0 && phoneNumber.trim().length > 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="חיבור ערוץ חדש"
      description="צור רשומת ערוץ חדשה. לאחר החיבור יש ללחוץ 'התחל סשן' כדי לסרוק QR."
      primaryAction={{
        label: 'חבר ערוץ',
        onClick: () => { if (canSubmit) connect.mutate(); },
        loading: connect.isPending,
      }}
      secondaryAction={{ label: 'ביטול', onClick: onClose }}
    >
      <div className="space-y-3">
        <div>
          <label className="text-xs text-ink-muted">שם תצוגה</label>
          <Input value={accountDisplayName} onChange={(e) => setName(e.target.value)} placeholder="לדוגמה: חשבון ראשי" />
        </div>
        <div>
          <label className="text-xs text-ink-muted">מספר טלפון</label>
          <Input value={phoneNumber} onChange={(e) => setPhone(e.target.value)} placeholder="+972501234567" />
        </div>
        <div>
          <label className="text-xs text-ink-muted">תפקיד</label>
          <Select value={role} onChange={(e) => setRole(e.target.value as 'profiles_source' | 'match_sending')} className="w-full">
            <option value="profiles_source">{label('channelRole', 'profiles_source')}</option>
            <option value="match_sending">{label('channelRole', 'match_sending')}</option>
          </Select>
        </div>
      </div>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────
// QR Pairing modal
// ─────────────────────────────────────────────────────────────

function QRPairingModal({
  open, onClose, channelId,
}: {
  open: boolean;
  onClose: () => void;
  channelId: string;
}) {
  // Shares the same session-status cache entry the card uses, so a
  // refresh here also refreshes the card (and vice-versa). While the
  // modal is open and the session is still moving toward "connected"
  // we poll fast (3s): the QR rotates ~every 20s while pairing, and
  // after a scan we keep polling so the modal advances through the
  // connecting handshake to success on its own.
  const statusQuery = useQuery({
    queryKey: ['channel', channelId, 'session-status'] as const,
    queryFn: () => channelsApi.sessionStatus(channelId),
    enabled: open,
    refetchInterval: (q) => {
      const st = q.state.data?.data?.state;
      return open && st && PAIRING_IN_PROGRESS.includes(st) ? 3000 : false;
    },
  });
  const navigate = useNavigate();
  const status = statusQuery.data?.data ?? null;
  const refresh = () => {
    void statusQuery.refetch().then((r) => {
      if (r.isError) toast.error('רענון QR נכשל', (r.error as Error).message);
    });
  };

  // Once connected we DON'T auto-close — we leave the success panel up
  // with a CTA into chat mapping, so pairing flows straight into picking
  // which WhatsApp groups feed candidates instead of dead-ending here.
  const goToMappings = () => { onClose(); navigate('/channels/mappings'); };

  useEffect(() => {
    if (!open) return;
    if (status?.state === 'connected') toast.success('החיבור הושלם');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, status?.state]);

  if (!open) return null;

  const state = status?.state ?? 'idle';
  const qr = status?.qr;
  const isBase64Png = qr && /^[A-Za-z0-9+/=]+$/.test(qr) && qr.length > 100;

  // Map the raw session state onto what the operator actually needs to
  // see, so the moment after a scan reads as forward progress — not as
  // a "no QR / reconnecting" error.
  //  - connected               → success, modal auto-closes
  //  - connecting/reconnecting  → scan accepted, finishing the handshake
  //  - pending_pairing + qr     → show the code to scan
  //  - pending_pairing, no qr   → code is loading
  //  - anything else            → no live code, offer to (re)generate
  const isConnected = state === 'connected';
  const isFinishing = state === 'connecting' || state === 'reconnecting';
  const isAwaitingScan = state === 'pending_pairing';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="חיבור WhatsApp"
      description="סרוק את הקוד מהטלפון שמחזיק בחשבון כדי לחבר אותו לשדכנAI."
      primaryAction={
        isConnected
          ? { label: 'המשך למיפוי קבוצות →', onClick: goToMappings }
          : { label: 'סגור', onClick: onClose }
      }
      secondaryAction={isConnected ? { label: 'סגור', onClick: onClose } : undefined}
    >
      <div className="space-y-3">
        {isAwaitingScan && qr && (
          <ol className="list-decimal ps-5 text-xs text-ink-muted space-y-1">
            <li>פתח WhatsApp בטלפון שמחזיק בחשבון.</li>
            <li>Settings → Linked Devices → Link a Device.</li>
            <li>סרוק את הקוד המוצג כאן.</li>
          </ol>
        )}

        <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-border bg-white p-4 min-h-[220px] text-center">
          {isConnected ? (
            <>
              <CheckCircle2 className="h-12 w-12 text-emerald-500" />
              <div className="text-sm font-medium text-emerald-700">החיבור הושלם בהצלחה!</div>
              <div className="text-xs text-ink-muted">
                הטלפון מחובר לשדכנAI. השלב הבא: לבחור אילו קבוצות ווטסאפ יזינו מועמדים — לחץ "המשך למיפוי קבוצות".
              </div>
            </>
          ) : isFinishing ? (
            <>
              <Spinner className="h-8 w-8 text-brand-600" />
              <div className="text-sm font-medium">הסריקה התקבלה — מתחבר ל-WhatsApp…</div>
              <div className="text-xs text-ink-muted">משלים את ההתחברות ומאמת את החשבון. אין צורך לסרוק שוב.</div>
            </>
          ) : isAwaitingScan && qr ? (
            isBase64Png ? (
              <img src={`data:image/png;base64,${qr}`} alt="QR" className="h-56 w-56 object-contain" />
            ) : (
              <QRCodeSVG value={qr} size={224} level="M" />
            )
          ) : isAwaitingScan ? (
            <>
              <Spinner className="h-8 w-8 text-brand-600" />
              <div className="text-sm font-medium">טוען קוד QR…</div>
            </>
          ) : (
            <>
              <QrCode className="h-10 w-10 text-ink-faint" />
              <div className="text-sm font-medium">אין קוד QR פעיל כרגע</div>
              <div className="text-xs text-ink-muted">לחץ "רענן QR" כדי להפיק קוד חדש לסריקה.</div>
            </>
          )}
        </div>

        <div className="flex items-center justify-between text-xs text-ink-muted">
          <span className="inline-flex items-center gap-1.5">
            סטטוס:
            <Badge tone={isConnected ? 'success' : isFinishing ? 'info' : 'neutral'}>
              {label('pairingStatus', state)}
            </Badge>
          </span>
          {!isConnected && (
            <Button size="sm" variant="secondary" onClick={refresh} loading={statusQuery.isFetching} leftIcon={<RefreshCcw className="h-3.5 w-3.5" />}>
              רענן QR
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────
// Chain modal
// ─────────────────────────────────────────────────────────────

function ChainModal({ open, onClose, channelId }: { open: boolean; onClose: () => void; channelId: string }) {
  const chain = useQuery({
    queryKey: ['channels', channelId, 'chain'],
    queryFn: () => channelsApi.chain(channelId),
    enabled: open,
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="שרשרת ערוצים"
      description="רצף הערוצים שהוחלפו זה בזה עבור חשבון זה."
      primaryAction={{ label: 'סגור', onClick: onClose }}
    >
      {chain.isLoading ? (
        <div className="flex items-center gap-2 text-xs text-ink-muted"><Spinner className="h-4 w-4" /> טוען…</div>
      ) : chain.isError ? (
        <div className="text-xs text-red-700">שגיאה: {(chain.error as Error).message}</div>
      ) : !chain.data?.data || chain.data.data.length <= 1 ? (
        <div className="text-xs text-ink-muted">אין ערוצים קודמים בשרשרת.</div>
      ) : (
        <ul className="divide-y divide-border border border-border rounded-md">
          {chain.data.data.map((c: Channel) => (
            <li key={c.channelId} className="px-3 py-2 text-xs flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="font-medium">{c.accountDisplayName}</div>
                <div className="font-mono text-ink-faint truncate">{c.channelId}</div>
              </div>
              <div className="text-ink-muted">{formatDateTime(c.createdAt)}</div>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────
// Multi-account admin: live sessions + persisted lock state.
// Auto-refreshes every 30s so operators can watch concurrent
// startup, lock holders, and force-release stale locks without
// reaching for the CLI.
// ─────────────────────────────────────────────────────────────

function SessionsAdminPanel() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['channels', 'sessions', 'admin'],
    queryFn: () => channelsApi.adminSessions(),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  if (q.isLoading) return null;
  if (q.isError) return null;
  if (!q.data) return null;

  const { instanceId, sessions } = q.data.data;
  const stale = sessions.filter((s) => s.lock.isStale);
  const heldElsewhere = sessions.filter((s) => s.lock.ownerInstanceId && !s.lock.isOurs);
  const live = sessions.filter((s) => s.hasLiveClient);

  return (
    <Card>
      <CardHeader>
        <h3 className="text-sm font-semibold inline-flex items-center gap-2">
          <KeyRound className="h-4 w-4" /> ניהול סשנים מרובי-חשבון
        </h3>
        <p className="text-xs text-ink-muted">
          תצוגת בקרה: לקוחות חיים בתהליך הזה, ובעלי הנעילה הקבועים. תהליך נוכחי:
          <span className="font-mono ms-1">{instanceId}</span>
        </p>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="flex items-center gap-3 flex-wrap text-xs">
          <Badge tone="success">{live.length} חיים בתהליך זה</Badge>
          <Badge tone={heldElsewhere.length > 0 ? 'warning' : 'neutral'}>
            {heldElsewhere.length} נעולים בתהליך אחר
          </Badge>
          <Badge tone={stale.length > 0 ? 'danger' : 'neutral'}>
            {stale.length} נעילות תקועות
          </Badge>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-ink-muted">
              <tr>
                <th className="text-start py-1 pe-2">ערוץ</th>
                <th className="text-start py-1 pe-2">תפקיד</th>
                <th className="text-start py-1 pe-2">סטטוס</th>
                <th className="text-start py-1 pe-2">לקוח חי</th>
                <th className="text-start py-1 pe-2">מצב סשן</th>
                <th className="text-start py-1 pe-2">בעל הנעילה</th>
                <th className="text-start py-1 pe-2">גיל פעימה</th>
                <th className="text-start py-1 pe-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sessions.map((s) => (
                <SessionAdminRow
                  key={s.channelId}
                  s={s}
                  onChanged={() => qc.invalidateQueries({ queryKey: ['channels'] })}
                />
              ))}
            </tbody>
          </table>
        </div>

        {stale.length > 0 && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 inline-flex items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5" />
            נעילה נחשבת תקועה כשהפעימה האחרונה ישנה מ-60 שניות. ניתן לשחרר ידנית מהשורה.
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function SessionAdminRow({
  s,
  onChanged,
}: {
  s: AdminSessionView;
  onChanged: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reason, setReason] = useState('');

  const release = useMutation({
    mutationFn: () => channelsApi.forceReleaseLock(s.channelId, { reason }),
    onSuccess: () => {
      toast.success('הנעילה שוחררה בכוח');
      setConfirmOpen(false);
      setReason('');
      onChanged();
    },
    onError: (e: Error) => toast.error('שחרור הנעילה נכשל', e.message),
  });

  // Force-release allowed only when there IS an owner AND no live
  // client in this process (server enforces the same rule, but we
  // gate the button so the operator doesn't have to discover it).
  const canForceRelease = !!s.lock.ownerInstanceId && !s.hasLiveClient;
  const lockTone: 'success' | 'warning' | 'danger' | 'neutral' =
    !s.lock.ownerInstanceId ? 'neutral'
    : s.lock.isStale ? 'danger'
    : s.lock.isOurs ? 'success' : 'warning';

  const ageHe = s.lock.ageMs == null
    ? '—'
    : s.lock.ageMs < 60_000
      ? `${Math.round(s.lock.ageMs / 1000)} שנ׳`
      : `${Math.round(s.lock.ageMs / 60_000)} דק׳${s.lock.isStale ? ' (תקוע)' : ''}`;

  return (
    <>
      <tr className="hover:bg-bg-hover/40">
        <td className="py-1.5 pe-2">
          <div className="font-medium">{s.accountDisplayName}</div>
          <div className="font-mono text-[10px] text-ink-faint">{s.channelId}</div>
        </td>
        <td className="py-1.5 pe-2">{label('channelRole', s.role)}</td>
        <td className="py-1.5 pe-2">
          <Badge tone={statusTone(s.status)}>{label('channelStatus', s.status)}</Badge>
        </td>
        <td className="py-1.5 pe-2">
          {s.hasLiveClient
            ? <Badge tone="success">פעיל</Badge>
            : <span className="text-ink-faint">—</span>}
        </td>
        <td className="py-1.5 pe-2">
          {s.liveState ? <span className="font-mono text-[11px]">{s.liveState}</span> : <span className="text-ink-faint">—</span>}
        </td>
        <td className="py-1.5 pe-2">
          <Badge tone={lockTone} icon={<Lock className="h-3 w-3" />}>
            {!s.lock.ownerInstanceId ? 'פנוי'
              : s.lock.isOurs ? 'תהליך זה'
              : s.lock.isStale ? 'תקוע' : 'תהליך אחר'}
          </Badge>
          {s.lock.ownerInstanceId && (
            <div className="font-mono text-[10px] text-ink-faint mt-0.5 truncate max-w-[180px]">
              {s.lock.ownerInstanceId}
            </div>
          )}
        </td>
        <td className="py-1.5 pe-2 text-ink-muted">{ageHe}</td>
        <td className="py-1.5 pe-2 text-end">
          {canForceRelease && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setConfirmOpen(true)}
            >
              שחרר נעילה
            </Button>
          )}
        </td>
      </tr>
      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="שחרור נעילה בכוח"
        description={`ערוץ ${s.accountDisplayName}. הפעולה רלוונטית רק כשהבעלים הקודם נפל. תיעוד נשמר ב-AuditLog.`}
        primaryAction={{
          label: 'שחרר',
          onClick: () => release.mutate(),
          loading: release.isPending,
          disabled: reason.trim().length < 3,
          variant: 'danger',
        }}
        secondaryAction={{ label: 'ביטול', onClick: () => setConfirmOpen(false) }}
      >
        <Input
          placeholder="סיבת השחרור (חובה — לפחות 3 תווים)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Dialog>
    </>
  );
}
