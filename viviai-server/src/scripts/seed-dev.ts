import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { DatabaseService } from '../shared/database/database.service.js';
import { hashPassword } from '../modules/identity/identity.service.js';
import { WalletService } from '../modules/wallet/wallet.service.js';

export async function seedDevelopmentAccount(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (env.NODE_ENV !== 'development')
    throw new Error('Development seed requires NODE_ENV=development');
  const parsed = z
    .object({
      DATABASE_URL: z
        .string()
        .url()
        .refine((value) => /^postgres(ql)?:/.test(value)),
      DEV_SEED_EMAIL: z.string().trim().toLowerCase().email().max(254),
      DEV_SEED_USERNAME: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9_]{3,32}$/),
      DEV_SEED_PASSWORD: z.string().min(12).max(128),
      DEV_SEED_CREDITS: z
        .string()
        .regex(/^\d+$/)
        .default('0')
        .transform(BigInt)
        .refine((value) => value <= 1_000_000n),
    })
    .safeParse(env);
  if (!parsed.success)
    throw new Error(
      'Explicit valid development database, email, username and password are required',
    );
  const input = parsed.data;
  const db = new DatabaseService(input.DATABASE_URL);
  try {
    const passwordHash = await hashPassword(input.DEV_SEED_PASSWORD);
    const wallet = new WalletService(db);
    await db.transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email: input.DEV_SEED_EMAIL, username: input.DEV_SEED_USERNAME, passwordHash },
      });
      if (input.DEV_SEED_CREDITS > 0n)
        await wallet.grant(tx, user.id, 'development-promotional-v1', input.DEV_SEED_CREDITS, null);
    });
  } catch {
    throw new Error('Account seed failed; existing accounts are never overwritten');
  } finally {
    await db.onModuleDestroy();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedDevelopmentAccount().then(
    () => {
      console.info(
        'Development account created; optional credits are zero-revenue promotional credits',
      );
    },
    (error) => {
      console.error(error instanceof Error ? error.message : 'Account seed failed');
      process.exitCode = 1;
    },
  );
}
