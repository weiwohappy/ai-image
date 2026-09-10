import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config.js';
import { DatabaseService } from '../shared/database/database.service.js';
import { bootstrapSuperAdministrator } from '../modules/admin/team/bootstrap-super-admin.js';
export function parseSuperAdminArgs(args: string[]) {
  const flags = new Map<string, string>();
  let apply = false;
  for (const arg of args) {
    if (arg === '--apply' && !apply) {
      apply = true;
      continue;
    }
    const match = /^--(email|expected-version|reason)=(.+)$/.exec(arg);
    if (!match || flags.has(match[1]!))
      throw new Error('Use --email=... --expected-version=... --reason=... and optional --apply');
    flags.set(match[1]!, match[2]!);
  }
  if (flags.size !== 3 || !/^[1-9]\d*$/.test(flags.get('expected-version')!))
    throw new Error('Explicit email, version and reason are required');
  return {
    email: flags.get('email')!,
    expectedVersion: Number(flags.get('expected-version')),
    reason: flags.get('reason')!,
    apply,
  };
}
export async function adminSuperAdminCli(args = process.argv.slice(2), env = process.env) {
  const input = parseSuperAdminArgs(args);
  const config = loadConfig(env);
  const db = new DatabaseService(config.databaseUrl);
  try {
    return await bootstrapSuperAdministrator(db, config, input);
  } finally {
    await db.onModuleDestroy();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void adminSuperAdminCli().then(
    (result) => console.info(JSON.stringify(result)),
    (error) => {
      console.error(
        error instanceof Error ? error.message : 'Super administrator bootstrap failed',
      );
      process.exitCode = 1;
    },
  );
