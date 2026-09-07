import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { DatabaseService } from '../shared/database/database.service.js';
import { hashPassword } from '../modules/identity/identity.service.js';

export async function seedDevelopmentAccount(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (env.NODE_ENV !== 'development') throw new Error('Development seed requires NODE_ENV=development');
  const parsed = z.object({
    DATABASE_URL: z.string().url().refine(value => /^postgres(ql)?:/.test(value)),
    DEV_SEED_EMAIL: z.string().trim().toLowerCase().email().max(254),
    DEV_SEED_USERNAME: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,32}$/),
    DEV_SEED_PASSWORD: z.string().min(12).max(128),
  }).safeParse(env);
  if (!parsed.success) throw new Error('Explicit valid development database, email, username and password are required');
  const input = parsed.data;
  const db = new DatabaseService(input.DATABASE_URL);
  try {
    await db.client.user.create({ data: { email: input.DEV_SEED_EMAIL, username: input.DEV_SEED_USERNAME, passwordHash: await hashPassword(input.DEV_SEED_PASSWORD) } });
  } catch { throw new Error('Account seed failed; existing accounts are never overwritten'); }
  finally { await db.onModuleDestroy(); }
  // Wallet grants belong to the wallet service introduced by task 3.
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedDevelopmentAccount().then(() => { console.info('Development account created without credits'); }, error => {
    console.error(error instanceof Error ? error.message : 'Account seed failed'); process.exitCode = 1;
  });
}
