// ═══════════════════════════════════════════════════════════
// SourceCardTab — "כרטיס מקורי"
//
// Shows the original WhatsApp message(s) a candidate profile was
// extracted from — the raw "card" the AI received. External candidates
// imported from a group have linked source messages; internal (and any
// manually-created) candidates have no source, so we render a clear
// "no details" state instead of hiding the tab.
// ═══════════════════════════════════════════════════════════

import { useQuery } from '@tanstack/react-query';
import { FileText, MessageSquare } from 'lucide-react';
import { Badge, Card, CardBody, CardHeader } from '@/components/ui/primitives';
import { AuthImage } from '@/components/AuthImage';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/states/states';
import { externalCandidatesApi, internalCandidatesApi, type SourceCardMessage } from '@/services/api/candidates';
import { formatDate } from '@/utils/format';

export function SourceCardTab({ kind, candidateId }: { kind: 'internal' | 'external'; candidateId: string }) {
  const q = useQuery({
    queryKey: [kind, candidateId, 'source-card'],
    queryFn: () =>
      kind === 'external'
        ? externalCandidatesApi.sourceCard(candidateId)
        : internalCandidatesApi.sourceCard(candidateId),
    enabled: !!candidateId,
  });

  if (q.isLoading) return <LoadingSkeleton rows={5} />;
  if (q.isError) return <ErrorState description={(q.error as Error).message} onRetry={() => q.refetch()} />;

  const card = q.data?.data;
  if (!card || !card.hasSource) {
    return (
      <EmptyState
        icon={<FileText className="h-10 w-10 text-ink-faint" />}
        title="אין כרטיס מקורי"
        description="המועמד לא יובא מהודעת WhatsApp (נוצר ידנית), ולכן אין כרטיס מקורי להצגה."
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Source provenance */}
      <Card>
        <CardHeader><h3 className="text-sm font-semibold">מקור הכרטיס</h3></CardHeader>
        <CardBody className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
          {card.sourceGroupName && <Meta label="קבוצת WhatsApp" value={card.sourceGroupName} />}
          {card.sourceSenderName && <Meta label="נשלח ע״י" value={card.sourceSenderName} />}
          {card.sourceSenderPhone && <Meta label="טלפון השולח" value={card.sourceSenderPhone} />}
          {card.sourceName && <Meta label="מקור" value={card.sourceName} />}
          {card.sourceImportedAt && <Meta label="יובא בתאריך" value={formatDate(card.sourceImportedAt)} />}
          {card.lastSourceUpdateAt && <Meta label="עודכן ממקור" value={formatDate(card.lastSourceUpdateAt)} />}
        </CardBody>
      </Card>

      {/* The original message(s) — the exact text the AI extracted from */}
      {card.messages.length > 0 ? (
        <div className="space-y-3">
          {card.messages.map((m) => <SourceMessage key={m._id} m={m} />)}
        </div>
      ) : card.rawText ? (
        <Card>
          <CardHeader><h3 className="text-sm font-semibold">טקסט מקורי</h3></CardHeader>
          <CardBody>
            <pre className="whitespace-pre-wrap font-sans text-sm text-ink leading-relaxed">{card.rawText}</pre>
          </CardBody>
        </Card>
      ) : (
        <EmptyState
          icon={<MessageSquare className="h-10 w-10 text-ink-faint" />}
          title="ההודעות המקוריות אינן זמינות"
          description="הכרטיס יובא ממקור, אך הודעות המקור כבר לא נמצאות במערכת."
        />
      )}
    </div>
  );
}

function SourceMessage({ m }: { m: SourceCardMessage }) {
  const text = m.body || m.mediaCaption;
  return (
    <Card>
      <CardBody className="space-y-2">
        <div className="flex items-center gap-2 text-xs text-ink-muted flex-wrap">
          <MessageSquare className="h-3.5 w-3.5" />
          {m.senderName && <span className="font-medium text-ink">{m.senderName}</span>}
          {m.contentType && m.contentType !== 'text' && <Badge tone="neutral">{m.contentType}</Badge>}
          <span className="num ms-auto">{formatDate(m.createdAt)}</span>
        </div>
        {m.mediaUrl && (
          <AuthImage src={m.mediaUrl} alt={m.mediaCaption ?? 'מדיה'} className="max-h-80 rounded-md border border-border object-contain" />
        )}
        {text ? (
          <pre className="whitespace-pre-wrap font-sans text-sm text-ink leading-relaxed">{text}</pre>
        ) : (
          !m.mediaUrl && <div className="text-xs text-ink-faint">— ללא תוכן טקסט —</div>
        )}
      </CardBody>
    </Card>
  );
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-ink-muted">{label}</span>
      <span className="text-ink font-medium truncate">{value}</span>
    </div>
  );
}
