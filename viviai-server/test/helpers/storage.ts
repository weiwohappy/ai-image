import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalObjectStore } from '../../src/modules/assets/local-object-store.js';

export async function createTestStorage(): Promise<{ root: string; store: LocalObjectStore; cleanup(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'viviai-store-test-'));
  return { root, store: new LocalObjectStore(root), cleanup: () => rm(root, { recursive: true, force: true }) };
}
