import type { ProviderAttempt, Prisma } from '../../generated/prisma/client.js';
import type { DbTransaction } from '../../shared/database/database.service.js';
import type { BillingCertainty, NormalizedImageRequest, UsageLine } from './contracts.js';
import { actualCost } from './pricing.js';
import type { Channel } from './registry.js';
export const budgetKey = (scope: string, now: Date) => `${scope}:${now.toISOString().slice(0, 10)}`;
export async function lockScopes(tx: DbTransaction, keys: string[]) {
  for (const key of [...new Set(keys)].sort())
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`provider:${key}`}, 0))`;
}
export async function reserveChannel(tx: DbTransaction, channels: Channel[], now: Date) {
  await lockScopes(
    tx,
    channels.flatMap(({ profile: p }) => [
      `quota:${p.quotaScope}`,
      `budget:${budgetKey(p.budgetScope, now)}`,
    ]),
  );
  for (const channel of channels) {
    const p = channel.profile;
    const key = budgetKey(p.budgetScope, now);
    const quota = await tx.providerQuota.upsert({
      where: { id: p.quotaScope },
      create: { id: p.quotaScope },
      update: {},
    });
    const budget = await tx.providerBudget.upsert({
      where: { id: key },
      create: { id: key },
      update: {},
    });
    if (
      quota.inflight >= p.concurrency ||
      quota.unknown >= p.maxUnknown ||
      budget.reservedMicros + budget.consumedMicros + p.estimatedCostMicros > p.dailyBudgetMicros
    )
      continue;
    await tx.providerQuota.update({
      where: { id: p.quotaScope },
      data: { inflight: { increment: 1 } },
    });
    await tx.providerBudget.update({
      where: { id: key },
      data: { reservedMicros: { increment: p.estimatedCostMicros } },
    });
    return { channel, budgetKey: key };
  }
  return null;
}
export async function markUnknown(tx: DbTransaction, attempt: ProviderAttempt) {
  await lockScopes(tx, [`quota:${attempt.quotaScope}`, `budget:${attempt.budgetKey}`]);
  const current = await tx.providerAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
  if (current.slotActive && !current.unknownSlot) {
    await tx.providerQuota.update({
      where: { id: current.quotaScope },
      data: { unknown: { increment: 1 } },
    });
    await tx.providerAttempt.update({ where: { id: current.id }, data: { unknownSlot: true } });
  }
}
export async function releaseConfirmedSlot(tx: DbTransaction, attempt: ProviderAttempt) {
  await lockScopes(tx, [`quota:${attempt.quotaScope}`, `budget:${attempt.budgetKey}`]);
  const current = await tx.providerAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
  if (!current.slotActive) return;
  await tx.providerQuota.update({
    where: { id: current.quotaScope },
    data: { inflight: { decrement: 1 }, unknown: { decrement: current.unknownSlot ? 1 : 0 } },
  });
  await tx.providerAttempt.update({
    where: { id: current.id },
    data: { slotActive: false, unknownSlot: false },
  });
  // No budget change: confirmed remote termination need not mean confirmed fee.
}
export async function recordCost(
  tx: DbTransaction,
  attempt: ProviderAttempt,
  billing: BillingCertainty,
  lines: UsageLine[] = [],
  usageComplete = false,
) {
  await lockScopes(tx, [`quota:${attempt.quotaScope}`, `budget:${attempt.budgetKey}`]);
  const current = await tx.providerAttempt.findUniqueOrThrow({
    where: { id: attempt.id },
    include: { usage: true },
  });
  // A later incomplete observation must never erase known accounting evidence.
  if (current.usage?.certainty !== 'unknown' && billing === 'unknown') return;
  if (current.usage?.certainty !== 'unknown') return;
  const normalized = current.request as unknown as NormalizedImageRequest;
  const cost =
    billing === 'not_billable'
      ? 0n
      : billing === 'billable'
        ? current.usage?.simulated
          ? current.estimatedCostMicros
          : actualCost(normalized.pricing, lines, usageComplete)
        : null;
  if (cost === null) {
    // Evidence of completion is not evidence of a zero bill. Retain budget reserve.
    if (lines.length)
      await tx.providerUsageRecord.update({
        where: { attemptId: current.id },
        data: { lines: lines as unknown as Prisma.InputJsonValue },
      });
    if (billing !== 'unknown')
      await tx.providerAttempt.update({ where: { id: current.id }, data: { billing } });
    return;
  }
  await tx.providerBudget.update({
    where: { id: current.budgetKey },
    data: {
      reservedMicros: { decrement: current.estimatedCostMicros },
      consumedMicros: { increment: cost },
    },
  });
  if (current.slotActive)
    await tx.providerQuota.update({
      where: { id: current.quotaScope },
      data: { inflight: { decrement: 1 }, unknown: { decrement: current.unknownSlot ? 1 : 0 } },
    });
  await tx.providerAttempt.update({
    where: { id: current.id },
    data: { billing, slotActive: false, unknownSlot: false },
  });
  await tx.providerUsageRecord.update({
    where: { attemptId: current.id },
    data: {
      certainty: billing,
      actualCostMicros: cost,
      lines: lines as unknown as Prisma.InputJsonValue,
    },
  });
}
