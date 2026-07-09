// ═══════════════════════════════════════════════════════════
// "השלמת פרטים" tab — a fast, focused editor that shows ONLY the
// fields still missing on an external candidate and saves them in
// one click, instead of opening the full edit form.
//
// Reuses: missingCompletionFields (shared rule), the normal
// externalCandidatesApi.update endpoint, and the shared UI
// primitives. The tab is only rendered when something is missing
// (the parent hides it otherwise), and after a successful save the
// candidate query refetches — so a now-complete profile drops the
// tab automatically.
// ═══════════════════════════════════════════════════════════

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import { Button, Card, CardBody, Input, Select } from '@/components/ui/primitives';
import { toast } from '@/components/ui/Toast';
import { externalCandidatesApi } from '@/services/api/candidates';
import { missingCompletionFields, type CompletionField } from './completion';
import type { ExternalCandidate } from '@/types/domain';

type Draft = Record<string, string>;

export function ProfileCompletionTab({ c }: { c: ExternalCandidate }) {
  const qc = useQueryClient();
  const fields = missingCompletionFields(c);
  const [draft, setDraft] = useState<Draft>({});

  const set = (key: string, value: string) => setDraft((d) => ({ ...d, [key]: value }));

  const save = useMutation({
    mutationFn: () => externalCandidatesApi.update(c._id, buildPatch(fields, draft)),
    onSuccess: () => {
      toast.success('הפרטים נשמרו');
      // Refetch the candidate (drops the tab once complete) + the lists/counters.
      qc.invalidateQueries({ queryKey: ['external', c._id] });
      qc.invalidateQueries({ queryKey: ['externals'] });
      setDraft({});
    },
    onError: (e: Error) => toast.error('השמירה נכשלה', e.message),
  });

  // Something to save = at least one non-empty draft value.
  const hasInput = Object.values(draft).some((v) => v != null && String(v).trim() !== '');

  if (fields.length === 0) {
    return (
      <Card>
        <CardBody className="text-sm text-success flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4" /> כל הפרטים הבסיסיים מולאו 🎉
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="text-xs text-ink-muted">
          מלא כאן רק את השדות שחסרים ולחץ שמור — מהיר יותר מעריכת הכרטיס המלא.
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {fields.map((f) => (
            <FieldEditor key={f.key} field={f} draft={draft} onChange={set} />
          ))}
        </div>
        <div className="flex justify-end">
          <Button
            leftIcon={<CheckCircle2 className="h-4 w-4" />}
            loading={save.isPending}
            disabled={!hasInput}
            onClick={() => save.mutate()}
          >
            שמור
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

function FieldEditor({ field, draft, onChange }: {
  field: CompletionField;
  draft: Draft;
  onChange: (key: string, value: string) => void;
}) {
  if (field.type === 'name') {
    return (
      <div className="sm:col-span-2 grid grid-cols-2 gap-3">
        <Labeled label="שם פרטי">
          <Input value={draft['firstName'] ?? ''} onChange={(e) => onChange('firstName', e.target.value)} />
        </Labeled>
        <Labeled label="שם משפחה">
          <Input value={draft['lastName'] ?? ''} onChange={(e) => onChange('lastName', e.target.value)} />
        </Labeled>
      </div>
    );
  }
  if (field.type === 'select') {
    return (
      <Labeled label={field.label}>
        <Select value={draft[field.key] ?? ''} onChange={(e) => onChange(field.key, e.target.value)}>
          <option value="">בחר…</option>
          {(field.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
      </Labeled>
    );
  }
  return (
    <Labeled label={field.label}>
      <Input
        type={field.type === 'number' ? 'number' : 'text'}
        value={draft[field.key] ?? ''}
        onChange={(e) => onChange(field.key, e.target.value)}
      />
    </Labeled>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] text-ink-muted mb-0.5">{label}</div>
      {children}
    </div>
  );
}

// Build the update patch from the drafted values, coercing to the right type
// and dropping empties (so an untouched field is never written).
function buildPatch(fields: CompletionField[], draft: Draft): Partial<ExternalCandidate> {
  const patch: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.type === 'name') {
      const first = draft['firstName']?.trim();
      const last = draft['lastName']?.trim();
      if (first) patch['firstName'] = first;
      if (last) patch['lastName'] = last;
      continue;
    }
    const raw = draft[f.key]?.trim();
    if (!raw) continue;
    patch[f.key] = f.type === 'number' ? Number(raw) : raw;
  }
  return patch as Partial<ExternalCandidate>;
}
