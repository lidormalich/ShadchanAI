// ═══════════════════════════════════════════════════════════
// CoverageReport — post-reconnect downtime coverage verdict.
//
// Written by the coverage service a few minutes after a channel
// reconnects from a meaningful offline window. Answers, per
// downtime event: "did WhatsApp's offline queue actually deliver
// the messages sent while we weren't listening?"
//
// A chat is flagged `suspect` when it normally has traffic
// (baseline rate) but produced ZERO messages inside the window —
// the one silent-loss shape the operator must go verify by hand.
// ═══════════════════════════════════════════════════════════

import mongoose, { Schema, Document } from 'mongoose';

export interface ICoverageChatEntry {
  chatJid: string;
  chatName?: string;
  /** Inbound messages whose ORIGINAL send time falls inside the window. */
  windowCount: number;
  /** Inbound messages ingested during the baseline period before the window. */
  baselineCount: number;
  /** Baseline messages per day (baselineCount / baseline days). */
  baselinePerDay: number;
  /** baselinePerDay × window length in days. */
  expectedInWindow: number;
  /** Normally-active chat that yielded zero window messages. */
  suspect: boolean;
}

export interface ICoverageReport extends Document {
  channelId: string;
  accountDisplayName?: string;

  /** The offline window we verified. */
  offlineFrom: Date;
  offlineTo: Date;
  offlineMs: number;

  /** Total inbound messages (channel-wide) with original timestamp in the window. */
  messagesInWindow: number;

  /** Per mapped profiles_source chat. */
  chats: ICoverageChatEntry[];
  suspectCount: number;

  createdAt: Date;
  updatedAt: Date;
}

const coverageChatEntrySchema = new Schema<ICoverageChatEntry>(
  {
    chatJid: { type: String, required: true },
    chatName: { type: String },
    windowCount: { type: Number, required: true },
    baselineCount: { type: Number, required: true },
    baselinePerDay: { type: Number, required: true },
    expectedInWindow: { type: Number, required: true },
    suspect: { type: Boolean, required: true },
  },
  { _id: false },
);

const coverageReportSchema = new Schema<ICoverageReport>(
  {
    channelId: { type: String, required: true },
    accountDisplayName: { type: String },
    offlineFrom: { type: Date, required: true },
    offlineTo: { type: Date, required: true },
    offlineMs: { type: Number, required: true },
    messagesInWindow: { type: Number, required: true },
    chats: { type: [coverageChatEntrySchema], default: [] },
    suspectCount: { type: Number, required: true, default: 0 },
  },
  { timestamps: true, collection: 'coverageReports' },
);

// Operator banner: recent reports, newest first (optionally per channel).
coverageReportSchema.index({ channelId: 1, createdAt: -1 });
// Reports are diagnostics, not history-of-record — expire after 90 days.
coverageReportSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });

export const CoverageReport = mongoose.model<ICoverageReport>('CoverageReport', coverageReportSchema);
