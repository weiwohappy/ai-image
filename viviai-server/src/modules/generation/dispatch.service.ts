import { randomUUID } from 'node:crypto';
import type { Prisma, ProviderAttempt } from '../../generated/prisma/client.js';
import { DatabaseService } from '../../shared/database/database.service.js';
import { lockWallet } from '../../shared/database/locks.js';
import type { ObjectStore } from '../assets/object-store.js';
import { normalizeInput } from '../catalog/input-schema.js';
import type { ExecutionSnapshot } from '../providers/official-config.js';
import { WalletService } from '../wallet/wallet.service.js';
import {
  markUnknown,
  recordCost,
  releaseConfirmedSlot,
  reserveChannel,
} from '../providers/accounting.js';
import type {
  InputImage,
  NormalizedImageRequest,
  ProviderFailure,
  QueryResult,
  SubmitResult,
} from '../providers/contracts.js';
import { ProviderRegistry, type Channel } from '../providers/registry.js';
import { candidates, providerContext } from '../providers/router.js';
import { SettlementService } from './settlement.service.js';
import { TERMINAL } from './job-serializer.js';
import { recordLifecycle } from '../admin/lifecycle.js';

interface Claim {
  mode: 'submit' | 'query' | 'materialize';
  attempt: ProviderAttempt;
  fence: number;
  channel?: Channel;
  cancelRequested: boolean;
}
const uncertain: ProviderFailure = {
  code: 'transport_error',
  acceptance: 'unknown',
  billing: 'unknown',
  safeMessage: 'Provider result is unknown',
};
const pollDelay = (value: number) =>
  Math.min(30_000, Math.max(500, Number.isFinite(value) ? value : 1000)) +
  Math.floor(Math.random() * 200);
const activeStates = ['submitting', 'pending', 'unknown', 'materializing'];
export class DispatchService {
  private readonly settlement: SettlementService;
  constructor(
    private readonly db: DatabaseService,
    private readonly wallet: WalletService,
    store: ObjectStore,
    private readonly registry: ProviderRegistry,
  ) {
    this.settlement = new SettlementService(db, wallet, store);
  }
  private async claim(itemId: string): Promise<Claim | null> {
    const owner = await this.db.client.generationItem.findUnique({
      where: { id: itemId },
      select: { job: { select: { userId: true } } },
    });
    if (!owner) return null;
    return this.db.transaction(async (tx) => {
      await lockWallet(tx, owner.job.userId);
      const item = await tx.generationItem.findUniqueOrThrow({
        where: { id: itemId },
        include: { job: { include: { pins: true } }, attempts: { orderBy: { ordinal: 'desc' } } },
      });
      if (TERMINAL.includes(item.status)) return null;
      const now = new Date();
      const latest = item.attempts[0];
      if (item.job.deliveryDeadlineAt <= now) {
        if (latest?.slotActive) await markUnknown(tx, latest);
        await this.settlement.fail(tx, itemId, 'DELIVERY_DEADLINE');
        return null;
      }
      if (
        item.status === 'queued' &&
        (item.job.cancelRequested || item.job.queueDeadlineAt <= now)
      ) {
        await this.settlement.fail(
          tx,
          itemId,
          item.job.cancelRequested ? 'CANCELLED' : 'QUEUE_DEADLINE',
          item.job.cancelRequested,
        );
        return null;
      }
      if (item.leaseUntil && item.leaseUntil > now) return null;
      if (item.status === 'submitting') {
        if (latest) {
          await markUnknown(tx, latest);
          await tx.providerAttempt.update({
            where: { id: latest.id },
            data: { status: 'unknown', acceptance: 'unknown' },
          });
        }
        await tx.generationItem.update({
          where: { id: itemId },
          data: {
            status: 'unknown',
            fence: { increment: 1 },
            leaseUntil: null,
            nextRunAt: new Date(now.getTime() + 1000),
          },
        });
        return null;
      }
      if (item.nextRunAt > now) return null;
      const fence = item.fence + 1;
      if (item.status !== 'queued') {
        if (!latest) {
          await this.settlement.fail(tx, itemId, 'ATTEMPT_MISSING');
          return null;
        }
        if (item.status === 'materializing' && latest.stagedKey) {
          await tx.generationItem.update({
            where: { id: itemId },
            data: { fence, leaseUntil: new Date(now.getTime() + 60_000) },
          });
          return {
            mode: 'materialize',
            attempt: latest,
            fence,
            cancelRequested: item.job.cancelRequested,
          };
        }
        const channel = this.registry.channels.find((c) => c.profile.id === latest.channelId);
        if (!channel) {
          await tx.generationItem.update({
            where: { id: itemId },
            data: { nextRunAt: new Date(now.getTime() + 30_000) },
          });
          return null;
        }
        const caps = channel.adapter.capabilities(providerContext(channel, latest.id));
        if (!latest.providerRequestId || !caps.supportsQuery || !channel.adapter.query) {
          await tx.generationItem.update({
            where: { id: itemId },
            data: { nextRunAt: new Date(now.getTime() + 1000) },
          });
          return null;
        }
        await tx.generationItem.update({
          where: { id: itemId },
          data: { fence, leaseUntil: new Date(now.getTime() + 30_000) },
        });
        return {
          mode: 'query',
          attempt: latest,
          fence,
          channel,
          cancelRequested: item.job.cancelRequested,
        };
      }
      if (item.attempts.length >= 2) {
        await this.settlement.fail(tx, itemId, 'ATTEMPTS_EXHAUSTED');
        return null;
      }
      const busy = await tx.generationItem.count({
        where: { job: { userId: item.job.userId }, status: { in: activeStates } },
      });
      const unresolved = await tx.providerAttempt.count({
        where: { userId: item.job.userId, slotActive: true, unknownSlot: true },
      });
      if (busy || unresolved) {
        await tx.generationItem.update({
          where: { id: itemId },
          data: { nextRunAt: new Date(now.getTime() + 1000) },
        });
        return null;
      }
      const input = normalizeInput(item.job.input);
      const execution = item.job.execution as unknown as ExecutionSnapshot | null;
      if (
        input.modelId !== 'simulation-image-v1' &&
        (!execution || execution.upstreamModelId !== input.modelId)
      ) {
        await this.settlement.fail(tx, itemId, 'MODEL_SNAPSHOT_MISSING');
        return null;
      }
      const attemptId = randomUUID();
      const normalized: NormalizedImageRequest = {
        jobId: item.jobId,
        itemId,
        attemptId,
        productModelVersionId: input.modelId,
        upstreamModelId: execution?.upstreamModelId ?? 'deterministic-png-v1',
        outputSpecId: execution?.id ?? 'png-1024-square-v1',
        ...(execution
          ? { channelId: execution.channelId, providerRegion: 'global', pricing: execution.pricing }
          : {}),
        prompt:
          input.source === 'remix'
            ? `Adaptation strength: ${input.strength}. Preserve image roles.\n${input.prompt}`
            : input.prompt,
        promptTemplateVersion: execution ? 'official-remix-v1' : 'simulation-prompt-v1',
        images: item.job.pins
          .map((pin) => pin.snapshot as unknown as InputImage)
          .sort((a, b) => a.order - b.order),
        output: {
          width: execution?.width ?? 1024,
          height: execution?.height ?? 1024,
          format: 'png',
          ...(execution?.provider === 'openai' ? { quality: 'medium' as const } : {}),
          allowedNativeDimensions: [
            { width: execution?.width ?? 1024, height: execution?.height ?? 1024 },
          ],
        },
        count: 1,
        executionMode: 'interactive',
        businessDeadlineAt: item.job.deliveryDeadlineAt.toISOString(),
      };
      const eligible = candidates(
        this.registry,
        normalized,
        item.attempts.map((a) => a.channelId),
      );
      if (!eligible.length) {
        await this.settlement.fail(tx, itemId, 'MODEL_UNAVAILABLE');
        return null;
      }
      const reserved = await reserveChannel(tx, eligible, now);
      if (!reserved) {
        await tx.generationItem.update({
          where: { id: itemId },
          data: { nextRunAt: new Date(now.getTime() + 1000) },
        });
        return null;
      }
      const p = reserved.channel.profile;
      const attempt = await tx.providerAttempt.create({
        data: {
          id: attemptId,
          itemId,
          userId: item.job.userId,
          ordinal: item.attempts.length,
          fence,
          channelId: p.id,
          quotaScope: p.quotaScope,
          budgetKey: reserved.budgetKey,
          estimatedCostMicros: p.estimatedCostMicros,
          request: normalized as unknown as Prisma.InputJsonValue,
          usage: { create: { lines: [], simulated: p.simulated } },
        },
      });
      await tx.generationItem.update({
        where: { id: itemId },
        data: {
          status: 'submitting',
          fence,
          leaseUntil: new Date(now.getTime() + (p.responseTimeoutMs ?? 0) + 30_000),
        },
      });
      await recordLifecycle(tx, itemId, 'dispatched', now);
      return { mode: 'submit', attempt, fence, channel: reserved.channel, cancelRequested: false };
    });
  }
  async process(itemId: string): Promise<void> {
    const claim = await this.claim(itemId);
    if (!claim) return;
    const { channel, attempt } = claim;
    if (claim.mode === 'materialize') {
      await this.settlement.resume(attempt, claim.fence);
      return;
    }
    if (!channel) return;
    const context = providerContext(channel, attempt.id);
    let result: SubmitResult | QueryResult;
    try {
      if (claim.mode === 'submit')
        result = await channel.adapter.submit(
          attempt.request as unknown as NormalizedImageRequest,
          context,
        );
      else {
        const ref = {
          providerRequestId: attempt.providerRequestId!,
          channelId: attempt.channelId,
          credentialVersionRef: channel.profile.credentialVersion,
        };
        if (
          claim.cancelRequested &&
          channel.adapter.capabilities(context).supportsCancel &&
          channel.adapter.cancel
        ) {
          const cancelled = await channel.adapter.cancel(ref, context);
          if (cancelled.kind === 'confirmed') {
            await this.finish(claim, {
              kind: 'cancelled',
              billing: cancelled.billing,
              ...(cancelled.usage ? { usage: cancelled.usage } : {}),
            });
            return;
          }
        }
        result = await channel.adapter.query!(ref, context);
      }
    } catch {
      result = { kind: 'unknown', failure: uncertain };
    }
    // IDs may be supplied by an adapter, but must match the selected account.
    if (
      'ref' in result &&
      result.ref &&
      (result.ref.channelId !== channel.profile.id ||
        result.ref.credentialVersionRef !== channel.profile.credentialVersion ||
        !result.ref.providerRequestId ||
        result.ref.providerRequestId.length > 512 ||
        (claim.mode === 'query' && result.ref.providerRequestId !== attempt.providerRequestId))
    )
      result = { kind: 'unknown', failure: uncertain };
    if (result.kind === 'completed') {
      await this.settlement.complete(attempt, claim.fence, result);
      return;
    }
    await this.finish(claim, result);
  }
  private async finish(
    claim: Claim,
    result: Exclude<SubmitResult | QueryResult, { kind: 'completed' }>,
  ) {
    const { attempt, fence } = claim;
    await this.db.transaction(async (tx) => {
      await lockWallet(tx, attempt.userId);
      const item = await tx.generationItem.findUniqueOrThrow({ where: { id: attempt.itemId } });
      if ('ref' in result && result.ref)
        await tx.providerAttempt.update({
          where: { id: attempt.id },
          data: { providerRequestId: result.ref.providerRequestId },
        });
      const failure =
        result.kind === 'rejected' || result.kind === 'failed' || result.kind === 'unknown'
          ? result.failure
          : result.kind === 'not_found'
            ? {
                ...uncertain,
                ...(result.authoritative && result.disposition === 'never_accepted'
                  ? { acceptance: 'not_accepted' as const, billing: 'not_billable' as const }
                  : {}),
              }
            : null;
      if (failure)
        await recordCost(
          tx,
          attempt,
          failure.billing,
          failure.usage ?? [],
          'usageComplete' in failure && failure.usageComplete === true,
        );
      if (failure?.acceptance === 'accepted' && result.kind === 'rejected')
        await releaseConfirmedSlot(tx, attempt);
      if (result.kind === 'cancelled') {
        await recordCost(tx, attempt, result.billing, result.usage ?? []);
        await releaseConfirmedSlot(tx, attempt);
      }
      if (TERMINAL.includes(item.status) || item.fence !== fence) return;
      if (result.kind === 'accepted' || result.kind === 'pending') {
        await recordLifecycle(tx, item.id, 'accepted');
        await tx.providerAttempt.update({
          where: { id: attempt.id },
          data: { status: 'pending', acceptance: 'accepted' },
        });
        await tx.generationItem.update({
          where: { id: item.id },
          data: {
            status: 'pending',
            leaseUntil: null,
            nextRunAt: new Date(Date.now() + pollDelay(result.pollAfterMs)),
          },
        });
        return;
      }
      if (result.kind === 'cancelled') {
        await this.settlement.fail(tx, item.id, 'CANCELLED', true);
        await tx.providerAttempt.update({
          where: { id: attempt.id },
          data: { status: 'cancelled' },
        });
        return;
      }
      if (!failure) throw new Error('Unrecognized provider outcome');
      const unknown = result.kind === 'unknown' || failure.acceptance === 'unknown';
      await tx.providerAttempt.update({
        where: { id: attempt.id },
        data: { status: unknown ? 'unknown' : 'failed', acceptance: failure.acceptance },
      });
      if (unknown) {
        await markUnknown(tx, attempt);
        await tx.generationItem.update({
          where: { id: item.id },
          data: {
            status: 'unknown',
            leaseUntil: null,
            nextRunAt: new Date(Date.now() + pollDelay(1000)),
            errorCode: 'PROVIDER_UNKNOWN',
          },
        });
        return;
      }
      const retryable =
        failure.acceptance === 'not_accepted' &&
        failure.billing === 'not_billable' &&
        ['server_error', 'transport_error', 'timeout', 'rate_limit', 'quota'].includes(
          failure.code,
        ) &&
        attempt.ordinal < 1;
      if (retryable)
        await tx.generationItem.update({
          where: { id: item.id },
          data: {
            status: 'queued',
            leaseUntil: null,
            nextRunAt: new Date(Date.now() + pollDelay(failure.retryAfterMs ?? 500)),
            errorCode: null,
          },
        });
      else await this.settlement.fail(tx, item.id, `PROVIDER_${failure.code.toUpperCase()}`);
    });
  }
}
