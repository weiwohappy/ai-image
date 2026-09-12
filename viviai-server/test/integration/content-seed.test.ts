import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { createTestStorage } from '../helpers/storage.js';
import {
  contentSeedManifest,
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
    await seedContent(database.database, storage.store);
    const first = await snapshot();

    await seedContent(database.database, storage.store);
    expect(await snapshot()).toEqual(first);
    expect(first.media).not.toHaveLength(0);
    expect(first.inspirations).toHaveLength(contentSeedManifest.inspirations.length);
    expect(first.templates).toHaveLength(contentSeedManifest.templates.length);
    expect(first.tools).toHaveLength(contentSeedManifest.tools.length);
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
