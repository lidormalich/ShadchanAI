// ═══════════════════════════════════════════════════════════
// Internal monitoring dashboard (admin-only).
//
// Not for shadchan operators. Intentionally plain: cards +
// numbers + bar stubs. Polls every 12 s. Alerts are highlighted
// in-line (yellow/red) based on backend-computed booleans.
// ═══════════════════════════════════════════════════════════

import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Inbox,
  MessageSquare,
  Send,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, Card, CardBody, CardHeader } from '@/components/ui/primitives';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/states/states';
import { monitoringApi, type MonitoringEvent, type MonitoringOverview } from '@/services/api/monitoring';

const POLL_MS = 12_000;

export function MonitoringPage() {
  const overview = useQuery({
    queryKey: ['monitoring', 'overview'],
    queryFn: () => monitoringApi.overview(24),
    refetchInterval: POLL_MS,
  });
  const events = useQuery({
    queryKey: ['monitoring', 'events'],
    queryFn: () => monitoringApi.events(100),
    refetchInterval: POLL_MS,
  });

  if (overview.isLoading && !overview.data) {
    return <div className="p-6"><LoadingSkeleton rows={12} /></div>;
  }
  if (overview.isError) {
    return (
      <ErrorState
        description={(overview.error as Error).message}
        onRetry={() => overview.refetch()}
      />
    );
  }
  const o = overview.data?.data;
  if (!o) return null;

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold inline-flex items-center gap-2">
            <Activity className="h-5 w-5" /> ניטור מערכת
          </h2>
          <p className="text-xs text-ink-muted">
            חלון {o.windowHours} שעות · רענון אוטומטי כל {POLL_MS / 1000} שניות · עודכן {new Date(o.generatedAt).toLocaleTimeString('he-IL')}
          </p>
        </div>
        <ActiveAlerts alerts={o.alerts} />
      </header>

      <SafeModePanel safeMode={o.safeMode} />
      <SystemHealth sessions={o.whatsappSessions} />

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Section title="קליטה (Ingestion)" icon={<Inbox className="h-4 w-4" />}>
          <Metric label="הודעות בשעה האחרונה" value={o.ingestion.messagesLastHour} />
          <Metric label="פרופילים שזוהו" value={o.ingestion.profilesDetected} />
          <Metric label="דולגו ללא טקסט" value={o.ingestion.profilesSkippedNoText} tone={o.ingestion.profilesSkippedNoText > 0 ? 'warn' : undefined} />
          <Metric
            label="כפילויות זוהו"
            value={o.ingestion.duplicatesDetected}
            tone={o.alerts.highDuplicateRate ? 'bad' : o.ingestion.duplicatesDetected > 0 ? 'warn' : undefined}
          />
        </Section>

        <Section title="חילוץ (Extraction)" icon={<Sparkles className="h-4 w-4" />}>
          <Metric label="הצלחות" value={o.extraction.successCount} tone="good" />
          <Metric label="כשלים" value={o.extraction.failureCount} tone={o.extraction.failureCount > 0 ? 'bad' : undefined} />
          <Metric
            label="גודל תור הסקירה"
            value={o.extraction.reviewQueueSize}
            tone={o.alerts.highReviewQueue ? 'bad' : o.extraction.reviewQueueSize > 0 ? 'warn' : undefined}
          />
        </Section>

        <Section title="התאמה (Matching)" icon={<CheckCircle2 className="h-4 w-4" />}>
          <Metric label="הצעות שנוצרו" value={o.matching.matchesCreated} />
          <Metric label="עם חסימות (נכפו)" value={o.matching.blockedCount} tone={o.matching.blockedCount > 0 ? 'warn' : undefined} />
          <Metric label="כפיות override" value={o.matching.overrideCount} tone={o.matching.overrideCount > 0 ? 'warn' : undefined} />
          <Metric label="ציון ממוצע" value={o.matching.avgScore ?? '—'} />
        </Section>

        <Section title="תקשורת (Communication)" icon={<Send className="h-4 w-4" />}>
          <Metric label="הצעות נשלחו" value={o.communication.proposalsSent} />
          <Metric
            label="תגובות התקבלו"
            value={o.communication.responsesReceived}
            tone={o.alerts.noResponses ? 'bad' : undefined}
          />
          <ResponseBar
            accepted={o.communication.acceptedCount}
            declined={o.communication.declinedCount}
            considering={o.communication.consideringCount}
          />
        </Section>

        <Section title="סיכונים (Risks)" icon={<ShieldAlert className="h-4 w-4" />}>
          <Metric
            label="כפילות טלפון"
            value={o.risks.duplicatePhoneEvents}
            tone={o.alerts.highDuplicateRate ? 'bad' : o.risks.duplicatePhoneEvents > 0 ? 'warn' : undefined}
          />
          <Metric
            label="ניסיונות לא-בעלים"
            value={o.risks.notOwnerAttempts}
            tone={o.alerts.manyNotOwnerAttempts ? 'bad' : o.risks.notOwnerAttempts > 0 ? 'warn' : undefined}
          />
          <Metric
            label="כפל-שליחה נחסמו"
            value={o.risks.alreadySendingErrors}
            tone={o.risks.alreadySendingErrors > 0 ? 'warn' : undefined}
          />
          <Metric
            label="כפיות התאמה"
            value={o.risks.forceMatchCount}
            tone={o.risks.forceMatchCount > 0 ? 'warn' : undefined}
          />
          <Metric
            label="שליחות שנחסמו (safe mode)"
            value={o.risks.sendBlockedSafeModeCount}
            tone={o.risks.sendBlockedSafeModeCount > 0 ? 'warn' : undefined}
          />
        </Section>

        <Section title="זרם אירועים (Event Stream)" icon={<MessageSquare className="h-4 w-4" />}>
          <EventStream events={events.data?.data ?? []} loading={events.isLoading} />
        </Section>
      </div>
    </div>
  );
}

function ActiveAlerts({ alerts }: { alerts: MonitoringOverview['alerts'] }) {
  const active: Array<{ label: string; tone: 'warning' | 'danger' }> = [];
  if (alerts.safeModeActive)          active.push({ label: 'מצב בטיחות פעיל',       tone: 'warning' });
  if (alerts.highDuplicateRate)       active.push({ label: 'כפילויות גבוהות',       tone: 'danger' });
  if (alerts.highReviewQueue)         active.push({ label: 'תור סקירה גדול',         tone: 'danger' });
  if (alerts.noResponses)             active.push({ label: 'אין תגובות בתקופה',     tone: 'warning' });
  if (alerts.manyNotOwnerAttempts)    active.push({ label: 'ניסיונות לא-בעלים',     tone: 'warning' });
  if (active.length === 0) {
    return <span className="inline-flex items-center gap-1 text-xs text-success"><CheckCircle2 className="h-4 w-4" /> הכול תקין</span>;
  }
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {active.map((a) => (
        <Badge key={a.label} tone={a.tone}>
          <AlertTriangle className="h-3 w-3 ms-1 inline" /> {a.label}
        </Badge>
      ))}
    </div>
  );
}

function SafeModePanel({ safeMode }: { safeMode: MonitoringOverview['safeMode'] }) {
  const enabled = safeMode.outboundEnabled;
  return (
    <Card className={enabled ? '' : 'border-amber-300 bg-amber-50/40'}>
      <CardHeader>
        <h3 className="text-sm font-semibold inline-flex items-center gap-2">
          <ShieldAlert className={`h-4 w-4 ${enabled ? 'text-success' : 'text-warning'}`} />
          מצב בטיחות (Safe Mode)
        </h3>
      </CardHeader>
      <CardBody className="space-y-2">
        <div className="flex items-center gap-2">
          <Badge tone={enabled ? 'success' : 'warning'}>
            {enabled ? 'שליחה מופעלת' : 'שליחה מושבתת'}
          </Badge>
          {safeMode.reason && <span className="text-xs text-ink-muted">{safeMode.reason}</span>}
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">env ENABLE_OUTBOUND_MESSAGES</span>
            <Badge tone={safeMode.envEnabled ? 'success' : 'neutral'}>{String(safeMode.envEnabled)}</Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">setting outbound.enabled</span>
            <Badge tone={safeMode.settingEnabled ? 'success' : 'neutral'}>{String(safeMode.settingEnabled)}</Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">requireExplicitMapping</span>
            <Badge tone={safeMode.requireExplicitMapping ? 'success' : 'warning'}>{String(safeMode.requireExplicitMapping)}</Badge>
          </div>
        </div>
        {!enabled && (
          <p className="text-[11px] text-ink-muted">
            כל ניסיון לשלוח ייחסם בשרת ויירשם כ־SEND_BLOCKED_SAFE_MODE ביומן הביקורת. אין סיכון של "נשלח לכאורה" למעלה במערכת.
          </p>
        )}
      </CardBody>
    </Card>
  );
}

function SystemHealth({ sessions }: { sessions: MonitoringOverview['whatsappSessions'] }) {
  return (
    <Card>
      <CardHeader>
        <h3 className="text-sm font-semibold inline-flex items-center gap-2">
          <Activity className="h-4 w-4" /> מצב ערוצי WhatsApp
        </h3>
      </CardHeader>
      <CardBody>
        {sessions.length === 0 ? (
          <EmptyState title="אין ערוצים רשומים" description="הוסף ערוץ ב-/channels." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-ink-muted">
                <th className="text-start py-1">ערוץ</th>
                <th className="text-start py-1">תפקיד</th>
                <th className="text-start py-1">סטטוס</th>
                <th className="text-start py-1">בריאות</th>
                <th className="text-start py-1">פעילות אחרונה</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.channelId} className="border-t border-border">
                  <td className="py-1 font-mono text-xs">{s.channelId}</td>
                  <td className="py-1">{s.role}</td>
                  <td className="py-1">
                    <Badge tone={statusTone(s.status)}>{s.status}</Badge>
                  </td>
                  <td className="py-1">
                    <Badge tone={s.connectionHealth === 'healthy' ? 'success' : s.connectionHealth === 'degraded' ? 'warning' : 'danger'}>
                      {s.connectionHealth}
                    </Badge>
                  </td>
                  <td className="py-1 text-xs text-ink-muted">
                    {s.lastActivityAt ? new Date(s.lastActivityAt).toLocaleString('he-IL') : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardBody>
    </Card>
  );
}

function statusTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'active') return 'success';
  if (status === 'rate_limited') return 'warning';
  if (status === 'disconnected' || status === 'suspended' || status === 'replaced') return 'danger';
  return 'neutral';
}

function Section({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <h3 className="text-sm font-semibold inline-flex items-center gap-2">{icon} {title}</h3>
      </CardHeader>
      <CardBody className="space-y-2">{children}</CardBody>
    </Card>
  );
}

function Metric({
  label, value, tone,
}: {
  label: string;
  value: number | string;
  tone?: 'good' | 'warn' | 'bad';
}) {
  const toneClass =
    tone === 'good' ? 'text-success' :
    tone === 'warn' ? 'text-warning' :
    tone === 'bad'  ? 'text-danger'  : 'text-ink';
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-ink-muted">{label}</span>
      <span className={`num font-semibold ${toneClass}`}>{value}</span>
    </div>
  );
}

function ResponseBar({ accepted, declined, considering }: { accepted: number; declined: number; considering: number }) {
  const total = Math.max(1, accepted + declined + considering);
  const pct = (n: number) => `${Math.round((n / total) * 100)}%`;
  return (
    <div className="space-y-1 pt-1">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-success">אישורים {accepted}</span>
        <span className="text-ink-faint">·</span>
        <span className="text-danger">סירובים {declined}</span>
        <span className="text-ink-faint">·</span>
        <span className="text-ink-muted">שוקלים {considering}</span>
      </div>
      <div className="flex h-1.5 rounded-full overflow-hidden bg-bg-subtle">
        <div className="bg-success" style={{ width: pct(accepted) }} />
        <div className="bg-danger"  style={{ width: pct(declined) }} />
        <div className="bg-ink-muted" style={{ width: pct(considering) }} />
      </div>
    </div>
  );
}

function EventStream({ events, loading }: { events: MonitoringEvent[]; loading: boolean }) {
  if (loading && events.length === 0) return <LoadingSkeleton rows={6} />;
  if (events.length === 0) return <EmptyState title="אין אירועים" />;
  return (
    <ul className="space-y-1 max-h-80 overflow-y-auto">
      {events.map((e, i) => (
        <li key={`${e.type}-${e.timestamp}-${i}`} className="text-xs flex items-start gap-2">
          <EventTypeIcon type={e.type} />
          <div className="min-w-0 flex-1">
            <div>
              <span className="font-mono font-semibold">{e.type}</span>
              {e.entityId && <span className="ms-2 font-mono text-ink-faint">#{e.entityId.slice(-6)}</span>}
              {e.type === 'ERROR' && e.metadata?.kind != null && (
                <span className="ms-2 text-danger">{String(e.metadata.kind)}</span>
              )}
            </div>
            <div className="text-[10px] text-ink-faint">
              {new Date(e.timestamp).toLocaleString('he-IL')}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function EventTypeIcon({ type }: { type: MonitoringEvent['type'] }) {
  if (type === 'ERROR') return <AlertCircle className="h-3.5 w-3.5 text-danger mt-0.5 shrink-0" />;
  if (type === 'FORCE_MATCH') return <ShieldAlert className="h-3.5 w-3.5 text-warning mt-0.5 shrink-0" />;
  if (type === 'SEND_BLOCKED') return <ShieldAlert className="h-3.5 w-3.5 text-warning mt-0.5 shrink-0" />;
  if (type === 'PROPOSAL_SENT') return <Send className="h-3.5 w-3.5 text-brand mt-0.5 shrink-0" />;
  if (type === 'RESPONSE_DETECTED') return <MessageSquare className="h-3.5 w-3.5 text-brand mt-0.5 shrink-0" />;
  return <CheckCircle2 className="h-3.5 w-3.5 text-ink-faint mt-0.5 shrink-0" />;
}
