import { open, readFile, lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseService } from '../shared/database/database.service.js';
import { bootstrapAdministrators, revokeAdministrator } from '../modules/admin/bootstrap.js';
export async function adminBootstrapCli(args = process.argv.slice(2), env = process.env) {
  if (!['development', 'test'].includes(env.NODE_ENV ?? ''))
    throw new Error(
      'Increment A offline administration requires explicit NODE_ENV=development or test',
    );
  if (!env.DATABASE_URL) throw new Error('Explicit DATABASE_URL is required');
  const [command, ...options] = args;
  const flags = new Map<string, string>();
  for (const option of options) {
    const match = /^--(input|output)=(.+)$/.exec(option);
    if (!match || flags.has(match[1]!))
      throw new Error(
        'Use explicit --input=/absolute/private.json and --output=/absolute/new-private.json',
      );
    flags.set(match[1]!, match[2]!);
  }
  const inputPath = flags.get('input');
  if (!inputPath || !isAbsolute(inputPath))
    throw new Error('Explicit absolute input path required');
  const info = await lstat(inputPath);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
    throw new Error('Input must be an owner-only regular file');
  const input: unknown = JSON.parse(await readFile(inputPath, 'utf8'));
  const db = new DatabaseService(env.DATABASE_URL);
  try {
    if (command === 'bootstrap') {
      const destination = flags.get('output');
      if (!destination || !isAbsolute(destination) || destination === inputPath)
        throw new Error('Explicit new absolute owner-only output destination required');
      // Reserve an exclusive private destination before creating invitations. No tokens enter logs.
      const output = await open(destination, 'wx', 0o600);
      try {
        await bootstrapAdministrators(db, input, async (invitations) => {
          await output.writeFile(JSON.stringify({ invitations }, null, 2) + '\n', 'utf8');
          await output.sync();
        });
      } finally {
        await output.close();
      }
    } else if (command === 'revoke-account') {
      if (
        flags.has('output') ||
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).sort().join(',') !== 'email,reason'
      )
        throw new Error('Revocation input requires only email and reason');
      const values = input as { email: unknown; reason: unknown };
      if (typeof values.email !== 'string' || typeof values.reason !== 'string')
        throw new Error('Invalid revocation input');
      await revokeAdministrator(db, values.email, values.reason);
    } else throw new Error('Choose bootstrap or revoke-account');
  } finally {
    await db.onModuleDestroy();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void adminBootstrapCli().then(
    () => console.info('Offline administration completed; no credentials were printed.'),
    () => {
      console.error(
        'Offline administration failed. Check private input, output permissions, configuration and prior bootstrap state.',
      );
      process.exitCode = 1;
    },
  );
