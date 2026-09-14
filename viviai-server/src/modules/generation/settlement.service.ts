import { createHash, randomUUID } from 'node:crypto';
import type { ProviderAttempt } from '../../generated/prisma/client.js';
import { DatabaseService, type DbTransaction } from '../../shared/database/database.service.js';
import { lockWallet } from '../../shared/database/locks.js';
import type { ObjectStore } from '../assets/object-store.js';
import { validateImage, MAX_GENERATED_IMAGE_BYTES } from '../assets/image-validation.js';
import { WalletService } from '../wallet/wallet.service.js';
import { recordCost, releaseConfirmedSlot } from '../providers/accounting.js';
import type { CompletedResult, NormalizedImageRequest } from '../providers/contracts.js';
import { TERMINAL } from './job-serializer.js';
import { recordLifecycle } from '../admin/lifecycle.js';
import { NotificationService } from '../engagement/notification.service.js';

export class SettlementService {
  private readonly notifications: NotificationService;
  constructor(
    private readonly db: DatabaseService,
    private readonly wallet: WalletService,
    private readonly store: ObjectStore,
  ) {
    this.notifications = new NotificationService(db);
  }
  async fail(tx: DbTransaction, itemId: string, code: string, cancelled = false, now = new Date()) {
    const item = await tx.generationItem.findUniqueOrThrow({
      where: { id: itemId },
      include: { job: true },
    });
    await lockWallet(tx, item.job.userId);
    const current = await tx.generationItem.findUniqueOrThrow({ where: { id: itemId } });
    if (TERMINAL.includes(current.status)) return;
    await this.wallet.settle(tx, itemId, 'release', now);
    await recordLifecycle(tx, itemId, cancelled ? 'cancelled' : 'failed', now);
    await tx.generationItem.update({
      where: { id: itemId },
      data: {
        status: cancelled ? 'cancelled' : 'failed',
        errorCode: code,
        leaseUntil: null,
        fence: { increment: 1 },
      },
    });
    await this.notifyIfTerminal(tx, item.job.userId, item.job.id);
  }
  private async notifyIfTerminal(tx: DbTransaction, userId: string, jobId: string) {
    const items = await tx.generationItem.findMany({
      where: { jobId },
      select: { status: true },
    });
    if (items.length === 0 || items.some((item) => !TERMINAL.includes(item.status))) return;
    const successes = items.filter((item) => item.status === 'succeeded').length;
    const message =
      successes === items.length
        ? { title: '任务完成', body: '图片已全部生成。' }
        : successes > 0
          ? { title: '任务完成', body: '图片部分生成成功。' }
          : items.every((item) => item.status === 'cancelled')
            ? { title: '任务已取消', body: '任务已取消。' }
            : { title: '任务失败', body: '图片生成失败。' };
    await this.notifications.createOnce(tx, `generation-terminal:${jobId}`, {
      userId,
      type: 'task',
      ...message,
      action: { href: '/tasks', jobId },
    });
  }
  async complete(attempt: ProviderAttempt, fence: number, result: CompletedResult) {
    const allowed = await this.db.transaction(async (tx) => {
      await lockWallet(tx, attempt.userId);
      await recordCost(tx, attempt, 'billable', result.usage, result.usageComplete);
      await releaseConfirmedSlot(tx, attempt);
      const item = await tx.generationItem.findUniqueOrThrow({
        where: { id: attempt.itemId },
        include: { job: true },
      });
      if (TERMINAL.includes(item.status) || item.fence !== fence) return false;
      if (item.job.deliveryDeadlineAt <= new Date()) {
        await this.fail(tx, item.id, 'DELIVERY_DEADLINE');
        return false;
      }
      await recordLifecycle(tx, item.id, 'accepted');
      await recordLifecycle(tx, item.id, 'materializing');
      await tx.providerAttempt.update({
        where: { id: attempt.id },
        data: {
          status: 'materializing',
          acceptance: 'accepted',
          ...(result.ref ? { providerRequestId: result.ref.providerRequestId } : {}),
        },
      });
      await tx.generationItem.update({
        where: { id: item.id },
        data: { status: 'materializing', leaseUntil: new Date(Date.now() + 60_000) },
      });
      return true;
    });
    if (!allowed) return;
    let validated = false;
    try {
      if (result.outputs.length !== 1 || result.outputs[0]?.kind !== 'stream')
        throw new Error('Unsupported provider output');
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of result.outputs[0].content) {
        size += chunk.byteLength;
        if (size > MAX_GENERATED_IMAGE_BYTES) throw new Error('Output too large');
        chunks.push(chunk);
      }
      const image = await validateImage(Buffer.concat(chunks), MAX_GENERATED_IMAGE_BYTES);
      const request = attempt.request as unknown as NormalizedImageRequest;
      if (
        !request.output.allowedNativeDimensions.some(
          (d) => d.width === image.width && d.height === image.height,
        )
      )
        throw new Error('Output dimensions differ from quote');
      validated = true;
      const objectKey =
        attempt.stagedKey ?? `results/${attempt.userId}/${attempt.id}/${attempt.fence}.png`;
      if (!attempt.stagedKey) {
        await this.store.put(objectKey, image.bytes, image.contentType);
        // Separate durable checkpoint; final wallet transaction can safely retry locally.
        await this.db.transaction(async (tx) => {
          await lockWallet(tx, attempt.userId);
          const item = await tx.generationItem.findUniqueOrThrow({ where: { id: attempt.itemId } });
          if (item.fence !== fence || TERMINAL.includes(item.status)) return;
          await tx.providerAttempt.update({
            where: { id: attempt.id },
            data: { stagedKey: objectKey },
          });
        });
      }
      await this.db.transaction(async (tx) => {
        await lockWallet(tx, attempt.userId);
        const item = await tx.generationItem.findUniqueOrThrow({
          where: { id: attempt.itemId },
          include: { job: true },
        });
        if (TERMINAL.includes(item.status) || item.fence !== fence) return;
        if (item.job.deliveryDeadlineAt <= new Date()) {
          await this.fail(tx, item.id, 'DELIVERY_DEADLINE');
          return;
        }
        const asset = await tx.asset.create({
          data: {
            id: randomUUID(),
            userId: attempt.userId,
            name: `${request.productModelVersionId === 'simulation-image-v1' ? '模拟图片' : '生成图片'} ${item.ordinal + 1}`,
            objectKey,
            source:
              request.productModelVersionId === 'simulation-image-v1' ? 'simulation' : 'generation',
            width: image.width,
            height: image.height,
            byteSize: image.bytes.byteLength,
            contentType: image.contentType,
            sha256: createHash('sha256').update(image.bytes).digest('hex'),
          },
        });
        const settled = await this.wallet.settle(tx, item.id, 'consume', new Date());
        if (!settled) throw new Error('Credit settlement was already terminal');
        await recordLifecycle(tx, item.id, 'delivered');
        await tx.generationItem.update({
          where: { id: item.id },
          data: { status: 'succeeded', resultAssetId: asset.id, leaseUntil: null, errorCode: null },
        });
        await tx.providerAttempt.update({
          where: { id: attempt.id },
          data: { status: 'completed', stagedKey: objectKey },
        });
        await this.notifyIfTerminal(tx, attempt.userId, item.job.id);
      });
    } catch {
      // Recover a persisted output locally, or query the same simulated attempt.
      await this.db.transaction(async (tx) => {
        await lockWallet(tx, attempt.userId);
        const current = await tx.generationItem.findUniqueOrThrow({
          where: { id: attempt.itemId },
        });
        if (current.fence !== fence || TERMINAL.includes(current.status)) return;
        const record = await tx.providerAttempt.findUniqueOrThrow({
          where: { id: attempt.id },
          include: { usage: true },
        });
        if ((!validated && !record.stagedKey) || (!record.stagedKey && !record.usage?.simulated)) {
          await this.fail(
            tx,
            attempt.itemId,
            validated ? 'OUTPUT_STORAGE_FAILED' : 'INVALID_PROVIDER_OUTPUT',
          );
          return;
        }
        await tx.generationItem.updateMany({
          where: { id: attempt.itemId, fence, status: 'materializing' },
          data: {
            leaseUntil: null,
            nextRunAt: new Date(Date.now() + 1000),
            errorCode: 'MATERIALIZATION_RETRY',
          },
        });
      });
    }
  }
  async resume(attempt: ProviderAttempt, fence: number) {
    const store = this.store;
    await this.complete(attempt, fence, {
      kind: 'completed',
      usage: [],
      usageComplete: false,
      outputs: [
        {
          kind: 'stream',
          mimeType: 'image/png',
          content: (async function* () {
            yield await store.get(attempt.stagedKey!);
          })(),
        },
      ],
    });
  }
}
