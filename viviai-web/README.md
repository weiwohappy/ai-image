# VIVIAI 前端

VIVIAI 是一个面向商业图片生产的深色创作工作台。前端默认使用 MSW Mock，配置真实模式后可连接 `viviai-server` 的账号、模型、报价、任务、上传、资产和积分接口。

## 本地运行

```bash
npm install
npm run dev
```

打开终端输出的 Local 地址。页面使用 Hash Router，例如 `/#/create`。

Mock 演示账号：

- 邮箱：`demo@viviai.local`
- 密码：`demo1234`
- 积分兑换码：`VIVIAI2026`

## 常用命令

```bash
npm run test
npm run test:e2e
npm run build
npx tsc --noEmit
```

## 真实后端模式

复制 `.env.example` 为 `.env.local`，本地开发推荐留空 API 地址，让 Vite 将 `/api` 代理到 `http://127.0.0.1:3001`：

```env
VITE_API_MODE=real
VITE_API_BASE_URL=
```

如果前端和后端不通过同一开发代理，设置完整的 `VITE_API_BASE_URL`，例如 `http://localhost:3001`，并把前端实际 Origin 加入后端 `CORS_ORIGINS`。真实模式使用 `credentials: include` 携带 `viviai_session` Cookie，前端不保存或转发模型供应商密钥。

真实创作请求严格按以下顺序执行：

1. `POST /api/generation-quotes` 获取五分钟有效的服务端报价；
2. `POST /api/generation-tasks` 或 `POST /api/remix-tasks`，body 为 `{ quoteId, input }`，并携带 `Idempotency-Key`；
3. 轮询任务列表和活动任务详情，终态后刷新用户余额与资产。

模型面板的分辨率、比例和精确像素来自 `GET /api/models` 的 `specs`，不会拼接前端固定的非法组合。参考图上传只发送 multipart `file`，私有资产通过 `/api/assets/:id/content` 读取。

当前后端尚未提供灵感、平台爆款模板库、AI 工具、工作流、通知、邀请和个人资料编辑接口；真实模式会显示“暂未接入真实接口”，不会向这些 Mock-only 路由发请求。支付页仍使用既有 `/api/billing` 接口。

## Mock 行为

- 数据首次从固定样例初始化，并持久化在 `localStorage` 的 `viviai-mock-db-v1`。
- 创建任务后依次进入排队、生成和成功状态；失败与部分成功的结算逻辑已在 Mock 数据层保留。
- 购买流程只有显式的“模拟支付成功”按钮，不会产生真实订单或扣款。
- 图片均为代码生成的抽象演示视觉，不包含 VIVIAI 来源站点的品牌素材或第三方作品。
- 可通过 `POST /api/mock/reset` 恢复初始演示数据。

## 接入真实后端

UI 组件只依赖 `src/services/api.ts`，不直接读取 Mock 数据。替换后端时只需停止 `src/app/AppProviders.tsx` 中的 MSW worker，并把 `src/services/api.ts` 的 API 根地址指向正式服务；页面、查询键和领域类型可以继续复用。

模型调用、支付、邮件、对象存储、内容安全与鉴权必须在服务端实现，前端不得持有模型供应商密钥。
