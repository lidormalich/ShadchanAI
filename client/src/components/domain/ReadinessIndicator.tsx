import { clsx } from 'clsx';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { label } from '@/utils/labels';
import type { ReadinessDetails } from '@/types/domain';

export function ReadinessIndicator({ readiness }: { readiness: ReadinessDetails }) {
  const { profileCompletion, missingCriticalFields, sendReadinessBlockers } = readiness;
  const ready = sendReadinessBlockers.length === 0;
  const barColor =
    profileCompletion >= 80 ? 'bg-success' :
    profileCompletion >= 60 ? 'bg-amber-500' :
    'bg-red-500';

  return (
    <div className="rounded-lg border border-border bg-bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-ink">מוכנות לשליחה</div>
        {ready ? (
          <span className="inline-flex items-center gap-1 text-xs text-success">
            <CheckCircle2 className="h-4 w-4" /> מוכן
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-warning">
            <AlertCircle className="h-4 w-4" /> חסם
          </span>
        )}
      </div>
      <div>
        <div className="flex items-center justify-between text-xs text-ink-muted mb-1">
          <span>השלמת פרופיל</span>
          <span className="num">{profileCompletion}%</span>
        </div>
        <div className="h-2 bg-bg rounded-full overflow-hidden">
          <div className={clsx('h-full rounded-full transition-all', barColor)} style={{ width: `${profileCompletion}%` }} />
        </div>
      </div>
      {missingCriticalFields.length > 0 && (
        <div>
          <div className="text-xs font-medium text-ink-muted mb-1">שדות חסרים קריטיים</div>
          <div className="flex flex-wrap gap-1.5">
            {missingCriticalFields.map((f) => (
              <span key={f} className="text-xs px-2 py-0.5 rounded bg-red-50 text-red-700 border border-red-100">
                {label('fieldName', f)}
              </span>
            ))}
          </div>
        </div>
      )}
      {sendReadinessBlockers.length > 0 && (
        <div>
          <div className="text-xs font-medium text-ink-muted mb-1">חסמים לשליחה</div>
          <ul className="text-xs text-ink space-y-1 list-disc ps-4">
            {sendReadinessBlockers.map((b) => <li key={b}>{b}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
