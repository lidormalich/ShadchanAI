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

// Profile field lists are intentionally identical to InternalCandidateForm —
// external and internal are the SAME profile, fed from a different source.
const SECTORS = ['dati_leumi', 'haredi', 'dati', 'masorti', 'hardal', 'torani', 'other'];
const REGIONS = ['north', 'haifa_krayot', 'sharon', 'gush_dan', 'jerusalem', 'shfela', 'south', 'yosh'];
const PERSONAL_STATUS = ['single', 'divorced', 'widowed', 'separated'];
const LIFE_STAGE = ['post_high_school', 'national_service', 'army', 'yeshiva_seminary', 'early_studies', 'mid_studies', 'early_career', 'established_career', 'mature'];
const READINESS = ['actively_looking', 'open', 'exploring', 'not_ready', 'on_hold'];
const STUDY_WORK = ['full_time_torah', 'torah_with_work', 'academic_studies', 'professional_training', 'working', 'military_career', 'entrepreneurial', 'hesder', 'mechina_army', 'sherut_leumi', 'undecided'];
const CHILDREN_PREF = ['large_family', 'balanced', 'small_family', 'flexible', 'undecided'];
const CAREER_PRIO = ['torah_focused', 'balanced', 'career_focused', 'flexible'];
const CHARACTER_TRAITS = ['סבלנות', 'כבוד הדדי', 'עין טובה', 'יכולת הכלה', 'רוגע', 'אופטימיות', 'נדיבות', 'אחריות', 'חוש הומור', 'רגישות', 'יציבות', 'ענווה'];
const SOURCES = ['whatsapp_group', 'matchmaker_referral', 'website', 'manual_entry', 'other'];
const AVAILABILITY = ['available', 'dating', 'unavailable', 'unknown'];
const AGE_CONF = ['exact', 'approximate', 'estimated', 'unknown'];
const SECOND_CHAPTER_STATUSES = ['divorced', 'separated', 'widowed'];

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

        <Section title="זיהוי">
          <Row label="שם פרטי"><Input value={v.firstName ?? ''} onChange={(e) => set('firstName', e.target.value)} /></Row>
          <Row label="שם משפחה"><Input value={v.lastName ?? ''} onChange={(e) => set('lastName', e.target.value)} /></Row>
          <Row label="שם עברי"><Input value={v.hebrewName ?? ''} onChange={(e) => set('hebrewName', e.target.value)} /></Row>
          <Row label="מין">
            <Select value={v.gender ?? ''} onChange={(e) => set('gender', e.target.value as Values['gender'])}>
              <option value="">—</option><option value="male">זכר</option><option value="female">נקבה</option>
            </Select>
          </Row>
          <Row label="גיל"><Input type="number" value={v.age ?? ''} onChange={(e) => set('age', e.target.value ? Number(e.target.value) : undefined)} /></Row>
          <Row label="טלפון"><Input value={v.contactPhone ?? ''} onChange={(e) => set('contactPhone', e.target.value)} /></Row>
          <Row label="אימייל"><Input type="email" value={v.email ?? ''} onChange={(e) => set('email', e.target.value)} /></Row>
          <Row label="עיר"><Input value={v.city ?? ''} onChange={(e) => set('city', e.target.value)} /></Row>
          <Row label="אזור">
            <Select value={v.region ?? ''} onChange={(e) => set('region', (e.target.value || undefined) as Values['region'])}>
              <option value="">—</option>
              {REGIONS.map((r) => <option key={r} value={r}>{label('region', r)}</option>)}
            </Select>
          </Row>
          <Row label="גובה (ס״מ)"><Input type="number" value={v.height ?? ''} onChange={(e) => set('height', e.target.value ? Number(e.target.value) : undefined)} /></Row>
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
          <Row label="מצב אישי">
            <Select value={v.personalStatus ?? ''} onChange={(e) => set('personalStatus', (e.target.value || undefined) as Values['personalStatus'])}>
              <option value="">—</option>
              {PERSONAL_STATUS.map((s) => <option key={s} value={s}>{label('personalStatus', s)}</option>)}
            </Select>
          </Row>
          <Row label="שלב חיים">
            <Select value={v.lifeStage ?? ''} onChange={(e) => set('lifeStage', (e.target.value || undefined) as Values['lifeStage'])}>
              <option value="">—</option>
              {LIFE_STAGE.map((s) => <option key={s} value={s}>{label('lifeStage', s)}</option>)}
            </Select>
          </Row>
          <Row label="מוכנות לנישואין">
            <Select value={v.readinessForMarriage ?? ''} onChange={(e) => set('readinessForMarriage', (e.target.value || undefined) as Values['readinessForMarriage'])}>
              <option value="">—</option>
              {READINESS.map((s) => <option key={s} value={s}>{label('readinessForMarriage', s)}</option>)}
            </Select>
          </Row>
          <Row label="זמינות" required>
            <Select value={v.availabilityStatus ?? 'available'} onChange={(e) => set('availabilityStatus', e.target.value as Values['availabilityStatus'])}>
              {AVAILABILITY.map((s) => <option key={s} value={s}>{label('availabilityStatus', s)}</option>)}
            </Select>
          </Row>
        </Section>

        <Section title="לימודים, עבודה וצבא">
          <Row label="כיוון לימודים / עבודה">
            <Select value={v.studyWorkDirection ?? ''} onChange={(e) => set('studyWorkDirection', (e.target.value || undefined) as Values['studyWorkDirection'])}>
              <option value="">—</option>
              {STUDY_WORK.map((s) => <option key={s} value={s}>{label('studyWorkDirection', s)}</option>)}
            </Select>
          </Row>
          <Row label="עיסוק נוכחי (עובד/לומד)"><Input value={v.currentOccupation ?? ''} onChange={(e) => set('currentOccupation', e.target.value)} /></Row>
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
          <Row label="מידע נוסף" full><Textarea rows={2} value={v.additionalInfo ?? ''} onChange={(e) => set('additionalInfo', e.target.value)} /></Row>
          <Row label="שם ממליץ"><Input value={v.referenceName ?? ''} onChange={(e) => set('referenceName', e.target.value)} /></Row>
          <Row label="טלפון ממליץ"><Input value={v.referencePhone ?? ''} onChange={(e) => set('referencePhone', e.target.value)} /></Row>
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
  str('hebrewName', p.hebrewName);
  if (p.gender) filled.gender = p.gender;
  numField('age', p.age);
  numField('height', p.height);
  str('city', p.city);
  str('neighborhood', p.neighborhood);
  str('ethnicity', p.ethnicity);
  str('familyBackground', p.familyBackground);
  // External now has the same profile fields as internal — fill the
  // dedicated columns instead of cramming everything into `about`.
  str('currentOccupation', p.currentOccupation);
  str('educationLevel', p.educationLevel);
  str('educationInstitution', p.educationInstitution);
  str('armyService', p.armyService);
  // Candidate's own number → contactPhone; the card's inquiry contact →
  // reference (set below). Fall back to the inquiry number if the
  // candidate's own wasn't on the card.
  str('contactPhone', p.candidatePhone ?? p.contactPhone);
  str('sectorGroup', p.sectorGroup);
  str('subSector', p.subSector);
  str('lifestyleTone', p.lifestyleTone);
  str('religiousStyle', p.religiousStyle);
  str('personalStatus', p.personalStatus);
  numField('numberOfChildren', p.numberOfChildren);
  str('lifeStage', p.lifeStage);
  str('readinessForMarriage', p.readinessForMarriage);
  str('studyWorkDirection', p.studyWorkDirection);
  str('about', p.about);
  str('whatSeeking', p.whatSeeking);
  str('referenceName', p.contactName);
  str('referencePhone', p.contactPhone);

  // Only the few card fields with no dedicated column go into "מידע נוסף".
  const extraParts = [
    p.religiousLevelText ? `השקפה: ${p.religiousLevelText}` : undefined,
    p.headCovering ? `כיסוי ראש: ${p.headCovering}` : undefined,
    p.smoking ? `מעשן/ת: ${p.smoking}` : undefined,
  ].filter((s): s is string => Boolean(s && s.trim()));
  if (extraParts.length) filled.additionalInfo = extraParts.join('\n');

  // An age explicitly written in the card text is a STATED age → mark it
  // exact. (The operator can still downgrade it if the card said "כבת 25".)
  if (typeof p.age === 'number') {
    filled.ageReliability = { ageConfidence: 'exact' };
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
  // A candidate who is themselves second-chapter (divorced/separated/
  // widowed) is, by default, open to a divorcee — otherwise the engine
  // would wrongly block the very common second-chapter↔second-chapter
  // pair. Only defaulted when the card didn't state otherwise.
  if (SECOND_CHAPTER_STATUSES.includes(p.personalStatus ?? '') && p.openToDivorced === undefined) {
    openness.openToDivorced = true;
    notes.push('המועמד/ת בפרק ב׳ — סומן אוטומטית "פתוח/ה לגרוש/ה". שנה במידת הצורך.');
  }
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
