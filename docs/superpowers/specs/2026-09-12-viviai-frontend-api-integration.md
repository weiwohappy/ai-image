# VIVIAI 前端真实 API 接入设计

## 目标

让 `viviai-web` 在配置真实 API 地址后使用 `viviai-server` 的真实会话、模型、报价、任务、上传、资产与积分接口，同时保留默认 Mock 模式用于开发演示和单元测试。

## 范围

### 本次接入

- Cookie 会话：当前用户、登录、注册、验证码、重置密码、退出。
- 目录与计费前置：模型目录、服务端报价、积分流水。
- 创作：文生图、用户参考图复刻、任务列表/详情、取消、失败重试。
- 资产：上传、列表筛选、私有内容预览/下载、收藏、重命名、删除、恢复。
- 运行时配置：真实 API 根地址、MSW 开关、同源/跨源凭据。

### 明确不在本次接入

后端尚未提供真实业务接口的灵感、爆款模板库、AI 工具、工作流、通知、邀请等页面继续使用 Mock；前端不向不存在的后端路由发请求。支付页继续使用既有 `/api/billing` 适配器，不与创作 API 客户端混合。

## 真实后端约束

- 所有创作输入必须符合后端 `input-schema.ts`：`source` 使用 `create` 或 `remix`，格式为 `png`，质量为 `standard`。
- 创建任务必须先调用 `POST /api/generation-quotes`，再调用 `POST /api/generation-tasks` 或 `POST /api/remix-tasks`，body 为 `{ quoteId, input }`。
- 创建与重试必须发送合法的 `Idempotency-Key`，同一操作重放使用同一 key。
- 真实请求携带 `credentials: include`，服务端 Cookie 是唯一会话凭据。
- 上传接口只发送 multipart 的 `file` 字段；服务端负责解码、尺寸读取、规范化和资产持久化。
- `GET /api/assets/:id/content` 返回二进制，不是 JSON envelope；前端使用同一 API 根地址生成私有内容 URL。
- 模型的可用分辨率、比例、精确像素和单价以 `GET /api/models` 的服务端返回为准，前端不再使用固定旧模型 ID 或本地价格计算任务金额。
- `/auth/send-code` 必须发送 `purpose`；真实注册/重置密码遵守后端最小 12 位密码约束。

## 客户端架构

`src/services/api.ts` 作为唯一业务 API 边界，拆成以下职责但保留现有 `api` 导出以减少页面改动：

1. `apiConfig`：读取 `VITE_API_BASE_URL`、判断 real/mock 模式、规范化 `/api` 前缀。
2. `request`：JSON envelope 解析、二进制响应、错误码、超时、`credentials: include`、可选请求头。
3. `createGenerationQuote` / `createGenerationTask`：封装报价→受理两步流程与幂等 key。
4. `normalizeModel` / `normalizeTask` / `normalizeAsset`：把服务端 DTO 映射到现有 UI 领域类型；保留后端精确 `specs` 供参数面板使用。

`AppProviders` 仅在 Mock 模式启动 MSW。真实模式中不启动 worker，不拦截或改写后端响应。

## 领域类型调整

- `Resolution` 增加 `0.5K`。
- `ModelConfig` 增加可选 `simulated`、`formats`、`maxReferenceImages`、`unitCredits`、`specs`（`id/resolution/ratio/width/height/imageSize?/unitCredits?`）。
- `GenerationTask` 增加可选 `stage`、`cancelRequested`、`items`，兼容后端任务 DTO；继续兼容 Mock 的 `mockLifecycle`。
- `ImageAsset` 的 `imageUrl`/`thumbnailUrl` 由服务端资产 DTO 或 `/assets/:id/content` 派生，不持久化 blob URL。
- `UploadedReference` 使用服务端真实 UUID；上传预览 URL 仅保留在内存草稿中。

## 失败与恢复

- 401：清除 `me` 查询并让页面跳转登录（保留原有 redirect 草稿）。
- 402：显示服务端积分不足信息并链接套餐页。
- 409：展示报价过期、价格变化、参数不支持、幂等冲突等服务端消息；不静默重试。
- 请求超时/网络错误：保留草稿，不重复创建任务；任务已提交后由轮询查询最终状态。
- 真实模式下 UI 进度来自任务列表轮询；不使用 Mock 的本地生命周期字段。

## 配置与本地运行

推荐在 `viviai-web/.env.local` 设置：

```env
VITE_API_MODE=real
VITE_API_BASE_URL=http://localhost:3001
```

后端 `CORS_ORIGINS` 必须包含前端实际 Origin（例如 `http://localhost:3000` 或 `http://localhost:3010`）。未设置 `VITE_API_MODE=real` 时默认 Mock，保证现有页面测试与演示不需要数据库。

## 验收标准

- Mock 测试全部保持通过。
- 新增客户端测试覆盖：API 根地址、credentials、send-code purpose、报价→任务 payload/idempotency、真实模型 specs 映射、二进制资产 URL、真实模式不启动 MSW。
- `VITE_API_MODE=real` 下，登录后能从真实 `/api/models` 渲染模型与合法尺寸；上传参考图、报价、创建任务、轮询和资产内容链路使用后端接口。
- 类型检查、构建与 lint 通过。
