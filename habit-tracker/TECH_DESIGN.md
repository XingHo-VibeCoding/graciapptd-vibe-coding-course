# 自律计划 · 技术设计文档（TECH_DESIGN.md）

- 版本：v2.5（Day 24：**错误处理与安全审计**——§五 数据流的失败分支改为三类错误口径（原写"云端暂时联系不上"，已废）；明确前端文案唯一出口 `errKindText()` 与契约 §1.8 的对应关系；安全侧新增 `SECURITY.md` 自查清单（含 Git 全历史密钥扫描），`scripts/check-secrets.sh` 加【四】历史扫描段；`.gitignore` 补掉 `.env.*` 变体与密钥文件后缀两处缝隙。代码与契约零改动）。v2.4（Day 23：**§六 错误处理与 §七 环境变量按实际情况重写**——两节原来都是 v2.0 的 React/Vite 规划稿，与实际不符（"请求超时自动重试 1 次 + 待同步队列"其实没实现、`VITE_*` 这类构建时变量在本项目不存在）；现在据实写成三类错误分级（网络层 / 服务端故障 / 业务拒绝）+ 统一文案出口 `errKindText()`，环境变量表改为 CloudBase 实际使用的三条。v2.3（Day 20 补：新增 §5.3「云端检查台的数据流」——健康/真数据/写入测试三条路径，并说明为什么 `/api/health` 要单独一个客户端函数；v2.2（Day 20）§五 前后端数据流由"规划"改写为"已接线的现状"、§二.1 分层图前端说明同步；v2.1（Day 19）新增「二.1 分层结构」并重画项目结构树；v2.0 为重写版——由"纯前端单机路线"升级为"三方案比较 + 默认示范路线"））
- 撰写日期：2026-09-20（Day 5）
- 依据：`PRD.md` v2.0（自律计划）
- 版本历史：v1.0（同日早些时候）为纯前端 + localStorage 单机方案，已由 git 历史保留（提交 `133b7f5`），相当于任务清单里的"降级路线"；本版为完整版——多方案比较后给出默认路线
- 职责边界：定"怎么实现"，不写代码（代码 Day 7 起）

---

## 〇、待确认问题与临时假设

> 按要求先列问题；以下假设在确认前作为设计基线，任何一条被推翻只需改动对应章节。

| # | 待确认问题 | 临时假设（本文档采用） |
|---|-----------|----------------------|
| 1 | PRD 把"登录/多用户"列为本期不做，但后端 + 数据库通常需要用户身份，两者矛盾吗？ | **假设：使用 CloudBase 匿名登录**——用户无感知（无登录界面，符合 PRD A22"全程无登录"），云端自动生成并绑定设备级 `uid`；将来升级正式登录时数据可无缝继承 |
| 2 | 是否已有腾讯云 / CloudBase 账号与环境？ | **假设：第 3 周接入前开通**，使用免费基础版额度（个人学习足够） |
| 3 | 28 天时间预算是否仍是最硬约束？ | **假设：是**。因此采用分阶段策略：第 2 周纯前端本地跑通（零后端依赖），第 3 周再接云函数与数据库 |
| 4 | CloudBase 各产品（云函数/PostgreSQL/静态托管）的免费额度细节 | **假设：按官方文档公开说明为准，未逐一核实当前配额数字**，列在"不确定信息"待查 |

---

## 一、技术方案比较（三套）

### 方案 A：原生三件套 + localStorage + GitHub Pages（v1 路线 / 降级路线）

| 层 | 选型 |
|----|------|
| 前端 | 原生 HTML/CSS/JS，无框架 |
| 后端 | **无** |
| 数据库 | 浏览器 localStorage（约 5MB） |
| 部署 | GitHub Pages（或任意静态托管） |

- ✅ 零基础最快上手；无后端 = 无鉴权、无接口调试、无费用
- ✅ 数据天然在用户浏览器里，隐私零成本
- ❌ 换浏览器/换电脑数据不跟人走；清缓存即丢数据
- ❌ 无法生成"设备无关"的周/月报告；后续加登录/云同步基本要推倒重做存储层

### 方案 B（示范路线）：React/Vite + CloudBase 云函数 + CloudBase PostgreSQL + 静态托管

| 层 | 选型 |
|----|------|
| 前端 | React 18 + Vite（构建工具） |
| 后端 | CloudBase 云函数（Node.js） |
| 数据库 | CloudBase PostgreSQL（关系型，Serverless 化） |
| 部署 | CloudBase 静态网站托管 |

- ✅ **一体化**：函数、数据库、托管在同一个平台，一次开通全有，不用分别管服务器
- ✅ **课程对齐**：示范路线，遇卡点老师/同学有现成经验可问
- ✅ **演进顺畅**：PRD 列为"后续"的登录、云同步、多设备，都只是在现有架构上加东西，不是重写
- ✅ 国内访问速度好（腾讯云节点）
- ❌ React + SQL 对零基础是两座山，学习曲线陡
- ❌ 引入接口调试、数据库连不上的排查这类"看不见的问题"（第 2 天推 GitHub 时你已经体会过鉴权之痛，后端这类问题只多不少）

### 方案 C：Vue 3 + 自建 Node.js(Express) + 云 MySQL + 云服务器（传统自建）

| 层 | 选型 |
|----|------|
| 前端 | Vue 3 + Vite |
| 后端 | Node.js + Express（自己写服务器进程） |
| 数据库 | 云 MySQL（腾讯云/阿里云 RDS 或轻量服务器自装） |
| 部署 | 云服务器（nginx 反代 + 进程守护） |

- ✅ 概念最"正统"，学到的服务器知识可迁移
- ❌ 要自己管：服务器安全补丁、域名备案、HTTPS 证书、进程守护、数据库备份——每一项都是零基础的新坑
- ❌ 三家服务商/多组件拼装，出问题不知道怪谁
- ❌ 28 天内完成 MVP 的风险最高

### 推荐结论：**方案 B（示范路线）为默认路线**

| 取舍点 | 舍 | 得 |
|--------|----|----|
| 学习成本 | 放弃 A 的"无框架、全代码可读" | 换来组件化开发（时间轴/卡片/月历天然是三个组件）和课程支援 |
| 架构演进 | 放弃 A 的"零后端零运维" | 换来数据跟人走、报告跨设备一致、后续功能只加不改 |
| 控制力 | 放弃 C 的"一切自己掌控" | 换来平台托管运维，精力花在产品上 |
| 风险 | React+SQL 双学习曲线 | 用**分阶段策略**对冲：第 2 周前端先行（不碰后端），第 3 周再接云 |

> 与方案 A 不冲突的保留项：**localStorage 仍作为当日数据的本地缓存**（离线兜底，见"迁移注意事项"），但**唯一数据源（Source of Truth）是云端 PostgreSQL**。

---

## 二、项目结构

> **更新说明**：原计划是 React/Vite 多文件结构。考虑到 MVP 28 天节奏与零基础学员门槛，**改为 vanilla 单文件 HTML，按 5 步分步交付**。React/Vite 化作为 step 5 之后或后续的优化项（独立 TECH_DESIGN v3.0），不在本阶段范围。
> **Day 19 起**：第 3 周加了后端，云函数内部按「路由层 / 数据访问层」拆开（见下方 **二.1 分层结构**）。下方树已按**当前真实结构**重画。

```
habit-tracker/
├── frontend/
│   ├── index.html              ← 单文件 vanilla HTML：全部前端代码（约 2900 行）
│   └── assets/                 ← 6 张内置背景图
├── cloudfunctions/
│   └── api/                    ← 云函数「api」＝前端的唯一后端入口（Node.js 20，零 npm 依赖）
│       ├── index.js            ← 路由层：HTTP 解析 / 参数校验 / 业务规则 / 路由表
│       ├── db.js               ← 数据访问层：连接配置 / PostgREST 查询 / fetch / 行映射（Day 19 拆出）
│       ├── selftest.js         ← 本地自测：不联网、stub 掉 fetch（162 条断言）
│       └── package.json
├── db/                         ← 数据库脚本（在真库执行；本地无 Postgres 时用 pglite 先验）
│   ├── schema.sql              ← 建表（Day 16）
│   ├── schema-2.sql            ← 增量脚本：Day 18 起所有结构变更都追加在这里，不改 schema.sql
│   ├── seed.sql                ← 种子数据（编造的示例，可重复执行）
│   ├── verify.sql              ← 验证语句
│   └── README.md
├── skills/                     ← 项目内 Skill（提交进仓库，供老师 review）
├── docs/                       ← 早期素材（structure.svg 等）
├── research.md                 ← Day 3 调研
├── PRD.md / TECH_DESIGN.md     ← 需求文档 / 本文档
├── api-contract.md             ← 接口契约：第 3 周建表与写接口的唯一依据
├── RUN.md                      ← 怎么跑起来 / 怎么验证
└── DEPLOY.md                   ← 部署手册（云函数 + 数据库 + 静态托管）
```

**为什么放弃 React/Vite 路线（至少在 MVP 阶段）**：
1. **零基础友好**：无需 `npm install` / 构建工具链，打开页面就看到效果
2. **第 1 周节奏**：PRD v2.0 + TECH_DESIGN + 第 1 周任务清单加起来已经 3 份文档，**心智能耗已近上限**；引入 React 学习曲线会压垮新功能的学习
3. **数据模型没变**：所有 v2.0 的设计（4 张数据表、A1-A22 验收标准、3 主题 CSS 变量、规则拼装报告）都能在 vanilla 中实现
4. **未来切换成本可控**：当所有 F1-F5 跑通后，可一次性切到 React 而无需重写产品逻辑

> 前后端各自内部保持"三文件封顶"的精神不再适用（框架天生多文件），但**"存储只走一个模块"的铁律保留**：前端所有 localStorage 读写过 `loadData()/saveData()` 两个函数；后端所有数据库读写过 `db.js`（见下）。

### 二.1 分层结构（Day 19：云函数拆出数据访问层）

第 3 周的后端只有两个代码文件，各管一层，**依赖方向单向**：路由层 → 数据访问层 → 数据库。

```mermaid
flowchart TB
  FE["前端 frontend/index.html<br/>单文件 vanilla JS<br/>Day 20 起：云端优先 · 本机兜底"]
  subgraph ROUTE["路由层 · cloudfunctions/api/index.js"]
    R1["① 解析 HTTP：方法 / 路径 / query / body"]
    R2["② 校验与业务规则：必填字段 · 格式 · 幂等键 · 排序位 · 写后读回"]
    R3["③ 拼统一信封响应 code / message / data"]
  end
  subgraph DATA["数据访问层 · cloudfunctions/api/db.js（Day 19 拆出）"]
    D1["连接配置（读函数环境变量）"]
    D2["PostgREST 查询串 + fetch"]
    D3["PostgreSQL 错误码（23505 = 唯一冲突）"]
    D4["行映射：数据库列名 → 契约字段名"]
  end
  DB[("CloudBase PostgreSQL<br/>plan_days / checkins")]

  FE -->|"HTTPS 公网地址 /api/…"| R1
  R1 --> R2
  R2 --> R3
  R3 -->|"await db.findPlanDay(uid, date)<br/>业务语义调用（不是 SQL）"| D1
  D1 --> D2
  D2 --> D3
  D3 --> D4
  D4 -->|"REST 接口（Bearer 环境 API Key）"| DB
```

**每层只知道自己该知道的事**（这是分层的全部意义）：

| 层 | 文件 | 知道什么 | **不**知道什么 |
|---|---|---|---|
| 路由层 | `cloudfunctions/api/index.js` | HTTP 怎么进怎么出、契约要什么形状、业务规则（校验 / 幂等 / 排序位 / 写后读回） | 数据库怎么连、表里有哪些列、查询串怎么写 |
| 数据访问层 | `cloudfunctions/api/db.js` | 怎么连数据库、表结构与列名、查询怎么写、错误码什么意思 | HTTP 长什么样、响应信封、业务规则 |
| 数据库 | CloudBase PostgreSQL | 数据本身 + 约束（唯一索引 / CHECK） | —— |

> **Day 22 增补**：这一层多了两样东西 ——
> ① 通用管道 `update()`（PostgREST 的 `PATCH` 语义：只改传进来的列，**拒绝无条件改全表**）；
> ② **软删除**相关：`softDeleteCheckin()`（其实就是 `update({ is_deleted: true })`，**不是** `DELETE` 语句）
> 与常量 `NOT_DELETED`（`is_deleted = false`，所有面向用户的读取都要带上它）。
> 分层在这里体现得很清楚：**"删除"这件事怎么落库，是数据访问层的知识** —— 路由层只知道
> "我要删这条"，完全不需要知道它是真删还是打标记。这也是"删错了能找回"这个能力
> 只改了 `db.js` + 一个建表脚本、路由层只多 3 行调用就实现的原因。

**这次重构具体搬了什么**（"查数据库的代码"从哪移到哪）：

| 搬走的代码 | 原来在哪 | 现在在哪 |
|---|---|---|
| 连接配置 `dbConfig()`（环境变量 → REST 基址） | index.js | **db.js** |
| `pgSelect` / `pgInsert`（拼查询串 + 调 fetch） | index.js | **db.js**，改名成更中性的 `select` / `insert` |
| 分页总数解析 `pickTotal` | index.js | **db.js** |
| 列清单 `CHECKIN_COLS` / `PLANDAY_COLS` | index.js | **db.js** |
| 行映射 `mapPlanDay` / `mapCheckin`（`done_at` → `doneAt`） | index.js | **db.js** |
| 散在各处的查询对象拼装（`uid: 'eq.…'`、`order: 'sort.asc'`） | index.js | **db.js** 的表级函数 `findPlanDay` / `listCheckinsByDay` / `listCheckins` / `existsCheckinWithReqId` / `findCheckinByReqId` / `findCheckinByContent` / `findLastSort` / `createCheckin` |

**搬家的好处**：以后要换数据库（改用 `pg` 驱动、换服务商、加一层缓存）只改 `db.js` 一个文件，路由层一行不用动；反过来加接口，也只在 `index.js` 加一条路由 + 调 `db.*`。
**接口路径与字段名一个都没动** —— 契约 `api-contract.md` 本次未作任何修改。

**怎么保证"搬完没搬坏"**：`cloudfunctions/api/selftest.js` 的断言从 140 条增至 **162 条**，新增的第 9 节专测分层 —— 既做**静态检查**（断言 `index.js` 里已不再出现 `fetch(`、REST 基址、数据库列名），也**直接调用 `db.js`** 证明它能脱离路由独立工作（这是"拆干净了"的真正证明）。

## 三、数据模型（CloudBase PostgreSQL）

```sql
-- 身份：匿名 uid 由 CloudBase 生成，不做登录 UI（临时假设 1）
CREATE TABLE users (
  uid        TEXT PRIMARY KEY,          -- CloudBase 匿名 uid
  name       TEXT NOT NULL DEFAULT '自律的你',
  theme      TEXT NOT NULL DEFAULT 'warm',   -- warm | night | matcha
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE todos (
  id         SERIAL PRIMARY KEY,
  uid        TEXT NOT NULL REFERENCES users(uid),
  date       DATE   NOT NULL,           -- 属于哪一天（本机自然日，PRD 裁定）
  text       TEXT   NOT NULL,
  time       TEXT,                      -- 'HH:MM'，可空 = 未安排
  done       BOOLEAN NOT NULL DEFAULT FALSE,
  done_at    TIMESTAMPTZ
);

CREATE TABLE moods (                    -- 一天一条，覆盖更新
  date       DATE   PRIMARY KEY,        -- MVP 单用户后 uid 维度第 4 周再拆
  uid        TEXT NOT NULL REFERENCES users(uid),
  mood       TEXT   NOT NULL CHECK (mood IN ('smile','calm','cry')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE notes (
  id            SERIAL PRIMARY KEY,
  uid           TEXT NOT NULL REFERENCES users(uid),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  text          TEXT   NOT NULL,
  from_question BOOLEAN NOT NULL DEFAULT FALSE   -- 是否由每日一问引出
);

CREATE TABLE question_log (             -- 每日一问洗牌队列
  uid          TEXT NOT NULL,
  date         DATE   NOT NULL,
  question_idx INT    NOT NULL,         -- 题池索引
  swap_count   INT    NOT NULL DEFAULT 0,  -- "换一个"次数，上限 3
  PRIMARY KEY (uid, date)
);
```

> **统计一律现算不存**（PRD 原则）：完成数、连续天数、心情分布、报告由 `report` 接口用 SQL 聚合查询直接得出。

> **更新说明（Day 15，2026-10-01）**：上面的建表清单是 v2.0 时写的，只有 4 张表。Day 18–22 陆续加了**专注计时 / 纪念&倒数日 / 肯定语 / 主题换肤**四个板块，表清单已补全为 **7 张**（`users` / `plan_days` / `checkins` / `notes` / `focus_sessions` / `anniversaries` / `affirm_likes`），并在 `api-contract.md` §二 里给了每张表的字段来源与建表注意事项。
> **第 3 周建表以 `api-contract.md` 为准**（本文档本节作为背景保留，不再逐条同步）。

## 四、API 列表（云函数 `api` 统一承载，REST 风格）

| 方法 | 路径 | 作用 | 对应功能 |
|------|------|------|---------|
| GET | `/api/day?date=YYYY-MM-DD` | 一次取回该日待办 + 心情 + 当日问题（首屏合并请求，省往返） | F1/F2/F3 |
| POST | `/api/todos` | 新建待办 `{date, text, time?}` | F1 |
| PATCH | `/api/todos/:id` | 切换完成状态 / 改时间 | F1 |
| DELETE | `/api/todos/:id` | 删除待办 | F1 |
| PUT | `/api/moods` | 当日心情覆盖写入 `{date, mood}` | F2 |
| POST | `/api/notes` | 保存思考卡片 `{text, fromQuestion}` | F3 |
| GET | `/api/notes?from=&to=` | 卡片流（倒序分页） | F3 |
| POST | `/api/question/swap` | 换一题（服务端校验 ≤3 次） | F3 |
| GET | `/api/report?period=week\|month` | 统计 + 夸夸文案拼装 | F4 |
| GET | `/api/calendar?month=YYYY-MM` | 月历数据（每日心情 + 是否有记录） | F5 |
| GET / PUT | `/api/profile` | 读/改姓名与主题 | F5 |

> 所有接口从请求上下文取 `uid`（CloudBase SDK 注入），**不接受前端明传 uid**——防越权的第一道闸。

> **更新说明（Day 15，2026-10-01）**：本表是 v2.0 时的规划，只覆盖 F1–F5 五个功能。Day 18–22 新增的板块（专注计时 / 纪念&倒数日 / 肯定语 / 主题换肤）对应的接口，以及每条接口**完整的请求参数 / 响应 JSON 形状 / 错误返回**，统一写在 **`api-contract.md`** 里（共 22 个接口，含 6 个"列表读取"接口）。
> **第 3 周写接口以 `api-contract.md` 为唯一依据**。部署步骤见 `DEPLOY.md`。
>
> **实现进度（Day 22 更新）**：本表里的路径名（`/api/todos`、`/api/moods`）是 v2.0 的旧规划，
> 实际落地时按契约改成了名词复数的 `/api/checkins`、`/api/days/mood`。已实现的 6 条：
> `GET /api/health`（Day 15）、`GET /api/day`、`GET /api/checkins`（Day 17）、`POST /api/checkins`（Day 18）、
> **`PATCH /api/checkins/:id`、`DELETE /api/checkins/:id`（Day 22）** —— 到这一天，`checkins` 上的
> **增删改查四类操作全部闭环**，其中删除是**软删除**（打 `is_deleted` 标记，不真删行，见契约 §1.7）。

## 五、前后端数据流

> **Day 20 更新**：本节原先是 v2.0 撰写的**规划**（按 React + `api/client.js` 写）。第 3 周实际落地为
> **vanilla 单文件 + 云函数 `api`**，接线已于 Day 20 完成。下面按**现状**重写，原规划留作演进方向。

### 5.1 现状（Day 20 起接线，Day 22 补齐改与删）

```
读取流（打开首页 / 切日期）：
 页面启动
   ├─① loadLocalData()  → 读 localStorage  → 立刻渲染（秒开，不干等网络）
   └─② fetchCloudDay(日期) → GET /api/day?date=…
        ├─ 成功 → applyCloudDay() 把 planDay/checkins 映射进本机同一套结构
        │        → saveData() 当缓存 → renderAll() 重绘（页面看不出差别，因为数据结构一样）
        └─ 失败/超时 → 保持①的本机数据不变，只把那行小字换成人话
                       （网络层「网络连不上」/ 服务端故障「服务器开小差了（HTTP 502）」，
                        见 §六 与契约 §1.8；Day 23 起按"谁的锅"分三类）

写入流（三种写操作，全部"云端优先、本机兜底"）：
 · 添加待办  addTodo()   → POST   /api/checkins      （带 clientReqId 幂等键）
 · 勾选/取消  toggleTodo() → PATCH  /api/checkins/:id  （只发 {done:true|false}）  ← Day 22
 · 删除      deleteTodoAt() → DELETE /api/checkins/:id  （服务端软删除）           ← Day 22

 共同的分流规则（Day 22 明确）：
   ├─ apiReady() 且 id 是**数字**（云端记录）→ 发请求
   │     ├─ code:0        → 用服务端返回的值入内存 + 落缓存 + 重绘
   │     ├─ code:400/403/404/409 → 提示服务端的中文 message，**不改状态**（云端明确拒绝就得听；
   │     │                  例如给明天打勾回 409「这一天还没到，先别急着打勾」）
   │     └─ 网络失败（offline）
   │           ├─ 勾选 → 回落本机切换（非破坏性，页面照常可用）
   │           └─ 删除 → **不动本机**，提示"这条先没删掉"（破坏性操作不做乐观更新：
   │                    否则会"一时消失、刷新又冒出来"，比不删更让人困惑）
   └─ id 是**字符串**（本机兜底记录 'local-…' / 演示数据）→ 绝不发云请求，直接本机改

仍是本机的（对应接口未实现，见 api-contract.md §四）：移动（契约里没有"改归属日期"的接口）/
 改心情 / 思考想法 / 专注记录 / 纪念日 / 肯定语 / 主题偏好
```

**唯一真相源的口径**：今天页的**待办与心情以云端为准**（每次打开都重新拉，本机那份只是缓存与离线兜底）；
尚未接通的板块仍以本机为准。这条要写清楚，否则后面调试时会分不清"看到的是哪一份数据"。

> **一个小细节：前端怎么知道一条记录在不在云上？** 看 id 的类型 —— 云端返回的 id 是数字，
> 本机兜底造出来的 id 是 `'local-…'` 字符串。这个判断被收在一个函数 `isCloudId()` 里
> （`frontend/index.html`），越权/400 类错误基本都源于"把字符串 id 发给了云端"。

### 5.2 三条铁律（v1 继承，落地到本项目的真实文件）

| # | 铁律 | 本项目落地 |
|---|---|---|
| 1 | 存储 / 网络各只走一个出口 | 前端：localStorage 只走 `loadData`/`saveData`，网络只走 `apiGet`/`apiPost`/`apiPatch`/`apiDelete`（Day 20 建、Day 22 补齐改删）；后端 SQL 只走 `db.js` |
| 2 | 先拿到响应、再渲染 | 写操作都等接口返回后才入内存（`addTodo` 用服务端返回的 id）；请求期间用 `adding` 标志防止连点重复提交 |
| 3 | 统计现算不存 | 报告由 `report` 接口聚合查询（未实现），不建统计表 |

> 与 v2.0 规划的差异：`api/client.js` 这个独立模块**没有单独建文件**——前端是单文件 HTML，
> 所以它体现为 `index.html` 里一个带"只走这里"注释的段落（`API_BASE` / `apiGet` / `apiPost` / `apiPatch` / `apiDelete` / `apiHealth` / `newReqId` / `errKindText`）。
> 换托管地址时同样只改这一处。
>
> Day 23 在这条铁律上又加了一层：**错误文案也只走一个出口** `errKindText(r)`（见 §六）。
> 以前调用点各自拼「云端暂时联系不上 / 云端联系不上 / 云端返回异常 / 云端返回了预期之外的数据」，
> 同一件事四五种说法 —— 现在统一由 `errKindText` 按 `kind` 给基础句，调用点只补动作后缀。

### 5.3 云端检查台的数据流（Day 20 补）

「我的」页那张卡片不引入任何新的数据通道，只是把**已有的接口**换成"给人看的形状"：

```
打开「我的」页（或点「重新检查」）
  refreshDiag()
   ├─① apiHealth()  → GET /api/health
   │     ├─ 成功（body.ok === true） → 绿灯 + 服务名
   │     └─ 抛错/超时 → 红灯 + 中文原因
   └─② apiGet('/checkins?limit=100') → 取 total + items
         ├─ 从 items 算：数据最后一天 = max(date)（items 按 date 升序，取最后一条）
         │              今天打卡项 = items 里 date === 今天 的条数
         └─ 渲染：库内总条数 = 接口 total；列表 = 今天的 3 条（今天没有则取最后 3 条）

写入测试（仅 ?debug=1 时按钮出现）
  diagWriteTest()
   ├─ 本机当日已写 >= 3 条？ → Toast 拒绝（防刷库，计数存 localStorage）
   └─ apiPost('/checkins', {date: 今天, text: '检查台写入测试 HH:MM:SS', clientReqId: newReqId()})
        ├─ code:0 → Toast「已写入云端（id=…）」→ 重跑 refreshDiag()（计数 +1）
        │           → 若正看"今天"页，顺带 fetchCloudDay() 让首页也刷新
        └─ 失败 → Toast 说明原因（离线 / 云端拒绝）
```

**为什么 `/api/health` 要单独一个函数**：它是契约里**唯一的扁平响应**接口（回 `{ok, service}`，
不套 `{code, message, data}` 信封）。`apiGet` 的成败判据是 `body.code === 0`，
拿它去读健康检查会把一个**完全健康**的响应判成"失败"。所以 `apiHealth()` 单独存在 ——
但仍然守"网络请求只走一个出口"的铁律：**全前端只有那一个段落里有 `fetch(`**。

> 与 v2.0 规划的差异（补充）：这块本来没有规划——它是 Day 20 补的**验收辅助界面**，
> 作用是把"页面读的是真库"变成可当场核对、可截图、可给同伴看的证据（验收项 A53）。

## 六、错误处理

> **本节是 v2.0 的规划稿，Day 23 按实际情况重写。** 规划里的"请求超时自动重试 1 次"与"待同步队列"
> **都没有实现**（当前是"回落本机缓存 + 提示"，不做后台重试也不排队补传）—— 如实写下来，
> 免得后来人以为代码里有这些机制。三类的判定口径与文案以 `api-contract.md` §1.8 为准。

**三类错误的判定与分工**（按"谁的锅"分，不是按 HTTP 数字分）：

| 类别 | `kind` | 判定 | 前端（`index.html`） | 用户看到什么 |
|---|---|---|---|---|
| **网络层** | `offline` | `fetch` 抛异常：断网 / 超时（>5s）/ 跨域被浏览器拦 | `apiFetch` 捕获 → 回落本机缓存（页面照常能用）；删除**不**误删本机数据 | 「网络连不上」（删除场景：「…，这条先没删掉」） |
| **服务端故障** | `server` | 网关 HTTP ≥500，或响应不是 JSON（网关错误页 / 冷启动超时） | 同网络层回落本机；**不虚报 HTTP 数字**（函数自报 `code=500` 时 HTTP 其实仍是 200） | 「服务器开小差了（HTTP 502），过一会儿再试」 |
| **业务拒绝** | `business` | HTTP 200 但 `code ≠ 0`（400/401/403/404/409） | **不改状态、不做乐观更新**；直接展示服务端原因 | 服务端那句**原话**（如「这一天还没到，先别急着打勾」） |

**统一出口**：文案只有一个出口 `errKindText(r)`，调用点只负责补自己的动作后缀（契约 §1.8 规则 2）。
`apiFetch` / `apiHealth` **必须给出 `kind`**；`offline` 布尔字段保留（= `kind === 'offline'`），仅新增 `kind` —— 所以 Day 22 的调用点与断言无需改写。

**服务端**：`reply(code, message, data)` 统一信封（HTTP 恒 200，业务看 `code`），21 条提示**全部中文、无英文异常名/堆栈/SQLSTATE**；
未捕获异常由 `main()` 兜底成 `500「服务端出了点问题，稍后再试」`，内部细节只进服务端日志（`console.error` 打全栈）。

| 层 | 错误 | 处理策略 | 用户看到什么 |
|----|------|---------|-------------|
| 前端-网络 | 断网 / 超时 / 跨域被拦 | 回落 localStorage 缓存（**不重试、不排队**，见上方说明） | 标题下小字「网络连不上 · 当前显示本机数据」 |
| 前端-服务端 | 网关 5xx / 响应非 JSON | 同上传回落本机 | 小字「服务器开小差了（HTTP …）· 当前显示本机数据」 |
| 前端-业务 | 输入为空、超长、同日移动 | 提交前本机校验拦截（体验层） | 输入框聚焦 + 一行 Toast |
| 云函数 | 参数缺失/非法 | `400` + 中文 message，**一个字都不写库** | Toast 一句话（服务端原话） |
| 云函数 | 数据库连接失败 / 未配置 | `500` + 服务端日志记全貌 | 「服务端出了点问题，稍后再试」 |
| 云函数-规则 | 给未来日期的待办打勾、重复提交 | 服务端硬校验拒绝（前端禁用只是体验层） | `409` 的明确拒绝提示 |
| 统一约定 | — | `code: 0` 成功；`4xx` 用户/前端问题；`5xx` 服务端问题；message 一律中文可直读 | — |

> 原则：**服务端是规则的最后防线**（PRD 的 A5"不能提前打勾"必须在服务端也拦住），前端校验只为体验。
> 第二条原则（Day 23 加）：**别把服务端的问题说成用户的问题** —— 这是"把 502 说成网络连不上"那类
> 裸报错的根源，也是今天改动要解决的问题。

## 七、环境变量

> **本节是 v2.0 的 React/Vite 规划稿，Day 23 按实际情况重写。** 本项目**没有 Vite、没有前端构建步骤**，
> 所以 `VITE_*` 这类"构建时注入"的变量在本项目里**不存在**；`frontend/.env` 也没有被用到。

| 变量 | 放哪 | 作用 | 入库吗 |
|------|------|------|-------|
| `TCB_ENV` | 云函数环境变量（由 `cloudbaserc.json` 的 `functions[].envVariables` 下发） | 环境 ID，用来拼数据库 REST 地址 | ✅ 非密钥（环境 ID 本身是公开的） |
| `CLOUDBASE_API_KEY` | 同上 | 服务端身份（`service_role`，可绕过 RLS） | ❌ 只存在云端与被忽略的 `cloudbaserc.json` |
| `DEMO_UID` | 同上 | **临时**演示身份，接匿名登录后删掉 | ✅ 非密钥 |
| `API_BASE` | `frontend/index.html` 里的常量 | 前端唯一的网络出口地址 | ✅ 公开地址，**前端不含任何密钥** |
| （模板）`cloudbaserc.example.json` / `.env.example` | 仓库里 | 只含占位符，供换机器时对照 | ✅ 入库 |

> **`.env` 的真实角色（Day 23 澄清）**：本项目的密钥下发走上面那两条云端路径，
> **渲染流程里没有任何代码会读 `.env`**；`.env.example` 入库的意义是"写清需要哪些变量"
> 并给 `.gitignore` 里那条 `.env` 规则一个落点（规则 Day 18 就立好，注释写着"第 23 天才会用到"）。
> 提交前用 `bash habit-tracker/scripts/check-secrets.sh` 复核：8 类特征词在被跟踪文件里 0 命中，且 `.env` / `cloudbaserc.json` 均未被跟踪。

## 八、迁移注意事项

| 场景 | 注意点 |
|------|--------|
| v1 设计（localStorage 单机）→ v2 云端 | 若第 2 周已产生本地数据：写一次性导入脚本（导出 JSON → POST 批量入库）；MVP 早期数据量小，宁可重录也不写复杂双向同步 |
| localStorage 的新角色 | 降级为**只读缓存 + 离线待同步队列**，不再是真相源；缓存 key 沿用 `zl.` 前缀 |
| 数据库结构变更 | `schema.sql` 进 git 版本化；改表一律"加列不删列"，删列等确认无引用后再做（零基础期最容易丢数据的地方） |
| 免费额度 | 接近 CloudBase 免费配额上限时的信号是请求变慢/报错，提前确认额度数字（见不确定信息） |
| 未来换部署（如迁出 CloudBase） | 因铁律 1（client.js / db.js 单出口）+ REST 接口标准形状，迁移成本 = 重写两个模块 + 导出 SQL |
| 匿名 uid → 正式登录 | CloudBase 支持匿名账号升级绑定，数据随 uid 迁移，前端无需变化（PRD"登录列后续"的技术兑现路径） |

## 九、不确定的信息（诚实标注）

| # | 信息 | 不确定点 |
|---|------|---------|
| 1 | CloudBase 免费版具体额度（云函数调用次数、数据库容量、托管流量） | 未在官方文档逐一核实当前数字，接入前（第 3 周）需确认 |
| 2 | CloudBase 匿名登录升级绑定正式账号的具体行为 | 官方能力存在，具体数据迁移行为未实测 |
| 3 | PostgreSQL CHECK 约束在 CloudBase Serverless PG 上的支持情况 | 标准 PG 能力，假定可用；建表时如报错则改为应用层校验 |
| 4 | React 18 + Vite 当前推荐版本号 | 以第 7 天 `npm create vite` 时的官方脚手架为准，本文档不锁死小版本 |

---

## 附：与课程资产的关系

- 数据流一句话（Day 5 要掌握的问题）的答案在本版变为：**数据从你的手指来，经 React 状态和云函数，落到云上的 PostgreSQL（唯一真相源）；打开页面时从云端取回渲染，断网时 localStorage 缓存顶上。**
- 第 2 周开工顺序：先 `frontend/`（React 本地跑通 F1 时间轴）→ 第 3 周开 CloudBase 环境 → 接云函数与数据库 → 第 4 周部署静态托管 + 验收 A1-A22
