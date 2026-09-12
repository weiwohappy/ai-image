import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { failure } from '../team/policy.js';

const cursorSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(['inspirations', 'remix-templates', 'tools', 'media']),
    filter: z.string().max(2048),
    updatedAt: z.iso.datetime(),
    id: z.uuid(),
    mac: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

type Cursor = z.infer<typeof cursorSchema>;
export type AdminPageKind = Cursor['kind'];

function invalidCursor(): never {
  throw failure(400, 'ADMIN_INVALID_INPUT', '分页游标无效');
}

export function adminFilter(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)),
  );
}

function mac(payload: Omit<Cursor, 'mac'>, secret: string): string {
  return createHmac('sha256', secret)
    .update(`admin-content-cursor-v1:${JSON.stringify(payload)}`)
    .digest('hex');
}

export function decodeAdminCursor(
  value: string | undefined,
  kind: AdminPageKind,
  filter: string,
  secret: string,
): { updatedAt: Date; id: string } | undefined {
  if (!value) return undefined;
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(value)) return invalidCursor();
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) return invalidCursor();
    const parsed = cursorSchema.parse(JSON.parse(bytes.toString('utf8')));
    const { mac: received, ...payload } = parsed;
    const expected = mac(payload, secret);
    if (
      parsed.kind !== kind ||
      parsed.filter !== filter ||
      !timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'))
    )
      return invalidCursor();
    return { updatedAt: new Date(parsed.updatedAt), id: parsed.id };
  } catch {
    return invalidCursor();
  }
}

export function adminNextCursor(
  rows: Array<{ id: string; updatedAt: Date }>,
  limit: number,
  kind: AdminPageKind,
  filter: string,
  secret: string,
): string | null {
  if (rows.length <= limit) return null;
  const last = rows[limit - 1];
  if (!last) return null;
  const payload = {
    version: 1 as const,
    kind,
    filter,
    updatedAt: last.updatedAt.toISOString(),
    id: last.id,
  };
  return Buffer.from(JSON.stringify({ ...payload, mac: mac(payload, secret) })).toString(
    'base64url',
  );
}

export function adminAfter(anchor: { updatedAt: Date; id: string } | undefined) {
  return anchor
    ? {
        AND: [
          {
            OR: [
              { updatedAt: { lt: anchor.updatedAt } },
              { updatedAt: anchor.updatedAt, id: { lt: anchor.id } },
            ],
          },
        ],
      }
    : {};
}
