import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, posix, resolve, sep } from 'node:path';
import type { ObjectStore } from './object-store.js';

export class LocalObjectStore implements ObjectStore {
  private readonly initializedRoot: Promise<string>;

  constructor(root: string) {
    this.initializedRoot = initializeRoot(root);
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    if (!contentType.includes('/')) throw new Error('A valid content type is required');
    const root = await this.initializedRoot;
    const target = resolveKey(root, key);
    await ensureSafeParent(root, dirname(target));
    await refuseSymlink(target);
    const temporary = resolve(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      await rename(temporary, target);
      await syncDirectory(dirname(target));
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async get(key: string): Promise<Uint8Array> {
    const root = await this.initializedRoot;
    const target = resolveKey(root, key);
    await refuseSymlink(target);
    const actual = await realpath(target);
    assertContained(root, actual);
    return new Uint8Array(await readFile(actual));
  }

  async delete(key: string): Promise<void> {
    const root = await this.initializedRoot;
    const target = resolveKey(root, key);
    try {
      await refuseSymlink(target);
      const actual = await realpath(target);
      assertContained(root, actual);
      await unlink(actual);
      await syncDirectory(dirname(actual));
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
  }
}

async function initializeRoot(root: string): Promise<string> {
  const absoluteRoot = resolve(root);
  await ensureDirectory(absoluteRoot);
  return realpath(absoluteRoot);
}

function resolveKey(root: string, key: string): string {
  if (
    key.length === 0 ||
    key.includes('\\') ||
    key.includes('\0') ||
    isAbsolute(key) ||
    posix.normalize(key) !== key ||
    key.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error('Invalid object key');
  }
  const target = resolve(root, ...key.split('/'));
  assertContained(root, target);
  return target;
}

function assertContained(root: string, target: string): void {
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error('Object key escapes private storage root');
  }
}

async function ensureSafeParent(root: string, parent: string): Promise<void> {
  assertContained(root, parent);
  const relative = parent.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const segment of relative) {
    current = resolve(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error('Object path contains a non-directory or symbolic link');
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
      try {
        await mkdir(current, { mode: 0o700 });
        await syncDirectory(dirname(current));
      } catch (mkdirError) {
        if (!isAlreadyExists(mkdirError)) throw mkdirError;
        const stat = await lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error('Object path contains a non-directory or symbolic link');
        }
        await syncDirectory(dirname(current));
      }
    }
  }
}

async function ensureDirectory(directory: string): Promise<void> {
  try {
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Storage root contains a non-directory or symbolic link');
    }
    return;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  const parent = dirname(directory);
  if (parent === directory) throw new Error('Cannot create storage root');
  await ensureDirectory(parent);
  try {
    await mkdir(directory, { mode: 0o700 });
    await syncDirectory(parent);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Storage root contains a non-directory or symbolic link');
    }
    await syncDirectory(parent);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function refuseSymlink(target: string): Promise<void> {
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) throw new Error('Symbolic links are forbidden in object storage');
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}
