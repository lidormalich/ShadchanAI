// ═══════════════════════════════════════════════════════════
// Channel mappings — pre-pilot safety surface (discovery-based).
//
// Lists the REAL WhatsApp chats/groups from the paired Baileys
// session, merged with conversations we've already seen and any
// existing ChatMapping rows. The operator assigns a role per
// chatJid. Ingestion is blocked until a chat is explicitly mapped
// as profiles_source.
// ═══════════════════════════════════════════════════════════

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Filter, RefreshCw, Search, ShieldAlert, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, CardBody, CardHeader, Input, Select } from '@/components/ui/primitives';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/states/states';
import { channelsApi, type DiscoveredChat } from '@/services/api/channels';
import { toast } from '@/components/ui/Toast';

type RoleFilter = 'unmapped' | 'profiles_source' | 'match_sending' | 'ignore' | 'all';

const ROLE_OPTIONS: Array<{ value: NonNullable<DiscoveredChat['role']>; label: string }> = [
  { value: 'profiles_source', label: 'מקור פרופילים' },
  { value: 'match_sending',   label: 'שליחת הצעות' },
  { value: 'ignore',          label: 'התעלם' },
];

export function ChannelMappingsPage() {
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
          <ShieldAlert className="h-5 w-5" /> מיפוי שיחות לתפקיד
        </h2>
        <p className="text-sm text-ink-muted">
          רשימת הצ׳אטים/קבוצות של חשבון ה־WhatsApp המצומד. סמן בפירוש מאילו יש לקלוט פרופילים. ללא מיפוי — אין קליטה.
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

      {selectedChannel && <ChatList channelId={selectedChannel} />}
    </div>
  );
}

function ChatList({ channelId }: { channelId: string }) {
  const [filter, setFilter] = useState<RoleFilter>('unmapped');
  const [search, setSearch] = useState('');

  const discovery = useQuery({
    queryKey: ['channel', channelId, 'chats'],
    queryFn: () => channelsApi.listChats(channelId),
    refetchInterval: 30_000,
  });

  if (discovery.isLoading && !discovery.data) return <LoadingSkeleton rows={6} />;
  if (discovery.isError) {
    return (
      <ErrorState
        description={(discovery.error as Error).message}
        onRetry={() => discovery.refetch()}
      />
    );
  }
  const result = discovery.data!.data;

  const q = search.trim().toLowerCase();
  const filtered = result.chats.filter((c) => {
    const roleOk =
      filter === 'all' ? true
      : filter === 'unmapped' ? !c.role
      : c.role === filter;
    if (!roleOk) return false;
    if (!q) return true;
    return (c.name?.toLowerCase().includes(q) ?? false) || c.chatJid.toLowerCase().includes(q);
  });

  return (
    <div className="space-y-3">
      {!result.liveSessionAvailable ? (
        <Card className="p-3 border-amber-200 bg-amber-50 text-xs text-amber-900">
          הסשן אינו מחובר{result.liveState ? ` (מצב: ${result.liveState})` : ''} — מוצגות רק שיחות מוכרות ומיפויים קיימים.
          חבר את הסשן בעמוד <span className="font-semibold">ערוצי WhatsApp</span>, ואז לחץ "רענן רשימה".
        </Card>
      ) : result.groupsFetched === 0 && (
        <Card className="p-3 border-amber-200 bg-amber-50 text-xs text-amber-900">
          {result.groupFetchError
            ? <>הסשן מחובר אך שליפת הקבוצות נכשלה: <span className="font-mono">{result.groupFetchError}</span></>
            : <>הסשן מחובר אך WhatsApp החזיר 0 קבוצות. אם אתה חבר בקבוצות תחת המספר המחובר, המתן כמה שניות ולחץ "רענן רשימה", או חבר מחדש את הסשן.</>}
        </Card>
      )}
      <Card className="p-3 flex items-center gap-3 flex-wrap">
        <Filter className="h-4 w-4 text-ink-faint" />
        <Select value={filter} onChange={(e) => setFilter(e.target.value as RoleFilter)}>
          <option value="unmapped">ללא מיפוי</option>
          <option value="profiles_source">מקור פרופילים</option>
          <option value="match_sending">שליחת הצעות</option>
          <option value="ignore">מתעלם</option>
          <option value="all">הכול</option>
        </Select>
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="absolute top-1/2 -translate-y-1/2 start-2 h-3.5 w-3.5 text-ink-faint pointer-events-none" />
          <Input
            className="ps-7"
            placeholder="חיפוש לפי שם או מזהה…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button
          size="sm"
          variant="secondary"
          leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
          onClick={() => discovery.refetch()}
          loading={discovery.isFetching}
        >
          רענן רשימה
        </Button>
        <span className="text-xs text-ink-faint ms-auto">
          {result.liveSessionAvailable
            ? `נטענה מהסשן · ${result.groupsFetched} קבוצות · ${result.chats.length} סה״כ`
            : 'הסשן לא מחובר — מוצגות רק שיחות מוכרות ומיפויים קיימים'}
        </span>
      </Card>

      {filtered.length === 0 ? (
        <Card className="p-5">
          <EmptyState
            title={q ? 'אין תוצאות לחיפוש' : 'אין שיחות בקטגוריה זו'}
            description={
              q ? `לא נמצאה שיחה התואמת "${search.trim()}".`
              : filter === 'unmapped' ? 'כל השיחות מופו. שיחות חדשות יופיעו כאן.'
              : undefined
            }
          />
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold">{filtered.length} שיחות / קבוצות</h3>
          </CardHeader>
          <CardBody className="!p-0">
            <ul className="divide-y divide-border">
              {filtered.map((chat) => (
                <ChatRow key={chat.chatJid} channelId={channelId} chat={chat} />
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function ChatRow({ channelId, chat }: { channelId: string; chat: DiscoveredChat }) {
  const qc = useQueryClient();
  const assign = useMutation({
    mutationFn: (role: NonNullable<DiscoveredChat['role']> | null) =>
      channelsApi.assignChatRole(channelId, {
        chatJid: chat.chatJid,
        chatType: chat.chatType,
        chatName: chat.name,
        role,
      }),
    onSuccess: () => {
      toast.success('המיפוי עודכן');
      qc.invalidateQueries({ queryKey: ['channel', channelId, 'chats'] });
    },
    onError: (err) => toast.error('עדכון המיפוי נכשל', (err as Error).message),
  });

  const currentTone =
    chat.role === 'profiles_source' ? 'success' :
    chat.role === 'match_sending'   ? 'purple'  :
    chat.role === 'ignore'          ? 'neutral' : 'warning';

  return (
    <li className="px-5 py-3 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="text-sm font-medium truncate">{chat.name}</div>
          <Badge tone={chat.chatType === 'group' ? 'info' : 'neutral'}>
            <Users className="h-3 w-3 ms-1 inline" />
            {chat.chatType === 'group' ? 'קבוצה' : 'פרטי'}
          </Badge>
          <Badge tone={currentTone}>
            {chat.role === 'profiles_source' ? 'מקור פרופילים'
              : chat.role === 'match_sending' ? 'שליחת הצעות'
              : chat.role === 'ignore' ? 'מתעלם'
              : 'לא מופה'}
          </Badge>
          {chat.hasConversation && <Badge tone="neutral">נצפתה</Badge>}
        </div>
        <div className="text-[11px] text-ink-faint mt-0.5 font-mono truncate">
          {chat.chatJid}
          {typeof chat.participantCount === 'number' && ` · ${chat.participantCount} משתתפים`}
          {chat.lastMessageAt && ` · אחרון ${new Date(chat.lastMessageAt).toLocaleString('he-IL')}`}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 md:shrink-0">
        {ROLE_OPTIONS.map((r) => (
          <Button
            key={r.value}
            size="sm"
            variant={chat.role === r.value ? 'primary' : 'secondary'}
            disabled={assign.isPending && assign.variables === r.value}
            onClick={() => assign.mutate(r.value)}
          >
            {r.label}
          </Button>
        ))}
        {chat.role && (
          <Button
            size="sm"
            variant="subtle"
            disabled={assign.isPending && assign.variables === null}
            onClick={() => assign.mutate(null)}
          >
            נקה
          </Button>
        )}
      </div>
    </li>
  );
}
