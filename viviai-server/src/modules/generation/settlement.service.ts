import { createHash, randomUUID } from 'node:crypto';
import type { ProviderAttempt } from '../../generated/prisma/client.js';
import { DatabaseService, type DbTransaction } from '../../shared/database/database.service.js';
import { lockWallet } from '../../shared/database/locks.js';
import type { ObjectStore } from '../assets/object-store.js';
import { validateImage, MAX_IMAGE_BYTES } from '../assets/image-validation.js';
import { WalletService } from '../wallet/wallet.service.js';
import { recordCost } from '../providers/accounting.js';
import type { CompletedResult } from '../providers/contracts.js';
import { TERMINAL } from './job-serializer.js';

export class SettlementService {
  constructor(
    private readonly db: DatabaseService,
    private readonly wallet: WalletService,
    private readonly store: ObjectStore,
  ) {}
  async fail(tx: DbTransaction, itemId: string, code: string, cancelled = false, now = new Date()) {
    const item = await tx.generationItem.findUniqueOrThrow({
      where: { id: itemId },
      include: { job: true },
    });
    await lockWallet(tx, item.job.userId);
    const current = await tx.generationItem.findUniqueOrThrow({ where: { id: itemId } });
    if (TERMINAL.includes(current.status)) return;
    await this.wallet.settle(tx, itemId, 'release', now);
    await tx.generationItem.update({
      where: { id: itemId },
      data: {
        status: cancelled ? 'cancelled' : 'failed',
        errorCode: code,
        leaseUntil: null,
        fence: { increment: 1 },
      },
    });
  }
  async complete(attempt: ProviderAttempt, fence: number, result: CompletedResult) {
    const allowed = await this.db.transaction(async (tx) => {
      await lockWallet(tx, attempt.userId);
      await recordCost(tx, attempt, 'billable', result.usage);
      const item = await tx.generationItem.findUniqueOrThrow({
        where: { id: attempt.itemId },
        include: { job: true },
      });
      if (TERMINAL.includes(item.status) || item.fence !== fence) return false;
      if (item.job.deliveryDeadlineAt <= new Date()) {
        await this.fail(tx, item.id, 'DELIVERY_DEADLINE');
        return false;
      }
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
        data: { status: 'materializing', leaseUntil: new Date(Date.now() + 30_000) },
      });
      return true;
    });
    if (!allowed) return;
    try {
      if (result.outputs.length !== 1 || result.outputs[0]?.kind !== 'stream')
        throw new Error('Unsupported simulation output');
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of result.outputs[0].content) {
        size += chunk.byteLength;
        if (size > MAX_IMAGE_BYTES) throw new Error('Output too large');
        chunks.push(chunk);
      }
      const image = await validateImage(Buffer.concat(chunks));
      if (image.width !== 1024 || image.height !== 1024)
        throw new Error('Output dimensions differ from quote');
      const objectKey = `results/${attempt.userId}/${attempt.id}/${fence}.png`;
      await this.store.put(objectKey, image.bytes, image.contentType);
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
            name: `模拟图片 ${item.ordinal + 1}`,
            objectKey,
            source: 'simulation',
            width: image.width,
            height: image.height,
            byteSize: image.bytes.byteLength,
            contentType: image.contentType,
            sha256: createHash('sha256').update(image.bytes).digest('hex'),
          },
        });
        const settled = await this.wallet.settle(tx, item.id, 'consume', new Date());
        if (!settled) throw new Error('Credit settlement was already terminal');
        await tx.generationItem.update({
          where: { id: item.id },
          data: { status: 'succeeded', resultAssetId: asset.id, leaseUntil: null },
        });
        await tx.providerAttempt.update({
          where: { id: attempt.id },
          data: { status: 'completed', stagedKey: objectKey },
        });
      });
    } catch {
      // Recover through the same queryable Attempt. Never generate a replacement.
      await this.db.transaction(async (tx) => {
        await lockWallet(tx, attempt.userId);
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
}
