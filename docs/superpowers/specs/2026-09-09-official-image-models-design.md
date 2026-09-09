# 官方图片模型接入设计

状态：用户已授权先出方案并实现代码，Key 与真实付费联调后补。2026-09-09。

## 目标和首版范围

接通现有报价 → 冻结积分 → 异步任务 → 官方生成/编辑 → 私有存储 → 成功扣款、失败退款链路。用户上传的参考图是复刻输入，不使用内置爆款图库替代。每个任务可以有 1–4 个独立图片项，每次上游请求只生成 1 张。

| 产品 | 官方模型 ID | 协议 |
| --- | --- | --- |
| Nano Banana | gemini-2.5-flash-image | Gemini Interactions REST |
| Nano Banana 2 Lite | gemini-3.1-flash-lite-image | Gemini Interactions REST |
| Nano Banana 2 | gemini-3.1-flash-image | Gemini Interactions REST |
| Nano Banana Pro | gemini-3-pro-image | Gemini Interactions REST |
| GPT Image 2 | gpt-image-2 | OpenAI Images REST |

按用户补充要求，商业规格由分辨率 × 常见比例决定，不是固定方图。输出 PNG、单轮文生图/参考图编辑；GPT Image 2 映射 medium 质量，Google 使用原生质量。保留现有 `quality: standard` 产品字段，其上游映射由版本控制。最多参考图 + 主体图各 1 张；Lite 首版仅 1 张参考图，这是产品限制（官方提示该型号不擅长多参考图），不是声称官方硬上限。

多轮会话、蒙版、Batch、搜索增强、前端真接口切换不在本轮实现范围。不能把有限规格冒充模型全部能力。后续增加规格必须同时补原生尺寸白名单、价格和测试，不静默缩放。

## 分辨率与比例（用户追加要求）

- 常见比例：1:1、2:3、3:2、3:4、4:3、4:5、5:4、9:16、16:9、21:9。
- Nano Banana：上述比例的 1K，逐项使用官方旧型号像素表。例如 16:9 为 1344×768。
- Nano Banana 2：上述比例的 0.5K / 1K / 2K / 4K；Pro 为 1K / 2K / 4K。例如 2K 16:9 为 2752×1536，不是 2048×1152。例外：Flash 0.5K 21:9 的官方行写 792×168，与比例矛盾，暂禁用而不擅自修正。
- Nano Banana 2 Lite：官方独立模型页确认 1K 1024×1024；它写 `image_size: 1024px`，与 Interactions 枚举不一致，所以本轮省略此固定尺寸型号的可选 size 参数并严格验图。官方提及其他比例，但未找到可核验的逐比例像素表，暂仅开放方图，不借用其他型号表；Lite 在接口枚举中的缺漏须真实联调核实。
- GPT Image 2：按官方可变尺寸约束（边长为 16 倍数、长边 ≤3840、长宽比 ≤3:1、像素 655360–8294400）制定显式产品预设，不冒称 Google 式原生 1K/2K 档。1K / 2K 提供上述常见比例；4K 仅 3840×2160 / 2160×3840。高于 2560×1440 的官方实验性边界需在上线前说明。
- 完整白名单以 `official-models.ts` 为单一来源，报价校验、模型目录、适配器和结果尺寸检查共同使用。`/api/models[].specs` 列出有效组合和宽高，前端不能把 resolutions × ratios 两个数组直接做笛卡尔积。
- 配置仅开放已填写售价的分辨率，后端拒绝未定价或无明确尺寸的组合。价格按型号/档位，输出真实成本按 usage 分账。

## 结构和接口

沿用 ProviderAdapter 契约，Google / OpenAI 各一个适配器；模型目录与提供方渠道分离。正式渠道可独立开关，模型精确匹配，禁止跨型号回退。配置只接受五个审核过的模型 ID，固定官方 HTTPS 地址，禁止客户端传 base URL、Key 或任意模型名。

Google 请求 `/v1beta/interactions`，`input` 中按顺序放文本与私有图片内联数据，显式 `response_format` 图像输出和 inline 交付，关闭服务端会话存储；只解析 REST 的 `steps[type=model_output].content[type=image]`，不把 SDK 的便利属性当 REST 字段。Nano Banana 老型号和 Lite 不发送可选 size 参数。接口枚举未列 PNG 输出参数，故不强传 mime_type；接收真实格式与标注匹配的 PNG/JPEG/WebP，最终规范化 PNG，不缩放、不去除像素水印。

OpenAI 无参考图用 JSON `/v1/images/generations`；有图用 multipart `/v1/images/edits`。固定 `model: gpt-image-2`、`n: 1`、`quality: medium`、`output_format: png`，`size` 从审核过的分辨率/比例组合提取。不发送不适用的 `response_format` / `input_fidelity`；不升级成 2.5。

共用受控 HTTP 传输：凭据只放请求头；禁止重定向、禁止自动重试；响应读流有字节上限和时间上限；本地对象读取失败属于未提交，发送后连接中断/5xx/响应不明属于 acceptance unknown。不返回上游原始错误、Key、Base64、内部对象路径到客户端/日志。参考图校验摘要，输出严格验证 Base64、单张图、真实栅格和约定尺寸。

## 开关与价格

默认所有官方模型关闭，保留开发模拟模式。后续服务端配置 `OFFICIAL_IMAGE_MODELS_JSON`（无 Key）及 `GEMINI_API_KEY` / `OPENAI_API_KEY`。配置包含每型号售价积分、成本价格版本、USD 微元/百万 token 分项单价、单请求预算预留、账号共享日预算/并发。启用渠道缺 Key、缺价格或非法配置启动失败，不退回模拟图。

首版不内置未经账户账单确认的价格。报价/任务保存不可变执行快照（模型、渠道修订、规格、售价、价格版本），执行中配置不匹配则退款；不偷偷采用新模型/新价格。

实际成本使用上游分项 usage × 快照单价，以整数微美元计算。缺 usage、维度不全或价格缺失记待对账，actualCost 不填零，也不把预算估计写成实际成本；保留预算占用。用户积分和上游成本分账，晚到成功可记成本但不能再次扣用户积分。日预算是服务端预留控制，不是供应商账单硬封顶。

## 恢复与风险

官方同步调用使用有界长超时，任务租约必须长于调用超时；网络调用在数据库事务外。未知结果禁止自动重发，等待交付截止退款并保留待对账记录；真实供应商没有可恢复查询的同步请求，不能承诺崩溃窗口零丢图。

成功响应转为私有对象并记录 stagedKey，数据库结算失败可从该对象继续，不能再次生成。输出已到达但私有存储首次写入失败的窗口无法可靠恢复，失败退款并保留供应商成本。终态、租约 fencing 和积分幂等沿用已有机制。

## 验收

全程仅本地 HTTP stub/测试对象存储/隔离数据库：五模型请求映射、复刻图片顺序和角色、拒绝/限流/超时/畸形输出、无隐藏重试、配置闭锁、报价快照、官方资产标签、实际/未知成本、重复派发/结算、防止外部 URL 下载。回归现有模拟、身份、钱包、支付测试。

Key 到位后单独执行账户权限、地区/模型可用性、各型号文生图与复刻、返回尺寸、真实 usage 与账单核对。当前通过离线测试不等于真实 API 联调或生产上线。

## 官方依据（2026-09-09 核验）

- [Google 图像生成与四款 Nano Banana](https://ai.google.dev/gemini-api/docs/image-generation)
- [Google Interactions REST 字段](https://ai.google.dev/api/interactions-api)
- [GPT Image 2 模型页](https://developers.openai.com/api/docs/models/gpt-image-2)
- [OpenAI Images generation](https://developers.openai.com/api/reference/typescript/resources/images/methods/generate)
- [OpenAI Images edit](https://developers.openai.com/api/reference/typescript/resources/images/methods/edit)
- [OpenAI 图片生成说明](https://developers.openai.com/api/docs/guides/image-generation)
