import { Types } from 'mongoose';
import { AuditActionType, AuditEntityType, TaskStatus } from '@shadchanai/shared';
import { Task, type ITask } from '../../models/index.js';
import { audit } from '../../services/audit.service.js';
import { NotFoundError, BusinessRuleError } from '../../utils/errors.js';
import { toSkipLimit, buildSort, makeMeta } from '../../utils/pagination.js';
import { applyOwnershipFilter } from '../../utils/ownership.js';
import { assertOwnershipOrAssignee } from '../../utils/ownership.assert.js';
import type { AuthUser } from '../../middleware/auth.middleware.js';
import type { CreateTaskInput, UpdateTaskInput, ListTasksQuery } from './task.validator.js';

export async function listTasks(
  query: ListTasksQuery,
  currentUserId?: string,
): Promise<{ items: ITask[]; total: number; meta: ReturnType<typeof makeMeta> }> {
  const { skip, limit } = toSkipLimit(query);
  const sort = buildSort(query, 'dueAt');
  const filter: Record<string, unknown> = {};
  if (query.status) filter['status'] = query.status;
  if (query.priority) filter['priority'] = query.priority;
  if (query.type) filter['type'] = query.type;
  if (query.ownerUserId) filter['ownerUserId'] = new Types.ObjectId(query.ownerUserId);
  if (query.assignedTo) filter['assignedTo'] = new Types.ObjectId(query.assignedTo);
  if (query.dueBefore) filter['dueAt'] = { $lte: query.dueBefore };
  if (query.internalCandidateId) filter['internalCandidateId'] = new Types.ObjectId(query.internalCandidateId);
  if (query.externalCandidateId) filter['externalCandidateId'] = new Types.ObjectId(query.externalCandidateId);
  if (query.matchSuggestionId) filter['matchSuggestionId'] = new Types.ObjectId(query.matchSuggestionId);
  if (query.conversationId) filter['conversationId'] = new Types.ObjectId(query.conversationId);
  // "mine" scopes to tasks the operator owns OR that have been
  // assigned to them — the operator's "my work" view on /tasks.
  if (query.ownership === 'mine' && currentUserId) {
    filter['$or'] = [
      { ownerUserId: new Types.ObjectId(currentUserId) },
      { assignedTo: new Types.ObjectId(currentUserId) },
    ];
  } else {
    applyOwnershipFilter(filter, 'ownerUserId', query.ownership, currentUserId);
  }

  const [items, total] = await Promise.all([
    Task.find(filter).sort(sort).skip(skip).limit(limit).lean().exec(),
    Task.countDocuments(filter).exec(),
  ]);
  return {
    items: items as unknown as ITask[],
    total,
    meta: makeMeta(query.page, query.limit, total),
  };
}

export async function getTaskById(id: string): Promise<ITask> {
  const doc = await Task.findById(id).exec();
  if (!doc) throw new NotFoundError('Task', id);
  return doc;
}

export async function createTask(input: CreateTaskInput, performedBy: string): Promise<ITask> {
  const doc = await Task.create({
    ...input,
    ownerUserId: new Types.ObjectId(performedBy),
    internalCandidateId: input.internalCandidateId ? new Types.ObjectId(input.internalCandidateId) : undefined,
    externalCandidateId: input.externalCandidateId ? new Types.ObjectId(input.externalCandidateId) : undefined,
    matchSuggestionId: input.matchSuggestionId ? new Types.ObjectId(input.matchSuggestionId) : undefined,
    conversationId: input.conversationId ? new Types.ObjectId(input.conversationId) : undefined,
    assignedTo: input.assignedTo ? new Types.ObjectId(input.assignedTo) : undefined,
    status: TaskStatus.OPEN,
  });
  await audit({
    entityType: AuditEntityType.TASK,
    entityId: String(doc._id),
    actionType: AuditActionType.CREATE,
    performedBy,
    after: doc.toObject(),
  });
  return doc;
}

export async function updateTask(id: string, input: UpdateTaskInput, performedBy: string, actor?: AuthUser): Promise<ITask> {
  const doc = await getTaskById(id);
  if (actor) assertOwnershipOrAssignee(doc.ownerUserId, doc.assignedTo, actor, { entity: 'task' });
  if (doc.status === TaskStatus.COMPLETED || doc.status === TaskStatus.CANCELLED) {
    throw new BusinessRuleError(`Cannot update task in status: ${doc.status}`);
  }
  const before = doc.toObject();
  Object.assign(doc, input);
  await doc.save();
  await audit({
    entityType: AuditEntityType.TASK,
    entityId: id,
    actionType: AuditActionType.UPDATE,
    performedBy,
    before,
    after: doc.toObject(),
  });
  return doc;
}

export async function completeTask(
  id: string,
  completionNote: string | undefined,
  performedBy: string,
  actor?: AuthUser,
): Promise<ITask> {
  const doc = await getTaskById(id);
  if (actor) assertOwnershipOrAssignee(doc.ownerUserId, doc.assignedTo, actor, { entity: 'task' });
  if (doc.status === TaskStatus.COMPLETED) return doc;
  const before = doc.toObject();
  doc.status = TaskStatus.COMPLETED;
  doc.completedAt = new Date();
  doc.completedBy = new Types.ObjectId(performedBy);
  doc.completionNote = completionNote;
  await doc.save();
  await audit({
    entityType: AuditEntityType.TASK,
    entityId: id,
    actionType: AuditActionType.STATUS_CHANGE,
    performedBy,
    before,
    after: doc.toObject(),
    metadata: { transition: 'complete' },
  });
  return doc;
}

export async function reassignTask(
  id: string,
  assignedTo: string,
  performedBy: string,
  actor?: AuthUser,
): Promise<ITask> {
  const doc = await getTaskById(id);
  if (actor) assertOwnershipOrAssignee(doc.ownerUserId, doc.assignedTo, actor, { entity: 'task' });
  const before = doc.toObject();
  doc.assignedTo = new Types.ObjectId(assignedTo);
  await doc.save();
  await audit({
    entityType: AuditEntityType.TASK,
    entityId: id,
    actionType: AuditActionType.UPDATE,
    performedBy,
    before,
    after: doc.toObject(),
    metadata: { transition: 'reassign', assignedTo },
  });
  return doc;
}
