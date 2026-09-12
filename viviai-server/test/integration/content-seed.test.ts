import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '../../src/generated/prisma/client.js';
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
    expect(first.cleanupWarnings).toEqual([]);
    expect(second.cleanupWarnings).toEqual([]);
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
    await new Promise((resolve) => setImmediate(resolve));
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
    const manifest = structuredClone(contentSeedManifest);
    manifest.media[0]!.externalId = 'content-media-rollback-retry';
    manifest.media = [manifest.media[0]!];
    manifest.inspirations = [];
    manifest.templates = [];
    manifest.tools = [];
    const events: string[] = [];
    let releasePut: (() => void) | undefined;
    let enteredPut: (() => void) | undefined;
    const firstPut = new Promise<void>((resolve) => {
      enteredPut = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    const orderedStore: ObjectStore = {
      get: (key) => storage.store.get(key),
      delete: async (key) => {
        events.push('delete');
        await storage.store.delete(key);
      },
      put: async (key, bytes, contentType) => {
        events.push('put');
        if (events.filter((event) => event === 'put').length === 1) {
          enteredPut!();
          await release;
        }
        await storage.store.put(key, bytes, contentType);
      },
    };
    const failing = seedContent(database.database, orderedStore, {
      manifest,
      beforeTransaction: () => {
        throw new Error('injected transaction failure');
      },
    });
    await firstPut;
    const retry = seedContent(database.database, orderedStore, { manifest });
    releasePut!();
    await expect(failing).rejects.toThrow('injected transaction failure');
    await retry;
    expect(events).toEqual(['put', 'delete', 'put']);
    const media = await database.database.client.contentMedia.findUniqueOrThrow({
      where: { externalId: manifest.media[0]!.externalId },
    });
    expect(await storage.store.get(media.objectKey)).toHaveLength(media.byteSize);
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
    const manifest = structuredClone(contentSeedManifest);
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
    manifest.media[0]!.colors = ['#102030', '#405060', '#708090'];
    await seedContent(database.database, storage.store, { manifest });
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
    await seedContent(database.database, storage.store, { manifest });
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
    const manifest = structuredClone(contentSeedManifest);
    manifest.media.push({ ...manifest.media[0]!, externalId: 'content-media-cleanup' });
    manifest.inspirations[0]!.coverMediaExternalId = 'content-media-cleanup';
    await expect(
      seedContent(database.database, storage.store, {
        manifest,
        beforeTransaction: () => {
          throw new Error('injected database failure');
        },
      }),
    ).rejects.toThrow('injected database failure');
    await expect(
      database.database.client.contentMedia.findUnique({
        where: { externalId: 'content-media-cleanup' },
      }),
    ).resolves.toBeNull();
  });

  it('reports a safe cleanup warning count when rollback object cleanup also fails', async () => {
    const manifest = structuredClone(contentSeedManifest);
    manifest.media.push({ ...manifest.media[0]!, externalId: 'content-media-cleanup-warning' });
    manifest.inspirations[0]!.coverMediaExternalId = 'content-media-cleanup-warning';
    const failingCleanupStore: ObjectStore = {
      get: (key) => storage.store.get(key),
      put: (key, bytes, contentType) => storage.store.put(key, bytes, contentType),
      delete: async () => {
        throw new Error('injected delete failure');
      },
    };

    await expect(
      seedContent(database.database, failingCleanupStore, {
        manifest,
        beforeTransaction: () => {
          throw new Error('injected database failure');
        },
      }),
    ).rejects.toMatchObject({
      name: SeedCleanupError.name,
      warningCount: 1,
      message: 'Content seed failed with 1 cleanup warning(s)',
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
      'mock-visual-1.png (content-media-visual-1) failed: object store read is unavailable',
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
