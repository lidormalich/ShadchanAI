// ═══════════════════════════════════════════════════════════
// External Candidate create/edit form.
// ═══════════════════════════════════════════════════════════

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Drawer } from '@/components/ui/Drawer';
import { Button, Input, Select, Textarea } from '@/components/ui/primitives';
import { toast } from '@/components/ui/Toast';
import { externalCandidatesApi } from '@/services/api/candidates';
import { type ProfileExtraction } from '@/services/api/ai';
import { describeApiError } from '@/utils/apiError';
import { CardImportButton } from './CardImportButton';
import { label } from '@/utils/labels';
import type { ExternalCandidate } from '@/types/domain';

const SECTORS = ['dati_leumi', 'haredi', 'dati', 'masorti', 'hardal', 'torani', 'other'];
const REGIONS = ['north', 'haifa_krayot', 'sharon', 'gush_dan', 'jerusalem', 'shfela', 'south', 'yosh'];
const SOURCES = ['whatsapp_group', 'matchmaker_referral', 'website', 'manual_entry', 'other'];
const AVAILABILITY = ['available', 'dating', 'unavailable', 'unknown'];
const AGE_CONF = ['exact', 'approximate', 'estimated', 'unknown'];

// contactPhone is accepted by the create/update endpoint but isn't on the
// read DTO type, so we widen Values to carry it (and agePreferences).
type Values = Partial<ExternalCandidate> & {
  contactPhone?: string;
  agePreferences?: { min?: number; max?: number; flexibility?: string };
  ageReliability?: { ageConfidence?: string; reportedAgeAt?: string };
};

export function ExternalCandidateForm({
  open, onClose, initial,
}: {
  open: boolean;
  onClose: () => void;
  initial?: ExternalCandidate;
}) {
  const qc = useQueryClient();
  const [v, setV] = useState<Values>({});
  const [aiNotes, setAiNotes] = useState<string[]>([]);
  useEffect(() => { setV(initial ?? { availabilityStatus: 'available', sourceType: 'manual_entry' }); }, [initial]);
  useEffect(() => { if (open) setAiNotes([]); }, [open]);

  const applyExtraction = (profile: ProfileExtraction) => {
    const { filled, notes } = mergeExtraction(profile);
    setV((prev) => ({ ...prev, ...filled }));
    setAiNotes(notes);
    toast.success('המידע מולא', `${Object.keys(filled).length} שדות זוהו. בדוק ותקן לפני שמירה.`);
  };

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
    onError: (err) => toast.error('השמירה נכשלה', describeApiError(err)),
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
        <CardImportButton target="external" onExtracted={applyExtraction} />
        {aiNotes.length > 0 && (
          <ul className="text-xs text-warning-700 list-disc ps-5 space-y-0.5 rounded-md bg-warning-50 border border-warning-200 p-2">
            {aiNotes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        )}

        <Section title="מקור">
          <Row label="סוג מקור" required>
            <Select value={v.sourceType ?? 'manual_entry'} onChange={(e) => set('sourceType', e.target.value as Values['sourceType'])}>
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
            <Select value={v.gender ?? ''} onChange={(e) => set('gender', e.target.value as Values['gender'])}>
              <option value="">—</option><option value="male">זכר</option><option value="female">נקבה</option>
            </Select>
          </Row>
          <Row label="גיל"><Input type="number" value={v.age ?? ''} onChange={(e) => set('age', Number(e.target.value))} /></Row>
          <Row label="עיר"><Input value={v.city ?? ''} onChange={(e) => set('city', e.target.value)} /></Row>
          <Row label="אזור">
            <Select value={v.region ?? ''} onChange={(e) => set('region', (e.target.value || undefined) as Values['region'])}>
              <option value="">—</option>
              {REGIONS.map((r) => <option key={r} value={r}>{label('region', r)}</option>)}
            </Select>
          </Row>
          <Row label="גובה (ס״מ)"><Input type="number" value={v.height ?? ''} onChange={(e) => set('height', e.target.value ? Number(e.target.value) : undefined)} /></Row>
          <Row label="טלפון"><Input value={v.contactPhone ?? ''} onChange={(e) => set('contactPhone', e.target.value)} /></Row>
        </Section>

        <Section title="דיוק גיל">
          <Row label="אמינות גיל">
            <Select
              value={v.ageReliability?.ageConfidence ?? 'unknown'}
              onChange={(e) => set('ageReliability', { ...(v.ageReliability ?? {}), ageConfidence: e.target.value } as Values['ageReliability'])}
            >
              {AGE_CONF.map((c) => <option key={c} value={c}>{label('ageConfidence', c)}</option>)}
            </Select>
          </Row>
        </Section>

        <Section title="זהות דתית">
          <Row label="מגזר">
            <Select value={v.sectorGroup ?? ''} onChange={(e) => set('sectorGroup', e.target.value as Values['sectorGroup'])}>
              <option value="">—</option>
              {SECTORS.map((s) => <option key={s} value={s}>{label('sectorGroup', s)}</option>)}
            </Select>
          </Row>
          <Row label="זמינות" required>
            <Select value={v.availabilityStatus ?? 'available'} onChange={(e) => set('availabilityStatus', e.target.value as Values['availabilityStatus'])}>
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
              value={(((v as Record<string, unknown>)['agePreferences'] as { min?: number } | undefined)?.min ?? '')}
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

// Turn the AI extraction into a patch over the form values. Only fields
// the model confidently returned are included, so a re-fill never blanks
// out something the operator already typed.
function mergeExtraction(p: ProfileExtraction): { filled: Values; notes: string[] } {
  const filled: Values = {};
  const bag = filled as Record<string, unknown>;
  const notes: string[] = [...(p.warnings ?? [])];

  const str = (k: keyof Values, val: string | undefined) => {
    if (val && val.trim()) bag[k as string] = val.trim();
  };
  const numField = (k: keyof Values, val: number | undefined) => {
    if (typeof val === 'number' && Number.isFinite(val)) bag[k as string] = val;
  };

  str('firstName', p.firstName);
  str('lastName', p.lastName);
  if (p.gender) filled.gender = p.gender;
  numField('age', p.age);
  numField('height', p.height);
  str('city', p.city);
  // External has one contact number; prefer the card's inquiry contact,
  // else the candidate's own.
  str('contactPhone', p.contactPhone ?? p.candidatePhone);
  str('sectorGroup', p.sectorGroup);
  str('subSector', p.subSector);
  str('lifestyleTone', p.lifestyleTone);
  str('personalStatus', p.personalStatus);
  str('lifeStage', p.lifeStage);
  str('studyWorkDirection', p.studyWorkDirection);
  str('whatSeeking', p.whatSeeking);

  // External has no dedicated occupation/education/army/family/ethnicity
  // fields → compose everything into `about` so nothing is lost.
  const aboutParts = [
    p.about,
    p.currentOccupation ? `עיסוק: ${p.currentOccupation}` : undefined,
    p.educationLevel ? `השכלה: ${p.educationLevel}` : undefined,
    p.educationInstitution ? `מוסד: ${p.educationInstitution}` : undefined,
    p.armyService ? `שירות: ${p.armyService}` : undefined,
    p.ethnicity ? `עדה: ${p.ethnicity}` : undefined,
    p.religiousLevelText ? `השקפה: ${p.religiousLevelText}` : undefined,
    p.familyBackground ? `משפחה: ${p.familyBackground}` : undefined,
    p.headCovering ? `כיסוי ראש: ${p.headCovering}` : undefined,
    p.smoking ? `מעשן/ת: ${p.smoking}` : undefined,
  ].filter((s): s is string => Boolean(s && s.trim()));
  if (aboutParts.length) filled.about = aboutParts.join('\n');

  // Age from a card is rarely exact — flag the confidence so the engine
  // and the operator treat it accordingly.
  if (typeof p.age === 'number') {
    filled.ageReliability = { ageConfidence: 'approximate' };
    notes.push(`הגיל (${p.age}) סומן כ"משוער" — תקן ל"מדויק" אם אומת.`);
  }

  if (typeof p.seekingAgeMin === 'number' || typeof p.seekingAgeMax === 'number') {
    filled.agePreferences = { min: p.seekingAgeMin, max: p.seekingAgeMax };
  }

  const openness: NonNullable<ExternalCandidate['openness']> = {};
  if (p.openToOtherSectors !== undefined) openness.openToOtherSectors = p.openToOtherSectors;
  if (p.openToConverts !== undefined) openness.openToConverts = p.openToConverts;
  if (p.openToDivorced !== undefined) openness.openToDivorced = p.openToDivorced;
  if (p.openToWithChildren !== undefined) openness.openToWithChildren = p.openToWithChildren;
  if (p.openToAgeDifference !== undefined) openness.openToAgeDifference = p.openToAgeDifference;
  if (p.openToLongDistance !== undefined) openness.openToLongDistance = p.openToLongDistance;
  if (Object.keys(openness).length > 0) filled.openness = openness;

  if (p.confidence < 0.5) notes.push(`רמת ביטחון נמוכה (${Math.round(p.confidence * 100)}%) — בדוק היטב.`);

  return { filled, notes };
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
