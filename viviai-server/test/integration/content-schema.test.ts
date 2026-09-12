import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';

describe('operational content schema', () => {
  let database: TestDatabase;
  let userId: string;
  let adminId: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    const db = database.database.client;
    userId = (
      await db.user.create({
        data: {
          email: 'content-user@example.test',
          username: 'content-user',
          passwordHash: 'test',
        },
      })
    ).id;
    adminId = (
      await db.adminAccount.create({
        data: {
          email: 'content-admin@example.test',
          displayName: 'Content admin',
          passwordHash: 'test',
          encryptedMfaSecret: 'test-secret',
        },
      })
    ).id;
  });

  afterAll(async () => {
    await database?.cleanup();
  });

  const mediaInput = (suffix: string) => ({
    externalId: `media-${suffix}`,
    objectKey: `content/${suffix}.png`,
    sha256: 'a'.repeat(64),
    contentType: 'image/png',
    width: 1200,
    height: 800,
    byteSize: 1024,
    createdByAdminId: adminId,
    updatedByAdminId: adminId,
  });

  const toolInput = (suffix: string) => ({
    externalId: `tool-${suffix}`,
    name: 'Test tool',
    description: 'A test tool',
    category: 'Test',
    creatorName: 'Content team',
    sourceType: 'licensed-user',
    sourceName: 'Test source',
    fieldSchema: [],
    promptTemplate: 'Make {{subject}} useful',
    defaults: { modelId: 'gemini-2.5-flash-image', resolution: '1K', ratio: '1:1', count: 1 },
    maxAssets: 1,
    maxOutputCount: 1,
    assetLabel: 'Reference image',
    defaultModelId: 'gemini-2.5-flash-image',
    defaultOutputSpecId: '1K-1:1',
  });

  it('keeps operational media separate while relating covers and reference images to content', async () => {
    const db = database.database.client;
    const media = await db.contentMedia.create({ data: mediaInput('hero') });
    const inspiration = await db.inspiration.create({
      data: {
        externalId: 'inspiration-hero',
        title: 'Hero inspiration',
        description: 'A test inspiration',
        category: 'Test',
        creatorName: 'Content team',
        sourceType: 'licensed-user',
        sourceName: 'Test source',
        tags: ['featured'],
        defaultPrompt: 'A hero image',
        defaultModelId: 'gemini-2.5-flash-image',
        defaultOutputSpecId: '1K-1:1',
        coverMediaId: media.id,
        createdByAdminId: adminId,
        updatedByAdminId: adminId,
      },
    });
    const template = await db.remixTemplate.create({
      data: {
        externalId: 'template-hero',
        title: 'Hero template',
        description: 'A test template',
        category: 'Test',
        platform: 'Test platform',
        industry: 'Test industry',
        style: 'Test style',
        sourceType: 'licensed-user',
        sourceName: 'Test source',
        tags: ['featured'],
        visualAnalysis: { composition: 'centered' },
        defaultPrompt: 'Remix this image',
        defaultParameters: { strength: 'balanced' },
        defaultModelId: 'gemini-2.5-flash-image',
        defaultOutputSpecId: '1K-1:1',
        coverMediaId: media.id,
        referenceMediaId: media.id,
        createdByAdminId: adminId,
        updatedByAdminId: adminId,
      },
    });
    const tool = await db.toolDefinition.create({
      data: {
        ...toolInput('hero'),
        coverMediaId: media.id,
        iconMediaId: media.id,
        createdByAdminId: adminId,
        updatedByAdminId: adminId,
      },
    });

    expect(inspiration.coverMediaId).toBe(media.id);
    expect(template).toMatchObject({ coverMediaId: media.id, referenceMediaId: media.id });
    expect(tool).toMatchObject({ coverMediaId: media.id, iconMediaId: media.id });

    const sql = new pg.Client({ connectionString: database.url });
    await sql.connect();
    try {
      const schema = new URL(database.url).searchParams.get('schema');
      if (!schema || !/^viviai_test_[a-f0-9]+$/.test(schema))
        throw new Error('Only owned test schemas');
      await sql.query(`SET search_path TO "${schema}"`);
      const foreignTables = await sql.query<{ table_name: string }>(
        `SELECT DISTINCT tc.table_name
           FROM information_schema.table_constraints tc
           JOIN information_schema.constraint_column_usage ccu
             ON tc.constraint_name = ccu.constraint_name AND tc.constraint_schema = ccu.constraint_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = current_schema()
            AND ccu.table_name = 'assets'`,
      );
      expect(foreignTables.rows).not.toContainEqual(
        expect.objectContaining({ table_name: 'content_media' }),
      );
      expect(foreignTables.rows).not.toContainEqual(
        expect.objectContaining({ table_name: 'inspirations' }),
      );
      expect(foreignTables.rows).not.toContainEqual(
        expect.objectContaining({ table_name: 'remix_templates' }),
      );
      expect(foreignTables.rows).not.toContainEqual(
        expect.objectContaining({ table_name: 'tool_definitions' }),
      );
    } finally {
      await sql.end();
    }
  });

  it('enforces stable external IDs, unique object keys, and one like or favorite per user', async () => {
    const db = database.database.client;
    const media = await db.contentMedia.create({ data: mediaInput('unique') });
    const inspiration = await db.inspiration.create({
      data: {
        externalId: 'inspiration-unique',
        title: 'Unique inspiration',
        description: 'A test inspiration',
        category: 'Test',
        creatorName: 'Content team',
        sourceType: 'licensed-user',
        sourceName: 'Test source',
        tags: [],
        defaultPrompt: 'A unique image',
        defaultModelId: 'gemini-2.5-flash-image',
        defaultOutputSpecId: '1K-1:1',
        coverMediaId: media.id,
      },
    });
    const template = await db.remixTemplate.create({
      data: {
        externalId: 'template-unique',
        title: 'Unique template',
        description: 'A test template',
        category: 'Test',
        platform: 'Test platform',
        industry: 'Test industry',
        style: 'Test style',
        sourceType: 'licensed-user',
        sourceName: 'Test source',
        tags: [],
        visualAnalysis: {},
        defaultPrompt: 'A unique template',
        defaultParameters: {},
        defaultModelId: 'gemini-2.5-flash-image',
        defaultOutputSpecId: '1K-1:1',
        referenceMediaId: media.id,
      },
    });
    const tool = await db.toolDefinition.create({ data: toolInput('unique') });
    await db.inspirationLike.create({ data: { userId, inspirationId: inspiration.id } });
    await expect(
      db.inspirationLike.create({ data: { userId, inspirationId: inspiration.id } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await db.remixTemplateFavorite.create({ data: { userId, remixTemplateId: template.id } });
    await expect(
      db.remixTemplateFavorite.create({ data: { userId, remixTemplateId: template.id } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      db.contentMedia.create({
        data: { ...mediaInput('duplicate-key'), objectKey: media.objectKey },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      db.contentMedia.create({
        data: { ...mediaInput('duplicate-external'), externalId: media.externalId },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      db.inspiration.create({
        data: {
          externalId: inspiration.externalId,
          title: 'Duplicate inspiration',
          description: 'A test inspiration',
          category: 'Test',
          creatorName: 'Content team',
          sourceType: 'licensed-user',
          sourceName: 'Test source',
          tags: [],
          defaultPrompt: 'A duplicate image',
          defaultModelId: 'gemini-2.5-flash-image',
          defaultOutputSpecId: '1K-1:1',
          coverMediaId: media.id,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      db.remixTemplate.create({
        data: {
          externalId: template.externalId,
          title: 'Duplicate template',
          description: 'A test template',
          category: 'Test',
          platform: 'Test platform',
          industry: 'Test industry',
          style: 'Test style',
          tags: [],
          visualAnalysis: {},
          defaultPrompt: 'A duplicate template',
          defaultParameters: {},
          defaultModelId: 'gemini-2.5-flash-image',
          defaultOutputSpecId: '1K-1:1',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      db.toolDefinition.create({
        data: { ...toolInput('duplicate'), externalId: tool.externalId },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('rejects invalid lifecycle, version, ordering, media dimensions, byte size, and product limits', async () => {
    const db = database.database.client;
    await expect(
      db.contentMedia.create({ data: { ...mediaInput('bad-status'), status: 'ready' } }),
    ).rejects.toThrow();
    await expect(
      db.contentMedia.create({ data: { ...mediaInput('bad-width'), width: 0 } }),
    ).rejects.toThrow();
    await expect(
      db.contentMedia.create({ data: { ...mediaInput('bad-bytes'), byteSize: 100_663_297 } }),
    ).rejects.toThrow();
    await expect(
      db.toolDefinition.create({ data: { ...toolInput('bad-assets'), maxAssets: 5 } }),
    ).rejects.toThrow();
    await expect(
      db.toolDefinition.create({ data: { ...toolInput('bad-output'), maxOutputCount: 5 } }),
    ).rejects.toThrow();
    await expect(
      db.toolDefinition.create({ data: { ...toolInput('bad-version'), version: 0 } }),
    ).rejects.toThrow();
    await expect(
      db.toolDefinition.create({ data: { ...toolInput('bad-sort'), sortOrder: -1 } }),
    ).rejects.toThrow();
  });

  it('creates stable status and sort indexes for every public catalog', async () => {
    const sql = new pg.Client({ connectionString: database.url });
    await sql.connect();
    try {
      const schema = new URL(database.url).searchParams.get('schema');
      if (!schema || !/^viviai_test_[a-f0-9]+$/.test(schema))
        throw new Error('Only owned test schemas');
      await sql.query(`SET search_path TO "${schema}"`);
      const indexes = await sql.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef
           FROM pg_indexes
          WHERE schemaname = current_schema()
            AND tablename IN ('inspirations', 'remix_templates', 'tool_definitions')`,
      );
      for (const table of ['inspirations', 'remix_templates', 'tool_definitions']) {
        const index = indexes.rows.find(
          (candidate) => candidate.indexname === `${table}_status_sort_order_id_idx`,
        );
        expect(index?.indexdef).toContain('(status, sort_order, id)');
      }
    } finally {
      await sql.end();
    }
  });
});
