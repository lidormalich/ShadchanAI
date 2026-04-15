import { z } from 'zod';
import { NoteEntityType, NoteVisibility } from '@shadchanai/shared';
import { PaginationQuerySchema } from '../../utils/pagination.js';

const ObjectIdString = z.string().regex(/^[a-f\d]{24}$/i);

export const CreateNoteSchema = z.object({
  entityType: z.nativeEnum(NoteEntityType),
  entityId: ObjectIdString,
  body: z.string().trim().min(1).max(5000),
  visibility: z.nativeEnum(NoteVisibility).default(NoteVisibility.INTERNAL),
  mentions: z.array(ObjectIdString).max(20).default([]),
  pinned: z.boolean().default(false),
});
export type CreateNoteInput = z.infer<typeof CreateNoteSchema>;

export const UpdateNoteSchema = z.object({
  body: z.string().trim().min(1).max(5000).optional(),
  visibility: z.nativeEnum(NoteVisibility).optional(),
  pinned: z.boolean().optional(),
  mentions: z.array(ObjectIdString).max(20).optional(),
});
export type UpdateNoteInput = z.infer<typeof UpdateNoteSchema>;

export const ListNotesQuerySchema = PaginationQuerySchema.extend({
  entityType: z.nativeEnum(NoteEntityType),
  entityId: ObjectIdString,
  visibility: z.nativeEnum(NoteVisibility).optional(),
});
export type ListNotesQuery = z.infer<typeof ListNotesQuerySchema>;

export const IdParamSchema = z.object({ id: ObjectIdString });
