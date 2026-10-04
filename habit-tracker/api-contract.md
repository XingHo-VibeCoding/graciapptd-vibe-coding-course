# 自律计划 · API 接口契约（api-contract.md）

- 版本：v1.2（2026-10-04 Day 18 起升版；v1.1 于 2026-10-03 Day 17、v1.0 于 2026-10-01 Day 15）
- 作用：**前端和云端之间的"合同"**。前端按这份文档发请求，后端按这份文档回数据；任何一方想改形状，先改这份文档，再改代码（R2 文档先行）。
- **定位**：这是**第 3 周建表（Day 16）和写接口（Day 17–20）的唯一依据**。
- **当前实现进度**：`GET /api/health`（Day 15）、`GET /api/day` + `GET /api/checkins`（Day 17）、`POST /api/checkins`（Day 18，第一个写入接口）；其余仍为占位，按 Day 19–20 逐个实现。
- 依据：`TECH_DESIGN.md` §三 数据模型 / §四 API 列表；并按 `frontend/index.html` 的**实际功能面**补全（Day 15 新增：专注计时 / 纪念&倒数日 / 肯定语 / 主题换肤）。

> **⚠️ 课程示例接口名与本项目的关系**（Day 17 与用户确认，勿再纠结）：
> 课程案例里出现的是 `GET /api/hot`（热搜）与 `GET /api/favorites`（收藏），那是课程演示项目的接口。
> **本项目是打卡应用，既没有热搜概念、也没有收藏模型**，所以：
> - `GET /api/favorites` → 对应本项目的**「列表读取」接口**（今天页待办列表就是第一个：`GET /api/checkins`）；
> - `GET /api/hot` → **本项目没有对应物**。课程它要考察的实质是"接口读出来的必须是**真库里的真实数据**，不是前端 mock / 假数据"，
>   本项目用 `GET /api/day` + `GET /api/checkins` 读 CloudBase 真库来达成同一个目标（Day 17 验收方式见 §六）。
>
> **Day 18 同理**：课程要求"正常 POST 返回 `{ok:true,...}`"。本项目**统一信封是铁律**（见 1.2），
> 所以成功返回 `{"code":0,"message":"已添加","data":{...}}` —— `code:0` 就是本项目里"成功"的表达，
> 与课程的 `ok:true` 同义。**以本文档为准**（课程自己也要求"形状与 api-contract.md 一致"）。


> **怎么用这份文档**（给未来的自己）：
> 1. 前端要调接口 → 只查本文档，不猜路径；
> 2. 后端要写接口 → 照本文档的"响应形状"照抄，不许自由发挥；
> 3. 要改 → 先改本文档并提交，再改代码（R2）。

---

## 一、通用约定（所有接口都遵守）

### 1.1 地址

| 项 | 值 |
|---|---|
| Base URL | `https://habit-tracker-d9gh0mjel767ff0d2.service.tcloudbase.com/api`（真实值，2026-10-03 部署后登记） |
| 承载方式 | CloudBase **云函数 `api`**（Node.js 20，单函数承载全部路由），由「HTTP 访问服务」暴露为公网地址 |
| 请求头 | `Content-Type: application/json`（写操作必带）；`Idempotency-Key: <uuid>`（写操作**建议必带**，见 1.6） |
| 跨域 CORS | ⚠️ **本期不配置**（Day 16–20 再处理）。浏览器从别的域名直接 `fetch` 会被拦，属预期；本阶段测试走**浏览器地址栏**或 `curl` |

### 1.2 响应形状

**A. 业务接口 —— 统一信封（铁律）**

无论成功失败，**HTTP 状态码一律 200**，业务结果看 `code`。这样前端只需要一套判断逻辑。

```json
{ "code": 0, "message": "ok", "data": {} }
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `code` | number | `0` = 成功；非 0 = 失败（见 1.3） |
| `message` | string | 中文，可直接展示给用户（如"这一天只能查看"） |
| `data` | object \| array \| null | 成功时的业务数据；失败时统一 `null` |

**B. `GET /api/health` —— 唯一例外（扁平返回）**

健康检查没有业务语义，是"存活探针"，**不走信封**，直接返回扁平对象：

```json
{ "ok": true, "service": "Self discipline plan" }
```

> 为什么允许这个例外：探针要能用一行 `curl` 或地址栏一眼看懂，套信封反而多一层。
> **例外只有这一个**，以后新增的任何业务接口都必须走 A 的信封。

### 1.3 错误码表

| code | 含义 | 谁的问题 | 前端应做什么 |
|---|---|---|---|
| `0` | 成功 | — | 正常渲染 |
| `400` | 参数缺失或非法（如日期格式不对） | 用户/前端 | 提示 `message`，不改本地数据 |
| `401` | 未取得身份（匿名 uid 缺失） | 前端 | 重新初始化匿名登录，重试一次 |
| `403` | 越权（想动别人的数据） | 前端 | 提示并停止操作 |
| `404` | 路径或资源不存在 | 前端 | 提示"功能暂未开放" |
| `409` | 状态冲突（如给明天的待办打勾） | 用户 | 拒绝并解释原因（服务端也要拦，PRD A5） |
| `500` | 服务端异常（如数据库连不上） | 服务端 | 提示"保存失败，已暂存本地，稍后自动同步" |

### 1.4 身份约定

- 身份来自 CloudBase **匿名登录**生成的 `uid`，请求上下文自动携带。
- **前端永远不许明传 `uid`**（含 query、body、header）。谁的数据由服务端从上下文判定——这是防越权的第一道闸。
- 下文所有接口的"请求参数"里都**不会**出现 `uid`，这是刻意的。

> **⚠️ 实现现状（临时，等接入匿名登录那天收敛）**：匿名登录还没接，云函数取 `uid` 的顺序是
> ① `context.userInfo.uid`（平台注入，接上登录后自动生效）→ ② 函数环境变量 `DEMO_UID`（服务端配置的演示身份）。
> **两者都不来自请求参数**，所以"前端不许明传 uid"这条没有被破坏；但它意味着**现在所有人看到的是同一份演示数据**。
> 接入匿名登录、删掉 `DEMO_UID` 兜底、并按 §二 打开 RLS —— 这是一件事，**按课程安排在其对应那天一起做**，
> 不拆散。届时本段改写为"已接入"。


### 1.5 数据格式约定

| 类型 | 格式 | 例 |
|---|---|---|
| 日期 | `YYYY-MM-DD`（**本地自然日**，非 UTC） | `2026-10-01` |
| 时间 | `HH:mm` 24 小时制 | `09:30` |
| 时刻（时间戳） | 毫秒级 Unix 时间戳（number） | `1759302600000` |
| 空值 | 一律用 `null`，不用 `undefined` / 空字符串 | — |
| 布尔 | 真 `true` / 假 `false`（不用 0/1） | — |

### 1.6 写入幂等约定（Day 18 建立）

**为什么要有**：写接口最大的麻烦不是"写不进去"，而是"**同一次写入被执行了两次**"——
用户双击按钮、网络超时后客户端自动重试、用户刷新页面又提交一次……结果就是库里多出一条重复数据。
读接口天然幂等（读多少次都一样），写接口不是，所以必须专门防。

**怎么防 —— 客户端幂等键（idempotency key）**：

| 项 | 约定 |
|---|---|
| 字段名 | `clientReqId`（请求体字段），或请求头 `Idempotency-Key`；**两者都传时以 body 为准** |
| 取值 | 每次「添加动作」**现场生成一个** uuid（1~64 位字母/数字/下划线/短横线）；**同一个动作重发必须复用同一个值** |
| 语义 | 它标识的是**一次动作**，不是**一份内容** —— 所以用户真想加两条同名待办，两次用两个不同 id，照常写入 |
| 服务端处理 | 先查 `(uid, clientReqId)` 是否已写过 → 有则回 `409`；写入时由数据库唯一索引 `checkins_uid_reqid_uniq` 兜底并发 |
| 不传会怎样 | 不传 = **不启用幂等保护**（仅做字段校验）。手测/curl 可以不传；**前端必须传** |

**重复提交的响应**（两条路径文案一致）：

```json
{ "code": 409, "message": "请勿重复提交：这条待办刚刚已经添加过了", "data": null }
```

> **为什么不直接用"同一天 + 同内容"去重？**
> 因为 Day 16 已确认 `checkins` 没有天然唯一键（"写周报"一天可能出现两次），
> 按内容去重会把**合法的重复内容**也一起拒掉 —— 那是误伤。用动作 id 才能把
> "同一个动作重发"和"两次不同的添加动作"分开。

---

## 二、数据表清单（第 3 周 Day 16 建表依据）

> 表格从**前端页面的实际字段**反推，不是凭空设计。TECH_DESIGN §三 是 v2.0 版本（只有 4 张表），本期按 Day 18–22 新增的板块补全为 7 张。
>
> **建表进度（Day 16 建、Day 18 增补）**：**核心两表 `plan_days` / `checkins` 已建**，脚本在 `db/schema.sql`（含字段说明与约束），种子在 `db/seed.sql`（可重复执行），验证语句 `db/verify.sql`，设计说明 `db/README.md`。Day 18 给 `checkins` 加了幂等键列 `client_req_id` + 唯一索引，写在 **`db/schema-2.sql`**（增量脚本，**不改 `schema.sql`**）。其余 5 张表在需要它们的接口开工那天，按同样方式追加到 `db/schema-2.sql`。

| 表名 | 中文名 | 谁在用 | 说明 |
|---|---|---|---|
| `users` | 用户 | 我的页 | 匿名 uid 主键；姓名、主题偏好 |
| `plan_days` | 计划日 | 今天页 | **一天一条**，记录当天心情；打卡应用里的"那一天" |
| `checkins` | 打卡项 | 今天页 | **一天多条**，就是待办事项；含完成状态、时间、四象限 |
| `notes` | 想法流 | 思考页 | 一条一条的记录卡片 |
| `focus_sessions` | 专注记录 | 应用·专注计时 | 每次计时结束写一条 |
| `anniversaries` | 纪念&倒数日 | 应用·纪念&倒数日 | 公历/农历、周期重复、置顶、背景 |
| `affirm_likes` | 肯定语点赞 | 应用·肯定语 | 点过赞的语录索引集合 |

**核心两表说明**（对应课程示例的 `plan_days` / `checkins`）：

- `plan_days`＝**"这一天"本身**（日期 + 心情），`checkins`＝**"这一天的打卡项"**（待办列表）。
- 两者用 `date` 关联，`plan_days` 一天最多一条、`checkins` 一天可多条。
- 今天页首屏 = 这两张表的一次合并读取（见 `GET /api/day`）。

**建表时注意**：

1. 所有业务表都要有 `uid` 列并建索引——每个查询都必须带 `uid` 条件，**这是防越权的最后一道防线**（前端可以伪造参数，服务端不能只信参数）。
2. **统计一律现算不存**（PRD 原则）：完成数、连续天数、心情分布、月度报告都由 `report` 接口用 SQL 聚合直接算，**不建统计表**。
3. 时间戳列统一 `TIMESTAMPTZ NOT NULL DEFAULT now()`。

---

## 三、已实现接口

### `GET /api/health` —— 服务健康检查（Day 15）

**用途**：确认云函数活着、公网能通、返回的是合法 JSON。**不读数据库、不写业务逻辑**。

**请求**：无参数，无请求体。

**响应**（扁平结构，不走信封）：

```json
{ "ok": true, "service": "Self discipline plan" }
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `ok` | boolean | 恒为 `true`；服务不可用时根本不会返回（会超时或 5xx） |
| `service` | string | 恒为 `Self discipline plan`，用来确认"公网地址打开的是我自己的服务"，而不是缓存页或别人家的接口 |

**错误返回**：

| 情况 | 返回 |
|---|---|
| 方法不对（如 `POST /api/health`） | `{"code":404,"message":"接口不存在：POST /api/health","data":{"availableRoutes":["GET /api/health"]}}` |
| 函数内部异常 | `{"code":500,"message":"服务端出了点问题，稍后再试","data":null}` |

**验证方式**（Day 15 截图就是这一步）：

```bash
curl "https://<环境ID>.service.tcloudbase.com/api/health"
# 或在浏览器地址栏直接打开，应看到 {"ok":true,"service":"Self discipline plan"}
```

---

### `GET /api/day?date=YYYY-MM-DD` —— 今天页首屏合并读取（**Day 17 已实现**）

**用途**：打开今天页那一次请求，把当天要的东西一次取回，省往返。上方日期/心情来自 `plan_days`，下面的待办列表来自 `checkins`。

**请求参数**：

| 参数 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `date` | ⭕ | string | `YYYY-MM-DD`；不传默认**服务端当天（东八区）**，前端建议总是显式传，避免时区歧义 |

**响应**：同 §4.1 的定义（`{ code, message, data: { date, planDay, checkins } }`）。
`planDay` 为 `null` 表示这一天还没建过记录（**不是错误**，前端照常渲染空列表）。

**实际行为补充（实现细节，前端可依赖）**：

- `checkins` 的排序固定为 `sort` 升序（同日内），再以 `id` 兜底 → 顺序稳定。
- 数据库时间戳列（`created_at` / `updated_at` / `done_at`）在响应里统一是**毫秒数**；为空则为 `null`。
- 日期在响应里原样回传字符串 `YYYY-MM-DD`（不是时间戳）。

**错误返回**：

| 情况 | 返回 |
|---|---|
| 日期格式不对，或日期不存在（如 `2026-02-30`） | `{"code":400,"message":"日期格式不对，应为 YYYY-MM-DD","data":null}` |
| 未取得身份 | `{"code":401,"message":"登录状态失效，请刷新页面","data":null}` |
| 服务端异常（数据库连不上 / 表不存在） | `{"code":500,"message":"服务端出了点问题，稍后再试","data":null}` |

---

### `GET /api/checkins?date=&from=&to=&done=&limit=` —— 打卡项列表读取（**Day 17 已实现**）

**用途**：只读列表（周历切换、单日刷新、后续报告页取数）。

**请求参数**（全部可选）：

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `date` | string | — | 单日查询；**与 `from`/`to` 互斥**，同时传回 400 |
| `from` / `to` | string | — | 区间查询（含首尾），可只传一边 |
| `done` | boolean | — | `true` 只看已完成 / `false` 只看未完成 |
| `limit` | number | 20 | 返回条数上限，范围 **1–100**（Day 17 余力加练） |

**响应**：

```json
{ "code": 0, "message": "ok",
  "data": { "total": 8, "limit": 20, "items": [
    { "id": 101, "date": "2026-10-01", "text": "晨跑 30 分钟", "time": "07:30",
      "quad": "q2", "done": true, "doneAt": 1759302600000, "sort": 0 }
  ] } }
```

| 字段 | 说明 |
|---|---|
| `total` | **满足条件的总条数**（不是本页条数），前端靠它判断"还有没有下一页" |
| `limit` | 把生效的条数上限回显，方便前端判断是否被截断 |
| `items` | 本页数据；排序固定 `date` 升序 → `sort` 升序 → `id` 兜底 |

**错误返回**：

| 情况 | 返回 |
|---|---|
| 日期格式不对 / 日期不存在 | `{"code":400,"message":"日期格式不对，应为 YYYY-MM-DD","data":null}` |
| `date` 与 `from`/`to` 同时传 | `{"code":400,"message":"date 与 from/to 不能同时传，请二选一","data":null}` |
| `from` 晚于 `to` | `{"code":400,"message":"from 不能晚于 to","data":null}` |
| `done` 不是 `true`/`false` | `{"code":400,"message":"done 只能是 true 或 false","data":null}` |
| `limit` 不是 1–100 的整数 | `{"code":400,"message":"limit 必须是 1~100 的整数","data":null}` |
| 未取得身份 | `{"code":401,"message":"登录状态失效，请刷新页面","data":null}` |

---

### `POST /api/checkins` —— 新建打卡项（**Day 18 已实现，第一个写入接口**）

**用途**：用户在今天页加一条待办。

**请求头**：`Content-Type: application/json`；建议带 `Idempotency-Key: <uuid>`（见 1.6）。

**请求体**：

```json
{ "date": "2026-10-01", "text": "写周报", "time": "14:00", "quad": "q2", "clientReqId": "9f1c…" }
```

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `date` | ✅ | string | 归属日期 `YYYY-MM-DD`，必须真实存在 |
| `text` | ✅ | string | 内容；**去首尾空白后** 1–60 字 |
| `time` | ⭕ | string | `HH:mm` 24 小时制；不传 / 空串 = 未安排（存 `NULL`） |
| `quad` | ⭕ | string | `q1`/`q2`/`q3`/`q4`；不传 / 空串 = 未分类（存 `NULL`） |
| `clientReqId` | ⭕ | string | 幂等键（1~64 位字母/数字/`_`/`-`）；也可放请求头 `Idempotency-Key`（见 1.6） |

> **服务端补的字段**（前端不许传，传了也忽略）：`uid`（取登录身份）、`done`（恒 `false`）、
> `sort`（当天已有条目的最大 `sort` + 1，空的一天从 0 开始）。

**响应**：

```json
{ "code": 0, "message": "已添加",
  "data": { "id": 103, "date": "2026-10-01", "text": "写周报", "time": "14:00",
            "quad": "q2", "done": false, "doneAt": null, "sort": 5 } }
```

**错误返回**：

| 情况 | 返回 |
|---|---|
| 缺 `text` | `{"code":400,"message":"缺少必填字段 text（待办内容）","data":null}` |
| `text` 去空白后为空 / 超 60 字 / 不是字符串 | `{"code":400,"message":"内容不能为空，且不超过 60 字","data":null}` |
| 缺 `date` | `{"code":400,"message":"缺少必填字段 date（这条待办属于哪一天）","data":null}` |
| `date` 格式不对或不存在 | `{"code":400,"message":"日期格式不对，应为 YYYY-MM-DD","data":null}` |
| `time` 不是 `HH:mm` | `{"code":400,"message":"时间格式不对，应为 HH:mm（24 小时制）","data":null}` |
| `quad` 不在 q1~q4 | `{"code":400,"message":"象限只能是 q1 / q2 / q3 / q4","data":null}` |
| `clientReqId` 格式非法 | `{"code":400,"message":"clientReqId 只能是 1~64 位的字母、数字、下划线或短横线","data":null}` |
| 请求体不是合法 JSON | `{"code":400,"message":"请求体不是合法的 JSON","data":null}` |
| **重复提交**（`clientReqId` 已用过） | `{"code":409,"message":"请勿重复提交：这条待办刚刚已经添加过了","data":null}` |
| 未取得身份 | `{"code":401,"message":"登录状态失效，请刷新页面","data":null}` |

**防重复提交的两层**（实现细节，前端可依赖）：

1. **服务层预检**：先查 `(uid, clientReqId)` 是否已存在 → 有则 409。作用是给出友好中文提示。
2. **数据库唯一索引兜底**：`checkins_uid_reqid_uniq`（部分唯一索引，`WHERE client_req_id IS NOT NULL`）。
   并发下两个请求可能同时通过预检，真正兜住的是这一层；冲突时 PostgreSQL 报 SQLSTATE `23505`，服务端翻译成同一个 409。

> ⚠️ **不传 `clientReqId` 就没有去重保护**（仅做字段校验）。curl 手测可以省，**前端必须传**。

---

## 四、待实现接口（Day 19–20 逐个补；标 ✅ 的已在 §三 实现）

> 以下是第 3 周要落地的全部接口。**先定名字和形状，避免前端先写死后端再改。**
> **实现进度**：✅ `GET /api/day`、✅ `GET /api/checkins`（Day 17）；✅ `POST /api/checkins`（Day 18）；其余待做。

### 📌 先记住这条：别忘了「列表读取」接口

前端有 5 个地方需要**把一批记录读回来渲染成列表**，这类接口最容易被漏掉——因为写的时候只想着"提交"，忘了"打开页面要先读"：

| 页面 | 要读的列表 | 接口 |
|---|---|---|
| 今天页待办列表 | 当天的打卡项 | `GET /api/checkins` |
| 思考页想法流 | 全部/区间的想法卡片 | `GET /api/notes` |
| 应用·专注计时 | 当天的专注记录 | `GET /api/focus-sessions` |
| 应用·纪念&倒数日 | 全部纪念日 | `GET /api/anniversaries` |
| 应用·肯定语 | 点过赞的语录集合 | `GET /api/affirm-likes` |
| 我的页 | 姓名 + 主题偏好 | `GET /api/profile` |

> 课程案例里这条叫 `GET /api/favorites`；本项目的对应物就是上表这些"读取接口"。

---

### 4.1 今天页（`plan_days` + `checkins`）

#### `GET /api/day?date=YYYY-MM-DD` —— 首屏合并读取 ✅ **Day 17 已实现**

> **完整定义见 §三**（响应形状、全部错误码、排序与时间戳口径都在那里，此处不重复免得两边不一致）。

**字段速查**：

- `planDay` 为 `null` 表示这一天还没建过记录（**不是错误**，前端照常渲染空列表）。
- `mood` 取值：`sad` / `blue` / `calm` / `cozy` / `joy`，未打卡为 `null`。
- `quad` 取值：`q1` / `q2` / `q3` / `q4`，未分类为 `null`。
- `sort` 是当天内的手动排序位（用于"移动到其他日期"后保持顺序）。

#### `GET /api/checkins` —— 打卡项列表读取 ✅ **Day 17 已实现**

> **完整定义见 §三**（含 `limit` 条数限制参数 `1–100`、区间查询与全部错误码）。

#### `POST /api/checkins` —— 新建打卡项 ✅ **Day 18 已实现**

> **完整定义见 §三**（请求头、全部字段与校验规则、全部错误码、幂等与防重复提交的两层机制都在那里，此处不重复免得两边不一致）。

**字段速查**：`date` ✅、`text` ✅（去首尾空白后 1–60 字）、`time` ⭕、`quad` ⭕、`clientReqId` ⭕（幂等键，见 1.6）。

#### `PATCH /api/checkins/:id` —— 修改（打勾 / 改时间 / 改内容 / 改象限）

**路径参数**：`:id` = 打卡项 id。

**请求体**（只传要改的字段，其余不动）：

```json
{ "done": true }
```

| 字段 | 说明 |
|---|---|
| `done` | 打勾 / 取消打勾；服务端同时写 `doneAt` |
| `time` | 改时间，或传 `null` 清空 |
| `text` | 改内容 |
| `quad` | 改象限，或传 `null` 清空 |

**响应**：返回改完之后的完整对象（同 `POST` 的 `data`）。

**错误返回**：

| 情况 | 返回 |
|---|---|
| id 不存在 | `{"code":404,"message":"这条待办不存在或已删除","data":null}` |
| 不是自己的数据 | `{"code":403,"message":"无权修改这条待办","data":null}` |
| **给未来的待办打勾** | `{"code":409,"message":"这一天还没到，先别急着打勾","data":null}` |

> ⚠️ 最后一条是 PRD A5 的硬规则，**必须服务端拦**（前端禁用只是体验层）。

#### `DELETE /api/checkins/:id` —— 删除打卡项

**请求参数**：路径 `:id`。

**响应**：

```json
{ "code": 0, "message": "已删除", "data": { "id": 103 } }
```

**错误返回**：`404` 不存在 / `403` 非本人数据。

#### `PUT /api/days/mood` —— 写当天心情（覆盖式）

**请求体**：

```json
{ "date": "2026-10-01", "mood": "calm" }
```

**响应**：

```json
{ "code": 0, "message": "已记录", "data": { "date": "2026-10-01", "mood": "calm" } }
```

**错误返回**：

| 情况 | 返回 |
|---|---|
| `mood` 不在枚举内 | `{"code":400,"message":"心情取值不合法","data":null}` |
| 日期格式不对 | `{"code":400,"message":"日期格式不对，应为 YYYY-MM-DD","data":null}` |

> **覆盖语义**：同一天重复调用是"改心情"，不是"加一条"——`plan_days` 一天只有一条。

#### `GET /api/moods?from=&to=` —— 心情区间读取

**用途**：周历条、月历、报告里的心情分布。

**请求参数**：`from` / `to`（均为 `YYYY-MM-DD`，含首尾）。

**响应**：

```json
{ "code": 0, "message": "ok",
  "data": { "items": [
    { "date": "2026-09-30", "mood": "joy"  },
    { "date": "2026-10-01", "mood": "calm" }
  ] } }
```

**错误返回**：`400` 日期格式不对 / `400` `from` 晚于 `to`。

---

### 4.2 思考页（`notes`）

#### `GET /api/notes?from=&to=&limit=&offset=` —— 想法流列表读取

**请求参数**：

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `from` / `to` | ⭕ | — | 时间区间（`YYYY-MM-DD`） |
| `limit` | ⭕ | 20 | 每页条数，最大 100 |
| `offset` | ⭕ | 0 | 偏移（倒序分页） |

**响应**（**倒序**：最新的在前）：

```json
{ "code": 0, "message": "ok",
  "data": { "total": 37, "limit": 20, "offset": 0, "items": [
    { "id": 51, "text": "今天状态不错", "fromQuestion": false,
      "createdAt": 1759302600000, "updatedAt": 1759302600000 }
  ] } }
```

**错误返回**：`400` `limit` 超出范围 / `400` 日期格式不对。

> `total` 是**满足条件的总数**（不是本页条数），前端靠它决定"还有没有下一页"。

#### `POST /api/notes` —— 保存想法

**请求体**：

```json
{ "text": "今天状态不错", "fromQuestion": false }
```

**响应**：

```json
{ "code": 0, "message": "已记下一条想法",
  "data": { "id": 52, "text": "今天状态不错", "fromQuestion": false, "createdAt": 1759302600000 } }
```

**错误返回**：`400` `text` 为空或超长。

#### `PATCH /api/notes/:id` / `DELETE /api/notes/:id` —— 编辑 / 删除

**请求体**（PATCH）：`{ "text": "改过的内容" }` → 服务端同时更新 `updatedAt`。

**响应**：PATCH 返回改后完整对象；DELETE 返回 `{ "code": 0, "message": "已删除", "data": { "id": 52 } }`。

**错误返回**：`404` 不存在 / `403` 非本人数据。

---

### 4.3 应用·专注计时（`focus_sessions`）

#### `GET /api/focus-sessions?date=&from=&to=` —— 专注记录列表读取

**响应**：

```json
{ "code": 0, "message": "ok",
  "data": { "totalMinutes": 75, "items": [
    { "id": 7, "date": "2026-10-01", "duration": 25, "endedAt": 1759302600000 }
  ] } }
```

| 字段 | 说明 |
|---|---|
| `duration` | **分钟数**（number），与前端 `focus.logs[].duration` 一致 |
| `totalMinutes` | 该区间合计分钟，服务端算好返回，前端不重复算 |

**错误返回**：`400` 日期格式不对。

> 说明：`totalMinutes` 属于"统计"，但它是**跟随列表一起算的即时值，不另建表**——符合"统计现算不存"。

#### `POST /api/focus-sessions` —— 记一次专注

**请求体**：

```json
{ "date": "2026-10-01", "duration": 25 }
```

**响应**：`{ "code": 0, "message": "已记录", "data": { "id": 8, "date": "2026-10-01", "duration": 25, "endedAt": 1759302600000 } }`

**错误返回**：`400` `duration` 不是 1–180 的整数（与前端自定义时长上限一致）。

---

### 4.4 应用·纪念&倒数日（`anniversaries`）

#### `GET /api/anniversaries` —— 纪念日列表读取

**用途**：弹窗里的卡片列表（大卡片=置顶的那条，小卡片=其余）。

**响应**：

```json
{ "code": 0, "message": "ok",
  "data": { "items": [
    { "id": 1, "name": "春节", "type": "lunar", "month": 1, "day": 1, "year": null,
      "repeat": "yearly", "book": "节日", "advance": 7, "isPinned": true, "bg": "hero",
      "createdAt": 1759302600000, "nextDate": "2027-02-17", "daysLeft": 139 }
  ] } }
```

| 字段 | 说明 |
|---|---|
| `type` | `solar`（公历） / `lunar`（农历） |
| `year` | 仅 `repeat: "never"` 时有意义（一次性事件）；循环事件为 `null` |
| `repeat` | `yearly`（一年一次，过完自动重算） / `never`（只此一次） |
| `advance` | 提前几天提醒（0–30） |
| `isPinned` | 是否置顶；**服务端保证同一用户最多一条为 `true`** |
| `bg` | 卡片背景：`hero`（跟随主题图） / `default` |
| `nextDate` / `daysLeft` | **服务端算好返回**（农历换算在服务端做，前端不重复实现） |

**错误返回**：`401` 未取得身份。

> 说明：`nextDate` / `daysLeft` 是**派生字段**——库里只存月/日/年，算出来随响应带回，避免前端和服务器两套算法算出两个结果。

#### `POST /api/anniversaries` —— 新建纪念日

**请求体**：

```json
{ "name": "妈妈生日", "type": "lunar", "month": 8, "day": 15, "repeat": "yearly",
  "book": "家人", "advance": 3, "bg": "default" }
```

**响应**：返回完整对象（含算好的 `nextDate` / `daysLeft`）。

**错误返回**：

| 情况 | 返回 |
|---|---|
| `name` 为空或超 20 字 | `{"code":400,"message":"名称不能为空，且不超过 20 字","data":null}` |
| `month`/`day` 越界（如 2 月 30 日） | `{"code":400,"message":"这个日期不存在，请检查月/日","data":null}` |
| 农历该年无此日（如闰月三十） | `{"code":400,"message":"农历没有这一天，请换个日期","data":null}` |

#### `PATCH /api/anniversaries/:id` —— 修改 / 置顶 / 改背景

**请求体**（只传要改的）：

```json
{ "isPinned": true }
```

| 字段 | 说明 |
|---|---|
| `isPinned` | 置顶（服务端把该用户其他条自动取消置顶），**同一时刻只有一条为 true** |
| `bg` | 换背景 |
| `name` / `month` / `day` / `year` / `repeat` / `book` / `advance` | 同 `POST` |

**响应**：返回改后完整对象。

**错误返回**：`404` 不存在 / `403` 非本人数据 / `400` 日期非法。

#### `DELETE /api/anniversaries/:id` —— 删除

**响应**：`{ "code": 0, "message": "已删除", "data": { "id": 3 } }` — 错误：`404` / `403`。

---

### 4.5 应用·肯定语（`affirm_likes`）

#### `GET /api/affirm-likes` —— 点赞集合读取

**用途**：打开肯定语弹窗时，知道哪些语录已点赞（已点赞的从随机池里排除）。

**响应**：

```json
{ "code": 0, "message": "ok",
  "data": { "likes": [0, 3, 7], "bgIndex": 2 } }
```

| 字段 | 说明 |
|---|---|
| `likes` | 已点赞的**语录索引数组**（对应前端 `AFFIRM_QUOTES` 的下标，0–23） |
| `bgIndex` | 当前选中的背景序号（0–4） |

> `bgIndex` 是**界面偏好**，跟主题图选择一样属于"设置"；本期一并带回方便前端，正式建表时归入 `users` 表的偏好字段（见 §二）。

**错误返回**：`401` 未取得身份。

#### `PUT /api/affirm-likes` —— 覆盖式写入点赞集合

**请求体**：

```json
{ "likes": [0, 3, 7], "bgIndex": 2 }
```

**响应**：`{ "code": 0, "message": "已同步", "data": { "likes": [0, 3, 7], "bgIndex": 2 } }`

**错误返回**：`400` 索引超出 0–23 / `400` `bgIndex` 超出 0–4。

> **为什么用 PUT 覆盖而不是 POST 单条**：点赞/取消点赞是**一组集合的最终状态**，覆盖写天然幂等，网络重试不会写出重复数据。

---

### 4.6 我的页（`users`）

#### `GET /api/profile` —— 读姓名与主题偏好

**响应**：

```json
{ "code": 0, "message": "ok",
  "data": { "name": "自律的你", "theme": { "img": "assets/hero.jpg", "mode": "dark",
            "accent": "#3ecf8e", "ink": "#06281a", "deep": "#7ddcb0" } } }
```

| 字段 | 说明 |
|---|---|
| `name` | 未设置时服务端回默认值 `自律的你` |
| `theme` | v3.5 主题换肤的 4 个值：背景图 / 深浅模式 / 强调色三件套 |

**错误返回**：`401` 未取得身份。

#### `PUT /api/profile` —— 改姓名 / 改主题

**请求体**（只传要改的）：

```json
{ "name": "小自" }
```

或

```json
{ "theme": { "img": "assets/affirm-3.jpg", "mode": "light",
             "accent": "#e8604c", "ink": "#2a1208", "deep": "#f0866f" } }
```

**响应**：返回改后的完整 `profile`。

**错误返回**：

| 情况 | 返回 |
|---|---|
| `name` 超 12 字 | `{"code":400,"message":"名字不超过 12 个字","data":null}` |
| `mode` 不是 `dark`/`light` | `{"code":400,"message":"主题模式取值不合法","data":null}` |
| `accent` 不是合法 16 进制色 | `{"code":400,"message":"颜色格式不合法","data":null}` |

> 说明：**自定义上传的背景图**本期不入库（前端压缩后存本地）；等做文件存储时再定方案，届时本文档要先更新。

---

### 4.7 报告（统计，现算不存）

#### `GET /api/report?period=week|month` —— 统计 + 夸夸文案

**请求参数**：

| 参数 | 必填 | 说明 |
|---|---|---|
| `period` | ✅ | `week` 或 `month` |
| `anchor` | ⭕ | 基准日期 `YYYY-MM-DD`，不传默认今天 |

**响应**：

```json
{ "code": 0, "message": "ok",
  "data": {
    "period": "week", "from": "2026-09-28", "to": "2026-10-04",
    "stats": { "doneCount": 18, "totalCount": 24, "rate": 0.75,
               "activeDays": 6, "streak": 4, "focusMinutes": 210 },
    "moodDist": { "joy": 2, "calm": 3, "blue": 1 },
    "praise": "这周有 6 天都留下了痕迹，稳定比完美更重要。"
  } }
```

| 字段 | 说明 |
|---|---|
| `rate` | 完成率，0–1 的小数，前端负责格式化成百分比 |
| `streak` | 连续有记录天数 |
| `praise` | **夸夸文案由服务端拼装返回**（PRD F4），前端直接展示，不自己造词 |

**错误返回**：`400` `period` 不是 `week`/`month`。

---

## 五、命名与变更约定

**命名约定**：路径用**名词复数、小写下划线**（`/api/checkins`、`/api/focus-sessions`）；路径参数用 `:id`；筛选条件走 query。

**变更规则**（R2 的接口版）：

1. **先改文档再改代码**：接口路径、字段名、错误码要动，先在本文档改并提交，再改实现。
2. **只加不删**：字段只增不删；确需废弃时保留字段并标 `@deprecated`，等前端全部迁移完再删（避免线上旧页面白屏）。
3. **向后兼容**：新增可选参数、新增响应字段都算兼容；改字段含义、改类型算**破坏性变更**，必须升版本号。
4. **版本号**：本文档版本在开头维护；破坏性变更时文档版本与响应里的版本标识同步升。

---

## 六、部署记录

| 项 | 值 | 更新时间 |
|---|---|---|
| 云函数名 | `api`（内部路由 `/api/health`、`/api/day`、`/api/checkins`、**`POST /api/checkins`**） | 2026-10-04 |
| 环境 ID | **`habit-tracker-d9gh0mjel767ff0d2`**（2026-10-01 21:57 开通，免费体验版·上海） | 2026-10-03 |
| 云函数公网地址 | **`https://habit-tracker-d9gh0mjel767ff0d2.service.tcloudbase.com/api`** | 2026-10-03 |
| 前端 mock 版公网地址 | **`https://habit-tracker-d9gh0mjel767ff0d2-1499348397.tcloudbaseapp.com/`** | 2026-10-03 |
| 数据库 | CloudBase PostgreSQL 17.11；`plan_days`(7 行) + `checkins`(8 行种子 + 1 行 Day 18 写入验证行 = 9 行)，均 `uid='seed-demo-user'`；RLS 未开启 | 2026-10-04 |
| 建表脚本 | `db/schema.sql`（Day 16 核心两表）+ `db/schema-2.sql`（Day 18 幂等键列 `client_req_id` 与唯一索引 `checkins_uid_reqid_uniq`） | 2026-10-04 |
| 部署方式 | CloudBase CLI 3.8.5（`tcb`）；配置见 `cloudbaserc.example.json`（真实文件 `cloudbaserc.json` 含密钥、已被 .gitignore 排除） | 2026-10-03 |

> ⚠️ **更正记录（Day 17）**：本表此前登记的「环境 ID = `habit-tracker-d3ghf0mjer76ffo02`」是**错的**，
> 真实值是 `habit-tracker-d9gh0mjel767ff0d2`。发现方式：`tcb env list` 列出唯一环境，与文档记录逐字符比对不一致。
> 教训：**ID 这种"看着像随机串"的值，人眼校对不可靠** —— 必须以命令输出为准，文档里的值要能被一条命令复核。

### 6.1 Day 17 验收记录（真库验证）

| 验收项 | 结果 |
|---|---|
| `GET /api/health` 公网可访问 | ✅ `{"ok":true,"service":"Self discipline plan"}` |
| `GET /api/day?date=2026-10-01` 返回真库数据 | ✅ 5 条打卡项 + `planDay.mood=calm`，与库里一致 |
| `GET /api/checkins?date=2026-10-01&limit=2` 条数限制生效 | ✅ `total=5, limit=2, items=2` |
| **改一行真库数据，接口跟着变** | ✅ 库里把 10-01 心情 `calm → joy`（`AffectedRows=1`），接口立刻返回 `joy` 且 `updatedAt` 刷新；复原后返回 `calm` |
| 前端页面公网可访问 | ✅ `https://...tcloudbaseapp.com/` HTTP 200，178667 字节，标题「自律计划」 |

> 这次验证证明：接口返回的是**真库里的数据**，不是前端 mock、也不是写死的假数据 —— 这正是课程 Day 17「接真实数据」在本项目里的达成方式。

### 6.2 Day 18 验收记录（写入 + 读回验证）

**怎么验的**：先在真库执行 `db/schema-2.sql`（建幂等键列与唯一索引），部署云函数，然后用 `curl`
从公网依次打四组请求 —— 每条都是**对线上地址发的真实请求**，不是本地自测。

| 验收项 | 命令要点 | 实际结果 |
|---|---|---|
| 正常写入 | `POST /api/checkins`，带 `Idempotency-Key: day18-demo-0001`，内容「写 Day 18 学习笔记」 | ✅ `{"code":0,"message":"已添加","data":{"id":9,…,"sort":5}}` |
| **数据库真的多了一行** | `curl` 读回 `GET /api/day?date=2026-10-01` | ✅ 从 5 条变 **6 条**，新增的 `id=9`、`sort=5` 排在最后；库里 `checkins` 总行数 8 → **9** |
| **重复提交被拒** | 同一条请求（同一个 `clientReqId`）再发一次 | ✅ `{"code":409,"message":"请勿重复提交：这条待办刚刚已经添加过了","data":null}` |
| **缺必填字段被拒且提示中文** | `POST` 只传 `{"date":"2026-10-01"}` | ✅ `{"code":400,"message":"缺少必填字段 text（待办内容）","data":null}` |
| 不误伤：同内容不同动作 | 同一天同内容，但换一个 `clientReqId` | ✅ 正常写入（`id=10`）——证明去重认的是**动作 id**，不是**内容**（验证后已清理该行） |
| 数据库约束真的生效 | 查 `pg_indexes` | ✅ `CREATE UNIQUE INDEX checkins_uid_reqid_uniq ON public.checkins USING btree (uid, client_req_id) WHERE (client_req_id IS NOT NULL)` |

**这次验证的核心问题（课程问的）**：防的是**「同一次写入被执行两次」**（用户双击 / 网络重试），
**不是**「内容重复」——所以用客户端幂等键 + 数据库唯一索引两层拦截，而不是按内容去重。
具体怎么测的：`curl` 用同一个 `clientReqId` 连发两次，第二次拿到 409；再换一个 `clientReqId` 发同样的内容，正常写入。

