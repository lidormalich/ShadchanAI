// ═══════════════════════════════════════════════════════════
// Pre-pilot safe-mode gate.
//
// Outbound is allowed ONLY when BOTH:
//   1. env.ENABLE_OUTBOUND_MESSAGES === true   (deploy-time gate)
//   2. settings 'outbound.enabled' === true    (runtime gate)
//
// Either being false blocks the send. Default for both is FALSE so
// the system ships safe — an operator must explicitly opt-in to
// real WhatsApp dispatch.
// ═══════════════════════════════════════════════════════════

import { env } from '../../config/env.js';
import { getSettingBoolean } from '../../modules/settings/settings.service.js';
import { BusinessRuleError } from '../../utils/errors.js';

export interface SafeModeStatus {
  outboundEnabled: boolean;
  envEnabled: boolean;
  settingEnabled: boolean;
  // Why outbound is blocked, when it is, in a form the UI can show.
  reason?: string;
  requireExplicitMapping: boolean;
}

export async function getSafeModeStatus(): Promise<SafeModeStatus> {
  const envEnabled = env.ENABLE_OUTBOUND_MESSAGES === true;
  const settingEnabled = await getSettingBoolean('outbound.enabled');
  const outboundEnabled = envEnabled && settingEnabled;

  let reason: string | undefined;
  if (!envEnabled && !settingEnabled) reason = 'env + settings both disabled';
  else if (!envEnabled) reason = 'ENABLE_OUTBOUND_MESSAGES env is false';
  else if (!settingEnabled) reason = 'settings outbound.enabled is false';

  return {
    outboundEnabled,
    envEnabled,
    settingEnabled,
    reason,
    requireExplicitMapping: env.REQUIRE_EXPLICIT_SOURCE_MAPPING === true,
  };
}

/**
 * Throw-form helper used at the top of every outbound entry point.
 * The caller catches BusinessRuleError and surfaces the structured
 * error code to the operator UI.
 */
export async function assertOutboundAllowed(): Promise<void> {
  const status = await getSafeModeStatus();
  if (!status.outboundEnabled) {
    throw new BusinessRuleError(
      'Safe mode active — outbound WhatsApp sending is disabled',
      {
        code: 'safe_mode_outbound_disabled',
        envEnabled: status.envEnabled,
        settingEnabled: status.settingEnabled,
        reason: status.reason,
      },
    );
  }
}
