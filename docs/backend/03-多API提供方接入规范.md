# VIVIAI 多 API 提供方接入规范

日期：2026-09-06。面向 Provider Gateway、任务 Worker、渠道运营和测试。关联：[总体架构](./01-后端架构设计.md)、[详细设计](./02-后端详细设计.md)。

## 1. 接入目标与提供方分类

新增提供方应主要增加适配器、渠道配置和能力验收记录，不能要求修改钱包、复刻页面或任务结算代码。

| 类型 | 例子 | 实际差异 | 平台适配方式 |
|---|---|---|---|
| 官方原生图片 API | Google Gemini | 特定多模态输入、尺寸与上下文规则 | Google 协议适配器 |
| 官方图片生成/编辑 API | OpenAI | 生图与编辑端点、尺寸/质量、用量字段 | OpenAI Images 适配器 |
| 同步商业兼容 API | 经过采购验收的提供方 | 名称类似但参数、结果、费用可能不同 | 独立渠道 profile，不盲目信任兼容性 |
| 异步任务 API | fal、Replicate 等 | submit 返回 ID，另有状态、结果、取消/回调 | 每家协议适配器，统一平台状态 |
| 离线 Batch API | 提供方实际支持的批处理产品 | 交付窗口、行级结果、计费与取消不同 | 独立 BulkAdapter，不能伪装交互渠道 |

这些是需要支持的类型，不表示用户已经采购、授权或开通了上述服务。

## 2. 已核对的官方事实及其架构影响

| 官方事实快照 | 架构影响 | 来源 |
|---|---|---|
| Gemini 图片模型支持文字和图片编辑输入、对话式修改；不同型号对多图/连续编辑的适用性不同 | 每型号维护能力，不以系列名称统一放开全部输入 | [Google 图片生成](https://ai.google.dev/gemini-api/docs/image-generation) |
| OpenAI 区分 Image API 与 Responses API；后者适合带上下文的图像交互，也可能产生主模型 Token 费用 | 首发单次生成/编辑接 Images，后续对话适配独立能力和成本维度 | [OpenAI 图片生成](https://developers.openai.com/api/docs/guides/image-generation) |
| fal 提供队列提交、查询与结果获取接口 | submit 与 query 分离，持久化 request_id | [fal 异步推理](https://fal.ai/docs/documentation/model-apis/inference/queue) |
| fal 回调有基于 ED25519/JWKS 的签名验证过程 | 不能用自创“统一 HMAC”代替各提供方验签 | [fal Webhooks](https://fal.ai/docs/documentation/model-apis/inference/webhooks) |
| Replicate 的远端预测截止时间不同于同步 HTTP 等待时长 | httpReadTimeout、remoteDeadline、businessDeadline 分字段 | [Replicate 创建预测](https://replicate.com/docs/topics/predictions/create-a-prediction) |
| Gemini Batch 是单独的异步产品 | 按模式和型号核实可用性，用户显式选择延后交付 | [Gemini Batch API](https://ai.google.dev/gemini-api/docs/batch-api) |

事实核对日期不代表上线验收。实际账号的模型权限、地域、配额、接口版本、计费合同和文件访问策略仍需渠道验收。

### 2.1 模型目录映射

| 当前前端 public code | 可核对的官方家族/ID | 上线处理 |
|---|---|---|
| `nano-banana-2` | `gemini-3.1-flash-image` | 建立新产品版本，精确能力验收后绑定 |
| `nano-banana-pro` | `gemini-3-pro-image` | 独立产品与价格版本 |
| `nano-banana-2-lite` | `gemini-3.1-flash-lite-image` | 多参考图/连续编辑按真实能力限制 |
| `nano-banana` | `gemini-2.5-flash-image` | 单独维护旧型号生命周期 |
| `g-image-2` | 名称本身不能证明是哪家模型 | 保持未核实；若明确采购 OpenAI，再映射到 `gpt-image-2` 或新增明确命名的产品 |

Gemini 名称按上述官方指南当前列举，OpenAI 模型 ID 按其图片指南示例核对。不要把以前的 preview 后缀、尺寸限制或旧价格视为永久事实。第三方“同名”需要合同型号声明、实际响应元数据和效果/参数验收共同佐证；无法确认底层身份时不加入严格等价切换组。

`1K/2K/4K` 是 UI 档位，真实尺寸还受模型、比例和像素约束影响。一个供应商接受 `resolution=4K` 也可能执行放大或忽略字段。能力验收必须解码输出实测，明确 `native` 或 `upscaled`；两者不能静默互换。

## 3. 规范化任务协议

### 3.1 核心类型

下列 TypeScript 是设计合约，不包含实际 SDK 调用。所有适配器以此向业务层返回结果；官方字段细节留在适配器内部。

```typescript
export type ImageRole = 'reference' | 'subject' | 'context';
export type Acceptance = 'not_accepted' | 'accepted' | 'unknown';
export type BillingCertainty = 'not_billable' | 'billable' | 'unknown';
export type ExecutionMode = 'interactive' | 'deferred';

export interface InputImage {
  assetId: string;
  role: ImageRole;
  order: number;
  sha256: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
  objectKey: string;
}

export interface NormalizedImageRequest {
  jobId: string;
  itemId: string;
  attemptId: string;
  productModelVersionId: string;
  upstreamModelId: string;
  outputSpecId: string;
  prompt: string;
  promptTemplateVersion: string;
  images: InputImage[];
  output: {
    width: number;
    height: number;
    format: 'png' | 'jpeg' | 'webp';
    quality?: 'low' | 'medium' | 'high';
    allowedNativeDimensions: Array<{ width: number; height: number }>;
  };
  count: 1;
  executionMode: ExecutionMode;
  businessDeadlineAt: string;
  providerContextRef?: string;
}

export interface ProviderContext {
  channelId: string;
  credentialVersionRef: string;
  baseUrl: string;
  region: string;
  capabilityVersionId: string;
  requestKey: string;
  connectTimeoutMs: number;
  responseTimeoutMs: number;
  remoteDeadlineAt?: string;
  signal: AbortSignal;
}

export interface ProviderRef {
  providerRequestId: string;
  channelId: string;
  credentialVersionRef: string;
}

export interface UsageLine {
  dimension: string;
  quantity: string;
  unit: 'token' | 'image' | 'second' | 'request' | 'byte';
  source: 'response' | 'invoice' | 'estimate' | 'allocated';
}

export type ProviderOutput =
  | { kind: 'stream'; content: AsyncIterable<Uint8Array>; mimeType: string }
  | { kind: 'remote_url'; url: string; expiresAt?: string };

export interface CompletedResult {
  kind: 'completed';
  ref?: ProviderRef;
  outputs: ProviderOutput[];
  usage: UsageLine[];
  usageComplete: boolean;
  providerContextRef?: string;
}

export interface ProviderFailure {
  code: 'invalid_input' | 'unsupported' | 'auth' | 'quota' |
    'rate_limit' | 'content_rejected' | 'server_error' |
    'transport_error' | 'timeout' | 'invalid_output';
  acceptance: Acceptance;
  billing: BillingCertainty;
  usage?: UsageLine[];
  usageComplete?: boolean;
  retryAfterMs?: number;
  safeMessage: string;
  diagnosticRef?: string;
}

export type SubmitResult = CompletedResult
  | { kind: 'accepted'; ref: ProviderRef; pollAfterMs: number }
  | { kind: 'rejected'; failure: ProviderFailure }
  | { kind: 'unknown'; ref?: ProviderRef; failure: ProviderFailure };

export type QueryResult = CompletedResult
  | { kind: 'pending'; ref: ProviderRef; pollAfterMs: number }
  | { kind: 'failed'; failure: ProviderFailure }
  | { kind: 'cancelled'; billing: BillingCertainty; usage?: UsageLine[] }
  | { kind: 'not_found'; authoritative: boolean;
      disposition: 'never_accepted' | 'expired_or_deleted' | 'unknown' };

export type CancelResult =
  | { kind: 'confirmed'; billing: BillingCertainty; usage?: UsageLine[] }
  | { kind: 'requested' }
  | { kind: 'unsupported' }
  | { kind: 'unknown' };

export interface VerifiedWebhook {
  dedupeKey: string;
  providerRequestId: string;
  eventType: string;
  occurredAt?: string;
  payloadDigest: string;
  normalized: QueryResult;
}

export interface ProviderCapabilities {
  submitMode: 'sync' | 'async' | 'both';
  supportsQuery: boolean;
  supportsCancel: boolean;
  supportsRemoteDeadline: boolean;
  webhookVerification: 'signed' | 'none';
  idempotency: 'documented' | 'none';
  maxReferenceImages: number;
  maxOutputImages: number;
  supportedRoles: ImageRole[];
  inputTransport: Array<'inline_bytes' | 'multipart' | 'url' | 'provider_file'>;
  supportsProviderContext: boolean;
  executionModes: ExecutionMode[];
}

export interface ProviderAdapter {
  readonly protocol: string;
  capabilities(context: ProviderContext): ProviderCapabilities;
  validate(request: NormalizedImageRequest, context: ProviderContext): void;
  submit(request: NormalizedImageRequest, context: ProviderContext): Promise<SubmitResult>;
  query?(ref: ProviderRef, context: ProviderContext): Promise<QueryResult>;
  cancel?(ref: ProviderRef, context: ProviderContext): Promise<CancelResult>;
  verifyAndParseWebhook?(
    rawBody: Uint8Array,
    headers: Record<string, string>,
    context: ProviderContext
  ): Promise<VerifiedWebhook>;
}
```

`capabilities()` 是版本化配置和验收结果，不能因为适配器有一个可选 query 方法就断言每个渠道支持查询。`validate()` 只做本地能力校验，绝不发收费请求。

`requestKey` 是平台生成的 Attempt 幂等标识；只有提供方正式支持且通过测试时才映射到其幂等机制。没有该能力时不能靠发送一个自定义同名 Header 获得幂等保证。

`remoteDeadlineAt` 仅在渠道正式支持远端截止时映射，不能把本地 AbortSignal 当成远端已取消。失败/取消同样可能返回用量，必须保留；缺失费用明细仍需要后续对账。`not_found` 只有协议证据明确证明 `never_accepted` 时才能据此安全重提；历史任务过期/被删除后查询不到，不证明它从未执行或收费。

stream/Base64 解码产物必须立即流入受控 staging，不进入 Redis 或普通数据库 JSON。若同步结果在进程崩溃前未能可靠保存，且提供方不可查询，标记交付丢失/结果未知并记录成本，不能再生成一次冒充下载恢复。

### 3.2 适配器不负责什么

- 不扣/退用户积分，不修改用户套餐。
- 不自行切换提供方，不选择更便宜的不同模型。
- 不无限重试，不在 SDK 默认重试之外再套一层不受控重试。
- 不根据错误文案猜测“应该没扣费”；必须返回接受状态与费用确定性。
- 不创建永久公开图片 URL，不在响应中泄露凭据。

## 4. 各协议字段映射

### 4.1 Google Gemini

维护独立协议标识，例如 `gemini-interactions` 与项目确需兼容的 `gemini-generate-content`，不要在业务层散落分支。

| 平台输入 | 适配规则 |
|---|---|
| prompt + promptTemplateVersion | 编译为该版本的文本指令 |
| reference/subject 图片 | 按角色附文本说明，发送实际图片字节/Base64或已核实文件输入 |
| outputSpec | 使用该协议实际支持的图片大小与比例字段；尺寸映射保存在能力版本 |
| providerContextRef | 仅在同协议、同渠道允许的上下文范围使用 |
| usage | 保留提供方返回的 Token/模态明细，缺失字段记未知而非补零 |

当前官方指南示例使用 Interactions 并提供 `previous_interaction_id` 续写；旧 GenerateContent 集成的上下文载荷与新接口不同，必须隔离版本，不能拼接混用。[Google 图片生成](https://ai.google.dev/gemini-api/docs/image-generation)

不要硬编码“所有 Gemini 图片模型都只需要同一个请求体”。能力检查包括双参考图、目标比例、清晰度、返回图片数量、状态查询和计费维度。普通同步调用的传输超时不意味着远端取消。

### 4.2 OpenAI Images / Responses

没有参考图的单次生图走生成能力；带参考图的复刻走编辑能力，不能把只支持文本生成的兼容端点当成图像编辑。内部每 Item 请求 1 张，减少多结果费用/重试歧义。

尺寸字符串、quality、输出编码与允许参考数量由模型能力版本映射。固定一个 `gpt-image-*` 家族的参数后，不意味着其它家族接受相同字段。对话式流程若采用 Responses，应另记录主模型用量以及图片工具用量。[OpenAI 图片生成](https://developers.openai.com/api/docs/guides/image-generation)

HTTP `x-request-id` 等追踪字段可存为诊断关联，但不能自动视作可查询任务的 ID。只有明确支持查询的协议才将 `supportsQuery=true`。

### 4.3 fal 队列类协议

submit 保存队列 request_id；IN_QUEUE/IN_PROGRESS 转平台 pending/processing；完成后获取结果并进入 materializing。供应商可能还返回 gateway request ID，作为诊断字段保存，去重与关联以正式队列请求 ID 为主。[fal 队列文档](https://fal.ai/docs/documentation/model-apis/inference/queue)

回调验证按其签名规范实现；JWKS 本地短期缓存、支持轮换，取不到可信验证材料时保留重试/轮询，不跳过验签。不得根据回调里传来的任意 URL 决定拉取密钥。[fal 回调文档](https://fal.ai/docs/documentation/model-apis/inference/webhooks)

签名有效仍不代表任务属于本站当前用户。必须继续按渠道、账户、上游请求 ID 关联内部 Attempt，并校验期望输出与归属。

### 4.4 Replicate 等 prediction 协议

将 prediction ID 映射为 ProviderRef，status/output/error 转统一 QueryResult。远端截止、客户端等待和业务交付截止分别配置；不能把 `Prefer: wait` 超时当成 prediction 已取消。[Replicate 预测文档](https://replicate.com/docs/topics/predictions/create-a-prediction)

提供方是否保留输出、保留多久、取消如何收费都属于该渠道 profile；平台在获取结果后尽快存自己的资产。没有核对文档/账户前不承诺该提供方支持某一具体 Nano Banana 型号。

### 4.5 商业“OpenAI 兼容”渠道

兼容仅作为复用传输解析代码的起点，接入 profile 必填：baseURL、认证 Header 规则、精确模型 ID、生成/编辑端点、结果响应模式、错误映射、下载域名、用量来源、幂等与取消语义。

已审核的新渠道可配置到已有兼容 profile；任意新增 JSONPath/脚本、域名、签名算法属于代码审查范围，不允许运营输入脚本后在服务器执行。`extraParameters` 采用渠道白名单 Schema，不能任意穿透用户提供的上游参数。

## 5. 能力矩阵与准入

每个 channel_capability_version 至少保存：

| 类别 | 字段 |
|---|---|
| 模型身份 | provider、真实 upstreamModelId/version、供应商声明/验收证据、equivalenceGroup |
| 输入能力 | textToImage、imageEdit、maxReferences、角色支持、MIME、bytes、pixels、远程URL/文件支持 |
| 输出能力 | 允许产品规格、原生尺寸列表、质量档、格式、透明背景、最大图数 |
| 执行协议 | sync/async、query、cancel、signedWebhook、documentedIdempotency、remoteDeadline |
| 上下文 | stateless/providerState、跨请求上下文有效期、能否重建 |
| 成本 | 按图/Token/请求/时长、输入与输出维度、失败计费、最小计费单位、余额查询能力 |
| 运行边界 | 地域、数据处理政策、账户/项目配额、RPM/TPM/并发、延迟分位 |
| 证据 | 文档链接、合同引用、测试日期、测试账号、样本报告、批准人 |

产品能力取“已验收且可售渠道能明确履约的集合”，而不是所有渠道字段的最大并集。例如某规格只由一个渠道提供，仍可售但标记备用不足；不能展示 4K 后只让备用渠道返回 1K。

参考图角色是平台规范，未必是提供方原生字段。通过受控提示词和图像顺序进行适配时，验收必须验证效果是否符合该角色；文档承诺只说明可接收两图不足以证明适配正确。

## 6. 路由算法

### 6.1 硬筛选

```text
candidates = 当前产品版本允许的 channel bindings
过滤：enabled、凭据有效、地域与数据政策匹配
过滤：model identity / equivalenceGroup 满足用户承诺
过滤：reference roles、图片数量、尺寸、质量、格式、执行模式支持
过滤：熔断关闭或允许半开探测、账号配额可用
过滤：价格版本已核实且覆盖全部费用维度
过滤：本次 Attempt 上限 + 已发生/未知预占成本 <= Item 成本预算
```

全部过滤后无候选：还未创建 Job 时拒绝报价/提交；已受理的 Job 在原截止前排队等待，否则失败释放。不可绕过硬条件随机选一个“差不多”的渠道。

### 6.2 排序与选择

首发建议确定性“满足质量/可靠性门槛后按交付成本优先”，再以预计完成时间打破平局；避免初期凭很少样本训练复杂路由。

```text
estimatedDeliveryCost(channel)
= 当前尝试预计费用
+ 对允许安全重试的失败场景做条件期望成本
+ 存储/下载/转换等增量费用

可靠性门槛：验收通过，近窗口已知成功率达产品门槛
流量较少渠道：使用验收基线，不因 1/1 成功就判为 100% 可靠
排序：成本 → 预计完成时间 → 稳定 channelId
```

默认性能窗口 5 分钟与 24 小时同时观察，错误按渠道技术问题与输入问题区分。无付费影子流量；灰度新渠道显式分配 5%/20%/100% 流量并带预算，检测质量下降可快速回滚绑定版本。

### 6.3 路由配置示例

下面为平台配置示例，`vendor-a` 是待采购的占位渠道名称，不代表已接入服务：

```json
{
  "policyId": "image-interactive-v1",
  "productModelCode": "nano-banana-2",
  "mode": "interactive",
  "allowCrossModelFallback": false,
  "allowSilentResize": false,
  "maxAttemptsPerItem": 2,
  "maxAdditionalCostRatio": "0.20",
  "candidates": [
    {"channelCode": "google-primary", "enabled": true},
    {"channelCode": "vendor-a-backup", "enabled": false}
  ],
  "unknownSubmissionPolicy": "reconcile_before_resubmit",
  "onNoCandidate": "wait_until_deadline_then_release"
}
```

示例 disabled 备用必须验收后才能打开。`maxAdditionalCostRatio` 限制预计采购成本超出初始计划的幅度，但同时受绝对现金预算与 quote 可承受成本上限约束；不能按 20% 比例绕过实际亏损。

## 7. 错误、重试、熔断与故障切换

### 7.1 决策矩阵

| 事件 | 上游是否接收 | 行为 | 是否可换渠道 |
|---|---|---|---|
| 本地验参/参考图未就绪 | 未发送 | 返回可修复输入错误 | 否，先改输入 |
| 401/403 凭据错误 | 依协议确认 | 停用该凭据并告警 | 只有确认未执行、预算允许时 |
| 429 限流 | 依协议确认 | Retry-After + 随机退避，尊重项目配额 | 确认未接收时可切等价渠道 |
| 明确的不可用/拒绝接单 | not_accepted | 结束当前 Attempt，按预算选备用 | 可 |
| 5xx、read timeout、连接重置 | 可能已接收 | unknown/reconcile，不假定没扣费 | 默认不可 |
| accepted 带 providerTaskId | accepted | query 原任务 | 不新建 |
| query 暂时返回 404 | 未必不存在 | 按一致性窗口继续查 | 非 authoritative 时不可 |
| 上游已确认终态失败 | accepted | 记录失败费用；按可重试类别和预算决定 | 允许但会增加采购成本 |
| 内容拒绝 | 可能已处理 | 展示拒绝/可修改项 | 不用于跨渠道绕过审核 |
| 输出下载失败 | 已生成 | 只重试获取同一结果 | 不重新生图 |
| 输出规格不符 | 已生成 | 不按承诺规格交付；计成本与渠道质量失败 | 预算允许可尝试等价渠道，否则释放 |

未知态的 `providerRef` 可为空。无任务查询能力且请求是否接收不明时，平台等待业务截止并释放用户冻结，后台保留暂估成本；默认不自动发第二次收费请求。用户主动再次生成是新 Job，并提示旧任务正在确认，避免通过自动刷新制造隐性重试。

### 7.2 超时分层

| 超时 | 初始参考值 | 含义 |
|---|---|---|
| connect timeout | 5 秒 | 建立连接；只有能证明未发送请求体时可视为未接收 |
| async submit response | 30 秒 | 获取任务 ID，不是完整生图时限 |
| sync image response | 180 秒，按型号调整 | Worker 等待响应；超时进入未知分类 |
| remote deadline | 渠道实际支持时发送 | 远端可能停止执行的真实期限 |
| job queue deadline | 创建后 5 分钟 | 尚未派发的普通任务截止 |
| business delivery deadline | 创建后 15 分钟 | 面向用户的普通任务收敛时间 |

deferred 模式使用独立最长交付窗口和报价，不能复用 15 分钟退款定时器。具体窗口以上游 Batch 产品承诺和平台交付策略为准，前端提交前展示。

### 7.3 熔断

初始策略：同渠道技术错误连续 5 次，或 60 秒内至少 20 次请求中技术错误率 ≥50%，停止新提交 60 秒；半开每次放行 1 个可用配额内的正常请求。该参数是初始配置，需要用生产数据调整。

输入错误与内容拒绝不计渠道技术故障率；429 触发配额退避而不是等同全站失败；余额不足停用预算 scope。停用提交不能阻断 query/cancel/materialize，避免在途任务永远无法收尾。

## 8. 用量、成本与账单适配

### 8.1 计价维度

一个提供方可能按 Token，另一个按张收费。统一为可扩展的 UsageLine：

```text
text_input_tokens
image_input_tokens
cached_input_tokens
reasoning_tokens
text_output_tokens
image_output_tokens
output_images_by_spec
execution_seconds
request_units
provider_storage_bytes
```

这些是可能的维度，不要求每个提供方全部返回。每条采购价声明互斥和包含关系：若供应商按张价格已经包含输出 Token，不得再把 output_images 与 image_output_tokens 两次收费。

采购价版本至少包括币种、计量单位、阶梯、最小计费量、缓存折扣、执行模式、失败/取消计费规则、税费是否包含、生效时间、合同或官方来源。不能把缺失 usageMetadata 转成成本 0。

### 8.2 成本修订

第一次保存 response/estimate 用量，账单到达后追加 invoice 版本并指向被修订记录。账单映射使用提供方账号+requestId；没有逐请求明细的供应商按账单批次分摊并标记 `allocated` 来源和分摊方法，不能冒充精确每请求费用。

金额计算保存原币和汇率版本，不直接用当天网页汇率改历史成本。记录平台冻结预算、响应估算、最终账单之间的差异，超出阈值自动下调该渠道流量或暂停新提交。

多次 Attempt 都进入 Job 总成本。即使用户只获得一张图片、只扣一次积分，平台也可能支付多次请求费用；费用报表不得只取 winner Attempt。

### 8.3 低成本模式

首发价格显示为用户可理解的每张/每次积分价，底层按多个费用维度核算。可后续增加“快速生成”和“延后批量”两种明确产品模式，不把用户期待实时返回的请求悄悄送离线 Batch。

BulkAdapter 与普通 Adapter 分开：`submitBatch(items)`、`queryBatch(batchRef)`、`fetchItemResults(batchRef)`、`cancelBatch(batchRef)`；记录 provider_batches、provider_batch_items 与平台 Item/Attempt 的唯一映射。每行结果独立结算，部分取消只影响未交付项。若某渠道不支持图片 Batch，不因为支持文本 Batch 就宣称可以接入。

## 9. 输入与输出文件策略

| 传输方式 | 适用条件 | 风险与处理 |
|---|---|---|
| inline bytes/Base64 | 同步且文件总量较小 | 控制编码后体积和内存；不写普通日志 |
| multipart | 图片编辑端点原生支持 | 带正确字段顺序、MIME 和尺寸元数据 |
| 签名 URL | 上游能拉 HTTPS 且地域可达 | TTL 覆盖读取时间；短期签名仅限该对象；过期重签不是再生成 |
| provider file ID | 上游要求先上传 | file ID 绑定渠道/账号/有效期；记录清理状态 |

默认图片不经过无业务需要的第三方转换服务。对同一资产提供方文件缓存只在同渠道、同凭据账户、同 sha256 和同数据政策范围复用，不能跨用户暴露文件句柄。

输出 URL 必须命中登记下载域名；DNS 解析排除内网、localhost、链路本地和云元数据地址；每次重定向重新校验。限制最大响应、解码像素、下载时间，防止把图片处理 Worker 变成任意网络代理。

## 10. 接入实施步骤与验收报告

每家新提供方依次完成以下工作，不能仅“填了 Key 能返回 200”就上线：

1. 登记采购主体、账号、允许地域、数据政策、模型声明、价格来源和费用预算。
2. 确定协议 profile 与文档版本，建立凭据引用、基础/下载/签名密钥域名 allowlist。
3. 实现 validate/submit，按实际能力实现 query/cancel/webhook；禁止臆造可选能力。
4. 使用受控测试服务验证超时、重复、乱序、签名失败、长队列、返回错误图片等路径。
5. 用目标真实账号、小额预算验证文字生图、单参考图、参考+主体图、每个拟售规格与质量档。
6. 记录实际输出尺寸、响应 shape、usage、远端任务ID、账单关联和失败费用。
7. 发布 channel capability 与采购价版本，先灰度、再扩大流量；保留上一版可回滚。

验收报告字段：

| 字段 | 通过标准 |
|---|---|
| 真实模型身份 | 官方/合同ID与响应信息一致；不明则不可加入严格等价组 |
| 参考图传递 | 两张有明显不同特征的测试图，确实都被请求携带；输出能体现约定角色 |
| 清晰度/比例 | 实际解码尺寸匹配声明的原生规格；未声明的放大/裁剪判失败 |
| 异常映射 | 超时、429、5xx、拒绝、空结果被正确区分 |
| 幂等 | 明确标记有/无；支持时重放同 Key 验证真实上游请求与账单数 |
| 回调 | 原始体签名验证、重复和乱序不会双重入库 |
| 取消 | 明确不同阶段是否可取消、取消后账单如何处理 |
| 费用 | 统计输入/输出/失败等费用，与真实账单核对 |
| 数据政策 | 输入和结果保留策略、地域和可删除能力有出处 |
| 运行 | 延迟分位、并发/RPM限制、恢复表现达到产品设定 |

## 11. 典型场景推演

### 场景 A：两张参考输入，主渠道明确限流

主渠道文档和测试确认此次 429 没有接收任务 → 记录非计费拒绝 → 释放当前预算预占 → 筛选支持 reference+subject、同模型和同原生尺寸的备用 → 预占备用成本 → 创建新 Attempt → 用户仍只看见一个 Job。

### 场景 B：主渠道已执行，响应丢失

Attempt 保持 unknown，用户界面显示确认中。存在可查询 ID 时查询；无 ID 且无正式幂等机制时不自动换供应商。业务截止释放用户积分，采购账仍保留暂估费用。迟到结果不追扣。

### 场景 C：4K 返回 1K 图片

输出校验不通过，不能将结果标成 4K 成功。记录质量故障和上游成本；备用必须支持真实约定规格且预算足够。不能静默本地拉伸后按原生 4K 收费。

### 场景 D：上游成功，但平台存储临时不可用

保留远端结果引用或 staging 文件，重试下载/落存储；不重新请求生图。交付期限内恢复后只结算一次。结果已无法恢复且到期则释放用户积分，记录平台交付损失。

### 场景 E：便宜渠道是不同模型

从同模型候选中移除。可以作为单独的“经济模型”上架，让用户明确选择并获得新报价；不能在原模型任务失败后偷偷换用。

## 12. 不应进入首发的复杂度

首发不做自动购买供应商余额、不做付费请求竞速、不做未经预算授权的影子流量、不开放任意用户自带 Key、不做自动跨模型降级、不把全部提供方强行转换成同一种 HTTP schema。

优先把“两条真实可验收渠道 + 明确的未知请求处理 + 用户积分和现金成本两套账”做完整，再扩展渠道数量。数量越多不天然越可靠，无法对账和无法追溯模型身份的低价渠道可能反而放大损失。
