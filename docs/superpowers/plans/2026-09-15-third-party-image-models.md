# 第三方图片渠道接入 GPT Image 2.5 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在共享模型目录中新增 `gpt-image-2.5-flare` 与 `gpt-image-2.5-sunburst` 两个型号，把第三方 Sub2API 渠道的单型号闸门改为按传输协议匹配，并修掉适配器写死模型 ID 造成的静默降级。

**Architecture:** 型号定义仍是单一定义源 `OFFICIAL_MODELS`。本批新增一个从协议映射派生的型号 ID 清单 `OPENAI_IMAGES_MODEL_IDS`，让配置 schema、运行期闸门、适配器白名单三处共用它，取代原先三处各自硬编码。执行路径不改：运行时按型号 `provider` 挑适配器，`upstreamModelId` 由执行快照透传，适配器把它写进请求体。

**Tech Stack:** TypeScript 5 / NestJS 12 / zod 4.5.4 / vitest 4。本批不涉及数据库迁移、Prisma schema 或前端。

**Spec:** `docs/superpowers/specs/2026-09-15-third-party-image-models-design.md`

## Global Constraints

- 合法型号 ID 只有 `gpt-image-2`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`。**不得**写入 `gpt-image-2.5`——该 ID 不存在。
- 显示名：`GPT Image 2`（不变）、`GPT Image 2.5-极速`、`GPT Image 2.5-精细`。
- 新增型号只允许改 `viviai-server/src/modules/providers/official-models.ts` 的定义表一处。
- 闸门判据：`OFFICIAL_PROTOCOLS[definition.provider] === OFFICIAL_PROTOCOLS.openai`。
- 第三方执行快照协议保持 `'openai-images-third-party-v1'`，型号协议是 `'openai-images-v1'`。两者语义不同（渠道身份 vs 传输契约），不得合并为同一个字符串。
- 不新增 `GEMINI_API_KEY` / `OPENAI_API_KEY` 通路，不修改 `viviai-server/src/config.ts` 的启动校验，不启用官方直连渠道。
- 不改支付、结算、账本、报价链路与 `viviai-web/`。
- 所有 Key 只来自进程环境；不得写进代码、JSON、文档示例或提交进 Git。
- 占位价格必须被标注为占位，不得声称经过成本核算。
- 集成测试需要数据库与 Redis。运行前设置：`DATABASE_URL='postgresql://viviai:viviai_dev_only@127.0.0.1:55432/viviai_dev' REDIS_URL='redis://127.0.0.1:6379'`。纯单元测试文件不需要。
- 本计划所有命令都在 `viviai-server/` 目录内执行。

---

### Task 1: 目录新增两个 2.5 型号，导出协议派生的型号清单

**Files:**
- Modify: `viviai-server/src/modules/providers/official-models.ts`
- Modify: `viviai-server/src/modules/providers/official-config.ts:54`
- Test: `viviai-server/test/official-config.test.ts`
- Test: `viviai-server/test/integration/admin-queries.test.ts:109`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  - `OPENAI_IMAGES_MODEL_IDS: readonly string[]` —— 从 `OFFICIAL_PROTOCOLS` 派生的 OpenAI Images 协议型号 ID 列表，本批等于 `['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']`。Task 2、Task 3、Task 4 都用它。
  - `officialSpecs('gpt-image-2.5-flare')` 与 `officialSpecs('gpt-image-2.5-sunburst')` 返回与 `officialSpecs('gpt-image-2')` 逐项相同的规格数组。

- [ ] **Step 1: 写失败测试**

编辑 `viviai-server/test/official-config.test.ts`。先改顶部 import，加入 `OPENAI_IMAGES_MODEL_IDS`：

```ts
import {
  OFFICIAL_MODELS,
  OFFICIAL_PROTOCOLS,
  OPENAI_IMAGES_MODEL_IDS,
  officialSpecs,
  getOfficialOutputSpec,
} from '../src/modules/providers/official-models.js';
```

把第 43–44 行的用例名与断言改为七个：

```ts
  it('contains seven distinct exact IDs, and published model-specific dimensions', () => {
    expect(OFFICIAL_MODELS.map((m) => m.id)).toHaveLength(7);
```

在同一个用例内、`expect(getOfficialOutputSpec('gpt-image-2', 'arbitrary')).toBeUndefined();` 这一行之前插入 2.5 的断言：

```ts
    // Both 2.5 IDs reuse the reviewed GPT Image 2 preset table verbatim, so the
    // div16 / aspect / pixel-bound loop above covers them by construction.
    for (const id of ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'] as const) {
      expect(officialSpecs(id)).toEqual(officialSpecs('gpt-image-2'));
    }
    expect(
      OFFICIAL_MODELS.filter((m) => m.provider === 'openai').map((m) => [m.id, m.name]),
    ).toEqual([
      ['gpt-image-2', 'GPT Image 2'],
      ['gpt-image-2.5-flare', 'GPT Image 2.5-极速'],
      ['gpt-image-2.5-sunburst', 'GPT Image 2.5-精细'],
    ]);
```

在同一个 `describe` 块内新增一个用例，锁住"协议派生清单"这个接口：

```ts
  it('derives the OpenAI Images model list from the protocol map, not a second hand-written list', () => {
    expect(OPENAI_IMAGES_MODEL_IDS).toEqual([
      'gpt-image-2',
      'gpt-image-2.5-flare',
      'gpt-image-2.5-sunburst',
    ]);
    // A derived ID that has no specs would be advertised by the gate and then fail at
    // execution. Every member must be servable.
    for (const id of OPENAI_IMAGES_MODEL_IDS) expect(officialSpecs(id).length).toBeGreaterThan(0);
  });
```

在文件最后一个 `});` 之前新增官方配置容量用例：

```ts
  it('accepts one entry per catalog model, so the catalog size does not cap official configuration', () => {
    const base = fixtureConfig();
    const account = base.accounts.openai;
    const rates = { ...base.models[0]!.pricing.rates, thought_tokens: '5000000' };
    const settings = {
      revision: 'offline-seven',
      accounts: { google: { ...account, scope: 'test-google' }, openai: account },
      models: OFFICIAL_MODELS.map((definition) => ({
        modelId: definition.id,
        enabledResolutions: ['1K'],
        reserveCostMicros: '1000000',
        pricing: { ...base.models[0]!.pricing, rates },
      })),
    };
    const loaded = loadOfficialConfig({
      OFFICIAL_IMAGE_MODELS_JSON: JSON.stringify(settings),
      OPENAI_API_KEY: 'offline-key',
      GEMINI_API_KEY: 'offline-key',
    });
    expect(loaded.models.map((m) => m.modelId)).toEqual(OFFICIAL_MODELS.map((d) => d.id));
  });
```

再更新管理后台的集成测试 `viviai-server/test/integration/admin-queries.test.ts:109`——`models()` 直接遍历 `OFFICIAL_MODELS`，目录从 5 变 7 会让它失败：

```ts
  it('shows all seven model definitions as disabled without claiming live verification', async () => {
    const response = await get('models');
    expect(response.body.data.rows).toHaveLength(7);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd viviai-server && npx vitest run test/official-config.test.ts`
Expected: FAIL —— `expected [ …(5) ] to have a length of 7 but got 5`，另有 `OPENAI_IMAGES_MODEL_IDS` 导入报错。

Run: `cd viviai-server && DATABASE_URL='postgresql://viviai:viviai_dev_only@127.0.0.1:55432/viviai_dev' REDIS_URL='redis://127.0.0.1:6379' npx vitest run test/integration/admin-queries.test.ts`
Expected: FAIL —— `expected [ …(5) ] to have a length of 7 but got 5`。

- [ ] **Step 3: 实现**

编辑 `viviai-server/src/modules/providers/official-models.ts`。把 `OFFICIAL_MODELS`（第 4–15 行）替换为：

```ts
export const OFFICIAL_MODELS = [
  { id: 'gemini-2.5-flash-image', name: 'Nano Banana', provider: 'google', maxImages: 2 },
  {
    id: 'gemini-3.1-flash-lite-image',
    name: 'Nano Banana 2 Lite',
    provider: 'google',
    maxImages: 1,
  },
  { id: 'gemini-3.1-flash-image', name: 'Nano Banana 2', provider: 'google', maxImages: 2 },
  { id: 'gemini-3-pro-image', name: 'Nano Banana Pro', provider: 'google', maxImages: 2 },
  { id: 'gpt-image-2', name: 'GPT Image 2', provider: 'openai', maxImages: 2 },
  // OpenAI splits this generation into a fast tier and a capability tier; there is no bare
  // `gpt-image-2.5` API id. Both speak the Images REST contract and reuse the reviewed
  // preset table below, so only these two lines are new.
  { id: 'gpt-image-2.5-flare', name: 'GPT Image 2.5-极速', provider: 'openai', maxImages: 2 },
  { id: 'gpt-image-2.5-sunburst', name: 'GPT Image 2.5-精细', provider: 'openai', maxImages: 2 },
] as const;
export type OfficialModelId = (typeof OFFICIAL_MODELS)[number]['id'];
export const OFFICIAL_PROTOCOLS = {
  google: 'google-interactions-v1',
  openai: 'openai-images-v1',
} as const;
// Which models a transport contract can actually carry. Derived rather than hand-written so
// that adding a model to OFFICIAL_MODELS is the only edit required; a second list would drift.
export const OPENAI_IMAGES_MODEL_IDS: readonly string[] = OFFICIAL_MODELS.filter(
  (model) => OFFICIAL_PROTOCOLS[model.provider] === OFFICIAL_PROTOCOLS.openai,
).map((model) => model.id);
```

把 `officialSpecs` 里按单个 ID 判断的 OpenAI 分支（原第 93–96 行）改为按协议判断：

```ts
  if (OPENAI_IMAGES_MODEL_IDS.includes(modelId))
    return openaiRows.flatMap(([ratio, ...sizes]) =>
      sizes.map((size, i) => spec(['1K', '2K', '4K'][i]!, ratio, size)),
    );
```

同时更新文件顶部第 1 行的核验注释：

```ts
// Verified 2026-09-09, OpenAI 2.5 family re-verified 2026-09-15: ai.google.dev/gemini-api/docs/image-generation,
// developers.openai.com/api/docs/guides/image-generation, .../models/gpt-image-2.5-sunburst.
```

编辑 `viviai-server/src/modules/providers/official-config.ts:54`，把上限绑到目录长度而不是写死 5：

```ts
    models: z.array(model).max(OFFICIAL_MODELS.length),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd viviai-server && npx vitest run test/official-config.test.ts`
Expected: PASS。

Run: `cd viviai-server && DATABASE_URL='postgresql://viviai:viviai_dev_only@127.0.0.1:55432/viviai_dev' REDIS_URL='redis://127.0.0.1:6379' npx vitest run test/integration/admin-queries.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd viviai-server
git add src/modules/providers/official-models.ts src/modules/providers/official-config.ts test/official-config.test.ts test/integration/admin-queries.test.ts
git commit -m "feat(models): add the GPT Image 2.5 family to the shared catalog"
```

---

### Task 2: 第三方渠道闸门改为按协议匹配

**Files:**
- Modify: `viviai-server/src/modules/providers/third-party-config.ts`（import、接口第 21–26 行、schema 第 88–96 行、闸门第 261–262 行）
- Test: `viviai-server/test/third-party-image.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `OPENAI_IMAGES_MODEL_IDS`、`OFFICIAL_PROTOCOLS`。
- Produces:
  - `ThirdPartyImageModelConfig.modelId` 类型由字面量 `'gpt-image-2'` 放宽为 `string`（schema 是真正的强制点）。
  - `loadThirdPartyImageConfig` 接受任意 OpenAI Images 协议型号，继续拒绝 `gemini-*`。
  - `thirdPartyImageSnapshot` 返回的 `upstreamModelId` 等于传入的型号 ID。

- [ ] **Step 1: 写失败测试**

编辑 `viviai-server/test/third-party-image.test.ts`。先在顶部 import 加入 `OPENAI_IMAGES_MODEL_IDS`：

```ts
import { OPENAI_IMAGES_MODEL_IDS } from '../src/modules/providers/official-models.js';
```

在 `describe('Sub2API third-party image channel', …)` 块内、`maps GPT Image 2 generation to the configured Sub2API base URL without a live call` 之前插入两个用例：

```ts
  it('accepts every OpenAI Images model and still refuses a Google-protocol model', () => {
    const config = loadThirdPartyImageConfig({
      ...baseEnv,
      SUB2API_IMAGE_MODELS_JSON: JSON.stringify({
        revision: 'sub2api-image-v2',
        models: OPENAI_IMAGES_MODEL_IDS.map((modelId) => ({
          modelId,
          enabledResolutions: ['1K', '2K'],
          reserveCostMicros: '1000000',
          pricing: {
            version: 'sub2api-cost-v1',
            currency: 'USD',
            rates: {
              input_text_tokens: '5000000',
              input_image_tokens: '10000000',
              output_image_tokens: '30000000',
              output_text_tokens: '5000000',
            },
          },
        })),
      }),
    })!;
    expect(config.models.map((model) => model.modelId)).toEqual([...OPENAI_IMAGES_MODEL_IDS]);
    expect(thirdPartyImageSnapshot(config, 'gpt-image-2.5-sunburst', '2K', '16:9')).toMatchObject({
      provider: 'openai',
      protocol: 'openai-images-third-party-v1',
      upstreamModelId: 'gpt-image-2.5-sunburst',
      width: 2048,
      height: 1152,
      reserveCostMicros: '1000000',
    });
    // Refusal is about the protocol the model needs, not about the channel it was asked for.
    expect(thirdPartyImageSnapshot(config, 'gemini-3.1-flash-image', '1K', '1:1')).toBeUndefined();
    const forged = JSON.parse(baseEnv.SUB2API_IMAGE_MODELS_JSON);
    forged.models[0].modelId = 'gemini-3.1-flash-image';
    expect(() =>
      loadThirdPartyImageConfig({
        ...baseEnv,
        SUB2API_IMAGE_MODELS_JSON: JSON.stringify(forged),
      }),
    ).toThrow(/SUB2API_IMAGE_MODELS_JSON/i);
  });

  it('keeps the runtime gate closed even if a Google-protocol model reaches the config object', () => {
    const config = loadThirdPartyImageConfig(baseEnv)!;
    // Shape-bypass on purpose: the schema is the first gate, this asserts the second one.
    const forged = {
      ...config,
      models: [...config.models, { ...config.models[0]!, modelId: 'gemini-3.1-flash-image' }],
    };
    expect(
      thirdPartyImageSnapshot(forged, 'gemini-3.1-flash-image', '1K', '1:1'),
    ).toBeUndefined();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd viviai-server && npx vitest run test/third-party-image.test.ts`
Expected: FAIL —— 第一个新用例在 `loadThirdPartyImageConfig` 处抛 `Invalid SUB2API_IMAGE_MODELS_JSON`（`z.literal('gpt-image-2')` 拒绝了 2.5）。第二个新用例当前会通过（旧闸门也是按 ID 卡的），这正是它要长期守住的性质。

- [ ] **Step 3: 实现**

编辑 `viviai-server/src/modules/providers/third-party-config.ts`。

import（第 3 行）改为：

```ts
import {
  OFFICIAL_MODELS,
  OFFICIAL_PROTOCOLS,
  OPENAI_IMAGES_MODEL_IDS,
  officialSpecs,
  type OfficialModelId,
} from './official-models.js';
```

接口（第 21–26 行）放宽类型：

```ts
export interface ThirdPartyImageModelConfig {
  // Widened from the literal 'gpt-image-2': the schema admits every model whose transport
  // contract is OpenAI Images. The runtime gate in thirdPartyImageSnapshot re-checks it.
  readonly modelId: string;
  readonly enabledResolutions: readonly string[];
  readonly reserveCostMicros: string;
  readonly pricing: PriceSnapshot;
}
```

schema 里的 `modelId`（第 88–92 行，连同它上面的注释）改为：

```ts
            // Sub2API is wired to the OpenAI Images contract, so it carries exactly the models
            // whose protocol is openai-images-v1. Gemini/Nano Banana needs the Google
            // Interactions contract unless a third-party contract is separately verified;
            // accepting that ID here would produce a false capability.
            modelId: z.enum([...OPENAI_IMAGES_MODEL_IDS]),
```

`thirdPartyImageSnapshot` 的闸门（第 261–262 行）改为：

```ts
  const definition = OFFICIAL_MODELS.find((item) => item.id === modelId);
  // Gate on the protocol the model needs, not on one hard-coded model ID.
  if (!definition || OFFICIAL_PROTOCOLS[definition.provider] !== OFFICIAL_PROTOCOLS.openai) return;
```

同文件的 `.max(5)`（第三方 schema 的 models 数组上限）**不动**：OpenAI 协议型号当前只有 3 个，上限 5 尚未触及；等它真的成为约束时再绑到 `OPENAI_IMAGES_MODEL_IDS.length`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd viviai-server && npx vitest run test/third-party-image.test.ts`
Expected: PASS（含原有的 `rejects a Nano Banana model in an OpenAI Images-only third-party config`）。

- [ ] **Step 5: 提交**

```bash
cd viviai-server
git add src/modules/providers/third-party-config.ts test/third-party-image.test.ts
git commit -m "feat(providers): gate the third-party channel on protocol, not on one model id"
```

---

### Task 3: 适配器把 upstreamModelId 写进请求体

> 这一步是 Spec 第 5 节的前置修复。只做 Task 1 和 Task 2 的话，前端会列出 2.5 型号，而上游收到的仍是 `model: gpt-image-2`——静默降级，不报错。

**Files:**
- Modify: `viviai-server/src/modules/providers/official/openai.ts:31, 70-71, 77-78, 88`
- Test: `viviai-server/test/official-adapters.test.ts`（helper 第 87 行 + 新增两个用例）

**Interfaces:**
- Consumes: Task 1 的 `OPENAI_IMAGES_MODEL_IDS`；Task 2 保证快照的 `upstreamModelId` 是真实型号 ID。
- Produces: `OpenAIImageProvider.validate` / `.submit` 接受全部 OpenAI Images 协议型号，发出的请求体 `model` 等于 `request.upstreamModelId`，不再有 `'gpt-image-2'` 字面量。

- [ ] **Step 1: 写失败测试**

编辑 `viviai-server/test/official-adapters.test.ts`。第 87 行的 helper 目前只给 `gpt-image-2` 补 `quality`，改为按型号族判断：

```ts
      ...(upstreamModelId.startsWith('gpt-image-') ? { quality: 'medium' as const } : {}),
```

在 `describe('OpenAI Images REST adapter', …)` 块内新增两个用例：

```ts
  it('sends the selected model ID upstream instead of the adapter default', async () => {
    const http = fakeFetch((_url, init) => {
      expect(JSON.parse(String(init.body))).toMatchObject({
        model: 'gpt-image-2.5-sunburst',
        size: '1024x1024',
        quality: 'medium',
        output_format: 'png',
      });
      return jsonResponse(openaiSuccess(squarePng));
    });
    const provider = new OpenAIImageProvider(new PrivateStore(), 'openai-secret', http.fetcher);

    const completed = await outputBytes(
      await provider.submit(request('gpt-image-2.5-sunburst'), context()),
    );

    expect(http.calls).toHaveLength(1);
    expect(completed.bytes).toEqual(squarePng);
  });

  it('rejects a Google-protocol model ID before any network call', async () => {
    const http = fakeFetch(() => jsonResponse(openaiSuccess(squarePng)));
    const provider = new OpenAIImageProvider(new PrivateStore(), 'openai-secret', http.fetcher);
    // Supply the quality field explicitly: without it the quality guard would reject first and
    // this test would stop proving anything about the model-ID allow-list.
    const wrongProtocol = request('gemini-3.1-flash-image', {
      output: {
        width: 1024,
        height: 1024,
        format: 'png',
        quality: 'medium',
        allowedNativeDimensions: [{ width: 1024, height: 1024 }],
      },
    });

    expect(() => provider.validate(wrongProtocol)).toThrow(/unsupported model/i);
    expect(await provider.submit(wrongProtocol, context())).toMatchObject({
      kind: 'rejected',
      failure: { code: 'unsupported' },
    });
    expect(http.calls).toHaveLength(0);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd viviai-server && npx vitest run test/official-adapters.test.ts`
Expected: FAIL —— 第一个新用例收到 `model: 'gpt-image-2'`，`toMatchObject` 报 `model: "gpt-image-2.5-sunburst"` 不匹配。这是静默降级的直接证据。

- [ ] **Step 3: 实现**

编辑 `viviai-server/src/modules/providers/official/openai.ts`。

import（第 2 行）改为：

```ts
import { OFFICIAL_PROTOCOLS, OPENAI_IMAGES_MODEL_IDS } from '../official-models.js';
```

删除第 31 行的写死白名单：

```ts
const OPENAI_MODEL = ['gpt-image-2'] as const;
```

`validate`（第 69–72 行）改为：

```ts
  validate(request: NormalizedImageRequest, _context?: ProviderContext) {
    if (request.output.quality !== 'medium')
      throw new Error('The OpenAI Images contract requires medium quality');
    validateOfficialRequest(request, OPENAI_IMAGES_MODEL_IDS, 2);
  }
```

`submit` 开头的校验（第 77–78 行）改为：

```ts
      if (request.output.quality !== 'medium')
        throw new Error('The OpenAI Images contract requires medium quality');
      spec = validateOfficialRequest(request, OPENAI_IMAGES_MODEL_IDS, 2);
```

请求体（第 88 行）改为透传快照里的型号 ID：

```ts
      model: request.upstreamModelId,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd viviai-server && npx vitest run test/official-adapters.test.ts`
Expected: PASS（含原有的四条 OpenAI 用例，它们断言 `model: 'gpt-image-2'`，此时 `upstreamModelId` 本就是它）。

- [ ] **Step 5: 提交**

```bash
cd viviai-server
git add src/modules/providers/official/openai.ts test/official-adapters.test.ts
git commit -m "fix(providers): send the snapshot model id to the OpenAI Images endpoint"
```

---

### Task 4: 运行时与目录按三型号端到端验证

**Files:**
- Modify: `viviai-server/test/third-party-image-runtime.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `OPENAI_IMAGES_MODEL_IDS`；Task 2 的放宽闸门；Task 3 的透传。
- Produces: 无新接口。这是本批的端到端验收，覆盖 Spec 第 10 节"目录列出三个型号"与"每个配置型号注册一条渠道"。

- [ ] **Step 1: 写失败测试**

编辑 `viviai-server/test/third-party-image-runtime.test.ts`。顶部加 import，并把 `imageEnv` 的单一型号改成三型号：

```ts
import { OPENAI_IMAGES_MODEL_IDS } from '../src/modules/providers/official-models.js';
```

```ts
  SUB2API_IMAGE_MODELS_JSON: JSON.stringify({
    revision: 'runtime-v1',
    models: OPENAI_IMAGES_MODEL_IDS.map((modelId) => ({
      modelId,
      enabledResolutions: ['1K'],
      reserveCostMicros: '1000000',
      pricing: {
        version: 'runtime-cost-v1',
        currency: 'USD',
        rates: {
          input_text_tokens: '1',
          input_image_tokens: '1',
          output_image_tokens: '1',
        },
      },
    })),
  }),
```

把两个用例替换为：

```ts
  it('registers one channel per configured preset for every OpenAI Images model', () => {
    const registry = buildProviderRegistry(config(), new EmptyStore(), viFetch());

    // 3 models × 10 reviewed 1K presets.
    expect(registry.channels).toHaveLength(30);
    expect(
      registry.channels.every(
        (channel) => channel.adapter.protocol === 'openai-images-third-party-v1',
      ),
    ).toBe(true);
    for (const modelId of OPENAI_IMAGES_MODEL_IDS) {
      const square = registry.channels.find(
        (channel) =>
          channel.profile.productVersion === modelId &&
          channel.profile.outputSpecId === 'png-1k-1x1-v1',
      );
      expect(square?.profile).toMatchObject({
        productVersion: modelId,
        upstreamModelId: modelId,
        outputSpecId: 'png-1k-1x1-v1',
        width: 1024,
        height: 1024,
        baseUrl: 'http://localhost:8080/v1',
        quotaScope: 'third-party-sub2api-sub2api-default',
      });
    }
  });

  it('exposes every third-party model through the normal catalog and quote snapshot path', async () => {
    const service = new CatalogService(
      {
        client: {
          modelCreditPrice: {
            findMany: async () =>
              OPENAI_IMAGES_MODEL_IDS.map((modelId) => ({
                modelId,
                resolution: '1K',
                unitCredits: 88,
                enabled: true,
              })),
          },
        },
      } as never,
      config(),
    );

    const models = await service.models();
    expect(models.map((model) => model.name)).toEqual([
      'GPT Image 2',
      'GPT Image 2.5-极速',
      'GPT Image 2.5-精细',
    ]);
    expect(models).toEqual(
      OPENAI_IMAGES_MODEL_IDS.map((modelId) =>
        expect.objectContaining({
          id: modelId,
          resolutions: ['1K'],
          ratios: expect.arrayContaining(['1:1']),
          unitCredits: 88,
        }),
      ),
    );
    expect(
      service.execution(
        normalizeInput({
          modelId: 'gpt-image-2.5-sunburst',
          resolution: '1K',
          ratio: '1:1',
          prompt: 'blue house',
          count: 1,
        }),
      ),
    ).toMatchObject({
      protocol: 'openai-images-third-party-v1',
      channelId: expect.stringContaining('third-party-sub2api'),
    });
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd viviai-server && npx vitest run test/third-party-image-runtime.test.ts`
Expected: FAIL —— 渠道数仍是 10（不是 30），目录仍只列出 `gpt-image-2`。若 Task 2 只做了一半（例如改了 schema 没改运行期闸门），这里会表现为渠道数 10 而配置已含三型号。

- [ ] **Step 3: 实现**

无需改产品代码。前三个任务已提供全部行为；若本步失败，说明 Task 1–3 有遗漏，回到对应任务修正，不要在此处打补丁。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd viviai-server && npx vitest run test/third-party-image-runtime.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd viviai-server
git add test/third-party-image-runtime.test.ts
git commit -m "test(providers): cover the three-model third-party channel end to end"
```

---

### Task 5: 文档与联调说明

**Files:**
- Modify: `viviai-server/OFFICIAL_MODELS.md:5, 17, 19, 27, 33, 47, 50, 53`
- Modify: `viviai-server/ADMIN.md:88`

**Interfaces:**
- Consumes: Task 1–4 已确定的型号 ID、显示名与闸门判据。
- Produces: 无代码接口。运营与联调人员按本文件配置 `SUB2API_IMAGE_MODELS_JSON`。

- [ ] **Step 1: 改 `OFFICIAL_MODELS.md`**

第 5 行的支持 ID 清单加入两个 2.5 ID，并把"第三方仅 gpt-image-2"的说法换成协议说法：

```
支持官方 ID：`gemini-2.5-flash-image`、`gemini-3.1-flash-lite-image`、`gemini-3.1-flash-image`、`gemini-3-pro-image`、`gpt-image-2`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`。官方通道不使用订阅账号代理或隐式型号升级；第三方 Sub2API 作为显式、独立的 OpenAI Images 渠道，承载协议为 `openai-images-v1` 的全部型号。注意 `gpt-image-2.5` 本身不是合法 API ID：该代拆为 `-flare`（极速）与 `-sunburst`（精细）两个 ID。
```

第 17 行的表加两行，放在 `GPT Image 2` 之后：

```
| GPT Image 2.5 极速 | 产品预设 1K / 2K；4K 横竖屏 | 1K/2K 10 种；4K 仅 16:9、9:16      |
| GPT Image 2.5 精细 | 产品预设 1K / 2K；4K 横竖屏 | 1K/2K 10 种；4K 仅 16:9、9:16      |
```

第 19 行末尾补一句：

```
两个 2.5 型号的尺寸约束与 GPT Image 2 逐条相同（边长 16 的倍数、宽高比 1:3–3:1、任一边 ≤3840、总像素 655,360–8,294,400），复用同一张预设表。
```

第 27 行的依据追加 2.5 的官方页与核验日期：

```
依据：[Google 生成指南](https://ai.google.dev/gemini-api/docs/image-generation)、[Lite 模型页](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite-image)、[OpenAI 生成接口](https://developers.openai.com/api/reference/typescript/resources/images/methods/generate)、[GPT Image 2](https://developers.openai.com/api/docs/models/gpt-image-2)、[GPT-Image-2.5 Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst)。Google 部分核验日期 2026-09-09，OpenAI 2.5 部分核验日期 2026-09-15。
```

第 33 行末尾的"当前第三方图片协议只接入 OpenAI Images 兼容的 `gpt-image-2`…"整句替换为：

```
第三方图片渠道承载的是"协议为 OpenAI Images"的型号，而不是某一个固定型号：`gpt-image-2`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst` 均在列；Nano Banana 需要 Google Interactions 协议，仍走官方 Google 通道，除非未来第三方明确提供并通过单独协议验收。
```

第 47 行与第 50 行的示例改为三型号，并保留占位声明：

```
如需把 OpenAI 协议型号作为第三方图片渠道，增加服务端配置（以下为占位值，不要把示例价格直接用于生产）：
```

```bash
SUB2API_IMAGE_MODELS_JSON='{"revision":"sub2api-images-v2","models":[{"modelId":"gpt-image-2","enabledResolutions":["1K","2K"],"reserveCostMicros":"1000000","pricing":{"version":"provider-cost-v1","currency":"USD","rates":{"input_text_tokens":"<per-million-micro-usd>","input_image_tokens":"<per-million-micro-usd>","output_image_tokens":"<per-million-micro-usd>"}}},{"modelId":"gpt-image-2.5-flare","enabledResolutions":["1K","2K"],"reserveCostMicros":"1000000","pricing":{"version":"provider-cost-v1","currency":"USD","rates":{"input_text_tokens":"<per-million-micro-usd>","input_image_tokens":"<per-million-micro-usd>","output_image_tokens":"<per-million-micro-usd>"}}},{"modelId":"gpt-image-2.5-sunburst","enabledResolutions":["1K","2K"],"reserveCostMicros":"1000000","pricing":{"version":"provider-cost-v1","currency":"USD","rates":{"input_text_tokens":"<per-million-micro-usd>","input_image_tokens":"<per-million-micro-usd>","output_image_tokens":"<per-million-micro-usd>"}}}]}'
```

第 53 行的验活说明改为按配置逐个型号：

```
`POST /api/admin/provider-accounts/sub2api/verify-image` 只请求 `/v1/models`，确认配置中每个型号 ID 都已列出，不会调用生图接口；实际生图仍需先完成小额联调和账单核对。
```

- [ ] **Step 2: 改 `ADMIN.md`**

第 88 行的"目录包含全部五个定义"改为：

```
目录包含全部七个定义
```

- [ ] **Step 3: 验证文档与代码一致**

Run: `cd viviai-server && grep -n "gpt-image-2.5" OFFICIAL_MODELS.md ADMIN.md`
Expected: 出现 `-flare` 与 `-sunburst`，且不出现裸 `gpt-image-2.5`（后接非 `-` 字符）。

Run: `cd viviai-server && npx vitest run test/official-config.test.ts`
Expected: PASS（目录规模断言与文档一致）。

- [ ] **Step 4: 提交**

```bash
cd viviai-server
git add OFFICIAL_MODELS.md ADMIN.md
git commit -m "docs(providers): document the GPT Image 2.5 third-party models"
```

---

### Task 6: 全量校验

**Files:** 无改动。

- [ ] **Step 1: 类型检查**

Run: `cd viviai-server && npm run typecheck`
Expected: PASS，无输出错误。

- [ ] **Step 2: 全量测试**

Run: `cd viviai-server && DATABASE_URL='postgresql://viviai:viviai_dev_only@127.0.0.1:55432/viviai_dev' REDIS_URL='redis://127.0.0.1:6379' npm test`
Expected: PASS，0 failures。

- [ ] **Step 3: 记录剩余的人工步骤**

不需要提交代码，向用户报告两件必须在部署前完成的事：

1. 由用户本人把 `SUB2API_ENABLED`、`SUB2API_BASE_URL`、`SUB2API_API_KEY`、`SUB2API_IMAGE_MODELS_JSON` 填进 `viviai-server/.env`。Key 不要贴进对话，不要提交 Git。
2. 确认 Sub2API 具备 HTTPS 入口。第三方渠道在开发环境允许 `http://localhost`，生产环境强制 HTTPS；若只有内网 http 入口，生产环境将拒绝启动该渠道。这是 Spec 第 6 节记录的部署前置条件，本批不放宽。
3. 对客积分仍是占位值，需在运营后台 `/model-pricing` 按实际成本调整。没有价格记录的分辨率不会出现在公开目录。

---

## 设计自审

- **Spec 覆盖**：第 3 节（型号与档位）→ Task 1；第 4 节（协议闸门）→ Task 2；第 5 节（适配器不写死）→ Task 3；第 6 节（环境一致性）→ Task 6 Step 3 与 Global Constraints；第 7 节（价格占位）→ Task 5 文档措辞；第 10 节（验收标准）→ Task 4 加 Task 6。第 8 节"明确不做"未出现在任何任务中，符合预期。
- **本计划新增的一项**：`official-config.ts` 的 `models` 上限从 `5` 绑到 `OFFICIAL_MODELS.length`，并更新 `test/integration/admin-queries.test.ts` 的目录行数。这两处不由 Spec 直接要求，但目录从 5 变 7 会让它们成为不实断言：官方配置会被一个小于目录的上限卡住，管理后台的行数断言会失败。已在 Task 1 内一并处理并给出测试。
- **未改动**：第三方 schema 的 `.max(5)`。OpenAI 协议型号当前 3 个，上限尚未触及；提前放宽是无测试的行为变更。
- **类型一致性**：`OPENAI_IMAGES_MODEL_IDS` 在 Task 1 定义，Task 2/3/4 均按同一名字与类型 `readonly string[]` 使用。Task 2 之后 `ThirdPartyImageModelConfig.modelId` 是 `string`，`thirdPartyImageSnapshot` 里既有的 `modelId as OfficialModelId` 断言仍成立。
- **zod 用法已验证**：`z.enum([...OPENAI_IMAGES_MODEL_IDS])` 在 zod 4.5.4 下通过 `tsc --strict` 且运行期拒绝非成员值；`z.enum` 需要可变数组，故用展开而非直接传只读数组。
- **静默降级**：Task 3 必须先于任何启用动作完成。Task 3 Step 2 明确要求观察到 `model: 'gpt-image-2'` 的失败证据，而不是只改代码。
