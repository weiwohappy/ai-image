import { PrismaPg } from '@prisma/adapter-pg';
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import pg from 'pg';
import { Prisma, PrismaClient } from '../../generated/prisma/client.js';

export type DbTransaction = Prisma.TransactionClient;

export class SessionAdvisoryLockTimeoutError extends Error {
  constructor() {
    super('Database session lock timed out');
    this.name = 'SessionAdvisoryLockTimeoutError';
  }
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  readonly client: PrismaClient;
  readonly #databaseUrl: string;

  constructor(databaseUrl: string) {
    this.#databaseUrl = databaseUrl;
    const schema = new URL(databaseUrl).searchParams.get('schema') ?? undefined;
    this.client = new PrismaClient({
      adapter: new PrismaPg(
        { connectionString: databaseUrl },
        schema === undefined ? undefined : { schema },
      ),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.client.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }

  async transaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return this.client.$transaction(fn, { maxWait: 15_000, timeout: 15_000 });
  }

  async withSessionAdvisoryLock<T>(
    key: string,
    timeoutMs: number,
    fn: () => Promise<T>,
    beforeLockAttempt?: () => void | Promise<void>,
    afterLockAcquired?: () => void | Promise<void>,
  ): Promise<T> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
      throw new Error('Database session lock timeout must be an integer between 1 and 60000ms');
    const url = new URL(this.#databaseUrl);
    url.searchParams.delete('schema');
    const session = new pg.Client({ connectionString: url.toString() });
    let locked = false;
    try {
      try {
        await session.connect();
      } catch {
        throw new Error('Database session lock unavailable');
      }
      await session.query("SELECT set_config('lock_timeout', $1, false)", [`${timeoutMs}ms`]);
      await beforeLockAttempt?.();
      try {
        await session.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
      } catch (error) {
        if (isLockTimeout(error)) throw new SessionAdvisoryLockTimeoutError();
        throw new Error('Database session lock failed');
      }
      locked = true;
      await afterLockAcquired?.();
      return await fn();
    } finally {
      if (locked)
        await session
          .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key])
          .catch(() => undefined);
      await session.end().catch(() => undefined);
    }
  }
}

function isLockTimeout(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '55P03';
}
