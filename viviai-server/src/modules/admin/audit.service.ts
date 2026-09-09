import { Injectable } from '@nestjs/common';
import type { DbTransaction } from '../../shared/database/database.service.js';
@Injectable()
export class AdminAuditService {
  write(
    tx: DbTransaction,
    action: string,
    outcome: 'allowed' | 'denied',
    accountId?: string,
    sessionId?: string,
    resourceId?: string,
    reasonDigest?: string,
  ) {
    return tx.adminAuditEvent.create({
      data: {
        action,
        outcome,
        ...(accountId ? { accountId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(resourceId ? { resourceId } : {}),
        ...(reasonDigest ? { reasonDigest } : {}),
      },
      select: { id: true },
    });
  }
}
