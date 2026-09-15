# 第三方图片渠道：接入 GPT Image 2.5 并解除单型号闸门

日期：2026-09-15。状态：设计已确认，待实现。本设计**修订** `2026-09-09-official-image-models-design.md` 中"不升级成 2.5"的决定，见第 9 节。

## 1. 目标与已确认规则

在现有第三方图片渠道（Sub2API，OpenAI Images 兼容）上新增两个型号，并把该渠道硬编码的单型号闸门改为"按协议匹配"。已确认的规则：

- 新增 `gpt-image-2.5-flare` 与 `gpt-image-2.5-sunburst` 两个型号，与既有 `gpt-image-2` 并存，共三个。
- 前端显示名：`GPT Image 2`（不变）、`GPT Image 2.5-极速`、`GPT Image 2.5-精细`。
- 模型集合不再按渠道区分，但**按协议匹配**：一条渠道只能承载与其协议相同的型号。
- 开发、测试、生产使用同一份型号清单与档位。
- 对客积分先以占位值跑通，之后在运营后台 `/model-pricing` 调整。
- 本轮不使用官方 Google/OpenAI 直连渠道；用户仅有 Sub2API 凭据。

## 2. 范围与现状

模型定义是一份共享目录 `OFFICIAL_MODELS`，两条渠道都引用它，不存在按渠道分叉的模型表。差别在传输协议：

- 官方渠道按 `definition.provider` 选择适配器（`GoogleImageProvider` 协议 `google-interactions-v1`，`OpenAIImageProvider` 协议 `openai-images-v1`）。
- 第三方渠道固定使用 `OpenAIImageProvider`。

`thirdPartyImageSnapshot` 当前以 `definition.id !== 'gpt-image-2'` 作为运行期闸门，配置 schema 以 `z.literal('gpt-image-2')` 作为解析闸门，注释给出的理由是：把 Google 型号写进第三方配置会产出虚假能力。该判断成立——Google 型号需要 Interactions 协议，第三方渠道说的是 OpenAI Images 协议。

执行路径本身是泛型的：运行时遍历配置中的每个型号，`upstreamModelId` 透传，适配器由协议决定。因此本批不需要改动派发、注册表、前端或计费链路。

本批只修改 `viviai-server`，以及本功能的设计/计划文档。`viviai-web` 不需要改动：真实模式下它渲染 `GET /api/models` 返回的 `name`，没有硬编码型号表。

## 3. 型号与档位

| 产品 | 模型 ID | 协议 | 显示名 |
| --- | --- | --- | --- |
| GPT Image 2 | `gpt-image-2` | OpenAI Images REST | GPT Image 2 |
| GPT Image 2.5 极速 | `gpt-image-2.5-flare` | OpenAI Images REST | GPT Image 2.5-极速 |
| GPT Image 2.5 精细 | `gpt-image-2.5-sunburst` | OpenAI Images REST | GPT Image 2.5-精细 |

两个 2.5 型号复用现有 `openaiRows` 预设表：官方给出的尺寸约束（边长为 16 的倍数、宽高比 1:3–3:1、任一边 ≤3840、总像素 655,360–8,294,400、超过 2560×1440 为实验性）与 `gpt-image-2` 逐条相同，不新增像素表，不做枚举笛卡尔积。档位沿用 1K / 2K，4K 仅 16:9 与 9:16。

`maxImages` 取 2，与 `gpt-image-2` 一致。官方 2.5 文档只声明支持编辑与 inpaint，未给出参考图数量上限；若实际受限，此为单点数值调整。

`quality` 继续固定 `medium`。官方 2.5 新增 `xhigh` / `max` 档，但产品侧不暴露质量档，本批不扩大输入 schema。

## 4. 闸门：按协议匹配

判据从"型号是否为 `gpt-image-2`"改为"型号的协议是否等于渠道的协议"：

```
模型可用于渠道 ⟺ OFFICIAL_PROTOCOLS[definition.provider] === 渠道协议
```

第三方渠道的协议取自 `OFFICIAL_PROTOCOLS.openai`。据此，三个 OpenAI 协议型号自动可用，`gemini-*` 因协议不匹配被拒——拒绝理由是协议，不是渠道。

这样做的收益：模型集合与渠道解耦（满足"模型不按渠道区分"），同时保住原有安全性质（不产生虚假能力）。今后新增 OpenAI 协议型号只需在 `OFFICIAL_MODELS` 增加一处定义，闸门与适配器白名单同步生效。

派生的型号 ID 列表在 `official-models.ts` 中定义一次，供配置 schema、运行期闸门与适配器白名单共用，避免三处各写一份。

## 5. 适配器：模型 ID 不得写死

现存的静默缺陷：`official/openai.ts` 以 `const OPENAI_MODEL = ['gpt-image-2']` 作为 `validateOfficialRequest` 的白名单，并在请求体写死 `model: 'gpt-image-2'`。若只放开目录与闸门，前端会列出 2.5 型号，而上游收到的仍是 `model: gpt-image-2`——静默降级为旧模型，不报错。这比直接失败更糟，必须先修。

改动两处：

- 白名单改为第 4 节派生的协议型号列表，使 `validateOfficialRequest` 接受三个型号。该校验本已使用 `request.upstreamModelId` 查规格，是模型参数化的，只有常量写死。
- 请求体 `model` 改为 `request.upstreamModelId`，由执行快照透传，不再使用字面量。

`quality: 'medium'` 保持不变（2.5 支持该档）；仅把"GPT Image 2 uses medium quality"这类措辞改为不绑定具体型号。

Google 适配器存在同类写死，但本批不触达 Google 型号，不改动。

## 6. 配置与环境一致性

开发、测试、生产使用同一份 `SUB2API_IMAGE_MODELS_JSON`，三个型号与档位一致。生产环境禁止模拟模型（`SIMULATION_PROVIDER_ENABLED` 在 `NODE_ENV=production` 下被拒），因此模拟型号仍是开发/测试独有；一致性指真实型号清单与档位，不包含模拟型号。

无法一致的一处：第三方渠道在开发环境允许 `http://localhost` 地址，生产环境要求 HTTPS。若 Sub2API 仅有内网 http 入口，生产环境将无法启动该渠道。此约束由现有校验施加，本批不放宽；部署前需确认 Sub2API 具备 HTTPS 入口。

凭据全部来自进程环境，不进数据库、不进后台页面、不进 JSON、不提交 Git。运营后台的 `/provider-accounts` 只做验活与配额展示，不回传密钥。

## 7. 价格

- 供应商成本：`pricing.rates` 与 `reserveCostMicros` 为 schema 必填。占位采用官方公布费率折微美元（文本输入 `5000000`、图片输入 `8000000`、文本输出 `0`、图片输出 `30000000`），`reserveCostMicros` 取 `1000000`，`dailyBudgetMicros` 设为不小于该值。
- 对客积分：`ModelCreditPrice` 按 `(modelId, resolution)` 占位，同档位下比例同价。没有价格记录的规格不出现在公开目录。

占位仅用于跑通链路。定价与成本口径由运营后台 `/model-pricing` 后续调整，该接口无需 Key 即可读写。本批不声称占位值经过成本核算。

## 8. 明确不做

- 不启用官方 Google/OpenAI 直连渠道，不新增 `GEMINI_API_KEY` / `OPENAI_API_KEY` 通路。
- 不让 Google 型号出现在第三方渠道。
- 不暴露 `xhigh` / `max` 质量档，不扩大生成输入 schema。
- 不改动前端目录、报价、结算、支付与账本逻辑。
- 不把占位价格包装成已审核定价。
- 不做 Sub2API 生图契约的完全验收；仅验证其 `/v1/models` 列出三个型号。

## 9. 对既有决定的修订

`2026-09-09-official-image-models-design.md` 第 37 行记载："固定 `model: gpt-image-2`…不升级成 2.5"。本批解除该限制：型号不再由适配器常量固定，改由执行快照透传，并新增两个 2.5 型号。

同一文档中"第三方图片协议只接入 `gpt-image-2`"的能力边界，由第 4 节的协议匹配判据取代：边界仍在，但依据从"单一型号"变为"协议兼容"。

## 10. 验收标准

- `OFFICIAL_MODELS` 含 7 个定义；`officialSpecs` 对两个新 ID 返回与 `gpt-image-2` 同构的规格集合。
- 第三方配置接受三个 OpenAI 协议型号；拒绝 `gemini-*`，且拒绝发生在 schema 解析或运行期闸门，不产生目录条目。
- 适配器对 2.5 型号发出的请求体 `model` 等于该型号 ID，不等于 `gpt-image-2`。
- `GET /api/models` 在配置并定价后列出三个型号，显示名符合第 3 节。
- `npm run typecheck` 与 `vitest run` 全绿。
- `npm run verify:sub2api-images` 确认 Sub2API 列出三个型号；该脚本只请求 `/v1/models`，不调用生图接口。

## 11. 官方依据（2026-09-15 核验）

- [GPT-Image-2.5 Sunburst 模型页](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst)：确认 ID、支持端点（仅 `v1/images/generations` 与 `v1/images/edits`）。
- [OpenAI 图片生成指南](https://developers.openai.com/api/docs/guides/image-generation)：确认尺寸约束、推荐尺寸、质量档与输出格式。
- 该代发布拆为 `-flare` 与 `-sunburst` 两个 ID，**不存在**名为 `gpt-image-2.5` 的有效 API ID。旁证：[Replicate openai/gpt-image-2.5-flare](https://replicate.com/openai/gpt-image-2.5-flare)、[Replicate openai/gpt-image-2.5-sunburst](https://replicate.com/openai/gpt-image-2.5-sunburst)。
- 既有 `2026-09-09-official-image-models-design.md` 记录的五型号表仍适用于官方直连渠道，本批不改其内容。

## 12. 设计自审

- 第 5 节为本次新增发现，若只按前三节实施会产出静默降级，故将其列为实现前置。
- 第 6 节的 HTTPS 缺口无法在代码内消除，已明确标为部署前置条件而非实现项。
- 第 7 节占位价格未声称经成本核算，与既有"不预设或更改实际价格"的立场一致。
- 未发现与既有文档冲突之处；第 9 节显式记录了对 2026-09-09 决定的两处修订。
