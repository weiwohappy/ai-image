# 官方模型接入与后续联调

本轮交付代码和离线测试，不需要 Key。默认关闭官方调用，没有执行真实付费请求。前端创作页仍为 Mock，本轮实现后端 API；后续单独切换前端真实接口。

支持官方 ID：`gemini-2.5-flash-image`、`gemini-3.1-flash-lite-image`、`gemini-3.1-flash-image`、`gemini-3-pro-image`、`gpt-image-2`。只有官方 API，无订阅账号代理、第三方中转或隐式型号升级。

## 尺寸选择

用户选择分辨率 + 比例；客户端从 `GET /api/models` 的 `specs` 中筛选组合，每项明确列出 width、height、unitCredits。请求只传 resolution / ratio，不接受任意宽高。型号、比例、分辨率和输出像素在报价、任务快照、派发、落盘四处校验，不会缩放替代不支持的规格。

| 模型 | 本轮分辨率 | 比例 |
| --- | --- | --- |
| Nano Banana | 1K | 下述 10 种常用比例 |
| Nano Banana 2 Lite | 1K | 暂仅 1:1，其他比例像素表待官方核验 |
| Nano Banana 2 | 0.5K / 1K / 2K / 4K | 下述 10 种常用比例 |
| Nano Banana Pro | 1K / 2K / 4K | 下述 10 种常用比例 |
| GPT Image 2 | 产品预设 1K / 2K；4K 横竖屏 | 1K/2K 10 种；4K 仅 16:9、9:16 |

常用比例：1:1、2:3、3:2、3:4、4:3、4:5、5:4、9:16、16:9、21:9。Google 的精确像素表与 OpenAI 合法预设维护于 `src/modules/providers/official-models.ts`。GPT Image 2 的 4K 是 3840×2160 或 2160×3840，不支持 4096 方图；OpenAI 将超过 2560×1440 的尺寸标为实验性，联调时需重点验证。

Google 多数表格比例对应近似像素比，例如 2K 16:9 为 2752×1536；以官方表格为准，不自行重算“更标准”的比例。Lite 官方只明确了 1K 方图像素，不能直接套用 Flash/Pro 表格。

例外：官方 Flash 0.5K「21:9」一行写 792×168，与比例明显矛盾，因此暂时禁用这一组合，等待官方澄清；没有擅自换成 792×336。该型号其他档位的 21:9 不受影响。

已发现的官方文档差异：Lite 模型页写 `1024px`，Interactions 的 image_size 枚举只有 `512/1K/2K/4K`，模型枚举也尚未列 Lite。因此 Lite 代码按图像指南给出的精确型号接入，但省略可选 image_size（固定 1K），仅指定方形并验证返回 1024×1024；真实端点可用性列为必测，不声称已经打通。Interactions 输出 mime_type 枚举只列 JPEG，故 Google 请求省略 mime_type，要求 inline，接受明确标注且真实格式匹配的 PNG/JPEG/WebP；落盘转 PNG，不缩放。OpenAI 仍显式请求 PNG。

依据：[Google 生成指南](https://ai.google.dev/gemini-api/docs/image-generation)、[Lite 模型页](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite-image)、[OpenAI 生成接口](https://developers.openai.com/api/reference/typescript/resources/images/methods/generate)、[GPT Image 2](https://developers.openai.com/api/docs/models/gpt-image-2)。核验日期 2026-09-09。

## 配置（之后提供 Key 时再启用）

## 第三方 OpenAI 兼容渠道（Sub2API）

Sub2API 不属于官方 Google/OpenAI 账号，也不改变官方图片模型的固定端点；它作为可替换的第三方 OpenAI 兼容聊天渠道配置。开发环境示例使用 `http://localhost:8080`，程序会规范化为 `http://localhost:8080/v1`；生产环境必须使用 HTTPS。当前渠道仅用于聊天模型的配置与连通性验证，不会自动出现在官方图片模型目录，也不会改变 Nano Banana/GPT Image 2 的官方路由。

```bash
SUB2API_ENABLED=true
SUB2API_BASE_URL=http://localhost:8080
SUB2API_API_KEY=<server-only-secret>
SUB2API_MODEL_ID=<the-exact-model-id-listed-by-Sub2API>
SUB2API_SCOPE=sub2api-default
SUB2API_CREDENTIAL_VERSION=v1
SUB2API_CONCURRENCY=1
SUB2API_MAX_UNKNOWN=1
SUB2API_DAILY_BUDGET_MICROS=0
```

`npm run verify:sub2api` 先请求 `/v1/models`，要求精确模型 ID 存在，再发送 `max_tokens=8`、`stream=false` 的最小 `/v1/chat/completions` 探针。输出只包含渠道、地址、模型和安全状态，不打印 Key 或上游响应正文。401/403、404、429、超时和畸形响应均返回稳定的安全错误。关闭 `SUB2API_ENABLED` 时不会要求 Key；启用但缺少 Key、模型或非法地址时服务启动即拒绝。

API 与 Worker 必须加载同一份配置。`OFFICIAL_IMAGE_MODELS_JSON` 为 JSON 字符串，无 Key。默认值：

```json
{"revision":"disabled","accounts":{},"models":[]}
```

启用前按以下字段准备配置；此处故意不提供可直接误用的生产价格：

- `revision`：业务发布版本号。
- `accounts.google` / `accounts.openai`：`scope`（真实采购账号/项目的稳定标识，不含密钥）、`credentialVersion`、`concurrency`（1–4）、`maxUnknown`（1–4）、`dailyBudgetMicros`（正整数的字符串，USD 微元）。同一供应商账号的模型共享配额和预算，不能为每个型号虚构新账号。
- `models[]`：`modelId` 必须为上面的精确 ID；`enabledResolutions` 指定允许运行的已审核档位，例如 `['1K', '2K']`。该列表必须非空且不能包含重复或不支持的档位。兼容旧配置时，省略此字段才从 `sales` 的键读取运行档位；两者同时存在时显式列表优先。`sales` 的数值不再用于报价，也不参与执行渠道指纹。
- 对客积分由数据库 `ModelCreditPrice` 管理；仅“运行档位可用＋价格已配置并启用”的规格出现在公开目录。没有 API Key 也可在运营平台先配置积分，不会启用官方调用。每档位下已支持比例统一价格，不能配置任意像素或比例加价。
- 每个 model 的 `reserveCostMicros`：单张预算预留，USD 微元字符串，应覆盖允许规格/参考图/提示词的保守预估，不等于最终费用。
- `pricing`：`version`、`currency: USD`、`rates`。rates 是“每百万 token 的微美元数”的整数字符串：`input_text_tokens`、`input_image_tokens`、`output_text_tokens`、`output_image_tokens`，Google 另需 `thought_tokens`。例如纯算术：若某项为每百万 token 2 美元，则填 `2000000`；这不是任何型号的实际报价。
- Key 独立设置 `GEMINI_API_KEY` / `OPENAI_API_KEY`，只在服务端秘密管理系统中配置。配置官方模型却缺 Key、运行档位、成本费率、账号或存在非法尺寸档位时启动拒绝，错误不包含密钥。没有数据库售价不会阻止启动，但该档位不能报价。Key 不放前端环境变量，不放 JSON、不提交 Git。轮换 Key 时同步更新 `credentialVersion`。

模型输入同原有报价接口，例如：

```json
{"source":"create","modelId":"gemini-3.1-flash-image","prompt":"蓝色陶瓷杯商品图","resolution":"2K","ratio":"16:9","format":"png","quality":"standard","count":1}
```

复刻改为 `source: remix` 并提供当前用户上传的 `referenceAssetId`，可增加 `subjectAssetId`（Lite 不提供主体图）。strength 表示提示词策略，不冒称官方数值保真度参数。每张成功交付才消费积分。

## 成本、超时和恢复

报价和任务分别存储执行快照与积分价格快照。价格快照包含价格ID、版本、模型、分辨率和单张积分；执行快照保留协议、像素、渠道、凭据版本和官方成本配置，不保存对客积分或 Key。调价/停用只影响新报价，未提交报价以 `409 PRICE_CHANGED` 或 `PRICE_UNAVAILABLE` 要求重新确认，已提交任务继续按原任务项积分扣除或释放。真实执行配置变更仍会使旧配置任务安全失败/释放，不改用新型号。不要在仍有排队任务时删执行配置。

已有 `sales` 只能通过 `npm run admin:import-model-prices` 显式 dry-run 查看；批准后加 `-- --apply` 创建缺失记录，已有启用/停用记录均不覆盖。导入无需 Key、不调用官方接口并记录离线审计。服务启动和迁移不会自动种价。详见 [后台维护说明](ADMIN.md)。

只有费用确定为 billable、上游 token 用量完整且价格覆盖时才计算 actualCostMicros；缺失/不完整使用量保留 unknown 和预算预留。畸形或拒绝的响应即使含 token 用量，也只作为对账证据，不能据此断言供应商最终收费；费用确定性与计量完整性分开记录。缓存、工具用量或不认识的维度不被悄悄省略。当前无运营待对账处理界面，上线前需实现供应商账单核对、差异更正与人工解锁；未对账成本不是利润。

HTTP 单次最长 180 秒，不自动重试，租约为 210 秒。每个任务 15 分钟交付截止。请求发送后网络断开可能已经计费：标记 unknown，不自动重发，截止释放用户积分，供应商费用继续待核对。同步接口没有可靠可恢复查询，本轮不宣称 exactly-once 上游执行。

结果先存入私有对象存储，再记录 stagedKey；最终结算失败从该对象恢复。响应到达但首次私有存储写入失败、或进程在持久化前崩溃的窗口仍可能丢失输出：不能重新付费生成掩盖，退款并保留成本证据。图片上传≤5 MiB、生成输出≤96 MiB、解码≤4000万像素；部署时需结合并发预留内存。

## 后续真实联调清单

1. 安全配置 Key，确认官方账号/地区/组织验证与五款型号实际权限；未开通则保持关闭。
2. 审核实时采购价、USD/人民币换算、支付成本、退款和毛利，填写版本化价格与售卖积分；官方接口按用量采购，不沿用网页会员价格。
3. 每型号先小额验证 1K 文生图与参考图编辑，再逐个验证比例和高分辨率、实际图片头部尺寸、Google 标记和 GPT 质量。
4. 核对真实 usage 分项与供应商账单，特别是思考 token、输出图片 token、缺失 usage 和输入图片费用；离线样例不能替代账单证据。
5. 验证限流、超时、存储暂时故障、重复点击、成本报警。之后再单独切换前端真实模型目录/报价/生成接口。
