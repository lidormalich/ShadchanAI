// ═══════════════════════════════════════════════════════════
// ShadchanAI — Inbound match-response classification + apply
//
// This is the MATCH-DOMAIN decision logic for an inbound WhatsApp
// reply on a sent proposal. It used to live inline in the WhatsApp
// message handler; it belongs to the matches module because it:
//   - resolves which side (a/b) the conversation represents,
//   - runs the deterministic regex classifier first, escalating to
//     the advisory AI classifier only under the confidence policy,
//   - and advances the match state machine via applyInboundResponse.
//
// The message handler now calls the single classifyAndApplyInbound-
// Response entrypoint; it no longer owns any match decisioning.
// ═══════════════════════════════════════════════════════════

import { MatchSuggestion } from '../../models/index.js';
import { classifyResponse } from '../../services/whatsapp/response.classifier.js';
import { classifyMessage as aiClassifyMessage } from '../../services/ai/ai.service.js';
import { applyInboundResponse } from './match.lifecycle.js';

// AI may ONLY escalate to a decisive accepted/declined when its own
// confidence crosses this floor; otherwise the status is held at
// "considering". Prevents a low-confidence LLM reply from mis-advancing
// the match state machine.
const AI_MIN_CONFIDENCE = 0.7;
// Below this regex confidence we fall back to the AI advisory.
const REGEX_MIN_CONFIDENCE = 0.6;

export interface InboundMatchResponseInput {
  matchId: string;
  conversationId: string;
  messageId: string;
  body: string;
}

/**
 * Classify an inbound reply on a match conversation and apply the
 * resulting response to the match. Returns false (no-op) when the
 * conversation is linked to the match but not bound to a specific
 * side, or when the match no longer exists.
 */
export async function classifyAndApplyInboundResponse(
  input: InboundMatchResponseInput,
): Promise<boolean> {
  const { matchId, conversationId, messageId, body } = input;

  const match = await MatchSuggestion.findById(matchId).lean().exec();
  if (!match) return false;

  // Determine which side this conversation represents.
  let side: 'a' | 'b' | null = null;
  if (String(match.conversationIds?.sideA ?? '') === conversationId) side = 'a';
  else if (String(match.conversationIds?.sideB ?? '') === conversationId) side = 'b';
  if (!side) return false; // linked to match but not bound to a specific side

  // Deterministic classification first.
  const regex = classifyResponse(body);
  let status: 'accepted' | 'declined' | 'considering' = regex.status;
  let classifier: 'regex' | 'ai' = 'regex';
  let confidence = regex.confidence;

  // Confidence policy (Phase 7 hardening):
  //   - Regex ≥ 0.6  → apply regex verdict.
  //   - Regex < 0.6  → AI advisory; AI may only escalate to a decisive
  //     accepted/declined when its own confidence crosses the floor.
  if (regex.confidence < REGEX_MIN_CONFIDENCE) {
    try {
      const ai = await aiClassifyMessage(
        { text: body, context: { purpose: 'match_proposal' } },
        { messageId },
      );
      const sentiment = ai.data.sentiment;
      const aiConfidence = ai.data.confidence ?? 0;
      const decisive = aiConfidence >= AI_MIN_CONFIDENCE;

      if (sentiment === 'positive' && decisive) {
        status = 'accepted';
      } else if (sentiment === 'negative' && decisive) {
        status = 'declined';
      } else {
        // non-decisive OR below confidence floor → conservative.
        // Row surfaces on dashboard as "considering" for operator review.
        status = 'considering';
      }
      classifier = 'ai';
      confidence = aiConfidence;
    } catch {
      // AI unreachable — keep regex verdict (likely 'considering').
    }
  }

  await applyInboundResponse(matchId, side, status, {
    messageId,
    classifier,
    classifierConfidence: confidence,
    rawText: body,
  });
  return true;
}
