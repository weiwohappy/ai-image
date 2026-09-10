import { z } from 'zod';
import { DatabaseService } from '../../shared/database/database.service.js';
import { AdminAuditService } from './audit.service.js';
import { lockAdmin } from './auth.service.js';
import { lockTeam, invalidateAdmin } from './team/transaction.js';
import { digest, token } from './crypto.js';
import { ROLE_PERMISSIONS } from './permissions.js';
const invite = z
  .object({
    email: z
      .string()
      .trim()
      .email()
      .max(254)
      .transform((s) => s.toLowerCase()),
    roles: z
      .array(z.string().refine((r) => r !== 'super_admin' && Object.hasOwn(ROLE_PERMISSIONS, r)))
      .min(1)
      .max(6),
    extraPermissions: z.array(z.literal('sensitive.read')).max(1).default([]),
  })
  .strict();
export async function bootstrapAdministrators(
  db: DatabaseService,
  input: unknown,
  deliver?: (
    invitations: Array<{ email: string; token: string; expiresAt: string }>,
  ) => Promise<void>,
) {
  const parsed = z.array(invite).length(2).safeParse(input);
  if (!parsed.success || new Set(parsed.data.map((i) => i.email)).size !== 2)
    throw new Error(
      'Bootstrap requires exactly two distinct explicit administrator emails and role lists',
    );
  return db.transaction(async (tx) => {
    await lockTeam(tx);
    await lockAdmin(tx, 'initial-bootstrap');
    if (
      (await tx.adminAccount.count()) ||
      (await tx.adminInvitation.count()) ||
      (await tx.adminAuditEvent.count({ where: { action: 'bootstrap.create' } }))
    )
      throw new Error('Administrator bootstrap already exists; repeat population is forbidden');
    const expiresAt = new Date(Date.now() + 86400000);
    const output = [];
    for (const item of parsed.data) {
      const raw = token();
      const invitation = await tx.adminInvitation.create({
        data: {
          email: item.email,
          roleBindings: { create: [...new Set(item.roles)].map((roleKey) => ({ roleKey })) },
          displayName: item.email,
          extraPermissions: item.extraPermissions,
          tokenHash: digest(raw),
          expiresAt,
        },
      });
      await new AdminAuditService().write(
        tx,
        'bootstrap.create',
        'allowed',
        undefined,
        undefined,
        invitation.id,
      );
      output.push({ email: item.email, token: raw, expiresAt: expiresAt.toISOString() });
    }
    if (deliver) await deliver(output);
    return output;
  });
}
export async function revokeAdministrator(db: DatabaseService, email: string, reason: string) {
  const normalized = z
    .string()
    .trim()
    .email()
    .max(254)
    .transform((s) => s.toLowerCase())
    .parse(email);
  if (reason.trim().length < 10 || reason.length > 500)
    throw new Error('A 10–500 character revocation reason is required');
  await db.transaction(async (tx) => {
    await lockTeam(tx);
    await lockAdmin(tx, `email:${normalized}`);
    const account = await tx.adminAccount.findUnique({
      where: { email: normalized },
      select: { id: true },
    });
    if (!account) throw new Error('Administrator not found');
    await lockAdmin(tx, account.id);
    if (
      await tx.adminAccountRole.findUnique({
        where: { accountId_roleKey: { accountId: account.id, roleKey: 'super_admin' } },
      })
    )
      throw new Error('Super administrators must be managed through the protected team interface');
    await tx.adminAccount.update({
      where: { id: account.id },
      data: { disabledAt: new Date(), version: { increment: 1 }, authVersion: { increment: 1 } },
    });
    await invalidateAdmin(tx, account.id);
    await new AdminAuditService().write(
      tx,
      'account.revoke',
      'allowed',
      undefined,
      undefined,
      account.id,
      digest(reason),
    );
  });
}
