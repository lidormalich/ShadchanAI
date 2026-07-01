// ═══════════════════════════════════════════════════════════
// Pending channels — ערוצים/קבוצות בהמתנה.
//
// Surfaces unmapped WhatsApp chats that already have messages the
// ingestion gate held back (decision = ignored_unmapped) — i.e. new
// groups that appeared after setup and whose messages are sitting in
// the DB untouched. The operator decides per chat:
//   • אשר כמקור פרופילים — map as profiles_source; optionally backfill
//     everything that already arrived into the extraction pipeline.
//   • התעלם — map as ignore; messages stay stored but are never processed.
//   • סרוק היסטוריה — best-effort pull of older history from WhatsApp.
// ═══════════════════════════════════════════════════════════

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Hourglass, History, RefreshCw, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, CardBody, CardHeader, Select } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/states/states';
import { channelsApi, type DiscoveredChat } from '@/services/api/channels';
import { toast } from '@/components/ui/Toast';

// Maps the server's history-sync skip reasons to clear Hebrew.
const HISTORY_REASON_HE: Record<string, string> = {
  session_not_connected: 'הסשן אינו מחובר — חבר אותו ונסה שוב.',
  unsupported_by_provider: 'הספק הנוכחי לא תומך במשיכת היסטוריה.',
  no_anchor_message: 'אין עדיין אף הודעה מהצ׳אט הזה — היסטוריה נמשכת רק אחרי שהגיעה לפחות הודעה אחת חיה. המתן שתגיע הודעה חדשה ואז נסה שוב.',
};

export function PendingChannelsPage() {
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);

  const channels = useQuery({
    queryKey: ['channels'],
    queryFn: () => channelsApi.list({ limit: 100 }),
  });

  // Auto-select the first active channel once data arrives.
  useEffect(() => {
    if (selectedChannel) return;
    const data = channels.data?.data ?? [];
    const firstActive = data.find((c) => c.status === 'active') ?? data[0];
    if (firstActive) setSelectedChannel(firstActive.channelId);
  }, [selectedChannel, channels.data]);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold inline-flex items-center gap-2">
          <Hourglass className="h-5 w-5" /> ערוצים/קבוצות בהמתנה
        </h2>
        <p className="text-sm text-ink-muted">
          צ׳אטים שטרם מופו אך כבר הגיעו מהם הודעות. החלט אם להוסיף אותם למאגר (ולעבד את מה שכבר הצטבר) או להתעלם.
        </p>
      </div>

      <Card className="p-3 flex items-center gap-3 flex-wrap">
        <span className="text-xs text-ink-muted">ערוץ:</span>
        <Select
          value={selectedChannel ?? ''}
          onChange={(e) => setSelectedChannel(e.target.value || null)}
          disabled={channels.isLoading}
        >
          <option value="">— בחר ערוץ —</option>
          {(channels.data?.data ?? []).map((c) => (
            <option key={c.channelId} value={c.channelId}>
              {c.accountDisplayName} ({c.channelId}) · {c.role} · {c.status}
            </option>
          ))}
        </Select>
      </Card>

      {selectedChannel && <PendingList channelId={selectedChannel} />}
    </div>
  );
}

function PendingList({ channelId }: { channelId: string }) {
  const pending = useQuery({
    queryKey: ['channel', channelId, 'pending'],
    queryFn: () => channelsApi.listPending(channelId),
    refetchInterval: 30_000,
  });

  if (pending.isLoading && !pending.data) return <LoadingSkeleton rows={6} />;
  if (pending.isError) {
    return <ErrorState description={(pending.error as Error).message} onRetry={() => pending.refetch()} />;
  }
  const result = pending.data!.data;
  const withWaiting = result.chats.filter((c) => (c.pendingMessageCount ?? 0) > 0).length;

  return (
    <div className="space-y-3">
      {!result.liveSessionAvailable ? (
        <Card className="p-3 border-amber-200 bg-amber-50 text-xs text-amber-900 space-y-1">
          <div>
            הסשן של WhatsApp אינו מחובר{result.liveState ? ` (מצב: ${result.liveState})` : ''}, לכן לא ניתן למשוך את רשימת הקבוצות המלאה — מוצגות רק שיחות מוכרות.
          </div>
          <div>
            חבר את הסשן בעמוד <span className="font-semibold">ערוצי WhatsApp</span> (התחל סשן / חבר מחדש), ואז לחץ רענן.
          </div>
        </Card>
      ) : result.groupsFetched === 0 && (
        <Card className="p-3 border-amber-200 bg-amber-50 text-xs text-amber-900 space-y-1">
          <div>הסשן מחובר אך WhatsApp החזיר 0 קבוצות.</div>
          {result.groupFetchError
            ? <div>שגיאה בשליפת קבוצות: <span className="font-mono">{result.groupFetchError}</span></div>
            : <div>ייתכן שהסנכרון הראשוני עדיין לא הושלם — המתן כמה שניות ולחץ רענן. אם אתה חבר בקבוצות תחת המספר המחובר והן עדיין לא מופיעות, נסה לחבר מחדש את הסשן.</div>}
        </Card>
      )}
      <Card className="p-3 flex items-center gap-3 flex-wrap">
        <Button
          size="sm"
          variant="secondary"
          leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
          onClick={() => pending.refetch()}
          loading={pending.isFetching}
        >
          רענן
        </Button>
        <span className="text-xs text-ink-faint ms-auto">
          {result.liveSessionAvailable
            ? `${result.chats.length} צ׳אטים לא ממופים · ${withWaiting} עם הודעות ממתינות`
            : 'הסשן לא מחובר — מוצגות שיחות מוכרות בלבד'}
        </span>
      </Card>

      {result.chats.length === 0 ? (
        <Card className="p-5">
          <EmptyState
            title="אין צ׳אטים בהמתנה"
            description="כל הצ׳אטים מופו. צ׳אט חדש שטרם מופה יופיע כאן."
          />
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold">{result.chats.length} צ׳אטים לא ממופים</h3>
          </CardHeader>
          <CardBody className="!p-0">
            <ul className="divide-y divide-border">
              {result.chats.map((chat) => (
                <PendingRow key={chat.chatJid} channelId={channelId} chat={chat} />
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function PendingRow({ channelId, chat }: { channelId: string; chat: DiscoveredChat }) {
  const qc = useQueryClient();
  const [approveOpen, setApproveOpen] = useState(false);
  const pendingCount = chat.pendingMessageCount ?? 0;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['channel', channelId, 'pending'] });
    qc.invalidateQueries({ queryKey: ['channel', channelId, 'chats'] });
  };

  const approve = useMutation({
    mutationFn: (backfillExisting: boolean) =>
      channelsApi.assignChatRole(channelId, {
        chatJid: chat.chatJid,
        chatType: chat.chatType,
        chatName: chat.name,
        role: 'profiles_source',
        backfillExisting,
      }),
    onSuccess: (res) => {
      setApproveOpen(false);
      const n = res.data?.backfilled ?? 0;
      toast.success('הצ׳אט נוסף למאגר', n > 0 ? `${n} הודעות נשלחו לעיבוד` : undefined);
      invalidate();
    },
    onError: (err) => toast.error('האישור נכשל', (err as Error).message),
  });

  const ignore = useMutation({
    mutationFn: () =>
      channelsApi.assignChatRole(channelId, {
        chatJid: chat.chatJid,
        chatType: chat.chatType,
        chatName: chat.name,
        role: 'ignore',
      }),
    onSuccess: () => {
      toast.success('הצ׳אט סומן כהתעלמות');
      invalidate();
    },
    onError: (err) => toast.error('העדכון נכשל', (err as Error).message),
  });

  const history = useMutation({
    mutationFn: () => channelsApi.historySync(channelId, chat.chatJid),
    onSuccess: (res) => {
      if (res.data?.requested) toast.success('בקשת היסטוריה נשלחה', 'הודעות ישנות יותר יופיעו בקרוב');
      else toast.info('לא ניתן לסרוק היסטוריה כעת', HISTORY_REASON_HE[res.data?.reason ?? ''] ?? res.data?.reason);
    },
    onError: (err) => toast.error('סריקת ההיסטוריה נכשלה', (err as Error).message),
  });

  return (
    <li className="px-5 py-3 flex items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="text-sm font-medium truncate">{chat.name}</div>
          <Badge tone={chat.chatType === 'group' ? 'info' : 'neutral'}>
            <Users className="h-3 w-3 ms-1 inline" />
            {chat.chatType === 'group' ? 'קבוצה' : 'פרטי'}
          </Badge>
          {pendingCount > 0 ? (
            <Badge tone="warning">{pendingCount} הודעות בהמתנה</Badge>
          ) : (
            <Badge tone="neutral">אין הודעות ממתינות</Badge>
          )}
        </div>
        <div className="text-[11px] text-ink-faint mt-0.5 font-mono truncate">
          {chat.chatJid}
          {typeof chat.participantCount === 'number' && ` · ${chat.participantCount} משתתפים`}
          {chat.lastPendingAt && ` · אחרון ${new Date(chat.lastPendingAt).toLocaleString('he-IL')}`}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button size="sm" variant="primary" onClick={() => setApproveOpen(true)}>
          אשר כמקור פרופילים
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => ignore.mutate()}
          loading={ignore.isPending}
        >
          התעלם
        </Button>
        <Button
          size="sm"
          variant="subtle"
          leftIcon={<History className="h-3.5 w-3.5" />}
          onClick={() => history.mutate()}
          loading={history.isPending}
        >
          סרוק היסטוריה
        </Button>
      </div>

      <Dialog
        open={approveOpen}
        onClose={() => setApproveOpen(false)}
        title={`הוספת "${chat.name}" למאגר`}
        description={
          pendingCount > 0
            ? `הצ׳אט "${chat.name}" — נמצאו ${pendingCount} הודעות בהמתנה. לעבד אותן עכשיו וליצור מהן מועמדים?`
            : `הצ׳אט "${chat.name}" — מעתה ייקלטו ממנו פרופילים. אין הודעות קודמות לעיבוד.`
        }
        primaryAction={{
          label: pendingCount > 0 ? 'אשר ועבד הכול' : 'אשר',
          onClick: () => approve.mutate(pendingCount > 0),
          loading: approve.isPending,
        }}
        secondaryAction={
          pendingCount > 0
            ? { label: 'אשר בלי לעבד', onClick: () => approve.mutate(false) }
            : undefined
        }
      />
    </li>
  );
}
