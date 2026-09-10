import { pathToFileURL } from 'node:url';
import { DatabaseService } from '../shared/database/database.service.js';
import { importLegacyPrices } from '../modules/admin/model-pricing/import.js';
export async function importModelPricesCli(args = process.argv.slice(2), env = process.env) {
  if (args.length > 1 || (args.length === 1 && !['--apply', '--dry-run'].includes(args[0]!)))
    throw new Error('Use optional --apply or --dry-run (default)');
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const db = new DatabaseService(env.DATABASE_URL);
  try {
    return await importLegacyPrices(
      db,
      {
        databaseUrl: env.DATABASE_URL,
        nodeEnv: env.NODE_ENV ?? 'development',
        host: env.HOST ?? '127.0.0.1',
      },
      env.OFFICIAL_IMAGE_MODELS_JSON ?? '',
      args[0] === '--apply',
    );
  } finally {
    await db.onModuleDestroy();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void importModelPricesCli().then(
    (result) => console.info(JSON.stringify(result)),
    () => {
      console.error(
        'Model price import failed; verify local environment and legacy price configuration',
      );
      process.exitCode = 1;
    },
  );
