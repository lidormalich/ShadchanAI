import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, ClipboardCheck, Info, Sparkles, XCircle } from 'lucide-react';
import { useState } from 'react';
import {
  sandboxApi,
  type SandboxCheckResult,
  type ChunkType,
} from '@/services/api/sandbox';
import { Badge, Button, Card, CardBody, CardHeader, Divider, Textarea } from '@/components/ui/primitives';
import { ErrorState } from '@/components/states/states';
import { useSetPageTitle } from '@/layouts/PageTitleContext';
import { label, matchTypeTone } from '@/utils/labels';
import { ApiError } from '@/types/api';

const RISK_HE: Record<string, string> = {
  none: 'ללא',
  low: 'נמוך',
  medium: 'בינוני',
  high: 'גבוה',
};

const CHUNK_HE: Record<ChunkType, string> = {
  religious: 'זהות דתית',
  expectations: 'ציפיות',
  personality: 'אישיות',
  background: 'רקע',
};

const PLACEHOLDER =
  'הדביקו כאן את המידע על האדם — שם, גיל, עיר, מגזר, עיסוק, מה מחפש/ת, וכל פרט נוסף. אפשר להדביק כרטיס שלם מווטסאפ.';

export function CandidateCheckPage() {
  useSetPageTitle('בדוק מועמדים');

  const [sideA, setSideA] = useState('');
  const [sideB, setSideB] = useState('');
  const [mode, setMode] = useState<'strict' | 'discovery'>('strict');

  const check = useMutation({
    mutationFn: () => sandboxApi.check({ sideA, sideB, mode }),
  });

  const canSubmit = sideA.trim().length > 0 && sideB.trim().length > 0 && !check.isPending;
  const result = check.data?.data;

  return (
    <div className="space-y-6">
      {/* Intro */}
      <div>
        <h1 className="flex items-center gap-2 text-lg font-bold text-ink">
          <ClipboardCheck className="h-5 w-5 text-brand" />
          בדוק מועמדים
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          הדביקו מידע חופשי על שני אנשים וקבלו אחוז התאמה וסיכום — משני המנועים: מנוע ההתאמות החכם ומנוע
          הווקטורים. אין צורך לשמור מועמדים, הבדיקה חד-פעמית.
        </p>
      </div>

      {/* Inputs */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <SideInput title="צד א׳" value={sideA} onChange={setSideA} />
        <SideInput title="צד ב׳" value={sideB} onChange={setSideB} />
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 rounded-md border border-border p-1">
          {(['strict', 'discovery'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={
                'rounded px-3 py-1 text-xs font-medium transition-colors ' +
                (mode === m ? 'bg-brand text-white' : 'text-ink-muted hover:bg-bg-hover')
              }
            >
              {m === 'strict' ? 'מחמיר' : 'גילוי'}
            </button>
          ))}
        </div>
        <Button onClick={() => check.mutate()} disabled={!canSubmit} loading={check.isPending} leftIcon={<Sparkles className="h-4 w-4" />}>
          בדוק התאמה
        </Button>
        {check.isError && (
          <span className="text-sm text-danger">
            {check.error instanceof ApiError ? check.error.message : 'הבדיקה נכשלה'}
          </span>
        )}
      </div>

      {check.isError && !(check.error instanceof ApiError) && <ErrorState />}

      {result && <Results result={result} />}
    </div>
  );
}

function SideInput({ title, value, onChange }: { title: string; value: string; onChange: (v: string) => void }) {
  return (
    <Card>
      <CardHeader>
        <h3 className="text-sm font-semibold">{title}</h3>
      </CardHeader>
      <CardBody>
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={PLACEHOLDER}
          rows={9}
          className="w-full resize-y"
        />
      </CardBody>
    </Card>
  );
}

// ── Results ───────────────────────────────────────────────

function Results({ result }: { result: SandboxCheckResult }) {
  const { engine, semantic, ai, sides, warnings } = result;

  return (
    <div className="space-y-4">
      {warnings.length > 0 && (
        <div className="rounded-md border border-warning/40 bg-warning/5 p-3">
          <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-warning">
            <AlertTriangle className="h-4 w-4" /> לתשומת לב
          </div>
          <ul className="space-y-1 text-sm text-ink-muted">
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      {!engine.eligible && (
        <div className="rounded-md border border-danger/40 bg-danger/5 p-3">
          <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-danger">
            <XCircle className="h-4 w-4" /> המנוע חסם את ההתאמה
          </div>
          <ul className="space-y-1 text-sm text-ink">
            {engine.blockers.map((b, i) => <li key={i}>{b.message}</li>)}
          </ul>
        </div>
      )}

      {/* Score header */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">ניתוח מנוע ההתאמות</h3>
            <Badge tone={matchTypeTone(engine.matchType)}>{label('matchType', engine.matchType)}</Badge>
          </div>
        </CardHeader>
        <CardBody>
          <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
            <Stat label="ציון התאמה" value={`${engine.matchScore}`} tone="brand" />
            <Stat label="ביטחון" value={`${engine.confidenceScore}`} />
            <Stat label="סיכון" value={RISK_HE[engine.riskLevel] ?? engine.riskLevel} small />
            <Stat
              label="דמיון וקטורי"
              value={semantic.score !== undefined ? `${Math.round(semantic.score * 100)}%` : semantic.enabled ? '—' : 'כבוי'}
            />
          </div>

          <Divider className="my-4" />

          <div className="space-y-2">
            {engine.scoreBreakdown.map((d) => (
              <div key={d.dimension} className="flex items-center gap-2">
                <div className="w-36 text-xs text-ink-muted">{label('scoringDimension', d.dimension)}</div>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-subtle">
                  <div className="h-full rounded-full bg-brand" style={{ width: `${d.score}%` }} />
                </div>
                <div className="num w-8 text-end text-xs">{d.score}</div>
              </div>
            ))}
          </div>
        </CardBody>
      </Card>

      {/* Strengths / attention */}
      <Card>
        <CardHeader><h3 className="text-sm font-semibold">נקודות חוזק ונקודות לב</h3></CardHeader>
        <CardBody className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <BulletList title="חוזקות" tone="success" items={engine.strengths} />
          <BulletList title="נקודות לב" tone="warning" items={engine.attentionPoints} />
        </CardBody>
      </Card>

      {/* Vector highlights */}
      {semantic.enabled && semantic.perChunk && Object.keys(semantic.perChunk).length > 0 && (
        <Card>
          <CardHeader><h3 className="text-sm font-semibold">מנוע הווקטורים — דמיון לפי תחום</h3></CardHeader>
          <CardBody>
            <div className="flex flex-wrap gap-2">
              {(Object.entries(semantic.perChunk) as Array<[ChunkType, number]>).map(([chunk, sim]) => (
                <Badge key={chunk} tone={sim >= 0.7 ? 'success' : 'neutral'}>
                  {CHUNK_HE[chunk]}: {Math.round(sim * 100)}%
                </Badge>
              ))}
            </div>
          </CardBody>
        </Card>
      )}

      {/* AI narrative */}
      {ai && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-brand" />
              <h3 className="text-sm font-semibold">סיכום AI</h3>
            </div>
          </CardHeader>
          <CardBody className="space-y-3">
            {ai.summary && <p className="text-sm leading-relaxed text-ink">{ai.summary}</p>}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <BulletList title="חוזקות" tone="success" items={ai.strengths} />
              <BulletList title="חששות" tone="warning" items={ai.concerns} />
            </div>
            {ai.nuance && <Para title="ניואנס" text={ai.nuance} />}
            {ai.recommendedApproach && <Para title="גישה מומלצת" text={ai.recommendedApproach} />}
            {ai.notMatchReasons.length > 0 && (
              <BulletList title="סיבות שלא מתאים" tone="danger" items={ai.notMatchReasons} />
            )}
          </CardBody>
        </Card>
      )}

      {/* What we understood */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <UnderstoodCard title="מה הובן — צד א׳" side={sides.a} />
        <UnderstoodCard title="מה הובן — צד ב׳" side={sides.b} />
      </div>
    </div>
  );
}

function Stat({ label: l, value, tone, small }: { label: string; value: string; tone?: 'brand'; small?: boolean }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-ink-muted">{l}</div>
      <div className={(small ? 'text-xl' : 'text-3xl') + ' num font-semibold ' + (tone === 'brand' ? 'text-brand-700' : 'text-ink')}>
        {value}
      </div>
    </div>
  );
}

function BulletList({ title, tone, items }: { title: string; tone: 'success' | 'warning' | 'danger'; items: string[] }) {
  const toneClass = tone === 'success' ? 'text-success' : tone === 'warning' ? 'text-warning' : 'text-danger';
  return (
    <div>
      <div className={'mb-2 text-xs font-medium uppercase tracking-wide ' + toneClass}>{title}</div>
      {items.length === 0 ? (
        <div className="text-xs text-ink-muted">—</div>
      ) : (
        <ul className="list-disc space-y-1 ps-4 text-sm">{items.map((s, i) => <li key={i}>{s}</li>)}</ul>
      )}
    </div>
  );
}

function Para({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-muted">{title}</div>
      <p className="text-sm leading-relaxed text-ink">{text}</p>
    </div>
  );
}

function UnderstoodCard({ title, side }: { title: string; side: SandboxCheckResult['sides']['a'] }) {
  const p = side.profile;
  const rows: Array<[string, string | undefined]> = [
    ['שם', [p.firstName, p.lastName].filter(Boolean).join(' ') || undefined],
    ['מין', p.gender ? label('gender', p.gender) : undefined],
    ['גיל', p.age !== undefined ? String(p.age) : undefined],
    ['עיר', p.city],
    ['מגזר', p.sectorGroup ? label('sectorGroup', p.sectorGroup) : undefined],
    ['מצב אישי', p.personalStatus ? label('personalStatus', p.personalStatus) : undefined],
    ['עיסוק', p.occupation],
    ['מחפש/ת', p.whatSeeking],
  ];
  const filled = rows.filter(([, v]) => v);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">{title}</h3>
          <span className="flex items-center gap-1 text-[11px] text-ink-faint">
            <Info className="h-3 w-3" />
            {side.usedAI ? 'חולץ ע״י AI' : 'חולץ אוטומטית'} · ביטחון {Math.round(side.extractionConfidence * 100)}%
          </span>
        </div>
      </CardHeader>
      <CardBody>
        {filled.length === 0 ? (
          <div className="text-xs text-ink-muted">לא זוהו שדות מובנים מהטקסט.</div>
        ) : (
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-2">
            {filled.map(([k, v]) => (
              <div key={k} className="flex gap-2">
                <dt className="shrink-0 text-ink-muted">{k}:</dt>
                <dd className="text-ink">{v}</dd>
              </div>
            ))}
          </dl>
        )}
      </CardBody>
    </Card>
  );
}
