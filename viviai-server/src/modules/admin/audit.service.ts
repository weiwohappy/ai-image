import { Injectable } from '@nestjs/common';
import type { DbTransaction } from '../../shared/database/database.service.js';
export interface AuditMetadata {
  code?: string;
  changedFields?: string[];
  beforeRoles?: string[];
  afterRoles?: string[];
  beforeStatus?: string;
  afterStatus?: string;
  beforeVersion?: number;
  afterVersion?: number;
  credentialId?: string;
  memberCount?: number;
  invitationCount?: number;
  modelId?: string;
  resolution?: string;
  beforeUnitCredits?: number | null;
  afterUnitCredits?: number;
  beforeEnabled?: boolean | null;
  afterEnabled?: boolean;
  source?: 'offline_import';
}
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
    metadata?: AuditMetadata,
  ) {
    return tx.adminAuditEvent.create({
      data: {
        action,
        outcome,
        ...(accountId ? { accountId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(resourceId ? { resourceId } : {}),
        ...(reasonDigest ? { reasonDigest } : {}),
        ...(metadata
          ? {
              metadata: Object.fromEntries(
                Object.entries(metadata).filter(([key]) =>
                  [
                    'code',
                    'changedFields',
                    'beforeRoles',
                    'afterRoles',
                    'beforeStatus',
                    'afterStatus',
                    'beforeVersion',
                    'afterVersion',
                    'credentialId',
                    'memberCount',
                    'invitationCount',
                    'modelId',
                    'resolution',
                    'beforeUnitCredits',
                    'afterUnitCredits',
                    'beforeEnabled',
                    'afterEnabled',
                    'source',
                  ].includes(key),
                ),
              ),
            }
          : {}),
      },
      select: { id: true },
    });
  }
}
