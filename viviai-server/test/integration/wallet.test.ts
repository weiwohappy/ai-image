import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { WalletService } from '../../src/modules/wallet/wallet.service.js';

describe('conserved credit lots', () => {
  let db: TestDatabase; let wallet: WalletService;
  beforeAll(async () => { db = await createTestDatabase(); wallet = new WalletService(db.database); });
  afterAll(async () => { await db?.cleanup(); });
  async function fixture() {
    const id = randomUUID();
    await db.database.client.user.create({ data: { id, email: `${id}@example.test`, username: id, passwordHash: 'unused' } });
    const quote = await db.database.client.generationQuote.create({ data: { userId: id, input: {}, inputHash: 'test', productVersion: 'simulation-image-v1', unitCredits: 30n, totalCredits: 120n, expiresAt: new Date(Date.now() + 300_000) } });
    const job = await db.database.client.generationJob.create({ data: { userId: id, quoteId: quote.id, operation: 'create', idempotencyKey: randomUUID(), requestHash: 'test', input: {}, queueDeadlineAt: new Date(Date.now() + 300_000), deliveryDeadlineAt: new Date(Date.now() + 900_000), items: { create: [0,1,2,3].map(ordinal => ({ ordinal, unitCredits: 30n })) } }, include: { items: { orderBy: { ordinal: 'asc' } } } });
    return { id, job };
  }
  it('four distinct holds settle two successes and two failures exactly once', async () => {
    const { id, job } = await fixture();
    await db.database.transaction(tx => wallet.grant(tx, id, 'promo', 1000n, null));
    await db.database.transaction(async tx => { for (const item of job.items) await wallet.freeze(tx, id, job.id, item.id, 30n); });
    expect(await wallet.balance(id)).toMatchObject({ available: 880n, held: 120n });
    await Promise.all(job.items.flatMap((item, index) => [0,1].map(() => db.database.transaction(tx => wallet.settle(tx, item.id, index < 2 ? 'consume' : 'release', new Date())))));
    expect(await wallet.balance(id)).toMatchObject({ issued: 1000n, available: 940n, held: 0n, consumed: 60n });
    expect(await db.database.client.creditReservation.count({ where: { userId: id } })).toBe(4);
  });
  it('release from an expired lot moves held credits to expired, not available', async () => {
    const { id, job } = await fixture(); const expiresAt = new Date(Date.now() + 10_000);
    await db.database.transaction(tx => wallet.grant(tx, id, 'expiring', 60n, expiresAt));
    await db.database.transaction(tx => wallet.freeze(tx, id, job.id, job.items[0]!.id, 30n));
    const future = new Date(expiresAt.getTime() + 1);
    await db.database.transaction(tx => wallet.settle(tx, job.items[0]!.id, 'release', future));
    expect(await wallet.balance(id, future)).toMatchObject({ available: 0n, held: 0n, expired: 60n });
  });
  it('supports allocations across lots without event-key collisions', async () => {
    const { id, job } = await fixture();
    await db.database.transaction(async tx => { await wallet.grant(tx, id, 'a', 20n, null); await wallet.grant(tx, id, 'b', 10n, null); await wallet.freeze(tx, id, job.id, job.items[0]!.id, 30n); });
    await db.database.transaction(tx => wallet.settle(tx, job.items[0]!.id, 'consume', new Date()));
    expect(await db.database.client.creditEvent.count({ where: { userId: id, type: 'consume' } })).toBe(2);
    expect(await wallet.balance(id)).toMatchObject({ available: 0n, consumed: 30n });
  });
  it('same grant source is idempotent and invalid grants cannot create money', async () => {
    const { id } = await fixture();
    await Promise.all(Array.from({ length: 10 }, () => db.database.transaction(tx => wallet.grant(tx, id, 'once', 100n, null))));
    expect(await wallet.balance(id)).toMatchObject({ issued: 100n, available: 100n });
    for (const amount of [0n, -1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n]) await expect(db.database.transaction(tx => wallet.grant(tx, id, randomUUID(), amount, null))).rejects.toThrow();
    const lot = await db.database.client.creditLot.findFirstOrThrow({ where: { userId: id } });
    await expect(db.database.client.creditLot.update({ where: { id: lot.id }, data: { available: 200n } })).rejects.toThrow();
    expect(await wallet.balance(id)).toMatchObject({ available: 100n });
  });
});
