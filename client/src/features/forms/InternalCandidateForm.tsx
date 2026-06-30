// ═══════════════════════════════════════════════════════════
// Internal Candidate create/edit form (drawer-embedded).
// Minimal field set — the canonical authoring surface. All
// validation errors from the backend surface as toasts.
// ═══════════════════════════════════════════════════════════

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Drawer } from '@/components/ui/Drawer';
import { Button, Input, Select, Textarea } from '@/components/ui/primitives';
import { toast } from '@/components/ui/Toast';
import { internalCandidatesApi } from '@/services/api/candidates';
import { type ProfileExtraction } from '@/services/api/ai';
import { describeApiError } from '@/utils/apiError';
import { CardImportButton } from './CardImportButton';
import { label } from '@/utils/labels';
import type { InternalCandidate } from '@/types/domain';

// Superset of the domain shape — the create/update endpoint also accepts
// these fields (currentOccupation, agePreferences, …) even though they
// aren't surfaced as inputs yet. The AI extractor can fill them, so we
// keep them on the save body rather than dropping them on the floor.
type Values = Partial<InternalCandidate> & {
  height?: number;
  currentOccupation?: string;
  educationLevel?: string;
  educationInstitution?: string;
  armyService?: string;
  additionalInfo?: string;
  referencePhone?: string;
  agePreferences?: { min?: number; max?: number };
};

const SECTORS = ['dati_leumi', 'haredi', 'dati', 'masorti', 'hardal', 'torani', 'other'];
const REGIONS = ['north', 'haifa_krayot', 'sharon', 'gush_dan', 'jerusalem', 'shfela', 'south', 'yosh'];
const CHILDREN_PREF = ['large_family', 'balanced', 'small_family', 'flexible', 'undecided'];
const CAREER_PRIO = ['torah_focused', 'balanced', 'career_focused', 'flexible'];
// Curated מידות list — operator impression, stored as free Hebrew tags.
const CHARACTER_TRAITS = ['סבלנות', 'כבוד הדדי', 'עין טובה', 'יכולת הכלה', 'רוגע', 'אופטימיות', 'נדיבות', 'אחריות', 'חוש הומור', 'רגישות', 'יציבות', 'ענווה'];
const READINESS = ['actively_looking', 'open', 'exploring', 'not_ready', 'on_hold'];
const LIFE_STAGE = ['post_high_school', 'national_service', 'army', 'yeshiva_seminary', 'early_studies', 'mid_studies', 'early_career', 'established_career', 'mature'];
const PERSONAL_STATUS = ['single', 'divorced', 'widowed', 'separated'];
const SECOND_CHAPTER_STATUSES = ['divorced', 'separated', 'widowed'];
const STUDY_WORK = ['full_time_torah', 'torah_with_work', 'academic_studies', 'professional_training', 'working', 'military_career', 'entrepreneurial', 'hesder', 'mechina_army', 'sherut_leumi', 'undecided'];

export function InternalCandidateForm({
  open, onClose, initial,
}: {
  open: boolean;
  onClose: () => void;
  initial?: InternalCandidate;
}) {
  const qc = useQueryClient();
  const [v, setV] = useState<Values>({});
  const [aiNotes, setAiNotes] = useState<string[]>([]);

  useEffect(() => { setV(initial ?? {}); }, [initial]);
  // Clear AI notes whenever the drawer (re)opens.
  useEffect(() => { if (open) setAiNotes([]); }, [open]);

  const applyExtraction = (profile: ProfileExtraction) => {
    const { filled, notes } = mergeExtraction(profile);
    setV((prev) => ({ ...prev, ...filled }));
    setAiNotes(notes);
    toast.success('המידע מולא', `${Object.keys(filled).length} שדות זוהו. בדוק ותקן לפני שמירה.`);
  };

  const save = useMutation({
    mutationFn: async () => {
      const body: Values = {
        ...v,
        // Required minimums
        personalStatus: v.personalStatus ?? 'single',
        readinessForMarriage: v.readinessForMarriage ?? 'open',
        numberOfChildren: v.numberOfChildren ?? 0,
      };
      return initial?._id
        ? internalCandidatesApi.update(initial._id, body)
        : internalCandidatesApi.create(body);
    },
    onSuccess: (res) => {
      toast.success(initial ? 'המועמד עודכן' : 'המועמד נוצר');
      qc.invalidateQueries({ queryKey: ['internals'] });
      if (initial?._id) {
        // Write the fresh candidate into cache immediately so the
        // detail page reflects the edit before any refetch lands.
        qc.setQueryData(['internal', initial._id], res);
        qc.invalidateQueries({ queryKey: ['internal', initial._id, 'readiness'] });
      }
      onClose();
    },
    onError: (err) => toast.error('השמירה נכשלה', describeApiError(err)),
  });

  const set = <K extends keyof Values>(k: K, val: Values[K]) =>
    setV((prev) => ({ ...prev, [k]: val }));

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={initial ? 'עריכת מועמד פנימי' : 'יצירת מועמד פנימי'}
      subtitle={initial ? initial.firstName + ' ' + initial.lastName : 'הוסף מועמד חדש למאגר'}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>ביטול</Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>שמור</Button>
        </div>
      }
    >
      <div className="p-5 space-y-4">
        <CardImportButton target="internal" onExtracted={applyExtraction} />
        {aiNotes.length > 0 && (
          <ul className="text-xs text-warning-700 list-disc ps-5 space-y-0.5 rounded-md bg-warning-50 border border-warning-200 p-2">
            {aiNotes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        )}

        <Section title="זיהוי">
          <Row label="שם פרטי" required><Input value={v.firstName ?? ''} onChange={(e) => set('firstName', e.target.value)} /></Row>
          <Row label="שם משפחה" required><Input value={v.lastName ?? ''} onChange={(e) => set('lastName', e.target.value)} /></Row>
          <Row label="שם עברי"><Input value={v.hebrewName ?? ''} onChange={(e) => set('hebrewName', e.target.value)} /></Row>
          <Row label="מין" required>
            <Select value={v.gender ?? ''} onChange={(e) => set('gender', e.target.value as Values['gender'])}>
              <option value="">בחר</option>
              <option value="male">זכר</option>
              <option value="female">נקבה</option>
            </Select>
          </Row>
          <Row label="תאריך לידה" required><Input type="date" value={v.dateOfBirth?.slice(0, 10) ?? ''} onChange={(e) => set('dateOfBirth', e.target.value)} /></Row>
          <Row label="טלפון"><Input value={v.phone ?? ''} onChange={(e) => set('phone', e.target.value)} /></Row>
          <Row label="אימייל"><Input type="email" value={v.email ?? ''} onChange={(e) => set('email', e.target.value)} /></Row>
          <Row label="עיר"><Input value={v.city ?? ''} onChange={(e) => set('city', e.target.value)} /></Row>
          <Row label="אזור">
            <Select value={v.region ?? ''} onChange={(e) => set('region', (e.target.value || undefined) as Values['region'])}>
              <option value="">—</option>
              {REGIONS.map((r) => <option key={r} value={r}>{label('region', r)}</option>)}
            </Select>
          </Row>
          <Row label="גובה (ס״מ)"><Input type="number" value={v.height ?? ''} onChange={(e) => set('height', e.target.value ? Number(e.target.value) : undefined)} /></Row>
        </Section>

        <Section title="זהות דתית">
          <Row label="מגזר" required>
            <Select value={v.sectorGroup ?? ''} onChange={(e) => set('sectorGroup', e.target.value as Values['sectorGroup'])}>
              <option value="">בחר</option>
              {SECTORS.map((s) => <option key={s} value={s}>{label('sectorGroup', s)}</option>)}
            </Select>
          </Row>
          <Row label="מצב אישי">
            <Select value={v.personalStatus ?? 'single'} onChange={(e) => set('personalStatus', e.target.value as Values['personalStatus'])}>
              {PERSONAL_STATUS.map((s) => <option key={s} value={s}>{label('personalStatus', s)}</option>)}
            </Select>
          </Row>
          <Row label="שלב חיים">
            <Select value={v.lifeStage ?? ''} onChange={(e) => set('lifeStage', e.target.value as Values['lifeStage'])}>
              <option value="">—</option>
              {LIFE_STAGE.map((s) => <option key={s} value={s}>{label('lifeStage', s)}</option>)}
            </Select>
          </Row>
          <Row label="מוכנות לנישואין" required>
            <Select value={v.readinessForMarriage ?? 'open'} onChange={(e) => set('readinessForMarriage', e.target.value as Values['readinessForMarriage'])}>
              {READINESS.map((s) => <option key={s} value={s}>{label('readinessForMarriage', s)}</option>)}
            </Select>
          </Row>
          <Row label="כיוון לימודים / עבודה">
            <Select value={v.studyWorkDirection ?? ''} onChange={(e) => set('studyWorkDirection', e.target.value as Values['studyWorkDirection'])}>
              <option value="">—</option>
              {STUDY_WORK.map((s) => <option key={s} value={s}>{label('studyWorkDirection', s)}</option>)}
            </Select>
          </Row>
        </Section>

        <Section title="לימודים, עבודה וצבא">
          <Row label="עיסוק / לימודים נוכחיים" full><Input value={v.currentOccupation ?? ''} onChange={(e) => set('currentOccupation', e.target.value)} /></Row>
          <Row label="השכלה"><Input value={v.educationLevel ?? ''} onChange={(e) => set('educationLevel', e.target.value)} /></Row>
          <Row label="מוסד לימודים"><Input value={v.educationInstitution ?? ''} onChange={(e) => set('educationInstitution', e.target.value)} /></Row>
          <Row label="שירות צבאי / לאומי" full><Input value={v.armyService ?? ''} onChange={(e) => set('armyService', e.target.value)} /></Row>
        </Section>

        <Section title="מטרות משותפות">
          <Row label="גודל משפחה מבוקש">
            <Select
              value={v.lifeGoals?.childrenPreference ?? ''}
              onChange={(e) => set('lifeGoals', { ...(v.lifeGoals ?? {}), childrenPreference: (e.target.value || undefined) as NonNullable<Values['lifeGoals']>['childrenPreference'] })}
            >
              <option value="">—</option>
              {CHILDREN_PREF.map((c) => <option key={c} value={c}>{label('childrenPreference', c)}</option>)}
            </Select>
          </Row>
          <Row label="עדיפות תורה / קריירה">
            <Select
              value={v.lifeGoals?.careerPriority ?? ''}
              onChange={(e) => set('lifeGoals', { ...(v.lifeGoals ?? {}), careerPriority: (e.target.value || undefined) as NonNullable<Values['lifeGoals']>['careerPriority'] })}
            >
              <option value="">—</option>
              {CAREER_PRIO.map((c) => <option key={c} value={c}>{label('careerPriority', c)}</option>)}
            </Select>
          </Row>
          <Row label="חזון הבית" full>
            <Textarea rows={2} value={v.lifeGoals?.homeVision ?? ''} onChange={(e) => set('lifeGoals', { ...(v.lifeGoals ?? {}), homeVision: e.target.value })} />
          </Row>
        </Section>

        <Section title="מידות ואופי">
          <div className="col-span-2 flex flex-wrap gap-1.5">
            {CHARACTER_TRAITS.map((t) => {
              const on = (v.characterTraits ?? []).includes(t);
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => {
                    const curr = v.characterTraits ?? [];
                    set('characterTraits', on ? curr.filter((x) => x !== t) : [...curr, t]);
                  }}
                  className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${on ? 'bg-brand text-white border-brand' : 'bg-bg-subtle text-ink-muted border-border'}`}
                >
                  {t}
                </button>
              );
            })}
          </div>
          <Row label="הערות אופי" full>
            <Textarea rows={2} value={v.characterNotes ?? ''} onChange={(e) => set('characterNotes', e.target.value)} />
          </Row>
        </Section>

        <Section title="רקע משפחתי">
          <Row label="עדה / מוצא"><Input value={v.ethnicity ?? ''} onChange={(e) => set('ethnicity', e.target.value)} /></Row>
          <Row label="רקע משפחתי" full>
            <Textarea rows={2} value={v.familyBackground ?? ''} onChange={(e) => set('familyBackground', e.target.value)} />
          </Row>
        </Section>

        <Section title="טקסט חופשי">
          <Row label="על עצמו" full><Textarea rows={3} value={v.about ?? ''} onChange={(e) => set('about', e.target.value)} /></Row>
          <Row label="מה מחפש" full><Textarea rows={3} value={v.whatSeeking ?? ''} onChange={(e) => set('whatSeeking', e.target.value)} /></Row>
          <Row label="מידע נוסף (משפחה וכו׳)" full><Textarea rows={2} value={v.additionalInfo ?? ''} onChange={(e) => set('additionalInfo', e.target.value)} /></Row>
          <Row label="שם ממליץ"><Input value={v.referenceName ?? ''} onChange={(e) => set('referenceName', e.target.value)} /></Row>
          <Row label="טלפון ממליץ"><Input value={v.referencePhone ?? ''} onChange={(e) => set('referencePhone', e.target.value)} /></Row>
        </Section>

        <Section title="העדפות">
          <Row label="טווח גיל מבוקש — מ">
            <Input
              type="number"
              value={v.agePreferences?.min ?? ''}
              onChange={(e) => set('agePreferences', { ...(v.agePreferences ?? {}), min: e.target.value ? Number(e.target.value) : undefined })}
            />
          </Row>
          <Row label="טווח גיל מבוקש — עד">
            <Input
              type="number"
              value={v.agePreferences?.max ?? ''}
              onChange={(e) => set('agePreferences', { ...(v.agePreferences ?? {}), max: e.target.value ? Number(e.target.value) : undefined })}
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

// Tri-state openness toggle (לא ידוע / כן / לא) — identical to the one in
// ExternalCandidateForm; both forms edit the same openness shape.
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
  const next = (val: boolean | undefined) => set('openness', { ...openness, [flag]: val });
  return (
    <div className="col-span-2 flex items-center justify-between gap-3 py-1">
      <span className="text-sm text-ink-muted">{label}</span>
      <div className="flex gap-1 p-0.5 rounded-md bg-bg-subtle border border-border text-xs">
        <button type="button" onClick={() => next(undefined)} className={`px-2 py-1 rounded ${current === undefined ? 'bg-white shadow-sm font-medium' : 'text-ink-muted'}`}>לא ידוע</button>
        <button type="button" onClick={() => next(true)} className={`px-2 py-1 rounded ${current === true ? 'bg-white shadow-sm font-medium text-success' : 'text-ink-muted'}`}>כן</button>
        <button type="button" onClick={() => next(false)} className={`px-2 py-1 rounded ${current === false ? 'bg-white shadow-sm font-medium text-danger' : 'text-ink-muted'}`}>לא</button>
      </div>
    </div>
  );
}

// Turn the AI extraction into a patch over the form values. Only fields
// the model confidently returned are included, so a re-fill never blanks
// out something the operator already typed. `notes` collects anything the
// operator must verify (estimated DOB, model warnings).
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
  str('hebrewName', p.hebrewName);
  if (p.gender) filled.gender = p.gender;
  // The candidate is ours → their own number is `phone`; the card's
  // contact person/number becomes the reference.
  str('phone', p.candidatePhone);
  str('city', p.city);
  str('neighborhood', p.neighborhood);
  numField('height', p.height);
  str('sectorGroup', p.sectorGroup);
  str('subSector', p.subSector);
  str('lifestyleTone', p.lifestyleTone);
  str('religiousStyle', p.religiousStyle);
  str('personalStatus', p.personalStatus);
  numField('numberOfChildren', p.numberOfChildren);
  str('lifeStage', p.lifeStage);
  str('readinessForMarriage', p.readinessForMarriage);
  str('studyWorkDirection', p.studyWorkDirection);
  str('currentOccupation', p.currentOccupation);
  str('educationLevel', p.educationLevel);
  str('educationInstitution', p.educationInstitution);
  str('armyService', p.armyService);
  str('about', p.about);
  str('whatSeeking', p.whatSeeking);
  str('referenceName', p.contactName);
  str('referencePhone', p.contactPhone);

  // Fields with no dedicated input go into "מידע נוסף" so nothing is lost.
  const extra = [
    p.familyBackground,
    p.ethnicity ? `עדה: ${p.ethnicity}` : undefined,
    p.religiousLevelText ? `השקפה: ${p.religiousLevelText}` : undefined,
    p.headCovering ? `כיסוי ראש: ${p.headCovering}` : undefined,
    p.smoking ? `מעשן/ת: ${p.smoking}` : undefined,
  ].filter((s): s is string => Boolean(s && s.trim()));
  if (extra.length) filled.additionalInfo = extra.join('\n');

  // Date of birth: prefer an explicit date; otherwise estimate from the
  // reported age (Jan 1 of the birth year) and flag it for verification.
  if (p.dateOfBirth) {
    filled.dateOfBirth = p.dateOfBirth;
  } else if (typeof p.age === 'number' && Number.isFinite(p.age)) {
    const birthYear = new Date().getFullYear() - p.age;
    filled.dateOfBirth = `${birthYear}-01-01`;
    notes.push(`תאריך הלידה משוער מהגיל (${p.age}) — נא לאמת.`);
  }

  // Partner age preference → agePreferences.
  if (typeof p.seekingAgeMin === 'number' || typeof p.seekingAgeMax === 'number') {
    filled.agePreferences = { min: p.seekingAgeMin, max: p.seekingAgeMax };
  }

  // Openness flags — only the ones the model set explicitly.
  const openness: NonNullable<Values['openness']> = {};
  if (p.openToOtherSectors !== undefined) openness.openToOtherSectors = p.openToOtherSectors;
  if (p.openToConverts !== undefined) openness.openToConverts = p.openToConverts;
  if (p.openToDivorced !== undefined) openness.openToDivorced = p.openToDivorced;
  if (p.openToWithChildren !== undefined) openness.openToWithChildren = p.openToWithChildren;
  if (p.openToAgeDifference !== undefined) openness.openToAgeDifference = p.openToAgeDifference;
  if (p.openToLongDistance !== undefined) openness.openToLongDistance = p.openToLongDistance;
  // A second-chapter candidate (divorced/separated/widowed) is, by default,
  // open to a divorcee — otherwise the engine blocks the very common
  // second-chapter↔second-chapter pair. Defaulted only when not stated.
  if (SECOND_CHAPTER_STATUSES.includes(p.personalStatus ?? '') && p.openToDivorced === undefined) {
    openness.openToDivorced = true;
    notes.push('המועמד/ת בפרק ב׳ — סומן אוטומטית "פתוח/ה לגרוש/ה". שנה במידת הצורך.');
  }
  if (Object.keys(openness).length > 0) filled.openness = openness;

  if (p.confidence < 0.5) notes.push(`רמת ביטחון נמוכה (${Math.round(p.confidence * 100)}%) — בדוק היטב.`);

  return { filled, notes };
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
