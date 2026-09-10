# 内部运营查询台 A

这是独立管理员身份的本地只读增量，不自动创建管理员、邀请、积分或业务数据。默认 `ADMIN_ENABLED=false`；`GET /api/admin/status` 只公开启用状态、环境、阶段及可选的本机密码模式标记，不公开账号名单。生产环境下启用管理员入口会被配置校验拒绝。外部审计归档、保留期与部署安全审查尚未验收，不能作为生产控制台上线。

## 本地运行

先按仓库的服务说明准备 PostgreSQL、Redis 和私有对象存储。迁移由环境所有者对明确选定的数据库执行；测试仅创建 `viviai_test_*` 自有隔离 schema，绝不迁移、重置或回填 public schema。

本地显式设置 `ADMIN_ENABLED=true`、`ADMIN_ORIGINS=http://localhost:3010,http://127.0.0.1:3010`，以及由安全随机源生成的 32 字节规范 base64 `ADMIN_MFA_ENCRYPTION_KEY`。密钥仅由本地受保护配置或秘密管理系统注入，不写入源码、前端、日志或命令输出。加密密钥变更会使既存 MFA 密文不可读，A 不提供未经审核的在线轮换路径。

Node 22 下使用 `npm run dev` 启动 API，独立前端默认使用 3010，经同源代理转发 `/api/admin`，保留原始 Origin。管理员 Origin 与普通用户 Origin 独立校验，所有不安全方法包括登录、接受邀请、MFA、退出和隐私授权均要求匹配管理员白名单。支付 webhook 的已有例外保持不变。

管理员 Cookie 为 `viviai_admin_challenge` 与 `viviai_admin_session`，HttpOnly、SameSite=Strict、Host-only、Path=/api/admin。生产 Cookie 配置为 Secure，但本增量拒绝生产启用；本地 HTTP localhost/127.0.0.1 使用开发例外。普通 `viviai_session` 永远不能授权管理员 API。管理员响应均 `Cache-Control: no-store`。

## 离线初始化与紧急撤销

以下为离线初始化用法，服务启动不会自动初始化员工。CLI 需要显式 `NODE_ENV=development`（或隔离测试的 test）和 `DATABASE_URL`；只能用于所有者明确指定的本地环境。

准备一个当前用户所有、权限 0600 的常规 JSON 文件，例如 `/absolute/private/admin-invitations.json`。内容是恰好两项、邮箱不同的数组；每项必须显式给出角色，没有默认员工、密码或角色：

```json
[
  { "email": "operator-one@example.test", "roles": ["owner"] },
  { "email": "operator-two@example.test", "roles": ["system_admin"] }
]
```

可选 `extraPermissions:["sensitive.read"]` 必须在离线邀请中明确写出；查看客户内容还必须具备 `jobs.read`，例如 support + sensitive.read。预定义角色为 owner/support/finance/model_operator/content_operator/system_admin，具体只读权限由 `/roles` 展示。Owner 不默认拥有隐私读取权限。

```sh
NODE_ENV=development npm run admin:bootstrap -- bootstrap --input=/absolute/private/admin-invitations.json --output=/absolute/private/new-one-time-invitations.json
```

输出必须是全新的绝对文件路径，CLI 以排他创建和 0600 权限写入，文件中包含一次性邀请 token 与 24 小时截止时间；控制台不打印 token。文件写入与 fsync 成功之后才提交邀请事务。已有任一管理员、邀请或初始引导审计记录时拒绝再次填充，即使邀请已经过期也不能借此绕过后续权限审批。失败时可能留下空文件或无效邀请文件，应由所有者检查该明确文件；数据库提交失败时其中 token 无效，重试必须使用新输出路径。

所有者通过受控私有通道向对应邮箱人员交付邀请；前端可使用 `/#/accept?token=...`，避免 token 出现在服务端 URL 日志。邀请绑定邮箱，只消费一次。接受后创建 pending 账号并要求 TOTP；若响应丢失，可凭刚设置的密码重新登录，继续同一 MFA 注册。首次 TOTP 成功仅返回一次 8 个恢复码，数据库仅持久化其 SHA-256 哈希。挑战有效期 10 分钟、最多 5 次失败；TOTP 为 SHA1、6 位、30 秒、±1 步，计数器防重放。会话空闲 30 分钟、绝对 8 小时失效；每次请求重新读取状态与角色。IP/凭据认证限额写入数据库，失败计数不会因返回错误而回滚。

紧急撤销使用另一个 0600 JSON 文件，仅允许 `email`、`reason`（10–500 字）两个字段：

```json
{ "email": "operator-one@example.test", "reason": "应急响应工单 123，撤销该账号访问权限" }
```

```sh
NODE_ENV=development npm run admin:bootstrap -- revoke-account --input=/absolute/private/admin-revocation.json
```

撤销仅禁用账号、提高 authVersion、令会话过期并删除挑战，同时追加审计，不修改角色，不允许提权。已撤销会话与历史授权理由保留，供后续审计；不会因退出登录级联删除理由。线上邀请、角色修改及其审批属于后续阶段。

## HTTP 与筛选

### 本机临时密码例外

默认邀请设置密码与密码登录均要求 12–128 个字符，没有任何默认密码。只有所有者明确用于本机测试时，才可在私有启动环境中设置 `ADMIN_LOCAL_TEST_EMAILS`（逗号分隔，最多两个不同的完整邮箱；示例配置默认空）。该例外允许指定邮箱使用 6–128 位密码；其他邮箱仍为 12–128 位。密码仍使用独立随机盐及 scrypt 散列，日志、状态接口和普通 DTO 不返回密码。

以下条件同时成立才允许例外：`NODE_ENV=development`，服务绑定 `127.0.0.1` / `::1` / `localhost`，所有管理 Origin 均为本机来源，请求地址也是回环地址。非开发环境、公开监听地址或远程管理 Origin 携带该配置时拒绝启动，即使 `ADMIN_ENABLED=false` 也不忽略非法例外。不要将本机开发入口通过远程代理、隧道或共享服务暴露出去。

该配置不会创建账号、设置密码、扩大角色或跳过邀请和 MFA。用户须有有效邀请；待激活账号仍需验证器绑定成功才签发完整会话，不能凭临时密码直接进入工作台。移除 allowlist 后，短密码登录再次被拒绝；正式使用前必须恢复强密码并移除本机例外。状态接口仅在该模式有效时额外返回 `localTestPasswords: true`，不公布邮箱名单；前端据此调整本机提示，服务端始终负责最终校验。

所有 JSON 使用既有 `{data,message,requestId}` 成功包络；错误含 `code`。私有图片字节不包 JSON。固定 DTO 见 `src/modules/admin/contracts.ts`；金额/积分/美元微元均是十进制字符串，时间是 UTC ISO，中文 label 与 notices 用于前端显示。前端按 Asia/Shanghai 展示时间。

列表默认 30、上限 100。`limit` 为正整数字符串，`cursor` 为服务器生成的不透明游标；数据库列表按 `(createdAt DESC,id DESC)` 排序，游标锚定数据库原始行避免时间戳毫秒截断造成遗漏。静态目录使用固定时间与 ID 顺序。日期范围必须是含 Z 或 UTC 偏移的有效 ISO datetime，from ≤ to。没有提供的筛选键一律拒绝，数组/重复键与畸形游标返回 400。

| GET 路由                   | 支持的筛选（除 cursor/limit）                                                         |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `/users`                   | q=精确 UUID 或邮箱；from/to=创建时间                                                  |
| `/users/:id/credit-lots`   | q=精确批次 UUID；from/to                                                              |
| `/users/:id/credit-events` | q=精确流水 UUID；status=流水 type；from/to                                            |
| `/orders`                  | q=精确 UUID 或订单号；status；userId；source=支付 channel；from/to                    |
| `/jobs`                    | q=精确 Job UUID；status=包含该单图状态；userId；modelId；source=create/remix；from/to |
| `/models`                  | q=精确模型 ID；status=enabled/disabled                                                |
| `/provider-accounts`       | q=精确供应商配额账号 ID（如 official-google-账号scope）                               |
| `/alerts`                  | q=精确告警 UUID；status=active/resolved；source=告警 kind；from/to=首次创建           |
| `/audit-events`            | q=精确审计 UUID；status=allowed/denied；from/to                                       |
| `/administrators`          | q=精确管理员 UUID/邮箱；status；from/to                                               |
| `/roles`                   | q=精确角色名                                                                          |

`/dashboard` 不接受筛选。详情为 `/users/:id`、`/orders/:id`、`/jobs/:id`、`/attempts/:id`、`/models/:id`。模型规格表列键为 `id,resolution,ratio,width,height,enabled,credits`。目录包含全部五个定义；禁用规格不显示有效售价，不宣称已通过线上验证。供应商账号使用运行时实际 quotaScope/budgetScope，同账号多个模型与规格不重复累加限额；余额字段明确 null。告警重算用单个事务和投影锁串行化，仅改告警投影，不修改业务状态。

## 敏感内容与审计

`POST /sensitive-access-grants` 接受 `{jobId,reason}`，理由 10–500 字，拒绝常见凭据、Bearer、私钥、JWT 与连续长 token 格式。授权保存可读业务理由；审计只保存资源引用及理由摘要，绝不记录整个请求体。理由应填写工单/排查目的，不粘贴客户提示词或任何凭据。

`GET /jobs/:id/sensitive?grantId=...` 返回提示词及已关联图片元数据；`GET /assets/:id/preview?grantId=...` 仅读取私有 ObjectStore 中的既存字节，不取任意 URL。授权有效期 5 分钟，绑定管理员、会话和确切 Job；每次使用重新检查角色、账号状态、有效期、资产所有人以及 pinned input/result 关系。预览在存储读取后再次校验并审计，审计成功才释放字节。错误会安全拒绝，不提供外部 URL。授权不是公开分享链接。

SQL trigger 拒绝对审计行 UPDATE/DELETE；成功变更与审计同事务，拒绝敏感访问在独立事务持久记录。应由部署所有者配置独立审计归档与不可篡改存储，A 不宣称 SQL 拥有者无法修改数据库。

生命周期事件只从实际 dispatch/受理/本地物化/交付/终止事务记录，唯一 `(itemId,event)` 保留首次观察时间，历史缺失明确无数据。排队耗时不可用可变 updatedAt 推测。退款、手续费、净利润、通知、内容运营、资金/价格/配置/重试变更均未接入，不提供假成功。

## 验证

```sh
npm run typecheck
npm test
```

集成测试需要 DATABASE_URL 与 REDIS_URL 指向所有者提供的本地测试服务，自动创建和清理拥有的测试 schema。测试中的账号、密钥、私有素材均为隔离夹具；不会调用真实模型/支付接口，不会初始化真实员工。
