// ═══════════════════════════════════════════════════════════
// Persistent top banner shown ONLY while outbound is disabled.
// Mounted in AppShell so every screen sees it during pre-pilot.
// ═══════════════════════════════════════════════════════════

import { ShieldAlert } from "lucide-react";
import { useSafeMode } from "./useSafeMode";

export function SafeModeBanner() {
  return null;
  // Disabled for now — pilot is over, outbound is re-enabled.
  const sm = useSafeMode();
  if (sm.outboundEnabled) return null;
  return (
    <div className='bg-amber-50 border-b border-amber-200 text-amber-900 text-xs px-4 py-1.5 flex items-center gap-2'>
      <ShieldAlert className='h-3.5 w-3.5 shrink-0' />
      <span className='font-medium'>
        מצב בטיחות פעיל — שליחת הודעות WhatsApp מושבתת.
      </span>
      {sm.reason && <span className='text-amber-700'>({sm.reason})</span>}
    </div>
  );
}
