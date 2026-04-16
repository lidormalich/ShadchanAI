// ═══════════════════════════════════════════════════════════
// useSafeMode — small client cache of the server's safe-mode
// status. Used to disable send buttons across the UI.
//
// Source of truth is the server. The client read here is a
// best-effort "is the button likely to work" cosmetic gate.
// The actual block is enforced server-side in match.service
// and whatsapp.service — frontend disabling is for UX only.
// ═══════════════════════════════════════════════════════════

import { useQuery } from '@tanstack/react-query';
import { safeModeApi } from '@/services/api/safe-mode';

export interface SafeModeView {
  outboundEnabled: boolean;
  reason?: string;
  requireExplicitMapping: boolean;
  loaded: boolean;
}

const FALLBACK: SafeModeView = {
  outboundEnabled: false, // safer default: assume blocked until we know
  reason: 'loading…',
  requireExplicitMapping: true,
  loaded: false,
};

export function useSafeMode(): SafeModeView {
  const q = useQuery({
    queryKey: ['safe-mode', 'status'],
    queryFn: () => safeModeApi.status(),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  if (!q.data) return FALLBACK;
  const sm = q.data.data;
  return {
    outboundEnabled: sm.outboundEnabled,
    reason: sm.reason,
    requireExplicitMapping: sm.requireExplicitMapping,
    loaded: true,
  };
}
