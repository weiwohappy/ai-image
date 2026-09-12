# VIVIAI 后端

这是可本地运行的后端闭环：真实账号、私有图片、报价、积分账本、任务、Outbox、Redis Worker、两个模拟提供方及五款官方图片模型适配器。创作前端仍使用 Mock；付款页已独立连接后端，支付默认关闭。微信/支付宝说明见 [PAYMENTS.md](PAYMENTS.md)，官方模型配置及尺寸矩阵见 [OFFICIAL_MODELS.md](OFFICIAL_MODELS.md)。

**当前不是生产就绪版本。** 官方模型和支付默认关闭，测试不调用付费 API，真实 Key、模型账户权限和账单仍待联调。测试通过不代表已完成生产验收。

## 已实现与未实现

| 范围                                    | 当前状态                                                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 账号、邮箱验证码、Cookie 会话、密码重置 | PostgreSQL 持久化；开发邮件写私有本地目录                                                                       |
| 上传、下载、收藏、重命名、回收站        | 逐次校验所有者；删除后七天可恢复                                                                                |
| 文生图 / 用户参考图复刻                 | 报价锁定参数及图片角色，复刻支持参考图 + 可选主体图                                                             |
| 积分                                    | bigint 批次守恒、每张冻结、交付后结算、失败释放、过期退款归入过期                                               |
| 任务                                    | 幂等受理、列表详情、取消、失败项使用新报价重试                                                                  |
| 多渠道网关                              | 统一协议、精确型号/尺寸过滤、账号共享预算与配额；官方 Google / OpenAI、Sub2API 第三方 OpenAI 兼容渠道及模拟渠道 |
| 恢复                                    | 防重复派发、持久化上游尝试、查询、存储重试、超时退款、队列丢失恢复                                              |
| 微信 Native / 支付宝电脑网站支付        | 代码已接入，默认关闭；无商户凭据，未做真实联调                                                                  |
| 真实模型 API                            | 五款型号代码已实现，默认关闭；真实 Key 与账单联调后补                                                           |
| 订阅周期、现金退款、社区、工作流运行    | 未实现，属于后续阶段                                                                                            |

默认仅开放 `simulation-image-v1`，展示为“模拟图片（非 AI）”：1024 × 1024 PNG，每张 30 测试积分，1–4 张。输出图上也标注 SIMULATION / NOT AI GENERATED。模拟成本只是测试单位，不能用于实际采购成本或利润测算。官方型号须配置凭据、规格售价与采购价格后才出现在目录。

## 本地启动

需要 Node.js 22（已用 22.22.2 验证）、PostgreSQL 和 Redis。所有命令在此目录执行。

```bash
npm ci --legacy-peer-deps --no-audit --no-fund
cp .env.example .env
```

通过 shell / 进程管理器加载 `.env`，应用不自动读取环境文件。使用 Bash / Zsh 时可执行：

```bash
set -a
source .env
set +a

docker compose up -d postgres redis
npm run prisma:migrate
npm run build
```

Compose 中开发数据库、Redis、MinIO 仅映射到 127.0.0.1，开发密码不可用于生产。Docker 不可用时使用自己创建的本地 PostgreSQL / Redis，修改 `DATABASE_URL` 与 `REDIS_URL` 即可；不要重置已有数据库。

分别打开两个终端，加载同一份环境：

```bash
# API，默认 http://127.0.0.1:3001
npm start

# Worker，不另开 HTTP 端口
npm run worker:start
```

开发热更新分别使用 `npm run dev`、`npm run worker`。每个部署环境应设置独立的 `QUEUE_NAMESPACE`，API 和 Worker 指向同一数据库、Redis 和私有存储。

### 创建开发账号

手动设置 `DEV_SEED_EMAIL`、`DEV_SEED_USERNAME`、`DEV_SEED_PASSWORD`；密码必须自行设置为 12–128 个字符，没有默认登录密码。可选 `DEV_SEED_CREDITS=1000` 赠送零收入测试积分，默认 0，最大 1000000。

```bash
NODE_ENV=development npm run seed:dev
```

种子操作只新建账号，不覆盖任何已有密码。赠送也通过正式账本服务完成，不提供公开赠分或“模拟支付成功”接口。

## HTTP 合约

成功：`{data,message,requestId}`。错误另带顶层 `code`。浏览器写请求（包括登录）必须携带精确匹配 `CORS_ORIGINS` 的 `Origin`。仅两个精确支付回调路径例外，使用渠道验签和原生确认响应。登录后使用 Cookie；不要传 body.userId 作为身份。

| 方法与路径（前缀 /api）                       | 用途                                                         |
| --------------------------------------------- | ------------------------------------------------------------ |
| GET /health、/health/ready                    | 存活与 PostgreSQL 就绪；不表示外部模型已开通                 |
| POST /auth/send-code                          | `{email,purpose:"register"或"reset-password"}`               |
| POST /auth/register                           | `{email,username,password,code}`                             |
| POST /auth/login                              | `{account,password}`，account 可用邮箱或用户名               |
| POST /auth/logout、/auth/reset-password       | 注销 / `{email,password,code}`                               |
| GET /me、/point-ledger                        | 实际可用 / 冻结余额和最多 200 条最新流水                     |
| POST /remix-references                        | 已登录用户 multipart 的 file 字段                            |
| GET /assets、/assets/:id、/assets/:id/content | 图片列表、元数据、私有原图                                   |
| PATCH /assets/:id                             | `{name?,favorite?}`                                          |
| DELETE /assets/:id、POST /assets/:id/restore  | 回收站 / 七天内恢复                                          |
| GET /models                                   | 当前启用产品；官方 specs 列出分辨率/比例的有效组合及精确像素 |
| POST /generation-quotes                       | 报价有效期五分钟，输入见下例                                 |
| POST /generation-tasks、/remix-tasks          | `{quoteId,input}`，必须有 Idempotency-Key                    |
| GET /generation-tasks、/generation-tasks/:id  | 当前用户任务；列表最多 100 条                                |
| POST /generation-tasks/:id/cancel             | 排队项释放积分；执行项记录取消意图并向提供方确认             |
| POST /generation-tasks/:id/retry              | 新 `{quoteId,input}` 和新 Key，count 等于原任务失败项数      |

报价输入例子（文生图用 source=create 并移除图片与 strength 字段）：

```json
{
  "source": "remix",
  "modelId": "simulation-image-v1",
  "prompt": "参考图的构图用于新的商品场景",
  "referenceAssetId": "替换为当前用户上传的图片 UUID",
  "subjectAssetId": "可选，另一张主体图片 UUID",
  "strength": "balanced",
  "resolution": "1K",
  "ratio": "1:1",
  "format": "png",
  "quality": "standard",
  "count": 1
}
```

未知参数、未开通模型、型号不支持或未定价的尺寸组合、外部用户图片会被拒绝，不静默降级。模拟型号仍仅支持 1K 方图。上传接受单帧 JPEG / PNG / WebP，输入及规范化文件 ≤5 MiB、解码 ≤4000 万像素；旋转到正确方向并去除 EXIF，存储 PNG。匿名上传暂不支持。

任务公共状态：queued / processing / succeeded / partial / failed / cancelled；stage 额外说明 submitting、pending、unknown、materializing 等阶段。上游字段、对象存储 Key、密码/会话哈希不会进入公共 DTO。

## 关键一致性约束

- PostgreSQL 是事实来源；Redis 只传 itemId 调度提示。任务、逐张冻结和 Outbox 在同一数据库事务提交。
- 同用户同操作同 Key 只受理一次；不同参数冲突返回 409；已成功受理的重放优先于报价过期检查。
- 所有账务及任务修改先取得用户钱包事务锁，再操作 Item、预约和积分批次；渠道预算和配额使用固定顺序锁。
- 每个 Item 最多两次提供方尝试。只有明确未受理且不收费的可重试错误才允许等价切换；内容拒绝不自动换渠道。
- 提交状态失去租约变成 unknown，不直接重提。普通排队截止五分钟、交付截止十五分钟。
- 图片字节校验并持久化之后，才在同一事务发布资产、扣分及标记成功；已存结果从 stagedKey 恢复，模拟渠道还能查询同一个 Attempt。官方同步请求首次存储失败不重新生成。
- 超时退款不抹去供应商费用预留；迟到结果可以补记成本，不能重启终态或重新扣分。
- unknown 成本可能长期保留预算；未知执行仍占用对应配额。当前没有运营对账 / 人工解锁后台，上线前必须补齐。
- 已确认取消但费用未知时，释放执行名额，费用预留继续保留。
- 模拟渠道配置为代码常量；官方配置在进程启动加载，报价/任务保存版本化快照。动态渠道发布、自动凭据轮换、利润准入与运营对账后台仍待实现。

## 验证

### 运营平台 B1 团队管理

`/api/admin/team` 提供成员、邀请、普通自定义角色的持久化管理；`/api/admin/model-pricing` 提供官方模型分辨率积分定价，其余业务资源仍为只读。写入要求 `NODE_ENV=development`、`HOST` 为回环地址、全部 `ADMIN_ORIGINS` 为回环 Origin 且请求真实对端为回环 IP。生产启动阻断继续保留；`GET /api/admin/status` 返回 `stage: B1`、实际 `teamWritesEnabled` 和 `modelPricingWritesEnabled`。

定价读取使用 `models.read`；写入仅内置 `super_admin` 具有 `model-pricing.write`，不能授予自定义角色。价格为 1–1,000,000 整数，版本和幂等键防止覆盖并发修改。数据库价即时影响新报价；旧报价需重新确认，已提交任务金额与执行渠道保持原快照。未定价或停用不会采用旧 JSON 或模拟价格兜底。迁移不种价，无 API Key 也可配置价格。维护导入默认 dry-run：`npm run admin:import-model-prices`，明确批准导入后才用 `npm run admin:import-model-prices -- --apply`。详细迁移和恢复边界见 [ADMIN.md](ADMIN.md)。

邀请有效期 24 小时，密码重置有效期 30 分钟。两者仅首次响应返回 fragment 链接，由操作者复制转交；不会发送真实邮件。幂等重放仅返回 `linkUnavailable: true`，需新操作重新生成链接。角色变化、禁用和密码重置撤销旧会话、挑战及敏感授权；密码重置保留 MFA。普通新成员仍使用原 12 字符密码和 MFA 流程；显式本地账号例外不扩展至新成员。

迁移 `20260910030000_admin_team_management` 将旧角色数组转换为带外键的关系绑定，保留既有密码、MFA 和额外敏感授权。迁移必须在停用旧后台进程后的维护窗口执行；未知旧角色会使整个事务回滚。成功后旧代码不能直接恢复运行，须先准备与备份及绑定关系一致的反向迁移。

首次超级管理员仅能在数据库尚无 `super_admin` 账号绑定时离线创建。默认 dry-run，检查目标规范化邮箱、版本、可登录状态及本机配置。以下参数中的邮箱和版本必须来自已核对的目标，原因不得包含秘密：

```bash
npm run admin:super-admin -- --email=operator@example.test --expected-version=1 --reason='批准初次建立超级管理员'
# 核对 dry-run 后，仅增加 --apply 执行同一明确目标
npm run admin:super-admin -- --email=operator@example.test --expected-version=1 --reason='批准初次建立超级管理员' --apply
```

命令只增加超级管理员绑定，保留其它角色及凭据，提升版本并撤销会话；记录离线操作者为空的审计。已有超级管理员后必须走团队界面，不允许重复离线提升。账号仅禁用/启用，不物理删除；角色逻辑删除后标识不可复用。

测试必须使用任务专用数据库角色 / 数据库，允许创建自己的测试 schema。每个集成套件创建随机 `viviai_test_*` schema，只清理自己拥有的 schema；Redis 队列同样使用独立 UUID 命名空间，不执行 Redis flush。

```bash
npm run typecheck
npm run build
npm test
npm run smoke
npm run format:check
```

`smoke` 会自行启动临时 HTTP API 和真实 Redis Worker，走注册→双图上传→报价→重复提交→轮询→下载→余额/流水，并分别验证成功、失败和 unknown。它使用模拟渠道，不调用付费 API；测试账号、隔离 schema 和测试队列会清理。

本地验证环境：PostgreSQL 16.9、Redis 7.4.2、Node 22.22.2。包含100次同 Key 并发受理、多用户余额/配额竞争、四项部分结算、费用未知、迟到结果和真实 Redis 提示丢失恢复。最新精确结果见 [验证记录](./VERIFICATION.md)。

## 上线前边界

Docker 镜像/Compose 和真实 S3/SMTP 未完成运行验收；目前验证的是本地私有文件存储，S3 使用官方 SDK 但尚未联通真实桶。镜像默认 production；生产环境禁止模拟提供方、本地存储和开发邮件。Worker 必须至少有一个显式启用的提供方。

本地存储只适用于受信任的开发目录，不能防御能任意修改该目录的其它本机进程。当前不执行图片物理清理，长期使用前需补充保留策略、备份与容量治理。列表暂为有界最新记录，不是完整分页后台。

下一步应完成真实渠道/账单验收及运营对账能力，然后单独迁移前端 API。Sub2API 等第三方 OpenAI 兼容聊天/图片渠道通过 `SUB2API_*` 服务端环境变量配置：聊天可用 `npm run verify:sub2api` 做 `/v1/models` + `/v1/chat/completions` 最小验证，图片后台验证只检查 `/v1/models` 中的精确 `gpt-image-2`，不会自动产生图片费用。Nano Banana 仍需官方 Google Key 和官方 Interactions 配置；密钥不进 JSON、前端或 Git。当前前端重置密码流程还需传 purpose=reset-password；旧 Mock 的模型/价格和匿名上传行为不能直接视为后端合约。
