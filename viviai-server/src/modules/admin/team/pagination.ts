import { z } from 'zod';
import { parse } from '../auth.controller.js';
import { emailSchema, failure } from './policy.js';
export function teamQuery(raw: unknown, kind: 'member' | 'invitation' | 'role') {
  const q = parse(
    z
      .object({
        cursor: z.string().max(1024).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
        ...(kind !== 'role'
          ? {
              q: emailSchema.optional(),
              status: z
                .enum(
                  kind === 'member'
                    ? ['pending', 'active', 'disabled']
                    : ['pending', 'expired', 'revoked', 'consumed'],
                )
                .optional(),
            }
          : { q: z.string().trim().max(80).optional() }),
        ...(kind === 'member' ? { role: z.string().min(1).max(64).optional() } : {}),
      })
      .strict(),
    raw,
  ) as {
    cursor?: string;
    limit: number;
    email?: string;
    status?: string;
    role?: string;
    q?: string;
  };
  let cursor: { id: string; createdAt: string } | undefined;
  if (q.cursor) {
    try {
      cursor = z
        .object({ id: z.string().min(1).max(64), createdAt: z.iso.datetime() })
        .strict()
        .parse(JSON.parse(Buffer.from(q.cursor, 'base64url').toString()));
      if (kind !== 'role') z.uuid().parse(cursor.id);
    } catch {
      throw failure(400, 'ADMIN_INVALID_INPUT', '分页游标无效');
    }
  }
  const field = kind === 'role' ? 'key' : 'id';
  return {
    ...q,
    email: kind !== 'role' ? q.q : undefined,
    page: {
      take: q.limit + 1,
      orderBy: [{ createdAt: 'desc' as const }, { [field]: 'desc' as const }],
    },
    where: cursor
      ? {
          OR: [
            { createdAt: { lt: new Date(cursor.createdAt) } },
            { createdAt: new Date(cursor.createdAt), [field]: { lt: cursor.id } },
          ],
        }
      : {},
  };
}
export function nextCursor(rows: { id?: string; key?: string; createdAt: Date }[], limit: number) {
  const last = rows[limit - 1];
  return rows.length > limit && last
    ? Buffer.from(
        JSON.stringify({ id: last.id ?? last.key, createdAt: last.createdAt.toISOString() }),
      ).toString('base64url')
    : null;
}
