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
import { label } from '@/utils/labels';
import type { InternalCandidate } from '@/types/domain';

type Values = Partial<InternalCandidate>;

const SECTORS = ['dati_leumi', 'haredi', 'dati', 'masorti', 'hardal', 'torani', 'other'];
const READINESS = ['actively_looking', 'open', 'exploring', 'not_ready', 'on_hold'];
const LIFE_STAGE = ['post_high_school', 'national_service', 'army', 'yeshiva_seminary', 'early_studies', 'mid_studies', 'early_career', 'established_career', 'mature'];
const PERSONAL_STATUS = ['single', 'divorced', 'widowed', 'separated'];
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

  useEffect(() => { setV(initial ?? {}); }, [initial]);

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
    onSuccess: () => {
      toast.success(initial ? 'המועמד עודכן' : 'המועמד נוצר');
      qc.invalidateQueries({ queryKey: ['internals'] });
      if (initial?._id) qc.invalidateQueries({ queryKey: ['internal', initial._id] });
      onClose();
    },
    onError: (err) => toast.error('השמירה נכשלה', (err as Error).message),
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
        <Section title="זיהוי">
          <Row label="שם פרטי" required><Input value={v.firstName ?? ''} onChange={(e) => set('firstName', e.target.value)} /></Row>
          <Row label="שם משפחה" required><Input value={v.lastName ?? ''} onChange={(e) => set('lastName', e.target.value)} /></Row>
          <Row label="שם עברי"><Input value={v.hebrewName ?? ''} onChange={(e) => set('hebrewName', e.target.value)} /></Row>
          <Row label="מין" required>
            <Select value={v.gender ?? ''} onChange={(e) => set('gender', e.target.value)}>
              <option value="">בחר</option>
              <option value="male">זכר</option>
              <option value="female">נקבה</option>
            </Select>
          </Row>
          <Row label="תאריך לידה" required><Input type="date" value={v.dateOfBirth?.slice(0, 10) ?? ''} onChange={(e) => set('dateOfBirth', e.target.value)} /></Row>
          <Row label="טלפון"><Input value={v.phone ?? ''} onChange={(e) => set('phone', e.target.value)} /></Row>
          <Row label="אימייל"><Input type="email" value={v.email ?? ''} onChange={(e) => set('email', e.target.value)} /></Row>
          <Row label="עיר"><Input value={v.city ?? ''} onChange={(e) => set('city', e.target.value)} /></Row>
        </Section>

        <Section title="זהות דתית">
          <Row label="מגזר" required>
            <Select value={v.sectorGroup ?? ''} onChange={(e) => set('sectorGroup', e.target.value)}>
              <option value="">בחר</option>
              {SECTORS.map((s) => <option key={s} value={s}>{label('sectorGroup', s)}</option>)}
            </Select>
          </Row>
          <Row label="מצב אישי">
            <Select value={v.personalStatus ?? 'single'} onChange={(e) => set('personalStatus', e.target.value)}>
              {PERSONAL_STATUS.map((s) => <option key={s} value={s}>{label('personalStatus', s)}</option>)}
            </Select>
          </Row>
          <Row label="שלב חיים">
            <Select value={v.lifeStage ?? ''} onChange={(e) => set('lifeStage', e.target.value)}>
              <option value="">—</option>
              {LIFE_STAGE.map((s) => <option key={s} value={s}>{label('lifeStage', s)}</option>)}
            </Select>
          </Row>
          <Row label="מוכנות לנישואין" required>
            <Select value={v.readinessForMarriage ?? 'open'} onChange={(e) => set('readinessForMarriage', e.target.value)}>
              {READINESS.map((s) => <option key={s} value={s}>{label('readinessForMarriage', s)}</option>)}
            </Select>
          </Row>
          <Row label="כיוון לימודים / עבודה">
            <Select value={v.studyWorkDirection ?? ''} onChange={(e) => set('studyWorkDirection', e.target.value)}>
              <option value="">—</option>
              {STUDY_WORK.map((s) => <option key={s} value={s}>{label('studyWorkDirection', s)}</option>)}
            </Select>
          </Row>
        </Section>

        <Section title="טקסט חופשי">
          <Row label="על עצמו" full><Textarea rows={3} value={v.about ?? ''} onChange={(e) => set('about', e.target.value)} /></Row>
          <Row label="מה מחפש" full><Textarea rows={3} value={v.whatSeeking ?? ''} onChange={(e) => set('whatSeeking', e.target.value)} /></Row>
          <Row label="שם ממליץ"><Input value={v.referenceName ?? ''} onChange={(e) => set('referenceName', e.target.value)} /></Row>
        </Section>
      </div>
    </Drawer>
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
