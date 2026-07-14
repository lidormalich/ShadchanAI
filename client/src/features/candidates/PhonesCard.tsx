// ═══════════════════════════════════════════════════════════
// PhonesCard — right-rail list of EVERY phone number known for an
// external candidate: the card's primary phone, numbers unioned in
// from merged duplicate cards, the reference ("ממליץ") phone, the
// WhatsApp poster's number, and manual additions.
//
// Each number carries an optional "מי זה" label the operator can edit
// inline; new numbers can be added. Saving persists the FULL list to
// the candidate's `phones` field (the server re-normalizes + dedups).
// Rows derived from legacy scalar fields (contactPhone / referencePhone
// / sourceSenderPhone) are shown even when the phones array predates
// them, and become persisted entries on the first label edit.
// ═══════════════════════════════════════════════════════════

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Pencil, Phone, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, CardBody, CardHeader, IconButton, Input } from '@/components/ui/primitives';
import { externalCandidatesApi } from '@/services/api/candidates';
import { toast } from '@/components/ui/Toast';
import type { CandidatePhone, ExternalCandidate } from '@/types/domain';

// Same canonicalization the server uses for dedup — digits only, Israeli
// leading 0 → 972 — so a dashed and an international spelling of the same
// number collapse into one row.
function phoneKey(raw: string): string {
  const d = raw.replace(/\D/g, '');
  return d.startsWith('0') ? '972' + d.slice(1) : d;
}

const SOURCE_HINT: Record<string, string> = {
  card: 'מהכרטיס',
  merged_card: 'מכרטיס שמוזג',
  reference: 'ממליץ/ה',
  sender: 'שולח ההודעה',
  manual: 'נוסף ידנית',
};

type PhoneRow = CandidatePhone & {
  // Row exists only as a legacy scalar field (not yet in phones[]) — it
  // cannot be deleted here (the scalar would just re-derive it).
  derivedOnly?: boolean;
};

function buildRows(c: ExternalCandidate): PhoneRow[] {
  const rows: PhoneRow[] = (c.phones ?? []).map((p) => ({ ...p }));
  const seen = new Set(rows.map((r) => phoneKey(r.number)));
  const derive = (number: string | undefined, label: string, source: string): void => {
    if (!number) return;
    const k = phoneKey(number);
    if (seen.has(k)) return;
    seen.add(k);
    rows.push({ number, label, source, derivedOnly: true });
  };
  derive(c.contactPhone, 'טלפון מהכרטיס', 'card');
  derive(c.referencePhone, c.referenceName ? `ממליץ/ה — ${c.referenceName}` : 'ממליץ/ה', 'reference');
  derive(c.sourceSenderPhone, c.sourceSenderName ? `שולח ההודעה — ${c.sourceSenderName}` : 'שולח ההודעה בוואטסאפ', 'sender');
  return rows;
}

function toPersist(rows: PhoneRow[]): CandidatePhone[] {
  return rows.map((r) => ({
    number: r.number,
    ...(r.label ? { label: r.label } : {}),
    ...(r.source ? { source: r.source } : {}),
  }));
}

export function PhonesCard({ c }: { c: ExternalCandidate }) {
  const qc = useQueryClient();
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [newNumber, setNewNumber] = useState('');
  const [newLabel, setNewLabel] = useState('');

  const rows = buildRows(c);
  // Keys covered by the legacy scalar fields — deleting such a row from
  // phones[] would be a no-op (the scalar re-derives it), so hide delete.
  const scalarKeys = new Set(
    [c.contactPhone, c.referencePhone, c.sourceSenderPhone].filter(Boolean).map((n) => phoneKey(n!)),
  );

  const save = useMutation({
    mutationFn: (phones: CandidatePhone[]) => externalCandidatesApi.update(c._id, { phones }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['external', c._id] });
      setEditingKey(null);
      setAdding(false);
      setNewNumber('');
      setNewLabel('');
      toast.success('רשימת הטלפונים עודכנה');
    },
    onError: (e: Error) => toast.error('עדכון הטלפונים נכשל', e.message),
  });

  const saveLabel = (row: PhoneRow) => {
    const next = rows.map((r) =>
      phoneKey(r.number) === phoneKey(row.number) ? { ...r, label: labelDraft.trim() || undefined } : r,
    );
    save.mutate(toPersist(next));
  };
  const removeRow = (row: PhoneRow) => {
    save.mutate(toPersist(rows.filter((r) => phoneKey(r.number) !== phoneKey(row.number))));
  };
  const addRow = () => {
    const number = newNumber.trim();
    if (!number) return;
    if (rows.some((r) => phoneKey(r.number) === phoneKey(number))) {
      toast.error('המספר כבר קיים ברשימה');
      return;
    }
    save.mutate(toPersist([...rows, { number, label: newLabel.trim() || undefined, source: 'manual' }]));
  };

  return (
    <Card>
      <CardHeader
        actions={
          <Button size="sm" variant="ghost" leftIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => setAdding((v) => !v)}>
            הוסף
          </Button>
        }
      >
        <h3 className="text-sm font-semibold inline-flex items-center gap-1.5">
          <Phone className="h-3.5 w-3.5" />
          מספרי טלפון
          {rows.length > 1 && <Badge tone="neutral">{rows.length}</Badge>}
        </h3>
      </CardHeader>
      <CardBody className="space-y-2 text-sm">
        {rows.length === 0 && !adding && (
          <div className="text-xs text-ink-muted">לא ידוע מספר טלפון למועמד זה.</div>
        )}
        {rows.map((row) => {
          const key = phoneKey(row.number);
          const editing = editingKey === key;
          return (
            <div key={key} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <a href={`tel:${row.number}`} dir="ltr" className="font-medium num text-brand-700 hover:underline">
                  {row.number}
                </a>
                {editing ? (
                  <div className="mt-1 flex items-center gap-1">
                    <Input
                      autoFocus
                      value={labelDraft}
                      onChange={(e) => setLabelDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveLabel(row); if (e.key === 'Escape') setEditingKey(null); }}
                      placeholder="מי זה? (אמא / שדכנית / הבחור עצמו…)"
                      className="h-7 text-xs"
                    />
                    <IconButton title="שמור" disabled={save.isPending} onClick={() => saveLabel(row)}>
                      <Check className="h-3.5 w-3.5" />
                    </IconButton>
                    <IconButton title="בטל" onClick={() => setEditingKey(null)}>
                      <X className="h-3.5 w-3.5" />
                    </IconButton>
                  </div>
                ) : (
                  <div className="text-xs text-ink-muted truncate">
                    {row.label ?? SOURCE_HINT[row.source ?? ''] ?? 'ללא תיאור'}
                  </div>
                )}
              </div>
              {!editing && (
                <div className="shrink-0 flex items-center gap-0.5">
                  <IconButton title="ערוך תיאור — מי זה" onClick={() => { setEditingKey(key); setLabelDraft(row.label ?? ''); }}>
                    <Pencil className="h-3.5 w-3.5" />
                  </IconButton>
                  {!row.derivedOnly && !scalarKeys.has(key) && (
                    <IconButton title="הסר מספר" disabled={save.isPending} onClick={() => removeRow(row)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </IconButton>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {adding && (
          <div className="rounded-md border border-border bg-bg-subtle/40 p-2 space-y-1.5">
            <Input
              dir="ltr"
              value={newNumber}
              onChange={(e) => setNewNumber(e.target.value)}
              placeholder="050-1234567"
              className="h-7 text-xs"
            />
            <Input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addRow(); }}
              placeholder="מי זה? (אופציונלי)"
              className="h-7 text-xs"
            />
            <div className="flex items-center gap-1.5">
              <Button size="sm" loading={save.isPending} disabled={!newNumber.trim()} onClick={addRow}>הוסף מספר</Button>
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>ביטול</Button>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
