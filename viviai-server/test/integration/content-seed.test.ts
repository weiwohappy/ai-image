import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import pg from 'pg';
import type { Prisma } from '../../src/generated/prisma/client.js';
import { SessionAdvisoryLockTimeoutError } from '../../src/shared/database/database.service.js';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { createTestStorage } from '../helpers/storage.js';
import {
  contentSeedManifest,
  SeedCleanupError,
  seedContent,
  type ContentSeedManifest,
} from '../../src/scripts/seed-content.js';
import type { ObjectStore } from '../../src/modules/assets/object-store.js';
import {
  inspirationInputSchema,
  toolDefinitionInputSchema,
} from '../../src/modules/content/content-contracts.js';

describe('operational content seed', () => {
  let database: TestDatabase;
  let storage: Awaited<ReturnType<typeof createTestStorage>>;

  beforeAll(async () => {
    database = await createTestDatabase();
    storage = await createTestStorage();
  });

  afterAll(async () => {
    await storage?.cleanup();
    await database?.cleanup();
  });

  it('is digest-idempotent for the reviewed content manifest', async () => {
    const firstResult = await seedContent(database.database, storage.store);
    const first = await snapshot();

    const secondResult = await seedContent(database.database, storage.store);
    expect(await snapshot()).toEqual(first);
    expect(first.media).not.toHaveLength(0);
    expect(first.inspirations).toHaveLength(contentSeedManifest.inspirations.length);
    expect(first.templates).toHaveLength(contentSeedManifest.templates.length);
    expect(first.tools).toHaveLength(contentSeedManifest.tools.length);
    expect(firstResult.inspirationCounts.created).toBe(contentSeedManifest.inspirations.length);
    expect(firstResult.templateCounts.created).toBe(contentSeedManifest.templates.length);
    expect(firstResult.toolCounts.created).toBe(contentSeedManifest.tools.length);
    expect(secondResult.inspirationCounts).toEqual({
      created: 0,
      updated: 0,
      unchanged: contentSeedManifest.inspirations.length,
    });
    expect(secondResult.templateCounts).toEqual({
      created: 0,
      updated: 0,
      unchanged: contentSeedManifest.templates.length,
    });
    expect(secondResult.toolCounts).toEqual({
      created: 0,
      updated: 0,
      unchanged: contentSeedManifest.tools.length,
    });
  });

  it('increments a changed catalog row exactly once while retaining its external ID', async () => {
    const changed = structuredClone(contentSeedManifest);
    changed.inspirations[0]!.title = '透明香氛（更新）';

    await seedContent(database.database, storage.store, { manifest: changed });
    const updated = await database.database.client.inspiration.findUniqueOrThrow({
      where: { externalId: changed.inspirations[0]!.externalId },
    });
    expect(updated).toMatchObject({ title: '透明香氛（更新）', version: 2 });

    await seedContent(database.database, storage.store, { manifest: changed });
    expect(
      await database.database.client.inspiration.findUniqueOrThrow({
        where: { externalId: changed.inspirations[0]!.externalId },
      }),
    ).toMatchObject({ id: updated.id, version: 2, updatedAt: updated.updatedAt });
  });

  it('rejects unknown keys and bad internal media references before writing catalog rows', async () => {
    const unknown = structuredClone(contentSeedManifest) as ContentSeedManifest & {
      inspirations: Array<ContentSeedManifest['inspirations'][number] & { unexpected: string }>;
    };
    unknown.inspirations[0]!.unexpected = 'nope';
    await expect(
      seedContent(database.database, storage.store, { manifest: unknown }),
    ).rejects.toThrow('Invalid content seed manifest');

    const badReference = structuredClone(contentSeedManifest);
    badReference.templates[0]!.coverMediaExternalId = 'content-media-missing';
    await expect(
      seedContent(database.database, storage.store, { manifest: badReference }),
    ).rejects.toThrow('content-media-missing');
  });

  it('keeps exported input contracts strict about lifecycle, field options, and defaults', () => {
    expect(
      inspirationInputSchema.safeParse({
        ...contentSeedManifest.inspirations[0]!,
        status: 'not-a-lifecycle',
      }).success,
    ).toBe(false);
    expect(
      toolDefinitionInputSchema.safeParse({
        ...contentSeedManifest.tools[0]!,
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      toolDefinitionInputSchema.safeParse({
        ...contentSeedManifest.tools[0]!,
        defaults: { ...contentSeedManifest.tools[0]!.defaults, modelId: 'gpt-image-2' },
      }).success,
    ).toBe(false);
    expect(
      toolDefinitionInputSchema.safeParse({
        ...contentSeedManifest.tools[0]!,
        fields: [{ ...contentSeedManifest.tools[0]!.fields[0]!, options: [] }],
      }).success,
    ).toBe(false);
    expect(
      toolDefinitionInputSchema.safeParse({
        ...contentSeedManifest.tools[0]!,
        promptTemplate: 'Malformed {{product-type',
      }).success,
    ).toBe(false);
  });

  it('rejects an unbounded session-lock timeout before acquiring the seed lock', async () => {
    await expect(
      seedContent(database.database, storage.store, { lockTimeoutMs: 60_001 }),
    ).rejects.toThrow('Content seed lock timeout must be an integer between 1 and 60000ms');
  });

  it('serializes concurrent complete imports and reports created, updated, unchanged, and cleanup warnings', async () => {
    const fresh = structuredClone(contentSeedManifest);
    fresh.media[0]!.externalId = 'content-media-concurrent';
    fresh.media = [fresh.media[0]!];
    fresh.inspirations = [];
    fresh.templates = [];
    fresh.tools = [];
    const [first, second] = await Promise.all([
      seedContent(database.database, storage.store, { manifest: fresh }),
      seedContent(database.database, storage.store, { manifest: fresh }),
    ]);
    expect(first.mediaCounts.created + second.mediaCounts.created).toBe(1);
    expect(first.mediaCounts.unchanged + second.mediaCounts.unchanged).toBe(1);
    expect(first.cleanupWarnings).toEqual({ rollback: 0, obsolete: 0 });
    expect(second.cleanupWarnings).toEqual({ rollback: 0, obsolete: 0 });
  });

  it('keeps a second import outside object operations until the first seed releases its session lock', async () => {
    const manifest = structuredClone(contentSeedManifest);
    manifest.media[0]!.externalId = 'content-media-session-lock';
    manifest.media = [manifest.media[0]!];
    manifest.inspirations = [];
    manifest.templates = [];
    manifest.tools = [];
    let puts = 0;
    let releasePut: (() => void) | undefined;
    let enteredPut: (() => void) | undefined;
    const firstPut = new Promise<void>((resolve) => {
      enteredPut = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    const delayedStore: ObjectStore = {
      get: (key) => storage.store.get(key),
      delete: (key) => storage.store.delete(key),
      put: async (key, bytes, contentType) => {
        puts++;
        if (puts === 1) {
          enteredPut!();
          await release;
        }
        await storage.store.put(key, bytes, contentType);
      },
    };

    const first = seedContent(database.database, delayedStore, { manifest });
    await firstPut;
    const second = seedContent(database.database, delayedStore, { manifest });
    await waitForAdvisoryLockWait(database.url);
    expect(puts).toBe(1);
    releasePut!();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.mediaCounts.created + secondResult.mediaCounts.created).toBe(1);
    expect(firstResult.mediaCounts.unchanged + secondResult.mediaCounts.unchanged).toBe(1);
    const media = await database.database.client.contentMedia.findUniqueOrThrow({
      where: { externalId: manifest.media[0]!.externalId },
    });
    expect(await storage.store.get(media.objectKey)).toHaveLength(media.byteSize);
  });

  it('finishes rollback cleanup before a waiting retry writes the same object', async () => {
    const manifest = freshMediaManifest('content-media-rollback-retry');
    const removeConstraint = await rejectMediaExternalId(database, manifest.media[0]!.externalId);
    const events: string[] = [];
    let releaseCleanup: (() => void) | undefined;
    let enteredCleanup: (() => void) | undefined;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const cleanupStarted = new Promise<void>((resolve) => {
      enteredCleanup = resolve;
    });
    const orderedStore: ObjectStore = {
      get: (key) => storage.store.get(key),
      delete: async (key) => {
        events.push('cleanup-start');
        enteredCleanup!();
        await cleanup;
        events.push('delete');
        await storage.store.delete(key);
      },
      put: async (key, bytes, contentType) => {
        events.push('put');
        await storage.store.put(key, bytes, contentType);
      },
    };
    const failing = seedContent(database.database, orderedStore, { manifest });
    await cleanupStarted;
    const retry = seedContent(database.database, orderedStore, { manifest });
    await waitForAdvisoryLockWait(database.url);
    expect(events).toEqual(['put', 'cleanup-start']);
    await removeConstraint();
    releaseCleanup!();
    await expect(failing).rejects.toThrow();
    await retry;
    expect(events).toEqual(['put', 'cleanup-start', 'delete', 'put']);
    const media = await database.database.client.contentMedia.findUniqueOrThrow({
      where: { externalId: manifest.media[0]!.externalId },
    });
    expect(digest(await storage.store.get(media.objectKey))).toBe(media.sha256);
  });

  it('applies an identical concurrent material update once and retains a readable matching object', async () => {
    const baseline = freshMediaManifest('content-media-identical-update');
    await seedContent(database.database, storage.store, { manifest: baseline });
    const before = await database.database.client.contentMedia.findUniqueOrThrow({
      where: { externalId: baseline.media[0]!.externalId },
    });
    const changed = structuredClone(baseline);
    changed.media[0]!.colors = ['#c01020', '#20c010', '#1020c0'];
    let releasePut: (() => void) | undefined;
    let enteredPut: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    const firstPut = new Promise<void>((resolve) => {
      enteredPut = resolve;
    });
    const delayedStore: ObjectStore = {
      get: (key) => storage.store.get(key),
      delete: (key) => storage.store.delete(key),
      put: async (key, bytes, contentType) => {
        enteredPut!();
        await release;
        await storage.store.put(key, bytes, contentType);
      },
    };
    const first = seedContent(database.database, delayedStore, { manifest: changed });
    await firstPut;
    const second = seedContent(database.database, delayedStore, { manifest: changed });
    await waitForAdvisoryLockWait(database.url);
    releasePut!();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.mediaCounts.updated + secondResult.mediaCounts.updated).toBe(1);
    const saved = await database.database.client.contentMedia.findUniqueOrThrow({
      where: { externalId: baseline.media[0]!.externalId },
    });
    expect(saved.version).toBe(before.version + 1);
    expect(digest(await storage.store.get(saved.objectKey))).toBe(saved.sha256);
  });

  it('holds reversion behind obsolete cleanup and never deletes its final live object', async () => {
    const baseline = freshMediaManifest('content-media-reversion-lock');
    await seedContent(database.database, storage.store, { manifest: baseline });
    const changed = structuredClone(baseline);
    changed.media[0]!.colors = ['#a0b0c0', '#d0e0f0', '#102938'];
    const events: string[] = [];
    let releaseCleanup: (() => void) | undefined;
    let enteredCleanup: (() => void) | undefined;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const cleanupStarted = new Promise<void>((resolve) => {
      enteredCleanup = resolve;
    });
    const orderedStore: ObjectStore = {
      get: (key) => storage.store.get(key),
      put: async (key, bytes, contentType) => {
        events.push(`put:${key}`);
        await storage.store.put(key, bytes, contentType);
      },
      delete: async (key) => {
        events.push(`delete:${key}`);
        enteredCleanup!();
        await cleanup;
        await storage.store.delete(key);
      },
    };
    const first = seedContent(database.database, orderedStore, { manifest: changed });
    await cleanupStarted;
    const reversion = seedContent(database.database, orderedStore, { manifest: baseline });
    await waitForAdvisoryLockWait(database.url);
    expect(events.filter((event) => event.startsWith('put:'))).toHaveLength(1);
    releaseCleanup!();
    await Promise.all([first, reversion]);
    const saved = await database.database.client.contentMedia.findUniqueOrThrow({
      where: { externalId: baseline.media[0]!.externalId },
    });
    expect(digest(await storage.store.get(saved.objectKey))).toBe(saved.sha256);
  });

  it('increments each referencing catalog item once when only its media changes', async () => {
    const manifest = structuredClone(contentSeedManifest);
    const before = await database.database.client.inspiration.findUniqueOrThrow({
      where: { externalId: manifest.inspirations[0]!.externalId },
    });
    manifest.media[0]!.colors = ['#a12b3c', '#4d5e6f', '#7a8b9c'];
    await seedContent(database.database, storage.store, { manifest });
    const changed = await database.database.client.inspiration.findUniqueOrThrow({
      where: { externalId: manifest.inspirations[0]!.externalId },
    });
    expect(changed.version).toBe(before.version + 1);
    await seedContent(database.database, storage.store, { manifest });
    expect(
      (await database.database.client.inspiration.findUniqueOrThrow({ where: { id: changed.id } }))
        .version,
    ).toBe(changed.version);
  });

  it('versions every non-manifest content record that references changed media exactly once', async () => {
    const manifest = freshMediaManifest('content-media-non-manifest-ref');
    await seedContent(database.database, storage.store, { manifest });
    const media = await database.database.client.contentMedia.findUniqueOrThrow({
      where: { externalId: manifest.media[0]!.externalId },
    });
    const sourceInspiration = await database.database.client.inspiration.findFirstOrThrow();
    const sourceTemplate = await database.database.client.remixTemplate.findFirstOrThrow();
    const sourceTool = await database.database.client.toolDefinition.findFirstOrThrow();
    const [inspiration, template, tool] = await Promise.all([
      database.database.client.inspiration.create({
        data: {
          externalId: 'inspiration-non-manifest-media-ref',
          title: sourceInspiration.title,
          description: sourceInspiration.description,
          category: sourceInspiration.category,
          tags: sourceInspiration.tags,
          defaultPrompt: sourceInspiration.defaultPrompt,
          defaultModelId: sourceInspiration.defaultModelId,
          defaultOutputSpecId: sourceInspiration.defaultOutputSpecId,
          coverMediaId: media.id,
        },
      }),
      database.database.client.remixTemplate.create({
        data: {
          externalId: 'template-non-manifest-media-ref',
          title: sourceTemplate.title,
          description: sourceTemplate.description,
          category: sourceTemplate.category,
          platform: sourceTemplate.platform,
          industry: sourceTemplate.industry,
          style: sourceTemplate.style,
          tags: sourceTemplate.tags,
          visualAnalysis: sourceTemplate.visualAnalysis as Prisma.InputJsonValue,
          defaultPrompt: sourceTemplate.defaultPrompt,
          defaultParameters: sourceTemplate.defaultParameters as Prisma.InputJsonValue,
          defaultModelId: sourceTemplate.defaultModelId,
          defaultOutputSpecId: sourceTemplate.defaultOutputSpecId,
          coverMediaId: media.id,
        },
      }),
      database.database.client.toolDefinition.create({
        data: {
          externalId: 'tool-non-manifest-media-ref',
          name: sourceTool.name,
          description: sourceTool.description,
          category: sourceTool.category,
          fieldSchema: sourceTool.fieldSchema as Prisma.InputJsonValue,
          promptTemplate: sourceTool.promptTemplate,
          defaults: sourceTool.defaults as Prisma.InputJsonValue,
          maxAssets: sourceTool.maxAssets,
          maxOutputCount: sourceTool.maxOutputCount,
          assetLabel: sourceTool.assetLabel,
          defaultModelId: sourceTool.defaultModelId,
          defaultOutputSpecId: sourceTool.defaultOutputSpecId,
          coverMediaId: media.id,
        },
      }),
    ]);
    const mediaOnly = structuredClone(manifest);
    mediaOnly.media[0]!.colors = ['#102030', '#405060', '#708090'];
    const changedResult = await seedContent(database.database, storage.store, {
      manifest: mediaOnly,
    });
    expect(changedResult.inspirationCounts).toEqual({ created: 0, updated: 1, unchanged: 0 });
    expect(changedResult.templateCounts).toEqual({ created: 0, updated: 1, unchanged: 0 });
    expect(changedResult.toolCounts).toEqual({ created: 0, updated: 1, unchanged: 0 });
    await expect(
      Promise.all([
        database.database.client.inspiration.findUniqueOrThrow({ where: { id: inspiration.id } }),
        database.database.client.remixTemplate.findUniqueOrThrow({ where: { id: template.id } }),
        database.database.client.toolDefinition.findUniqueOrThrow({ where: { id: tool.id } }),
      ]),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ version: inspiration.version + 1 }),
        expect.objectContaining({ version: template.version + 1 }),
        expect.objectContaining({ version: tool.version + 1 }),
      ]),
    );
    const noOpResult = await seedContent(database.database, storage.store, { manifest: mediaOnly });
    expect(noOpResult.inspirationCounts).toEqual({ created: 0, updated: 0, unchanged: 0 });
    expect(noOpResult.templateCounts).toEqual({ created: 0, updated: 0, unchanged: 0 });
    expect(noOpResult.toolCounts).toEqual({ created: 0, updated: 0, unchanged: 0 });
    await expect(
      Promise.all([
        database.database.client.inspiration.findUniqueOrThrow({ where: { id: inspiration.id } }),
        database.database.client.remixTemplate.findUniqueOrThrow({ where: { id: template.id } }),
        database.database.client.toolDefinition.findUniqueOrThrow({ where: { id: tool.id } }),
      ]),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ version: inspiration.version + 1 }),
        expect.objectContaining({ version: template.version + 1 }),
        expect.objectContaining({ version: tool.version + 1 }),
      ]),
    );
  });

  it('publishes a tool only with an enabled executable model and active price', async () => {
    const manifest = publishedToolManifest();
    await expect(
      seedContent(database.database, storage.store, {
        manifest,
        isModelSpecEnabled: () => true,
      }),
    ).rejects.toThrow('active model credit price');

    await database.database.client.modelCreditPrice.create({
      data: { modelId: 'gpt-image-2', resolution: '1K', unitCredits: 1, enabled: true },
    });
    await seedContent(database.database, storage.store, {
      manifest,
      isModelSpecEnabled: () => true,
    });
    await expect(
      database.database.client.toolDefinition.findUniqueOrThrow({
        where: { externalId: manifest.tools[0]!.externalId },
      }),
    ).resolves.toMatchObject({ status: 'published' });

    const unavailable = publishedToolManifest();
    unavailable.tools[0]!.externalId = 'tool-unavailable-model';
    await expect(
      seedContent(database.database, storage.store, {
        manifest: unavailable,
        isModelSpecEnabled: () => false,
      }),
    ).rejects.toThrow('enabled model specification');

    const mismatched = publishedToolManifest();
    mismatched.tools[0]!.externalId = 'tool-mismatched-spec';
    mismatched.tools[0]!.defaults.ratio = '16:9';
    await expect(
      seedContent(database.database, storage.store, {
        manifest: mismatched,
        isModelSpecEnabled: () => true,
      }),
    ).rejects.toThrow('exact output specification');
  });

  it('cleans newly stored objects when its database transaction fails', async () => {
    const manifest = freshMediaManifest('content-media-cleanup');
    await rejectMediaExternalId(database, manifest.media[0]!.externalId);
    await expect(seedContent(database.database, storage.store, { manifest })).rejects.toThrow();
    await expect(
      database.database.client.contentMedia.findUnique({
        where: { externalId: 'content-media-cleanup' },
      }),
    ).resolves.toBeNull();
  });

  it('reports a safe cleanup warning count when rollback object cleanup also fails', async () => {
    const manifest = freshMediaManifest('content-media-cleanup-warning');
    await rejectMediaExternalId(database, manifest.media[0]!.externalId);
    const failingCleanupStore: ObjectStore = {
      get: (key) => storage.store.get(key),
      put: (key, bytes, contentType) => storage.store.put(key, bytes, contentType),
      delete: async () => {
        throw new Error('injected delete failure');
      },
    };

    await expect(
      seedContent(database.database, failingCleanupStore, { manifest }),
    ).rejects.toMatchObject({
      name: SeedCleanupError.name,
      warningCount: 1,
      cleanupWarnings: { rollback: 1, obsolete: 0 },
      message: 'Content seed failed with 1 cleanup warning(s): rollback=1, obsolete=0',
    });
  });

  it('returns a safe obsolete cleanup category count without removing the live replacement', async () => {
    const manifest = structuredClone(contentSeedManifest);
    manifest.media[0]!.colors = ['#13579b', '#2468ac', '#3579bd'];
    const deleteFailingStore: ObjectStore = {
      get: (key) => storage.store.get(key),
      put: (key, bytes, contentType) => storage.store.put(key, bytes, contentType),
      delete: async () => {
        throw new Error('injected obsolete delete failure');
      },
    };
    const result = await seedContent(database.database, deleteFailingStore, { manifest });
    expect(result.cleanupWarnings).toEqual({ rollback: 0, obsolete: 1 });
    const media = await database.database.client.contentMedia.findUniqueOrThrow({
      where: { externalId: manifest.media[0]!.externalId },
    });
    expect(await storage.store.get(media.objectKey)).toHaveLength(media.byteSize);
  });

  it('times out a bounded waiting seed safely and allows recovery after the holder releases', async () => {
    const manifest = freshMediaManifest('content-media-lock-timeout');
    let releasePut: (() => void) | undefined;
    let enteredPut: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    const firstPut = new Promise<void>((resolve) => {
      enteredPut = resolve;
    });
    const delayedStore: ObjectStore = {
      get: (key) => storage.store.get(key),
      delete: (key) => storage.store.delete(key),
      put: async (key, bytes, contentType) => {
        enteredPut!();
        await release;
        await storage.store.put(key, bytes, contentType);
      },
    };
    const holder = seedContent(database.database, delayedStore, { manifest });
    await firstPut;
    const timedOut = seedContent(database.database, delayedStore, {
      manifest,
      lockTimeoutMs: 1,
    });
    await waitForAdvisoryLockWait(database.url);
    await expect(timedOut).rejects.toBeInstanceOf(SessionAdvisoryLockTimeoutError);
    releasePut!();
    await holder;
    await expect(
      seedContent(database.database, storage.store, { manifest }),
    ).resolves.toMatchObject({
      mediaCounts: { created: 0, updated: 0, unchanged: 1 },
    });
  });

  it('names the failed mock media when object storage rejects its PNG', async () => {
    const manifest = structuredClone(contentSeedManifest);
    manifest.media.push({ ...manifest.media[0]!, externalId: 'content-media-storage-error' });
    manifest.inspirations[0]!.coverMediaExternalId = 'content-media-storage-error';
    const failingStore: ObjectStore = {
      get: (key) => storage.store.get(key),
      delete: (key) => storage.store.delete(key),
      put: async (key, bytes, contentType) => {
        if (key.includes('content-media-storage-error')) throw new Error('storage is unavailable');
        return storage.store.put(key, bytes, contentType);
      },
    };

    await expect(seedContent(database.database, failingStore, { manifest })).rejects.toThrow(
      'mock-visual-1.png (content-media-storage-error) failed: storage is unavailable',
    );
    await expect(
      database.database.client.contentMedia.findUnique({
        where: { externalId: 'content-media-storage-error' },
      }),
    ).resolves.toBeNull();
  });

  it('fails safely when an existing content object cannot be read', async () => {
    const unreadableStore: ObjectStore = {
      get: async () => {
        throw new Error('object store read is unavailable');
      },
      delete: (key) => storage.store.delete(key),
      put: (key, bytes, contentType) => storage.store.put(key, bytes, contentType),
    };
    await expect(seedContent(database.database, unreadableStore)).rejects.toThrow(
      /mock-visual-\d+\.png \(content-media-visual-\d+\) failed: object store read is unavailable/,
    );
  });

  async function snapshot() {
    const db = database.database.client;
    return {
      media: await db.contentMedia.findMany({
        select: { id: true, externalId: true, version: true, updatedAt: true, sha256: true },
        orderBy: { externalId: 'asc' },
      }),
      inspirations: await db.inspiration.findMany({
        select: { id: true, externalId: true, version: true, updatedAt: true, coverMediaId: true },
        orderBy: { externalId: 'asc' },
      }),
      templates: await db.remixTemplate.findMany({
        select: { id: true, externalId: true, version: true, updatedAt: true, coverMediaId: true },
        orderBy: { externalId: 'asc' },
      }),
      tools: await db.toolDefinition.findMany({
        select: { id: true, externalId: true, version: true, updatedAt: true, coverMediaId: true },
        orderBy: { externalId: 'asc' },
      }),
    };
  }
});

function publishedToolManifest(): ContentSeedManifest {
  const manifest = structuredClone(contentSeedManifest);
  manifest.tools = [
    {
      ...manifest.tools[0]!,
      externalId: 'tool-published-price-test',
      status: 'published',
      defaultModelId: 'gpt-image-2',
      defaultOutputSpecId: 'png-1k-1x1-v1',
      defaults: { modelId: 'gpt-image-2', resolution: '1K', ratio: '1:1', count: 1 },
    },
  ];
  return manifest;
}

function freshMediaManifest(externalId: string): ContentSeedManifest {
  const manifest = structuredClone(contentSeedManifest);
  manifest.media[0]!.externalId = externalId;
  manifest.media = [manifest.media[0]!];
  manifest.inspirations = [];
  manifest.templates = [];
  manifest.tools = [];
  return manifest;
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function waitForAdvisoryLockWait(databaseUrl: string): Promise<void> {
  const url = new URL(databaseUrl);
  url.searchParams.delete('schema');
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const result = await client.query<{ waiting: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM pg_stat_activity
           WHERE application_name = 'viviai-content-seed-lock'
             AND wait_event_type = 'Lock'
             AND wait_event = 'advisory'
         ) AS waiting`,
      );
      if (result.rows[0]?.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for content seed advisory lock state');
  } finally {
    await client.end();
  }
}

let rejectedConstraint = 0;

async function rejectMediaExternalId(
  database: TestDatabase,
  externalId: string,
): Promise<() => Promise<void>> {
  const constraint = `content_seed_reject_${rejectedConstraint++}`;
  if (!/^[a-z0-9-]+$/.test(externalId)) throw new Error('Unsafe test media external ID');
  const url = new URL(database.url);
  const schema = url.searchParams.get('schema');
  if (!schema || !/^viviai_test_[a-f0-9]+$/.test(schema)) throw new Error('Unsafe test schema');
  url.searchParams.delete('schema');
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(
      `ALTER TABLE content_media ADD CONSTRAINT "${constraint}" CHECK (external_id <> '${externalId}')`,
    );
  } finally {
    await client.end();
  }
  return async () => {
    const cleanup = new pg.Client({ connectionString: url.toString() });
    await cleanup.connect();
    try {
      await cleanup.query(`SET search_path TO "${schema}"`);
      await cleanup.query(`ALTER TABLE content_media DROP CONSTRAINT "${constraint}"`);
    } finally {
      await cleanup.end();
    }
  };
}
