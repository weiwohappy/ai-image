# VIVIAI 后端 · 阶段 A

这是可本地运行的后端基础闭环：真实账号、私有图片、报价、积分账本、任务、Outbox、Redis Worker 和两个模拟提供方。现有前端仍使用 Mock，尚未切换到本后端。

**当前不是生产就绪版本。** 本阶段不调用任何付费模型；独立代码审查因执行代理的账户用量限制尚未完成，不能把自动化测试通过等同于审查批准。

## 已实现与未实现

| 范围                                               | 当前状态                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| 账号、邮箱验证码、Cookie 会话、密码重置            | PostgreSQL 持久化；开发邮件写私有本地目录                          |
| 上传、下载、收藏、重命名、回收站                   | 逐次校验所有者；删除后七天可恢复                                   |
| 文生图 / 用户参考图复刻                            | 报价锁定参数及图片角色，复刻支持参考图 + 可选主体图                |
| 积分                                               | bigint 批次守恒、每张冻结、交付后结算、失败释放、过期退款归入过期  |
| 任务                                               | 幂等受理、列表详情、取消、失败项使用新报价重试                     |
| 多渠道网关                                         | 统一协议、能力过滤、预算和项目级配额；同步 / 异步模拟渠道          |
| 恢复                                               | 防重复派发、持久化上游尝试、查询、存储重试、超时退款、队列丢失恢复 |
| 真实模型 API、真实支付、订阅周期、社区、工作流运行 | 未实现 / 未开通，属于后续阶段                                      |

唯一可用产品是 `simulation-image-v1`，展示为“模拟图片（非 AI）”：1024 × 1024 PNG，每张 30 测试积分，1–4 张。输出图上也标注 SIMULATION / NOT AI GENERATED。模拟成本只是测试单位，不能用于实际采购成本或利润测算。

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

成功：`{data,message,requestId}`。错误另带顶层 `code`。所有写请求（包括登录）必须携带精确匹配 `CORS_ORIGINS` 的 `Origin`。登录后使用 Cookie；不要传 body.userId 作为身份。

| 方法与路径（前缀 /api）                       | 用途                                                    |
| --------------------------------------------- | ------------------------------------------------------- |
| GET /health、/health/ready                    | 存活与 PostgreSQL 就绪；不表示外部模型已开通            |
| POST /auth/send-code                          | `{email,purpose:"register"或"reset-password"}`          |
| POST /auth/register                           | `{email,username,password,code}`                        |
| POST /auth/login                              | `{account,password}`，account 可用邮箱或用户名          |
| POST /auth/logout、/auth/reset-password       | 注销 / `{email,password,code}`                          |
| GET /me、/point-ledger                        | 实际可用 / 冻结余额和最多 200 条最新流水                |
| POST /remix-references                        | 已登录用户 multipart 的 file 字段                       |
| GET /assets、/assets/:id、/assets/:id/content | 图片列表、元数据、私有原图                              |
| PATCH /assets/:id                             | `{name?,favorite?}`                                     |
| DELETE /assets/:id、POST /assets/:id/restore  | 回收站 / 七天内恢复                                     |
| GET /models                                   | 仅显示当前启用的模拟产品                                |
| POST /generation-quotes                       | 报价有效期五分钟，输入见下例                            |
| POST /generation-tasks、/remix-tasks          | `{quoteId,input}`，必须有 Idempotency-Key               |
| GET /generation-tasks、/generation-tasks/:id  | 当前用户任务；列表最多 100 条                           |
| POST /generation-tasks/:id/cancel             | 排队项释放积分；执行项记录取消意图并向提供方确认        |
| POST /generation-tasks/:id/retry              | 新 `{quoteId,input}` 和新 Key，count 等于原任务失败项数 |

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

未知参数、未开通模型、非 1K 方图、外部用户图片会被拒绝，不静默降级。上传接受单帧 JPEG / PNG / WebP，输入 ≤5 MiB、解码 ≤4000 万像素；旋转到正确方向并去除 EXIF，存储 PNG。匿名上传暂不支持。

任务公共状态：queued / processing / succeeded / partial / failed / cancelled；stage 额外说明 submitting、pending、unknown、materializing 等阶段。上游字段、对象存储 Key、密码/会话哈希不会进入公共 DTO。

## 关键一致性约束

- PostgreSQL 是事实来源；Redis 只传 itemId 调度提示。任务、逐张冻结和 Outbox 在同一数据库事务提交。
- 同用户同操作同 Key 只受理一次；不同参数冲突返回 409；已成功受理的重放优先于报价过期检查。
- 所有账务及任务修改先取得用户钱包事务锁，再操作 Item、预约和积分批次；渠道预算和配额使用固定顺序锁。
- 每个 Item 最多两次提供方尝试。只有明确未受理且不收费的可重试错误才允许等价切换；内容拒绝不自动换渠道。
- 提交状态失去租约变成 unknown，不直接重提。普通排队截止五分钟、交付截止十五分钟。
- 图片字节校验并持久化之后，才在同一事务发布资产、扣分及标记成功；存储失败查询同一个 Attempt，不重新生成。
- 超时退款不抹去供应商费用预留；迟到结果可以补记成本，不能重启终态或重新扣分。
- unknown 成本可能长期保留预算；未知执行仍占用对应配额。当前没有运营对账 / 人工解锁后台，上线前必须补齐。
- 已确认取消但费用未知时，释放执行名额，费用预留继续保留。
- 模拟渠道的配置是版本化代码常量；动态渠道发布、凭据轮换、真实合同价格与利润准入尚需后续实现。

## 验证

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

本机 Docker daemon 未启动，Docker 镜像/Compose 和真实 S3/SMTP 未完成运行验收；目前验证的是本地私有文件存储，S3 使用官方 SDK 但尚未联通真实桶。镜像默认 production；生产环境禁止模拟提供方、本地存储和开发邮件。阶段 A Worker 因没有真实适配器而拒绝生产启动。

本地存储只适用于受信任的开发目录，不能防御能任意修改该目录的其它本机进程。当前不执行图片物理清理，长期使用前需补充保留策略、备份与容量治理。列表暂为有界最新记录，不是完整分页后台。

下一步应完成独立安全 / 并发审查、真实渠道适配与验收，然后单独迁移前端 API。当前前端重置密码流程还需传 purpose=reset-password；旧 Mock 的模型/价格和匿名上传行为不能直接视为后端合约。
