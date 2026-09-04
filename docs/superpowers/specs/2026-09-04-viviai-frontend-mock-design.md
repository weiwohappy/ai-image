# VIVIAI 前端 Mock 产品设计规格

> 日期：2026-09-04  
> 状态：已批准执行  
> 依据：`VIVIAI产品需求分析_PRD.md`  
> 视觉方向：A「Midnight Studio · 深色创作工作台」

## 1. 目标与边界

首版交付一个可运行、可演示、可测试的完整前端产品，而不是静态页面集合。用户应能在没有真实后端的情况下完成注册登录、图片生成、爆款复刻、资产管理、工具执行、工作流批量运行、套餐购买和账户管理等核心流程。

所有业务页面只通过统一服务层访问数据。当前由 MSW 拦截 HTTP 请求并返回模拟结果；真实后端上线后只需关闭 Mock worker、替换 API 基础地址，不重写页面组件和状态逻辑。

本阶段不包含真实模型调用、真实支付、邮件发送、对象存储、服务端鉴权、运营后台和 API Key 管理。上述能力在 UI 中分别以异步任务、支付状态、验证码提示和受控文件预览进行模拟。

## 2. 技术方案

- React + TypeScript + Vite 构建 SPA。
- React Router 管理公开路由、受保护路由和登录后回跳。
- TanStack Query 管理服务端状态、缓存、失效、轮询和错误重试。
- Zustand 管理登录用户、积分展示、草稿和全局任务抽屉等跨页面状态。
- MSW 实现与未来后端一致的 REST API Mock。
- Tailwind CSS 实现设计令牌、响应式布局和深色主题。
- Vitest + Testing Library 验证组件和业务规则。
- Playwright 验证用户核心闭环。

目录按业务域组织：`app` 负责启动与路由，`features` 承载业务模块，`components` 提供无业务耦合的通用组件，`services` 定义请求契约，`mocks` 提供处理器和场景，`stores` 只保存必要的跨页客户端状态。

## 3. 信息架构与路由

### 3.1 公开路由

| 路由 | 页面 | 说明 |
|---|---|---|
| `/login` | 登录 | 支持回跳目标参数 |
| `/register` | 注册 | 模拟验证码和注册奖励 |
| `/forgot-password` | 找回密码 | 模拟验证码和重置成功 |
| `/inspiration` | 灵感广场 | 游客可浏览，点赞需登录 |
| `/remix` | 爆款模板库 | 游客可浏览和筛选 |
| `/remix/:templateId` | 模板详情 | 游客可查看，提交生成需登录 |
| `/pricing` | 套餐 | 游客可浏览，购买需登录 |

### 3.2 工作区路由

| 路由 | 页面 | 说明 |
|---|---|---|
| `/create` | 图片生成 | 默认工作台首页 |
| `/assets` | 资产中心 | 搜索、筛选、收藏和批量操作 |
| `/tools` | 工具中心 | 工具搜索和分类 |
| `/tools/:toolId` | 工具执行 | 通用工具执行框架 |
| `/workflows` | 工作流列表 | 新建、搜索和任务入口 |
| `/workflows/:workflowId` | 工作流编辑器 | 表格式任务编排 |
| `/tasks` | 任务中心 | 单任务和批量任务状态 |
| `/account` | 个人中心 | 套餐、积分、兑换和安全设置 |
| `/invite` | 邀请有礼 | 链接、数据和积分记录 |

受保护路由未登录时跳转 `/login?redirect=...`。登录成功后返回原路由，并从 `sessionStorage` 恢复提示词、已选模板和表单草稿。

## 4. 应用外壳与视觉系统

桌面端采用固定左侧导航、顶部状态栏和弹性主内容区。移动端使用紧凑顶部栏与抽屉导航。左侧依次展示生成、灵感、爆款复刻、资产、工具、工作流和套餐入口；底部展示积分、用户头像与账户菜单。

设计令牌：页面底色 `#11120f`，侧栏 `#191a16`，卡片 `#1d1e1a`，分隔线 `#303228`，主文字 `#f2f4e9`，次文字 `#96998b`，主强调色 `#d8ff52`，错误色 `#ff6b5f`，成功色 `#59d69a`。荧光青柠只用于主要操作、选中态和关键数值，避免全页面高亮。

圆角以 12、16、20 像素三级为主；控件保持清晰边界和明显焦点环。图像内容可使用紫色、橙色、青绿色等高饱和背景，使生成结果成为视觉焦点。动画限定在 150–240ms，任务进度和骨架屏除外。

## 5. 核心组件边界

- `AppShell`：侧栏、顶部栏、响应式容器和任务抽屉入口。
- `PromptComposer`：提示词、参考图、模型、清晰度、比例和张数。
- `ModelParameterPanel`：根据模型能力动态生成兼容参数。
- `CreditEstimator`：根据服务端模型价格矩阵计算预计积分。
- `GenerationCard`：排队、生成中、成功、部分成功、失败和取消状态。
- `TemplateCard`：模板封面、标签、热度、收藏和复刻入口。
- `RemixWorkbench`：模板、主体素材、改编要求、复刻强度和参数摘要。
- `AssetPicker`：本地上传和资产选择两种模式。
- `AssetCard`：预览、下载、收藏、重命名、删除和作为参考图。
- `ToolRunner`：依据工具字段 Schema 渲染输入表单并提交任务。
- `WorkflowGrid`：行列编辑、依赖关系、选择和批量运行。
- `TaskDrawer`：跨页面展示进行中与最近完成任务。
- `PaywallDialog`：登录拦截、积分不足和套餐升级。
- `EmptyState`、`ErrorState`、`LoadingState`：统一列表反馈。

生成、复刻和工具共享上传、参数、积分预估和结果组件，但业务表单分别放在各自 feature 内，避免不同任务类型互相侵入。

## 6. Mock API 契约

统一响应包含 `data`、`message`、`requestId`；错误响应包含稳定 `code`。主要接口：

```text
POST   /api/auth/login
POST   /api/auth/register
POST   /api/auth/send-code
POST   /api/auth/reset-password
GET    /api/me
GET    /api/models
GET    /api/generation-tasks
POST   /api/generation-tasks
POST   /api/generation-tasks/:id/cancel
POST   /api/generation-tasks/:id/retry
GET    /api/inspirations
POST   /api/inspirations/:id/like
GET    /api/remix-templates
GET    /api/remix-templates/:id
POST   /api/remix-tasks
GET    /api/assets
PATCH  /api/assets/:id
DELETE /api/assets/:id
GET    /api/tools
POST   /api/tool-runs
GET    /api/workflows
POST   /api/workflows
PUT    /api/workflows/:id
POST   /api/workflows/:id/run
GET    /api/batches
GET    /api/plans
POST   /api/orders
POST   /api/mock/orders/:id/complete
GET    /api/point-ledger
GET    /api/notifications
```

处理器支持通过请求头 `x-mock-scenario` 或开发工具切换 `happy`、`slow`、`empty`、`unauthorized`、`insufficient-credits`、`partial-success` 和 `server-error` 场景。

## 7. 任务、积分与数据流

创建任务时，前端先校验必填字段，再由 Mock 服务校验登录、余额与并发。成功创建后立即冻结预计积分，任务依次经过 `queued → processing → succeeded | partial | failed | cancelled`。

TanStack Query 每 1.5 秒轮询进行中任务；任务终止后停止轮询并刷新用户余额、生成记录、资产和通知。成功任务确认扣除冻结积分并创建资产；失败任务返还全部冻结积分；部分成功只扣成功图片对应积分。

Mock 数据以内存状态为主，并序列化到 `localStorage`，保证刷新页面后登录态、资产、积分、工作流和任务结果仍可恢复。提供“重置演示数据”入口，用固定 seed 恢复默认内容。敏感信息不写入持久化数据，示例密码不参与真实验证逻辑。

上传图片使用浏览器对象 URL 做即时预览，同时保存体积受控的示例元数据；刷新后无法恢复的大文件明确显示为演示素材占位图。

## 8. 页面关键交互

### 图片生成

空提示词禁用提交；切换模型时保留仍兼容的参数。提交后结果卡立即插入记录区，展示排队与进度。积分不足时保留全部输入并打开升级弹窗。

### 爆款复刻

模板库支持分类、平台、行业、风格和搜索组合筛选。工作台自动带入模板版本、视觉分析和推荐参数。改编要求必填，主体素材可选，默认“平衡复刻”。提交前显示参数与预计积分摘要。

### 资产

支持搜索、来源/类型筛选、预览和批量选择。删除先确认，删除成功后提供短时撤销。资产可一键带回生成或复刻工作台作为参考素材。

### 工作流

新建时生成 3 行、2 个参考图列和 1 个生成列。草稿未保存前不进入列表。支持添加行、删除行、添加列、配置生成列和运行选中行；任务统计与积分预估实时更新。

### 套餐

购买弹窗模拟支付宝与微信支付。用户触发“已完成支付”后，订单进入成功状态并更新套餐、积分与并发；不接触真实支付渠道。

## 9. 错误与边界状态

所有请求必须区分加载、空数据、业务错误、网络错误和无权限。稳定错误码包括：`AUTH_REQUIRED`、`INVALID_CREDENTIALS`、`INSUFFICIENT_CREDITS`、`CONCURRENCY_LIMIT`、`MODEL_UNAVAILABLE`、`TEMPLATE_UNAVAILABLE`、`ASSET_INVALID`、`CONTENT_REJECTED`、`TASK_TIMEOUT` 和 `INTERNAL_ERROR`。

表单业务错误显示在对应字段附近；全局网络错误使用 Toast；页面级加载失败显示可重试错误页；登录过期打开登录提示并保留当前草稿。删除、取消任务和批量运行等高影响操作需要二次确认。

## 10. 测试与验收

单元测试覆盖积分计算、模型参数兼容、路由回跳、任务状态转换和工作流任务统计。组件测试覆盖 PromptComposer、CreditEstimator、AssetPicker、RemixWorkbench 和 PaywallDialog 的关键分支。

Playwright 至少覆盖：

1. 游客填写提示词后登录并返回完成生成。
2. 登录用户创建生成任务并在资产中心看到结果。
3. 从模板库进入复刻工作台并完成复刻任务。
4. 余额不足时表单不丢失，购买套餐后可继续生成。
5. 创建、保存并运行工作流，任务中心显示批量进度。
6. 失败任务退回积分，部分成功只扣成功图片积分。

基础可访问性要求：交互控件具备可读名称，键盘可完成主要流程，焦点清晰，文字和背景对比满足 WCAG AA。桌面 1440px、平板 1024px、手机 390px 三档进行视觉检查。

## 11. 实施顺序

先搭建工程与设计系统，再完成 Mock 数据层和应用外壳；随后按“生成闭环 → 爆款复刻 → 资产与工具 → 工作流 → 套餐与账户 → 集成测试”的顺序实现。每一阶段均要求有可运行页面、对应测试和状态场景，不积累到最后统一联调。
