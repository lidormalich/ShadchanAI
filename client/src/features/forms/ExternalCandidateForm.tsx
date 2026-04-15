// ═══════════════════════════════════════════════════════════
// External Candidate create/edit form.
// ═══════════════════════════════════════════════════════════

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Drawer } from '@/components/ui/Drawer';
import { Button, Input, Select, Textarea } from '@/components/ui/primitives';
import { toast } from '@/components/ui/Toast';
import { externalCandidatesApi } from '@/services/api/candidates';
import { label } from '@/utils/labels';
import type { ExternalCandidate } from '@/types/domain';

const SECTORS = ['dati_leumi', 'haredi', 'dati', 'masorti', 'hardal', 'torani', 'other'];
const SOURCES = ['whatsapp_group', 'matchmaker_referral', 'website', 'manual_entry', 'other'];
const AVAILABILITY = ['available', 'dating', 'unavailable', 'unknown'];
const AGE_CONF = ['exact', 'approximate', 'estimated', 'unknown'];

type Values = Partial<ExternalCandidate> & { ageReliability?: { ageConfidence?: string; reportedAgeAt?: string } };

export function ExternalCandidateForm({
  open, onClose, initial,
}: {
  open: boolean;
  onClose: () => void;
  initial?: ExternalCandidate;
}) {
  const qc = useQueryClient();
  const [v, setV] = useState<Values>({});
  useEffect(() => { setV(initial ?? { availabilityStatus: 'available', sourceType: 'manual_entry' }); }, [initial]);

  const save = useMutation({
    mutationFn: async () => initial?._id
      ? externalCandidatesApi.update(initial._id, v)
      : externalCandidatesApi.create(v),
    onSuccess: () => {
      toast.success(initial ? 'הפרופיל עודכן' : 'הפרופיל נוצר');
      qc.invalidateQueries({ queryKey: ['externals'] });
      if (initial?._id) qc.invalidateQueries({ queryKey: ['external', initial._id] });
      onClose();
    },
    onError: (err) => toast.error('השמירה נכשלה', (err as Error).message),
  });

  const set = <K extends keyof Values>(k: K, val: Values[K]) => setV((p) => ({ ...p, [k]: val }));

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={initial ? 'עריכת פרופיל חיצוני' : 'יצירת פרופיל חיצוני'}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>ביטול</Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>שמור</Button>
        </div>
      }
    >
      <div className="p-5 space-y-4">
        <Section title="מקור">
          <Row label="סוג מקור" required>
            <Select value={v.sourceType ?? 'manual_entry'} onChange={(e) => set('sourceType', e.target.value)}>
              {SOURCES.map((s) => <option key={s} value={s}>{label('sourceType', s)}</option>)}
            </Select>
          </Row>
          <Row label="שם המקור"><Input value={v.sourceName ?? ''} onChange={(e) => set('sourceName', e.target.value)} /></Row>
          <Row label="שם שדכן מקור"><Input value={v.sourceMatchmakerName ?? ''} onChange={(e) => set('sourceMatchmakerName', e.target.value)} /></Row>
        </Section>

        <Section title="פרטים בסיסיים">
          <Row label="שם פרטי"><Input value={v.firstName ?? ''} onChange={(e) => set('firstName', e.target.value)} /></Row>
          <Row label="שם משפחה"><Input value={v.lastName ?? ''} onChange={(e) => set('lastName', e.target.value)} /></Row>
          <Row label="מין">
            <Select value={v.gender ?? ''} onChange={(e) => set('gender', e.target.value)}>
              <option value="">—</option><option value="male">זכר</option><option value="female">נקבה</option>
            </Select>
          </Row>
          <Row label="גיל"><Input type="number" value={v.age ?? ''} onChange={(e) => set('age', Number(e.target.value))} /></Row>
          <Row label="עיר"><Input value={v.city ?? ''} onChange={(e) => set('city', e.target.value)} /></Row>
        </Section>

        <Section title="דיוק גיל">
          <Row label="אמינות גיל">
            <Select
              value={v.ageReliability?.ageConfidence ?? 'unknown'}
              onChange={(e) => set('ageReliability', { ...(v.ageReliability ?? {}), ageConfidence: e.target.value })}
            >
              {AGE_CONF.map((c) => <option key={c} value={c}>{label('ageConfidence', c)}</option>)}
            </Select>
          </Row>
        </Section>

        <Section title="זהות דתית">
          <Row label="מגזר">
            <Select value={v.sectorGroup ?? ''} onChange={(e) => set('sectorGroup', e.target.value)}>
              <option value="">—</option>
              {SECTORS.map((s) => <option key={s} value={s}>{label('sectorGroup', s)}</option>)}
            </Select>
          </Row>
          <Row label="זמינות" required>
            <Select value={v.availabilityStatus ?? 'available'} onChange={(e) => set('availabilityStatus', e.target.value)}>
              {AVAILABILITY.map((s) => <option key={s} value={s}>{label('availabilityStatus', s)}</option>)}
            </Select>
          </Row>
        </Section>

        <Section title="טקסט חופשי">
          <Row label="על עצמו" full><Textarea rows={3} value={v.about ?? ''} onChange={(e) => set('about', e.target.value)} /></Row>
          <Row label="מה מחפש" full><Textarea rows={3} value={v.whatSeeking ?? ''} onChange={(e) => set('whatSeeking', e.target.value)} /></Row>
        </Section>

        {/* Bidirectional preferences: OPTIONAL, used when the source
            provided them. The engine enforces these on the reverse
            direction (external-fits-internal) in addition to the
            forward direction. */}
        <Section title="העדפות (אופציונלי — לשימוש דו־כיווני)">
          <Row label="טווח גיל מבוקש — מ">
            <Input
              type="number"
              value={v.ageReliability ? '' : (((v as Record<string, unknown>)['agePreferences'] as { min?: number } | undefined)?.min ?? '')}
              onChange={(e) => {
                const curr = (((v as Record<string, unknown>)['agePreferences'] ?? {}) as { min?: number; max?: number; flexibility?: string });
                const min = e.target.value === '' ? undefined : Number(e.target.value);
                (set as unknown as (k: string, val: unknown) => void)('agePreferences', { ...curr, min });
              }}
            />
          </Row>
          <Row label="טווח גיל מבוקש — עד">
            <Input
              type="number"
              value={(((v as Record<string, unknown>)['agePreferences'] as { max?: number } | undefined)?.max ?? '')}
              onChange={(e) => {
                const curr = (((v as Record<string, unknown>)['agePreferences'] ?? {}) as { min?: number; max?: number; flexibility?: string });
                const max = e.target.value === '' ? undefined : Number(e.target.value);
                (set as unknown as (k: string, val: unknown) => void)('agePreferences', { ...curr, max });
              }}
            />
          </Row>
          <OpennessRow v={v} set={set as unknown as (k: string, val: unknown) => void} flag="openToOtherSectors" label="פתוח למגזרים אחרים" />
          <OpennessRow v={v} set={set as unknown as (k: string, val: unknown) => void} flag="openToDivorced" label="פתוח לגרוש/ה" />
          <OpennessRow v={v} set={set as unknown as (k: string, val: unknown) => void} flag="openToWithChildren" label="פתוח למועמד עם ילדים" />
          <OpennessRow v={v} set={set as unknown as (k: string, val: unknown) => void} flag="openToAgeDifference" label="פתוח לפערי גיל" />
          <OpennessRow v={v} set={set as unknown as (k: string, val: unknown) => void} flag="openToLongDistance" label="פתוח למרחק גיאוגרפי" />
        </Section>
      </div>
    </Drawer>
  );
}

function OpennessRow({
  v, set, flag, label,
}: {
  v: Record<string, unknown>;
  set: (k: string, val: unknown) => void;
  flag: string;
  label: string;
}) {
  const openness = (v['openness'] as Record<string, boolean | undefined> | undefined) ?? {};
  const current = openness[flag];
  // Tri-state: undefined (unknown) / true / false
  const next = (val: boolean | undefined) => {
    const upd = { ...openness, [flag]: val };
    set('openness', upd);
  };
  return (
    <div className="col-span-2 flex items-center justify-between gap-3 py-1">
      <span className="text-sm text-ink-muted">{label}</span>
      <div className="flex gap-1 p-0.5 rounded-md bg-bg-subtle border border-border text-xs">
        <button
          type="button"
          onClick={() => next(undefined)}
          className={`px-2 py-1 rounded ${current === undefined ? 'bg-white shadow-sm font-medium' : 'text-ink-muted'}`}
        >
          לא ידוע
        </button>
        <button
          type="button"
          onClick={() => next(true)}
          className={`px-2 py-1 rounded ${current === true ? 'bg-white shadow-sm font-medium text-success' : 'text-ink-muted'}`}
        >
          כן
        </button>
        <button
          type="button"
          onClick={() => next(false)}
          className={`px-2 py-1 rounded ${current === false ? 'bg-white shadow-sm font-medium text-danger' : 'text-ink-muted'}`}
        >
          לא
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{title}</div>
      <div className="grid grid-cols-2 gap-3">{children}</div>
    </div>
  );
}

function Row({ label, children, required, full }: { label: string; children: React.ReactNode; required?: boolean; full?: boolean }) {
  return (
    <div className={full ? 'col-span-2' : ''}>
      <label className="block text-xs font-medium text-ink-muted mb-1">
        {label}{required && <span className="text-danger"> *</span>}
      </label>
      {children}
    </div>
  );
}
