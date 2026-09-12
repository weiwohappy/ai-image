import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { DatabaseService, type DbTransaction } from '../../shared/database/database.service.js';
import { AppError } from '../../shared/http/errors.js';

function safeHref(action: Prisma.JsonValue | null): string | undefined {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return undefined;
  const href = (action as Record<string, unknown>).href;
  if (typeof href !== 'string' || !href.startsWith('/') || href.startsWith('//')) return undefined;
  if (href.includes('\\') || /[\u0000-\u001f\u007f]/.test(href)) return undefined;
  return href;
}

function dto(row: {
  id: string;
  type: string;
  title: string;
  body: string;
  action: Prisma.JsonValue | null;
  readAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    content: row.body,
    read: row.readAt !== null,
    ...(safeHref(row.action) ? { href: safeHref(row.action) } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class NotificationService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  create(
    tx: DbTransaction,
    input: {
      userId: string;
      type: string;
      title: string;
      body: string;
      action?: Prisma.InputJsonValue;
    },
  ) {
    return tx.notification.create({ data: input });
  }

  async list(userId: string) {
    const rows = await this.db.client.notification.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
    });
    return rows.map(dto);
  }

  async markRead(userId: string, id: string) {
    const row = await this.db.transaction(async (tx) => {
      const existing = await tx.notification.findFirst({ where: { id, userId } });
      if (!existing)
        throw new AppError(404, 'NOTIFICATION_NOT_FOUND', 'Notification was not found');
      return existing.readAt
        ? existing
        : tx.notification.update({ where: { id }, data: { readAt: new Date() } });
    });
    return dto(row);
  }

  async markAllRead(userId: string) {
    const result = await this.db.client.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }
}
