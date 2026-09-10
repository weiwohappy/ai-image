import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService, type DbTransaction } from '../../shared/database/database.service.js';
import { AppError } from '../../shared/http/errors.js';
import { ASSET_STORE } from '../assets/assets.service.js';
import type { ObjectStore } from '../assets/object-store.js';
import { AdminAuthService, lockAdmin, type AdminContext } from './auth.service.js';
import { AdminAuditService } from './audit.service.js';
import { digest } from './crypto.js';
import { requirePermission } from './permissions.js';
import { lockTeam } from './team/transaction.js';
const missing = () => new AppError(404, 'ADMIN_NOT_FOUND', 'Resource not found');
@Injectable()
export class AdminSensitiveService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AdminAuthService) private readonly auth: AdminAuthService,
    @Inject(AdminAuditService) private readonly audit: AdminAuditService,
    @Inject(ASSET_STORE) private readonly store: ObjectStore,
  ) {}
  private async failure(
    context: AdminContext,
    action: string,
    resourceId: string,
    error: unknown,
  ): Promise<never> {
    if (error instanceof AppError && [401, 403, 404].includes(error.status))
      await this.db.transaction((tx) =>
        this.audit.write(tx, action, 'denied', context.actor.id, context.sessionId, resourceId),
      );
    throw error;
  }
  private async check(tx: DbTransaction, context: AdminContext) {
    await lockTeam(tx);
    await lockAdmin(tx, context.actor.id);
    const current = await this.auth.reauthorize(
      tx,
      context.sessionId,
      context.actor.id,
      context.requestIp,
    );
    requirePermission(current.actor, 'sensitive.read');
    requirePermission(current.actor, 'jobs.read');
  }
  async grant(context: AdminContext, jobId: string, reason: string) {
    return this.db
      .transaction(async (tx) => {
        await this.check(tx, context);
        const job = await tx.generationJob.findUnique({
          where: { id: jobId },
          select: { id: true },
        });
        if (!job) throw missing();
        const id = randomUUID();
        const expiresAt = new Date(Date.now() + 300000);
        const reasonDigest = digest(reason);
        await this.audit.write(
          tx,
          'sensitive.grant',
          'allowed',
          context.actor.id,
          context.sessionId,
          id,
          reasonDigest,
        );
        await tx.adminSensitiveGrant.create({
          data: {
            id,
            accountId: context.actor.id,
            sessionId: context.sessionId,
            jobId,
            reason,
            reasonDigest,
            expiresAt,
          },
        });
        return { id, expiresAt: expiresAt.toISOString() };
      })
      .catch((error) => this.failure(context, 'sensitive.grant', jobId, error));
  }
  private async grantJob(
    tx: DbTransaction,
    context: AdminContext,
    grantId: string,
    jobId?: string,
  ) {
    await this.check(tx, context);
    const grant = await tx.adminSensitiveGrant.findUnique({
      where: { id: grantId },
      select: { id: true, accountId: true, sessionId: true, jobId: true, expiresAt: true },
    });
    if (
      !grant ||
      grant.accountId !== context.actor.id ||
      grant.sessionId !== context.sessionId ||
      grant.expiresAt <= new Date() ||
      (jobId && grant.jobId !== jobId)
    )
      throw missing();
    return grant.jobId;
  }
  private async assets(tx: DbTransaction, jobId: string) {
    const job = await tx.generationJob.findUnique({
      where: { id: jobId },
      select: {
        userId: true,
        items: { select: { resultAssetId: true } },
        pins: { select: { assetId: true, role: true } },
      },
    });
    if (!job) throw missing();
    const roles = new Map(job.pins.map((p) => [p.assetId, p.role]));
    for (const item of job.items) if (item.resultAssetId) roles.set(item.resultAssetId, 'result');
    const assets = await tx.asset.findMany({
      where: {
        id: { in: [...roles.keys()] },
        userId: job.userId,
        status: 'ready',
        deletedAt: null,
      },
      select: { id: true, width: true, height: true, objectKey: true, contentType: true },
    });
    return { assets, roles };
  }
  async content(context: AdminContext, jobId: string, grantId: string) {
    return this.db
      .transaction(async (tx) => {
        await this.grantJob(tx, context, grantId, jobId);
        const { assets, roles } = await this.assets(tx, jobId);
        const job = await tx.generationJob.findUnique({
          where: { id: jobId },
          select: { input: true },
        });
        if (!job) throw missing();
        const input = job.input as Record<string, unknown>;
        const prompt = typeof input.prompt === 'string' ? input.prompt : '';
        await this.audit.write(
          tx,
          'sensitive.content',
          'allowed',
          context.actor.id,
          context.sessionId,
          grantId,
        );
        return {
          prompt,
          assets: assets.map((a) => ({
            id: a.id,
            role: roles.get(a.id)!,
            width: a.width,
            height: a.height,
            previewPath: `/api/admin/assets/${a.id}/preview?grantId=${grantId}`,
          })),
        };
      })
      .catch((error) => this.failure(context, 'sensitive.content', grantId, error));
  }
  async preview(context: AdminContext, assetId: string, grantId: string) {
    return this.readPreview(context, assetId, grantId).catch((error) =>
      this.failure(context, 'sensitive.preview', grantId, error),
    );
  }
  private async readPreview(context: AdminContext, assetId: string, grantId: string) {
    const metadata = await this.db.transaction(async (tx) => {
      const jobId = await this.grantJob(tx, context, grantId);
      const { assets } = await this.assets(tx, jobId);
      const asset = assets.find((a) => a.id === assetId);
      if (!asset) throw missing();
      return asset;
    });
    let bytes: Uint8Array;
    try {
      bytes = await this.store.get(metadata.objectKey);
    } catch {
      throw missing();
    }
    // Reauthorize after I/O so expiry, deletion and revocation during retrieval fail closed.
    await this.db.transaction(async (tx) => {
      const jobId = await this.grantJob(tx, context, grantId);
      const { assets } = await this.assets(tx, jobId);
      if (!assets.some((a) => a.id === assetId && a.objectKey === metadata.objectKey))
        throw missing();
      await this.audit.write(
        tx,
        'sensitive.preview',
        'allowed',
        context.actor.id,
        context.sessionId,
        grantId,
      );
    });
    return { bytes, contentType: metadata.contentType };
  }
}
