// ═══════════════════════════════════════════════════════════
// ShadchanAI — Model barrel file
// Single import point for all Mongoose models.
// ═══════════════════════════════════════════════════════════

export { InternalCandidate } from '../modules/candidates/internal-candidate.model.js';
export type { IInternalCandidate } from '../modules/candidates/internal-candidate.model.js';

export { ExternalCandidate } from '../modules/candidates/external-candidate.model.js';
export type { IExternalCandidate } from '../modules/candidates/external-candidate.model.js';

export { MatchSuggestion } from '../modules/matches/match-suggestion.model.js';
export type { IMatchSuggestion } from '../modules/matches/match-suggestion.model.js';

export { Conversation } from '../modules/conversations/conversation.model.js';
export type { IConversation } from '../modules/conversations/conversation.model.js';

export { Message } from '../modules/conversations/message.model.js';
export type { IMessage } from '../modules/conversations/message.model.js';

export { Channel } from '../modules/channels/channel.model.js';
export type { IChannel } from '../modules/channels/channel.model.js';

export { Task } from '../modules/tasks/task.model.js';
export type { ITask } from '../modules/tasks/task.model.js';

export { Note } from '../modules/notes/note.model.js';
export type { INote } from '../modules/notes/note.model.js';

export { AuditLog } from '../modules/audit/audit-log.model.js';
export type { IAuditLog } from '../modules/audit/audit-log.model.js';

export { ChatMapping } from '../modules/chat-mappings/chat-mapping.model.js';
export type { IChatMapping, ChatRole, ChatType } from '../modules/chat-mappings/chat-mapping.model.js';

export { AIRequest } from '../modules/ai/ai-request.model.js';
export type { IAIRequest } from '../modules/ai/ai-request.model.js';

export { User } from '../modules/users/user.model.js';
export type { IUser, UserRole } from '../modules/users/user.model.js';
