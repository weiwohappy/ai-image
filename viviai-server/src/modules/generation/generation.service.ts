import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../../shared/database/database.service.js';
import { lockWallet } from '../../shared/database/locks.js';
import { AppError } from '../../shared/http/errors.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { digest, normalizeInput } from '../catalog/input-schema.js';
import { WalletService } from '../wallet/wallet.service.js';
import { jobDto, jobInclude, TERMINAL } from './job-serializer.js';

const missing = () => new AppError(404, 'NOT_FOUND', 'Task not found');
const submission = z.object({ quoteId: z.uuid(), input: z.unknown() }).strict();
@Injectable()
export class GenerationService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(WalletService) private readonly wallet: WalletService,
  ) {}
  async create(
    userId: string,
    raw: unknown,
    key: string,
    operation: 'create' | 'remix',
    retryOfJobId?: string,
  ) {
    const parsed = submission.safeParse(raw);
    if (!parsed.success || !/^[A-Za-z0-9._:-]{8,128}$/.test(key))
      throw new AppError(
        400,
        'INVALID_INPUT',
        'A quote, input and valid Idempotency-Key are required',
      );
    const { quoteId } = parsed.data;
    const input = normalizeInput(parsed.data.input);
    if (input.source !== operation)
      throw new AppError(400, 'INVALID_INPUT', 'Task mode and input differ');
    const requestHash = digest({ quoteId, input, retryOfJobId: retryOfJobId ?? null });
    const job = await this.db.transaction(async (tx) => {
      await lockWallet(tx, userId);
      const replay = await tx.generationJob.findUnique({
        where: { userId_operation_idempotencyKey: { userId, operation, idempotencyKey: key } },
        include: jobInclude,
      });
      if (replay) {
        if (replay.requestHash !== requestHash)
          throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Key was used for a different request');
        return replay;
      }
      const execution = this.catalog.execution(input);
      const quote = await tx.generationQuote.findFirst({ where: { id: quoteId, userId } });
      if (!quote) throw new AppError(404, 'NOT_FOUND', 'Quote not found');
      if (digest(quote.execution ?? null) !== digest(execution ?? null))
        throw new AppError(
          409,
          'MODEL_CONFIG_CHANGED',
          'Model configuration changed; request a new quote',
        );
      if (quote.consumedAt) throw new AppError(409, 'QUOTE_USED', 'Quote has already been used');
      if (quote.expiresAt.getTime() <= Date.now())
        throw new AppError(409, 'QUOTE_EXPIRED', 'Please request a new quote');
      const images = await this.catalog.references(tx, userId, input);
      if (quote.inputHash !== digest({ input, images }))
        throw new AppError(409, 'QUOTE_MISMATCH', 'Input differs from quoted parameters');
      if (retryOfJobId) {
        const previous = await tx.generationJob.findFirst({
          where: { id: retryOfJobId, userId },
          include: jobInclude,
        });
        if (!previous) throw missing();
        const failed = previous.items.filter((item) => item.status === 'failed');
        if (
          !previous.items.every((item) => TERMINAL.includes(item.status)) ||
          failed.length !== input.count
        )
          throw new AppError(
            409,
            'RETRY_NOT_ALLOWED',
            'Retry count must equal terminal failed items',
          );
        const previousInput = normalizeInput(previous.input);
        if (digest({ ...previousInput, count: input.count }) !== digest(input))
          throw new AppError(
            409,
            'RETRY_INPUT_MISMATCH',
            'Retry must preserve original parameters',
          );
      }
      const now = new Date();
      const created = await tx.generationJob.create({
        data: {
          userId,
          quoteId,
          operation,
          idempotencyKey: key,
          requestHash,
          input,
          ...(quote.execution ? { execution: quote.execution } : {}),
          ...(retryOfJobId ? { retryOfJobId } : {}),
          queueDeadlineAt: new Date(now.getTime() + 300_000),
          deliveryDeadlineAt: new Date(now.getTime() + 900_000),
          items: {
            create: Array.from({ length: input.count }, (_, ordinal) => ({
              ordinal,
              unitCredits: quote.unitCredits,
            })),
          },
          pins: {
            create: images.map((image) => ({
              assetId: image.assetId,
              role: image.role,
              snapshot: image,
            })),
          },
        },
        include: jobInclude,
      });
      for (const item of created.items) {
        await this.wallet.freeze(tx, userId, created.id, item.id, item.unitCredits);
        await tx.outboxEvent.create({ data: { eventKey: `ready:${item.id}`, itemId: item.id } });
      }
      await tx.generationQuote.update({ where: { id: quoteId }, data: { consumedAt: now } });
      return created;
    });
    return jobDto(job);
  }
  async get(userId: string, id: string) {
    if (!z.uuid().safeParse(id).success) throw missing();
    const job = await this.db.client.generationJob.findFirst({
      where: { id, userId },
      include: jobInclude,
    });
    if (!job) throw missing();
    return jobDto(job);
  }
  async list(userId: string) {
    return (
      await this.db.client.generationJob.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
        include: jobInclude,
      })
    ).map(jobDto);
  }
  async cancel(userId: string, id: string) {
    if (!z.uuid().safeParse(id).success) throw missing();
    return this.db.transaction(async (tx) => {
      await lockWallet(tx, userId);
      const job = await tx.generationJob.findFirst({ where: { id, userId }, include: jobInclude });
      if (!job) throw missing();
      if (job.items.every((item) => TERMINAL.includes(item.status))) return jobDto(job);
      await tx.generationJob.update({ where: { id }, data: { cancelRequested: true } });
      for (const item of job.items.filter((item) => item.status === 'queued')) {
        await this.wallet.settle(tx, item.id, 'release', new Date());
        await tx.generationItem.update({ where: { id: item.id }, data: { status: 'cancelled' } });
      }
      return jobDto(
        await tx.generationJob.findUniqueOrThrow({ where: { id }, include: jobInclude }),
      );
    });
  }
  async retry(userId: string, id: string, raw: unknown, key: string) {
    const previous = await this.get(userId, id);
    return this.create(userId, raw, key, normalizeInput(previous.input).source, id);
  }
}
