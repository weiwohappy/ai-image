import { PrismaPg } from '@prisma/adapter-pg';
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '../../generated/prisma/client.js';

export type DbTransaction = Prisma.TransactionClient;

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(databaseUrl: string) {
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
}
