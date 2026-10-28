import { z } from 'zod';
import { roleSchema } from './role.js';

// GET /api/v1/admin/users list item — the Role Management UI's view of a
// user, not the full Prisma row (no passwordHash/oidcSubject exposed).
export interface AdminUserSummary {
  id: string;
  email: string;
  name: string | null;
  role: z.infer<typeof roleSchema>;
  createdAt: string;
}

export const updateUserRoleRequestSchema = z.object({
  role: roleSchema
});

export type UpdateUserRoleRequest = z.infer<typeof updateUserRoleRequestSchema>;
