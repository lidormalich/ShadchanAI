// ═══════════════════════════════════════════════════════════
// Backfill: match ↔ conversation linkage consistency.
//
// Phase 2 added match.conversationIds.sideA/sideB and
// conversation.matchSuggestionId back-linking. Matches sent
// before that change have sentSideXAt but no conversationIds.
//
// This script detects and — only where UNAMBIGUOUS — repairs.
// Any ambiguous case is reported for manual handling; nothing
// is ever overwritten.
//
// Repairs performed automatically (only when exactly ONE candidate
// conversation exists):
//   (A) match.sentSideAAt is set but match.conversationIds.sideA is
//       missing: resolve the conversation by
//         { channelId: <any match_sending channel's>,
//           internalCandidateId: match.internalCandidateId,
//           archivedAt: {$exists:false} }
//       If exactly one hit → link in both directions.
//   (B) Same for side B against externalCandidateId.
//   (C) match.conversationIds.sideX set but
//       conversation.matchSuggestionId is empty → set the back-link.
//
// Reported but NOT auto-fixed:
//   - multiple candidate conversations for the same side.
//   - zero candidate conversations (implies the original conversation
//     has been archived or deleted).
//   - conversation.matchSuggestionId points to a match that no
//     longer exists.
//
// Usage:
//   DRY_RUN=true npx tsx src/scripts/backfill-match-conversation-links.ts
//                npx tsx src/scripts/backfill-match-conversation-links.ts
// ═══════════════════════════════════════════════════════════

import dns from 'node:dns';
dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

import mongoose, { Types } from 'mongoose';
import { env } from '../config/env.js';
import {
  MatchSuggestion,
  Conversation,
} from '../models/index.js';

const DRY_RUN = process.env['DRY_RUN'] === 'true';

interface RepairReport {
  autoFixedSideA: number;
  autoFixedSideB: number;
  backlinksFixed: number;
  ambiguousSideA: Array<{ matchId: string; conversationIds: string[] }>;
  ambiguousSideB: Array<{ matchId: string; conversationIds: string[] }>;
  missingSideA: Array<{ matchId: string; internalCandidateId: string }>;
  missingSideB: Array<{ matchId: string; externalCandidateId: string }>;
  orphanConversations: Array<{ conversationId: string; matchSuggestionId: string }>;
}

async function repairSide(report: RepairReport, side: 'a' | 'b'): Promise<void> {
  const sentField = side === 'a' ? 'sentSideAAt' : 'sentSideBAt';
  const convField = side === 'a' ? 'conversationIds.sideA' : 'conversationIds.sideB';
  const candFieldOnConv = side === 'a' ? 'internalCandidateId' : 'externalCandidateId';
  const candFieldOnMatch = side === 'a' ? 'internalCandidateId' : 'externalCandidateId';

  const cursor = MatchSuggestion.find({
    [sentField]: { $exists: true },
    [convField]: { $exists: false },
  }).select('_id internalCandidateId externalCandidateId').cursor();

  for await (const match of cursor) {
    const candId = (match as Record<string, unknown>)[candFieldOnMatch] as Types.ObjectId;
    const candidateConvs = await Conversation.find({
      [candFieldOnConv]: candId,
      archivedAt: { $exists: false },
    }).select('_id matchSuggestionId').lean().exec();

    if (candidateConvs.length === 1) {
      const conv = candidateConvs[0]!;
      if (!DRY_RUN) {
        await MatchSuggestion.updateOne(
          { _id: match._id, [convField]: { $exists: false } },
          { $set: { [convField]: conv._id } },
        ).exec();
        if (!conv.matchSuggestionId) {
          await Conversation.updateOne(
            { _id: conv._id, matchSuggestionId: { $exists: false } },
            { $set: { matchSuggestionId: match._id } },
          ).exec();
        }
      }
      if (side === 'a') report.autoFixedSideA += 1; else report.autoFixedSideB += 1;
    } else if (candidateConvs.length === 0) {
      const rec = { matchId: String(match._id), [candFieldOnMatch]: String(candId) } as unknown;
      if (side === 'a') report.missingSideA.push(rec as typeof report.missingSideA[number]);
      else report.missingSideB.push(rec as typeof report.missingSideB[number]);
    } else {
      const rec = {
        matchId: String(match._id),
        conversationIds: candidateConvs.map((c) => String(c._id)),
      };
      if (side === 'a') report.ambiguousSideA.push(rec);
      else report.ambiguousSideB.push(rec);
    }
  }
}

async function repairBacklinks(report: RepairReport): Promise<void> {
  // match.conversationIds.sideX set but conversation.matchSuggestionId empty → fix.
  const cursor = MatchSuggestion.find({
    $or: [
      { 'conversationIds.sideA': { $exists: true } },
      { 'conversationIds.sideB': { $exists: true } },
    ],
  }).select('_id conversationIds').cursor();

  for await (const match of cursor) {
    const ids: Types.ObjectId[] = [];
    if (match.conversationIds?.sideA) ids.push(match.conversationIds.sideA);
    if (match.conversationIds?.sideB) ids.push(match.conversationIds.sideB);

    for (const convId of ids) {
      const conv = await Conversation.findById(convId).select('_id matchSuggestionId').lean().exec();
      if (!conv) continue;
      if (!conv.matchSuggestionId) {
        if (!DRY_RUN) {
          await Conversation.updateOne(
            { _id: conv._id, matchSuggestionId: { $exists: false } },
            { $set: { matchSuggestionId: match._id } },
          ).exec();
        }
        report.backlinksFixed += 1;
      }
    }
  }

  // Orphan: conversation.matchSuggestionId set, but the match doesn't exist.
  const orphanCursor = Conversation.find({
    matchSuggestionId: { $exists: true },
  }).select('_id matchSuggestionId').cursor();
  for await (const conv of orphanCursor) {
    if (!conv.matchSuggestionId) continue;
    const exists = await MatchSuggestion.exists({ _id: conv.matchSuggestionId });
    if (!exists) {
      report.orphanConversations.push({
        conversationId: String(conv._id),
        matchSuggestionId: String(conv.matchSuggestionId),
      });
    }
  }
}

async function main(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI);

  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'APPLY'}`);

  const report: RepairReport = {
    autoFixedSideA: 0,
    autoFixedSideB: 0,
    backlinksFixed: 0,
    ambiguousSideA: [],
    ambiguousSideB: [],
    missingSideA: [],
    missingSideB: [],
    orphanConversations: [],
  };

  await repairSide(report, 'a');
  await repairSide(report, 'b');
  await repairBacklinks(report);

  console.log(JSON.stringify({
    summary: {
      autoFixedSideA: report.autoFixedSideA,
      autoFixedSideB: report.autoFixedSideB,
      backlinksFixed: report.backlinksFixed,
      ambiguousSideACount: report.ambiguousSideA.length,
      ambiguousSideBCount: report.ambiguousSideB.length,
      missingSideACount: report.missingSideA.length,
      missingSideBCount: report.missingSideB.length,
      orphanConversationCount: report.orphanConversations.length,
    },
    details: report,
  }, null, 2));

  console.log(DRY_RUN
    ? 'Dry run: no writes.'
    : 'Auto-fixes applied. Review "ambiguous*", "missing*", and "orphanConversations" manually.');

  await mongoose.disconnect();
}

void main().catch((e) => {
  console.error('backfill-match-conversation-links failed:', e);
  process.exit(1);
});
