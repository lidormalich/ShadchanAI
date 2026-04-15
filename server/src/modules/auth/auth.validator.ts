import { z } from 'zod';

export const LoginSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const RegisterSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
  name: z.string().trim().min(1).max(200),
  roles: z.array(z.enum(['admin', 'shadchan', 'reviewer', 'viewer'])).optional(),
});
export type RegisterInput = z.infer<typeof RegisterSchema>;

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8).max(200),
});
