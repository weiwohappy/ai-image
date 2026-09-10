import type { DbTransaction } from '../../../shared/database/database.service.js';
export async function lockTeam(tx: DbTransaction): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'admin:team'}, 0))`;
}
export async function invalidateAdmin(tx: DbTransaction, accountId: string) {
  await tx.adminSession.updateMany({ where: { accountId }, data: { expiresAt: new Date(0) } });
  await tx.adminChallenge.deleteMany({ where: { accountId } });
  await tx.adminSensitiveGrant.deleteMany({ where: { accountId } });
  await tx.adminPasswordReset.updateMany({
    where: { accountId, consumedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
