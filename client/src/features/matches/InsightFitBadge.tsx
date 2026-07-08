// ═══════════════════════════════════════════════════════════
// InsightFitBadge + useInsightFits — the advisory ⭐ surface.
//
// Shows whether an external candidate ALIGNS with what the engine
// learned about the internal candidate (positive signals) or CONFLICTS
// with a learned rejection pattern (negative signals). The badge tooltip
// carries the exact learned signal so the operator judges. Purely
// advisory — it never affects the deterministic match score or ranking.
// ═══════════════════════════════════════════════════════════

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Star, AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/primitives';
import { matchesApi, type InsightFitResult } from '@/services/api/matches';

type Fit = InsightFitResult['fit'];
type Pair = { internalCandidateId: string; externalCandidateId: string };

const keyOf = (internalId: string, externalId: string) => `${internalId}:${externalId}`;

/**
 * Batch-load insight-fit for a set of pairs in one request. Returns a
 * `fitFor(internalId, externalId)` lookup. Safe to call with an empty
 * list (no request fires). Cached 5 min — insights change slowly.
 */
export function useInsightFits(pairs: Pair[]) {
  const cacheKey = useMemo(
    () => pairs.map((p) => keyOf(p.internalCandidateId, p.externalCandidateId)).sort().join(','),
    [pairs],
  );

  const q = useQuery({
    queryKey: ['insight-fit', cacheKey],
    queryFn: () => matchesApi.insightFit({ pairs }),
    enabled: pairs.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  const map = useMemo(() => {
    const m = new Map<string, Fit>();
    for (const r of q.data?.data ?? []) m.set(keyOf(r.internalCandidateId, r.externalCandidateId), r.fit);
    return m;
  }, [q.data]);

  return {
    fitFor: (internalId: string, externalId: string): Fit | undefined => map.get(keyOf(internalId, externalId)),
    isLoading: q.isLoading,
  };
}

/** Renders nothing for neutral / missing fit — only speaks when it has something to say. */
export function InsightFitBadge({ fit, className }: { fit?: Fit; className?: string }) {
  if (!fit || fit.tier === 'neutral') return null;

  if (fit.tier === 'aligned') {
    return (
      <Badge tone="success" className={className} icon={<Star className="h-3 w-3" />} title={fit.reason ? `תואם תובנה שנלמדה: ${fit.reason}` : 'תואם למה שנלמד על המועמד'}>
        תואם תובנה
      </Badge>
    );
  }
  return (
    <Badge tone="warning" className={className} icon={<AlertTriangle className="h-3 w-3" />} title={fit.reason ? `מנוגד לתובנה שנלמדה: ${fit.reason}` : 'מנוגד למה שנלמד על המועמד'}>
      שים לב — נלמד
    </Badge>
  );
}
