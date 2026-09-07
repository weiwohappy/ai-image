import { spawn } from 'node:child_process';
if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
  console.error('Set DATABASE_URL and REDIS_URL to task-owned local services before smoke.');
  process.exitCode = 1;
} else {
  const child = spawn(
    process.execPath,
    ['node_modules/vitest/vitest.mjs', 'run', 'test/e2e/generation.test.ts'],
    { stdio: 'inherit', env: process.env },
  );
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
  child.on('error', () => {
    console.error('Unable to start smoke runner');
    process.exitCode = 1;
  });
}
