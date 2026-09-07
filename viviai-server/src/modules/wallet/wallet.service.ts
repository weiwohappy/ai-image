import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService, type DbTransaction } from '../../shared/database/database.service.js';
import { lockWallet, safeInteger } from '../../shared/database/locks.js';
import { AppError } from '../../shared/http/errors.js';

function requireAmount(amount: bigint) {
  if (typeof amount !== 'bigint' || amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new AppError(400, 'INVALID_AMOUNT', 'Credit amount is invalid');
}
@Injectable()
export class WalletService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}
  async grant(tx: DbTransaction, userId: string, sourceId: string, amount: bigint, expiresAt: Date | null): Promise<void> {
    requireAmount(amount);
    if (!sourceId || sourceId.length > 200 || (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()))) throw new AppError(400, 'INVALID_GRANT', 'Grant source or expiry is invalid');
    await lockWallet(tx, userId);
    const previous = await tx.creditLot.findUnique({ where: { userId_sourceId: { userId, sourceId } } });
    if (previous) {
      if (previous.issued !== amount || previous.expiresAt?.getTime() !== expiresAt?.getTime()) throw new AppError(409, 'GRANT_CONFLICT', 'Grant source already used');
      return;
    }
    const total = await tx.creditLot.aggregate({ where: { userId }, _sum: { issued: true } });
    safeInteger((total._sum.issued ?? 0n) + amount);
    const lot = await tx.creditLot.create({ data: { userId, sourceId, issued: amount, available: amount, expiresAt, revenueMinor: 0n } });
    await tx.creditEvent.create({ data: { eventKey: `grant:${lot.id}`, userId, lotId: lot.id, type: 'promotional_grant', availableDelta: amount } });
  }
  private async expire(tx: DbTransaction, userId: string, now: Date): Promise<void> {
    const lots = await tx.creditLot.findMany({ where: { userId, expiresAt: { lte: now }, available: { gt: 0n } }, orderBy: { id: 'asc' } });
    for (const lot of lots) {
      await tx.creditLot.update({ where: { id: lot.id }, data: { available: 0n, expired: { increment: lot.available } } });
      await tx.creditEvent.create({ data: { eventKey: `expire:${lot.id}`, userId, lotId: lot.id, type: 'expire', availableDelta: -lot.available, expiredDelta: lot.available } });
    }
  }
  async balance(userId: string, now = new Date()) {
    return this.db.transaction(async tx => {
      await lockWallet(tx, userId); await this.expire(tx, userId, now);
      const result = await tx.creditLot.aggregate({ where: { userId }, _sum: { issued: true, available: true, held: true, consumed: true, expired: true, revoked: true } });
      return { issued: result._sum.issued ?? 0n, available: result._sum.available ?? 0n, held: result._sum.held ?? 0n, consumed: result._sum.consumed ?? 0n, expired: result._sum.expired ?? 0n, revoked: result._sum.revoked ?? 0n };
    });
  }
  async freeze(tx: DbTransaction, userId: string, jobId: string, itemId: string, amount: bigint): Promise<void> {
    requireAmount(amount); await lockWallet(tx, userId);
    const item = await tx.generationItem.findFirst({ where: { id: itemId, jobId, job: { userId } } });
    if (!item || item.unitCredits !== amount) throw new AppError(409, 'RESERVATION_CONFLICT', 'Credit reservation does not match item');
    const existing = await tx.creditReservation.findUnique({ where: { itemId } });
    if (existing) { if (existing.amount !== amount) throw new AppError(409, 'RESERVATION_CONFLICT', 'Credit reservation already exists'); return; }
    if (item.status !== 'queued') throw new AppError(409, 'ITEM_NOT_QUEUED', 'Only new items may reserve credits');
    const now = new Date(); await this.expire(tx, userId, now);
    const lots = await tx.creditLot.findMany({ where: { userId, available: { gt: 0n }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, orderBy: [{ expiresAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }] });
    if (lots.reduce((sum, lot) => sum + lot.available, 0n) < amount) throw new AppError(402, 'INSUFFICIENT_CREDITS', 'Not enough available credits');
    const reservation = await tx.creditReservation.create({ data: { userId, jobId, itemId, amount } });
    let remaining = amount;
    for (const lot of lots) {
      if (remaining === 0n) break;
      const allocation = remaining < lot.available ? remaining : lot.available;
      await tx.creditLot.update({ where: { id: lot.id }, data: { available: { decrement: allocation }, held: { increment: allocation } } });
      await tx.creditAllocation.create({ data: { reservationId: reservation.id, lotId: lot.id, amount: allocation } });
      await tx.creditEvent.create({ data: { eventKey: `freeze:${reservation.id}:${lot.id}`, userId, lotId: lot.id, itemId, type: 'freeze', availableDelta: -allocation, heldDelta: allocation } });
      remaining -= allocation;
    }
  }
  async settle(tx: DbTransaction, itemId: string, outcome: 'consume' | 'release', now: Date): Promise<boolean> {
    // Lookup only obtains immutable ownership; no row/state is locked before wallet.
    const owner = await tx.creditReservation.findUnique({ where: { itemId }, select: { userId: true } });
    if (!owner) throw new Error('Item has no reservation');
    await lockWallet(tx, owner.userId);
    const reservation = await tx.creditReservation.findUniqueOrThrow({ where: { itemId }, include: { allocations: { include: { lot: true }, orderBy: { lotId: 'asc' } } } });
    if (reservation.status !== 'held') return false;
    for (const allocation of reservation.allocations) {
      const expired = allocation.lot.expiresAt !== null && allocation.lot.expiresAt <= now;
      const available = outcome === 'release' && !expired ? allocation.amount : 0n;
      const consumed = outcome === 'consume' ? allocation.amount : 0n;
      const expire = outcome === 'release' && expired ? allocation.amount : 0n;
      await tx.creditLot.update({ where: { id: allocation.lotId }, data: { held: { decrement: allocation.amount }, available: { increment: available }, consumed: { increment: consumed }, expired: { increment: expire } } });
      await tx.creditEvent.create({ data: { eventKey: `${outcome}:${reservation.id}:${allocation.lotId}`, userId: owner.userId, lotId: allocation.lotId, itemId, type: outcome, heldDelta: -allocation.amount, availableDelta: available, consumedDelta: consumed, expiredDelta: expire } });
    }
    await tx.creditReservation.update({ where: { id: reservation.id }, data: { status: outcome === 'consume' ? 'consumed' : 'released', settledAt: now } });
    return true;
  }
  async ledger(userId: string) {
    const records = await this.db.client.creditEvent.findMany({ where: { userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200 });
    return records.map(row => ({ id: row.id, type: row.type, itemId: row.itemId, amount: safeInteger(row.availableDelta), heldDelta: safeInteger(row.heldDelta), consumedDelta: safeInteger(row.consumedDelta), expiredDelta: safeInteger(row.expiredDelta), createdAt: row.createdAt.toISOString() }));
  }
}
