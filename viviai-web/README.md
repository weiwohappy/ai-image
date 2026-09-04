# VIVIAI 前端 Mock

VIVIAI 是一个面向商业图片生产的深色创作工作台。本项目先完成前端产品闭环，所有接口由 MSW 在浏览器中模拟，可演示登录、图片生成、爆款复刻、资产、AI 工具、批量工作流、套餐购买、积分、通知与邀请。

## 本地运行

```bash
npm install
npm run dev
```

打开终端输出的 Local 地址。页面使用 Hash Router，例如 `/#/create`。

演示账号：

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

## Mock 行为

- 数据首次从固定样例初始化，并持久化在 `localStorage` 的 `viviai-mock-db-v1`。
- 创建任务后依次进入排队、生成和成功状态；失败与部分成功的结算逻辑已在 Mock 数据层保留。
- 购买流程只有显式的“模拟支付成功”按钮，不会产生真实订单或扣款。
- 图片均为代码生成的抽象演示视觉，不包含 VIVIAI 来源站点的品牌素材或第三方作品。
- 可通过 `POST /api/mock/reset` 恢复初始演示数据。

## 接入真实后端

UI 组件只依赖 `src/services/api.ts`，不直接读取 Mock 数据。替换后端时只需停止 `src/app/AppProviders.tsx` 中的 MSW worker，并把 `src/services/api.ts` 的 API 根地址指向正式服务；页面、查询键和领域类型可以继续复用。

模型调用、支付、邮件、对象存储、内容安全与鉴权必须在服务端实现，前端不得持有模型供应商密钥。
