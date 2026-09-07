import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { DatabaseService } from '../../src/shared/database/database.service.js';

const execFileAsync = promisify(execFile);
const TEST_SCHEMA = /^viviai_test_[a-f0-9]+$/;

export interface TestDatabase {
  url: string;
  database: DatabaseService;
  cleanup(): Promise<void>;
}

function requireTestSchema(schema: string): void {
  if (!TEST_SCHEMA.test(schema)) {
    throw new Error(`Refusing to delete non-test schema: ${schema}`);
  }
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) {
    throw new Error('DATABASE_URL is required for integration tests');
  }

  const schema = `viviai_test_${randomBytes(8).toString('hex')}`;
  requireTestSchema(schema);
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
  } finally {
    await admin.end();
  }

  const schemaUrl = new URL(baseUrl);
  schemaUrl.searchParams.set('schema', schema);
  const url = schemaUrl.toString();
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

  try {
    await execFileAsync(resolve(projectRoot, 'node_modules/.bin/prisma'), ['migrate', 'deploy'], {
      cwd: projectRoot,
      env: { ...process.env, DATABASE_URL: url },
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    await dropOwnedTestSchema(baseUrl, schema);
    throw error;
  }

  const database = new DatabaseService(url);
  await database.onModuleInit();
  let cleaned = false;

  return {
    url,
    database,
    async cleanup(): Promise<void> {
      if (cleaned) return;
      requireTestSchema(schema);
      await database.onModuleDestroy();
      await dropOwnedTestSchema(baseUrl, schema);
      cleaned = true;
    },
  };
}

async function dropOwnedTestSchema(baseUrl: string, schema: string): Promise<void> {
  requireTestSchema(schema);
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    const result = await admin.query<{ owner: string; current_user: string }>(
      `SELECT pg_get_userbyid(n.nspowner) AS owner, current_user
         FROM pg_namespace n
        WHERE n.nspname = $1`,
      [schema],
    );
    if (result.rowCount === 0) return;
    const row = result.rows[0];
    if (!row || row.owner !== row.current_user) {
      throw new Error(`Refusing to delete test schema not owned by current user: ${schema}`);
    }
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    await admin.end();
  }
}
