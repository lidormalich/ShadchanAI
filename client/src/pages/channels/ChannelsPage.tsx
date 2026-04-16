import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity, LogOut, Plug, PlugZap, QrCode, RefreshCcw, Replace, Shield, Unplug, PlayCircle, Link2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { channelsApi } from '@/services/api/channels';
import {
  Badge, Button, Card, CardBody, CardHeader, Divider, Input, Select, Spinner,
} from '@/components/ui/primitives';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/states/states';
import { ConfirmActionModal, Dialog } from '@/components/ui/Dialog';
import { toast } from '@/components/ui/Toast';
import { useRealtimeEvents } from '@/features/realtime/useRealtimeEvents';
import { label } from '@/utils/labels';
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

function statusTone(status: string): 'success' | 'danger' | 'warning' | 'neutral' {
  if (status === 'active') return 'success';
  if (status === 'rate_limited') return 'warning';
  if (status === 'disconnected' || status === 'suspended' || status === 'replaced') return 'danger';
  return 'neutral';
}

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

function formatDate(s?: string): string {
  return s ? new Date(s).toLocaleString('he-IL') : '—';
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
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">ערוצים</h2>
          <p className="text-sm text-ink-muted">ערוצי WhatsApp מחולקים לפי תפקיד: מקור פרופילים ושליחת הצעות.</p>
        </div>
        <div className="flex items-center gap-2">
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
  const [session, setSession] = useState<BaileysChannelStatus | null>(null);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | 'disconnect' | 'logout' | 'replace' | 'delete'>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [chainOpen, setChainOpen] = useState(false);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['channels'] });

  async function run<T>(key: string, fn: () => Promise<T>, successMsg?: string): Promise<T | undefined> {
    setActiveAction(key);
    try {
      const res = await fn();
      if (successMsg) toast.success(successMsg);
      return res;
    } catch (err) {
      toast.error('הפעולה נכשלה', (err as Error).message);
      return undefined;
    } finally {
      setActiveAction(null);
    }
  }

  const refreshStatus = async () => {
    const res = await run('status', () => channelsApi.sessionStatus(channel.channelId));
    if (res) setSession(res.data);
  };

  useEffect(() => {
    // Initial fetch
    refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.channelId]);

  // Phase 7: while pairing, QR rotates on the Baileys side every
  // ~20s. Auto-poll status so the UI picks up the fresh QR before
  // the operator scans an expired one. Stops as soon as the state
  // transitions away from pending_pairing.
  useEffect(() => {
    if (session?.state !== 'pending_pairing') return;
    const interval = window.setInterval(() => { void refreshStatus(); }, 10_000);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.state, channel.channelId]);

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
    onSuccess: (r) => { setSession(r.data); toast.success('היציאה מהחשבון הושלמה'); invalidate(); },
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
    logoutMut.isPending || replaceMut.isPending || deleteMut.isPending || activeAction !== null;

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
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
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
            <InfoCell label="חיבור אחרון" value={formatDate(channel.lastConnectedAt)} />
            <InfoCell label="הודעה אחרונה נכנסת" value={formatDate(channel.lastInboundAt)} />
            <InfoCell label="הודעה אחרונה יוצאת" value={formatDate(channel.lastOutboundAt)} />
            <InfoCell label="סטטוס סשן" value={<Badge tone="neutral">{label('pairingStatus', state)}</Badge>} />
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
              loading={activeAction === 'status'} leftIcon={<RefreshCcw className="h-3.5 w-3.5" />}>
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
        initial={session}
        onUpdated={(s) => setSession(s)}
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
  open, onClose, channelId, initial, onUpdated,
}: {
  open: boolean;
  onClose: () => void;
  channelId: string;
  initial: BaileysChannelStatus | null;
  onUpdated: (s: BaileysChannelStatus) => void;
}) {
  const [status, setStatus] = useState<BaileysChannelStatus | null>(initial);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => { setStatus(initial); }, [initial]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await channelsApi.sessionStatus(channelId);
      setStatus(r.data);
      onUpdated(r.data);
    } catch (err) {
      toast.error('רענון QR נכשל', (err as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const currentState = status?.state;
    if (currentState && currentState !== 'pending_pairing') {
      if (currentState === 'connected') {
        toast.success('החיבור הושלם');
        const t = setTimeout(onClose, 1000);
        return () => clearTimeout(t);
      }
      return;
    }
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, status?.state]);

  if (!open) return null;

  const qr = status?.qr;
  const isBase64Png = qr && /^[A-Za-z0-9+/=]+$/.test(qr) && qr.length > 100;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="חיבור WhatsApp"
      description="סרוק את הקוד מהטלפון שמחזיק בחשבון כדי לחבר אותו לשדכנAI."
      primaryAction={{ label: 'סגור', onClick: onClose }}
    >
      <div className="space-y-3">
        <ol className="list-decimal ps-5 text-xs text-ink-muted space-y-1">
          <li>פתח WhatsApp בטלפון שמחזיק בחשבון.</li>
          <li>Settings → Linked Devices → Link a Device.</li>
          <li>סרוק את הקוד המוצג כאן.</li>
        </ol>

        <div className="flex items-center justify-center rounded-md border border-border bg-white p-3 min-h-[220px]">
          {qr ? (
            isBase64Png ? (
              <img src={`data:image/png;base64,${qr}`} alt="QR" className="h-56 w-56 object-contain" />
            ) : (
              <QRCodeSVG value={qr} size={224} level="M" />
            )
          ) : (
            <div className="text-xs text-ink-muted">אין QR זמין כרגע — נסה לרענן.</div>
          )}
        </div>

        <div className="flex items-center justify-between text-xs text-ink-muted">
          <span>סטטוס: {label('pairingStatus', status?.state ?? 'idle')}</span>
          <Button size="sm" variant="secondary" onClick={refresh} loading={refreshing} leftIcon={<RefreshCcw className="h-3.5 w-3.5" />}>
            רענן QR
          </Button>
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
              <div className="text-ink-muted">{formatDate(c.createdAt)}</div>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
