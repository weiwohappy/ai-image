import type { GenerationJob, GenerationItem } from '../../generated/prisma/client.js';
import { safeInteger } from '../../shared/database/locks.js';
export const TERMINAL = ['succeeded', 'failed', 'cancelled'];
export const jobInclude = { items: { orderBy: { ordinal: 'asc' as const } } };
export type JobRecord = GenerationJob & { items: GenerationItem[] };
export function jobDto(job: JobRecord) {
  const done = job.items.filter((item) => TERMINAL.includes(item.status));
  const successes = job.items.filter((item) => item.status === 'succeeded');
  const allDone = done.length === job.items.length;
  const status = allDone
    ? successes.length === job.items.length
      ? 'succeeded'
      : successes.length
        ? 'partial'
        : job.items.every((item) => item.status === 'cancelled')
          ? 'cancelled'
          : 'failed'
    : job.items.every((item) => item.status === 'queued')
      ? 'queued'
      : 'processing';
  return {
    id: job.id,
    input: job.input,
    status,
    stage: allDone ? 'settled' : job.items.find((item) => !TERMINAL.includes(item.status))?.status,
    progress: Math.floor((done.length / job.items.length) * 100),
    cancelRequested: job.cancelRequested,
    estimatedCredits: safeInteger(job.items.reduce((sum, item) => sum + item.unitCredits, 0n)),
    chargedCredits: safeInteger(successes.reduce((sum, item) => sum + item.unitCredits, 0n)),
    createdAt: job.createdAt.toISOString(),
    updatedAt: new Date(
      Math.max(job.updatedAt.getTime(), ...job.items.map((item) => item.updatedAt.getTime())),
    ).toISOString(),
    resultAssetIds: successes.flatMap((item) => (item.resultAssetId ? [item.resultAssetId] : [])),
    items: job.items.map((item) => ({
      id: item.id,
      ordinal: item.ordinal,
      status: item.status,
      resultAssetId: item.resultAssetId,
      errorCode: item.errorCode,
    })),
  };
}
