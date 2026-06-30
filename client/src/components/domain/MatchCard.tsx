import { clsx } from 'clsx';
import { AlertTriangle, Shield, Sparkles, Star } from 'lucide-react';
import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Card } from '../ui/primitives';
import type { MatchSuggestion } from '@/types/domain';

const matchTypeMeta: Record<string, { icon: React.ReactNode; tone: 'success' | 'brand' | 'warning' | 'danger'; label: string }> = {
  safe: { icon: <Shield className="h-3.5 w-3.5" />, tone: 'success', label: 'בטוח' },
  balanced: { icon: <Star className="h-3.5 w-3.5" />, tone: 'brand', label: 'מאוזן' },
  creative: { icon: <Sparkles className="h-3.5 w-3.5" />, tone: 'warning', label: 'יצירתי' },
  risky: { icon: <AlertTriangle className="h-3.5 w-3.5" />, tone: 'danger', label: 'מסוכן' },
};

export const MatchCard = React.memo(function MatchCard({ match, compact }: { match: MatchSuggestion; compact?: boolean }) {
  const meta = matchTypeMeta[match.matchType] ?? matchTypeMeta['balanced']!;
  const scoreTone = useMemo(
    () => match.matchScore >= 80 ? 'text-success'
      : match.matchScore >= 60 ? 'text-brand-700'
      : match.matchScore >= 40 ? 'text-warning'
      : 'text-danger',
    [match.matchScore],
  );

  return (
    <Link to={`/matches/${match._id}`} className="block">
      <Card className={clsx('p-4 hover:shadow-rise transition-shadow', compact && 'p-3')}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge tone={meta.tone} icon={meta.icon}>{meta.label}</Badge>
              {match.isDeferred && <Badge tone="warning">מושהה</Badge>}
              {match.riskLevel === 'high' && <Badge tone="danger">סיכון גבוה</Badge>}
              {match.flexibilityOverrideApplied && <Badge tone="purple">גמישות</Badge>}
            </div>
            <div className="mt-2 text-sm text-ink-muted">
              <div>פנימי: <span className="font-mono text-xs">{match.internalCandidateId.slice(-6)}</span></div>
              <div>חיצוני: <span className="font-mono text-xs">{match.externalCandidateId.slice(-6)}</span></div>
            </div>
          </div>
          <div className="shrink-0 text-end">
            <div className={clsx('text-2xl font-semibold num', scoreTone)}>{match.matchScore}</div>
            <div className="text-xs text-ink-muted num">ביטחון {match.confidenceScore}</div>
          </div>
        </div>
        {match.strengths.length > 0 && !compact && (
          <div className="mt-3 text-xs text-ink-muted line-clamp-1">
            חוזק: {match.strengths.slice(0, 2).join(' • ')}
          </div>
        )}
      </Card>
    </Link>
  );
}, (prev, next) =>
  prev.compact === next.compact &&
  prev.match._id === next.match._id &&
  prev.match.matchType === next.match.matchType &&
  prev.match.matchScore === next.match.matchScore &&
  prev.match.confidenceScore === next.match.confidenceScore &&
  prev.match.isDeferred === next.match.isDeferred &&
  prev.match.riskLevel === next.match.riskLevel &&
  prev.match.flexibilityOverrideApplied === next.match.flexibilityOverrideApplied &&
  prev.match.internalCandidateId === next.match.internalCandidateId &&
  prev.match.externalCandidateId === next.match.externalCandidateId &&
  prev.match.strengths === next.match.strengths,
);
