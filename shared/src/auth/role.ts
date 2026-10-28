import { z } from 'zod';

export const roleSchema = z.enum(['ADMIN', 'OPERATOR']);

export type Role = z.infer<typeof roleSchema>;
