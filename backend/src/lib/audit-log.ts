import { prisma } from './prisma-client.js';

// Durable compliance record (CLAUDE.md Security Baseline), separate from
// operational pino logs. Deliberately fire-and-forget from the caller's
// perspective: a Postgres hiccup writing the audit record must never
// block or roll back a safety-critical action (e.g. the e-stop itself) —
// the caller publishes the command first, then records it here, logging
// (not throwing) if the write fails.
export async function recordAdminAction(
  vin: string,
  action: string,
  issuedBy: string
): Promise<void> {
  await prisma.adminActionAudit.create({
    data: { vin, action, issuedBy }
  });
}

// Second admin-action kind (Role Management UI): the subject is a user,
// not a vehicle, so this populates targetEmail rather than vin — see the
// AdminActionAudit model comment for why the two subject columns are kept
// separate rather than one overloaded column.
export async function recordRoleChangeAudit(
  targetEmail: string,
  newRole: string,
  issuedBy: string
): Promise<void> {
  await prisma.adminActionAudit.create({
    data: { targetEmail, action: `role-change:${newRole}`, issuedBy }
  });
}
