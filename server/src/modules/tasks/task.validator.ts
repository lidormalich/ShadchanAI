import { z } from 'zod';
import { TaskStatus, TaskPriority, TaskType } from '@shadchanai/shared';
import { PaginationQuerySchema } from '../../utils/pagination.js';

const ObjectIdString = z.string().regex(/^[a-f\d]{24}$/i);

export const CreateTaskSchema = z.object({
  type: z.nativeEnum(TaskType),
  title: z.string().trim().min(1).max(300),
  description: z.string().max(2000).optional(),
  internalCandidateId: ObjectIdString.optional(),
  externalCandidateId: ObjectIdString.optional(),
  matchSuggestionId: ObjectIdString.optional(),
  conversationId: ObjectIdString.optional(),
  assignedTo: ObjectIdString.optional(),
  priority: z.nativeEnum(TaskPriority).default(TaskPriority.MEDIUM),
  dueAt: z.coerce.date().optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;

export const UpdateTaskSchema = CreateTaskSchema.partial();
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;

export const CompleteTaskSchema = z.object({
  completionNote: z.string().max(1000).optional(),
});

export const ReassignTaskSchema = z.object({
  assignedTo: ObjectIdString,
});

export const ListTasksQuerySchema = PaginationQuerySchema.extend({
  status: z.nativeEnum(TaskStatus).optional(),
  priority: z.nativeEnum(TaskPriority).optional(),
  type: z.nativeEnum(TaskType).optional(),
  ownerUserId: ObjectIdString.optional(),
  assignedTo: ObjectIdString.optional(),
  dueBefore: z.coerce.date().optional(),
  internalCandidateId: ObjectIdString.optional(),
  externalCandidateId: ObjectIdString.optional(),
  matchSuggestionId: ObjectIdString.optional(),
  conversationId: ObjectIdString.optional(),
  ownership: z.enum(['mine', 'team', 'all']).optional(),
});
export type ListTasksQuery = z.infer<typeof ListTasksQuerySchema>;

export const IdParamSchema = z.object({ id: ObjectIdString });
