# 自律计划 · 部署手册（DEPLOY.md）

- 版本：**v2.7（2026-10-10）** — 新增 §7.8「密钥排查 + `.env` 规则」（Day 23 的两张截图照这里截：`check-secrets.sh` 的「0 命中」那一屏 + 三类错误提示的区别）；§四 补 `.env.example` / `.env` 的入库与否，并如实说明"本项目真值不走 `.env`、渲染流程里没有代码读它"；§十三 补两条卡点（把 5xx 说成"你网络不好" / 密钥扫描扫错范围）。v2.6（2026-10-09）— §二 补 `db/schema-3.sql`（Day 22 软删除标记列）；新增 §7.7「Day 22 的两张截图照这里截」（PATCH 改前改后对比 + DELETE 后不再返回）；§十三 补三条卡点（软删除忘了过滤已删行 / 前端 id 类型混淆 / 改完忘了重新 deploy）。v2.5（2026-10-08）— 新增 §7.6「我的页 · 云端检查台」、§十二「把链接发给同伴」、§十三「最可能的卡点」；§六 补「部署前先跑 seed-shift」；§11.3 补「无 `*` 通配符」实测。v2.4（2026-10-07）新增 §十一「跨域（CORS）」：实测矩阵 + 诊断方法 + 免费版套餐限制；§六 补「前端改动后重新部署与缓存」；§七 加 Day 20 验证方法；§九 把"配置跨域"移出"本期不做"。v2.3（2026-10-05）§五 补「上传的是整个函数目录」；v2.2（2026-10-05）§7.4 补「⑤ 读回验证」；v2.1（Day 18）增加写入接口部署与验证；v2.0（Day 17）基于实测跑通重写；v1.0（Day 15）按旧版 CloudBase 写，多处与实际不符（见文末「v1.0 订正表」）。
- 用途：把**云函数 `api`**、**数据库表**、**前端页面**推上公网的可复现步骤。以后每次重新部署照这份做。
- 本版配套脚本：`db/schema.sql`、`db/schema-2.sql`、`db/schema-3.sql`（增量）、`db/seed.sql`、`db/verify.sql`；云函数 `cloudfunctions/api/index.js`（零依赖）；部署配置模板 `cloudbaserc.example.json`；上线前密钥排查 `scripts/check-secrets.sh`；配置模板 `.env.example`。

> **两条重要前提**
> 1. 前端是 **vanilla 单文件 HTML（零构建）**（TECH_DESIGN §二）→ **没有 `npm run build`**，`frontend/` 里的东西就是最终产物。
> 2. 云函数**零 npm 依赖**（用 Node 20 自带的全局 `fetch` 直连 CloudBase PostgreSQL 的 REST 接口）→ **没有 `npm install`**，上传的就是 `cloudfunctions/api/` 里的两个文件。

---

## 〇、开工前检查（30 秒）

```bash
tcb --version            # 需要 CloudBase CLI 3.8+
tcb env list             # 确认能登录、且能列出环境
grep -n 'src="/\|href="/\|url("/' habit-tracker/frontend/index.html   # 应为空
grep -n "localhost\|127.0.0.1" habit-tracker/frontend/index.html      # 应为空
```

**环境 ID 以 `tcb env list` 的输出为准**，不要相信任何文档里抄来的值。
本项目真实环境 ID：`habit-tracker-d9gh0mjel767ff0d2`（上海，免费体验版）。

---

## 一、登录 CLI（扫码，一次就够）

```bash
tcb login --flow device
```

会打印一个授权链接和用户码，用微信/QQ 登录腾讯云后确认即可。
登录态缓存在本机，后续命令直接用；换机器或过期后重跑这一条。

> **坑**：登录成功后 CLI 会追问「是否收集使用数据 (Y/n)」。
> 如果它在**非交互环境**（脚本、后台任务）里卡住，凭据其实**已经写好了** —— 直接中断该命令，用 `tcb env list` 验证登录态即可。

---

## 二、建表 + 种子 + 验证（在真库执行 SQL）

CLI 可以直连环境里的 PostgreSQL 执行 SQL，不用开控制台：

```bash
tcb db execute --sql "$(cat habit-tracker/db/schema.sql)"   # 建两张核心表（可重复执行）
tcb db execute --sql "$(cat habit-tracker/db/seed.sql)"     # 种子数据（可重复执行，应自报 7 / 8）
tcb db execute --sql "$(cat habit-tracker/db/verify.sql)"   # 6 段验证，最后一段应回 7 / 8
tcb db execute --sql "$(cat habit-tracker/db/schema-2.sql)" # 增量：Day 18 幂等键列 + 唯一索引（可重复执行）
tcb db execute --sql "$(cat habit-tracker/db/schema-3.sql)" # 增量：Day 22 软删除标记列 is_deleted（可重复执行）
```

查表与结果（`--json` 才看得到行）：

```bash
tcb db execute --json --sql "SELECT table_name FROM information_schema.tables WHERE table_schema='public'"
tcb db execute --json --sql "SELECT date::text, mood FROM plan_days WHERE uid='seed-demo-user' ORDER BY date"
```

**本步骤的验收**：`public` 下出现 `plan_days` 与 `checkins`；`plan_days` 7 行；`schema-2.sql` 自报两行
（`checkins.client_req_id 列已就绪 = 1`、`checkins_uid_reqid_uniq 索引已就绪 = 1`）。

---

## 三、创建环境 API Key（云函数读数据库的凭证）

云函数要读 CloudBase PostgreSQL，需要一个「服务端身份」。用环境 API Key：

```bash
tcb env apikey create habit-tracker-api
# ⚠️ 返回的 token 明文**只在创建时出现这一次**，立刻存好（下一步要用）
```

- Key 类型是 `service_role`（服务端角色，可绕过 RLS）。**它绝不能出现在前端**，只能待在云函数的环境变量里。
- 查看/回收：`tcb env apikey list` / `tcb env apikey delete <keyId>`。

---

## 四、写部署配置（含密钥，故不入库）

```bash
cp habit-tracker/cloudbaserc.example.json habit-tracker/cloudbaserc.json
# 然后把 cloudbaserc.json 里的三处占位替换为真实值：
#   envId                  → 真实环境 ID
#   TCB_ENV                → 真实环境 ID
#   CLOUDBASE_API_KEY      → 上一步拿到的 API Key token
```

| 文件 | 是否入库 | 说明 |
|---|---|---|
| `cloudbaserc.example.json` | ✅ 入库 | 不含密钥的模板，供后人照抄 |
| `cloudbaserc.json` | ❌ **不入库**（已在 `.gitignore`） | 含 API Key 明文 |
| `.env.example` | ✅ 入库 | Day 23 补：占位符模板，说明 `TCB_ENV` / `CLOUDBASE_API_KEY` / `DEMO_UID` 各自的用途 |
| `.env` | ❌ **不入库**（已在 `.gitignore`） | 本地私密配置。**注意：本项目当前真值不走它** —— 见下方说明 |

> **关于 `.env` 的一句实话**：本项目现在的密钥下发有两条云端路径（本节的 `cloudbaserc.json`
> 与云端环境变量），前端只持有公开的接口地址、**没有任何密钥** —— 也就是说渲染流程里
> **没有任何一份代码会去读 `.env`**。那为什么还要有它？两件事：
> ① `.gitignore` 里 `.env` 系列规则是 Day 18 就立好的（当时注释写着"第 23 天才会用到"），
> 规则立了就要有个落点，否则下次谁真建了个 `.env` 都不知道该不该忽略；
> ② 给将来可能出现的**本地脚本**（离线批处理、数据迁移）留一个统一的配置入口。
> `.env.example` 的存在意义是**写清"需要哪些变量"**，而不是虚构一套本项目并不使用的加载机制。

> **顺序很重要**：`.gitignore` 里 `cloudbaserc.json` 与 `.env` 这两组规则都是**先把规则立好、再落密钥**的。
> 反过来做（先建文件后补规则）就可能把密钥提交上去 —— 仓库是 public 的。
> Day 23 起，提交前用一条命令复核：`bash habit-tracker/scripts/check-secrets.sh`（见 §7.8）。

云函数运行时读三个环境变量：

| 变量 | 作用 |
|---|---|
| `TCB_ENV` | 环境 ID，用来拼数据库 REST 接口地址 |
| `CLOUDBASE_API_KEY` | 服务端身份，云函数带着它读库 |
| `DEMO_UID` | **Day 17 临时**：还没接匿名登录，用它在服务端指定"看谁的数据"。Day 18 接上登录后必须删掉 |

---

## 五、部署云函数 + 开公网访问路径

```bash
cd habit-tracker
MSYS_NO_PATHCONV=1 tcb fn deploy api --force --path /api --runtime Nodejs20.19
```

一条命令做三件事：**部署代码** + **应用 cloudbaserc.json 里的配置（含环境变量）** + **创建 HTTP 访问路径 `/api`**。

> **上传的是整个函数目录**（`cloudfunctions/api/`），不是单个文件。Day 19 拆出数据访问层后，目录里有两个代码文件：
> `index.js`（路由层）+ **`db.js`（数据访问层）**，两者会一起上传 —— 这也是拆分后部署方式**不需要任何改动**的原因。
> 若哪天只改了 `db.js`，照样跑这一条命令即可。
> 自测脚本 `selftest.js` 也会被一起上传，但云函数运行时不会执行它（入口只有 `index.main`），无副作用。

成功后打印：

```
Cloud function HTTP access service link: https://<环境ID>.service.tcloudbase.com/api
```

> **两个坑**
> 1. **`--path /api` 在 Git Bash 里会被篡改成 Windows 路径**（MSYS 会把 `/api` 当路径转换）→ 加 `MSYS_NO_PATHCONV=1` 前缀。
> 2. **不要加 `--httpFn`**：这个 CLI 里它的含义是「Web 函数」，会要求 `scf_bootstrap` 启动文件（那是另一种形态）。我们要的是**事件型云函数 + HTTP 访问服务路由**。
> 3. **默认域名不许手工加路由**：直接 `tcb routes add --data '{"domain":"<环境ID>.service.tcloudbase.com",...}'` 会报
>    「is a system internal domain, manual creation or modification is not supported」。
>    正解就是用 `--path` 让 `fn deploy` 顺带把路由建出来（或去控制台 HTTP 网关页面点「新建」）。

**生效时间**：路由创建后可能需要几分钟；首次访问有冷启动（1–3 秒），刷新一次即可。

---

## 六、部署前端到静态托管

> **部署/重新部署前，先跑这一条**（把种子数据的日期锚定到"今天"，否则首页是空的）：
> ```bash
> tcb db execute --sql "$(cat habit-tracker/db/seed-shift.sql)"   # 幂等，可重复跑
> ```
> 为什么必须有这一步：种子数据的日期是固定的（2026-09-25 ~ 10-01），而首页只显示"今天"。
> 隔一天不跑，首页就空了 —— 这是本项目**最常撞的卡点**（见 §十三 第 1 条）。

```bash
# 在仓库根目录执行
MSYS_NO_PATHCONV=1 tcb hosting deploy habit-tracker/frontend
```

- 该命令把 `frontend/` 里的**内容**（`index.html` + `assets/`）部署到静态托管**根目录**。
- 千万别上传 `habit-tracker/` 或 `frontend/` 这一层目录 —— 那样首页会变成 `/frontend/index.html`，直接访问根域名 404。
- 公网地址：`https://<环境ID>-<随机串>.tcloudbaseapp.com/`（本项目为 `...-1499348397.tcloudbaseapp.com`）。

> **Day 20 起**：前端接了云接口，所以**每次改完 `frontend/index.html` 都要重新跑这条命令**才会上线
> （前端是零构建的单文件，不存在"忘了 build"的问题，但**确实容易忘了 deploy**）。
> 部署输出里会列出上传的文件清单（`index.html` + 6 张图）并打印访问地址，逐行核对一遍最稳。

**部署完要验证"线上的确实是新版本"**（CDN 有缓存）：

```bash
curl -s -H "Cache-Control: no-cache" "https://<环境ID>-<随机串>.tcloudbaseapp.com/index.html" | grep -c "const API_BASE"
# 返回 1（或更多）= 线上那份已经含 Day 20 的接线代码；返回 0 = 还是旧版，等几分钟或 Ctrl+F5
```

---

## 七、验证方法（Day 17 / Day 18 的截图照这里截）

### 7.1 云函数读接口（Day 17 截图 1）

浏览器地址栏直接打开：

```
https://habit-tracker-d9gh0mjel767ff0d2.service.tcloudbase.com/api/health
https://habit-tracker-d9gh0mjel767ff0d2.service.tcloudbase.com/api/day?date=2026-10-01
```

**应看到**：第一行 `{"ok":true,"service":"Self discipline plan"}`；
第二行是带 `code/message/data` 信封的 JSON，`data.checkins` 里是**库里真实存在的那几条待办**。

**图里要有的**：地址栏完整 URL + 上述 JSON。

命令行等价写法（更快，可贴进终端）：

```bash
BASE=https://habit-tracker-d9gh0mjel767ff0d2.service.tcloudbase.com/api
curl "$BASE/health"
curl "$BASE/day?date=2026-10-01"
curl "$BASE/checkins?date=2026-10-01&limit=2"     # 顺带验证条数限制
```

### 7.2 前端页面（Day 17 截图 2）

打开 `https://habit-tracker-d9gh0mjel767ff0d2-1499348397.tcloudbaseapp.com/`。

**应看到**：自律计划首页（顶部主题大图 + 今天待办 + 底部导航），导航都能切。
**Day 17–19 时**：页面里的 `fetch` 还没接（跨域未验证），所以数据仍是浏览器本地的 mock —— 当时是预期。
**Day 20 起**：页面真的去读云端接口了，「今日待做」下面是**数据库里的真实待办**，
标题下方还有一行小字「云端数据 · 更新于 …」（见 §7.5）。

**图里要有的**：地址栏 + 页面内容。

### 7.3 真库验证（Day 17 的核心考核）

「接口读的是真库还是假数据」必须证明。办法是**直接改库里的数据，看接口是否跟着变**：

```bash
# 1) 改前：记下当前心情（应为 calm）
curl "$BASE/day?date=2026-10-01"

# 2) 真库改一行
tcb db execute --sql "UPDATE plan_days SET mood='joy', updated_at=now() WHERE uid='seed-demo-user' AND date=DATE '2026-10-01'"

# 3) 改后：接口应返回 mood=joy，且 updatedAt 变成刚才的时间
curl "$BASE/day?date=2026-10-01"

# 4) 复原
tcb db execute --sql "UPDATE plan_days SET mood='calm' WHERE uid='seed-demo-user' AND date=DATE '2026-10-01'"
```

**验收标准**：第 3 步返回的 `mood` 必须变成 `joy`。变了 = 数据真的来自数据库。

### 7.4 写入接口（Day 18 的两张截图照这里截）

写接口**不能用浏览器地址栏测**（地址栏只能发 GET）。用命令行，或控制台「云函数 → 测试」。

**先准备**（把下面整段贴进终端，`BASE` 后面几步都要用）：

```bash
BASE=https://habit-tracker-d9gh0mjel767ff0d2.service.tcloudbase.com/api
```

**① 正常写入 —— 截图 1（POST 成功返回）**

```bash
curl -s -X POST "$BASE/checkins" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: shot-0001" \
  -d '{"date":"2026-10-01","text":"写 Day 18 学习笔记","time":"20:00","quad":"q2"}'
```

**应看到**：`{"code":0,"message":"已添加","data":{"id":9,…,"sort":5}}` —— `code:0` 就是成功。
图里要有：**命令 + 返回的 JSON 形状**。

**② 数据库里新增的那一行 —— 截图 2**

```bash
tcb db execute --json --sql "SELECT id, text, time, quad, done, sort, client_req_id FROM checkins WHERE uid='seed-demo-user' AND date=DATE '2026-10-01' ORDER BY sort"
```

或在控制台：环境 → 数据库 → PostgreSQL → 表管理 → `checkins` → 数据。
**应看到**：刚写进去的那一行（`text` = 上面那条，`client_req_id` = `shot-0001`），且它**排在最后**（`sort` 最大）。

**③ 重复提交被拒（Day 18 的核心考核）**

把 ① 的命令**原样再跑一遍**（同一个 `Idempotency-Key`）：

```bash
curl -s -X POST "$BASE/checkins" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: shot-0001" \
  -d '{"date":"2026-10-01","text":"写 Day 18 学习笔记","time":"20:00","quad":"q2"}'
```

**应看到**：`{"code":409,"message":"请勿重复提交：这条待办刚刚已经添加过了","data":null}`，且**库里不会多出第二行**。

**④ 缺必填字段被拒（提示必须是中文）**

```bash
curl -s -X POST "$BASE/checkins" -H "Content-Type: application/json" -d '{"date":"2026-10-01"}'
```

**应看到**：`{"code":400,"message":"缺少必填字段 text（待办内容）","data":null}`。

**⑤ 读回验证（确认写进去的能读出来）**

课程的"收藏列表接口"在本项目没有对应物，对应物就是**列表读取接口**（见 `api-contract.md` §1.1 对照）。
按日期读回当天列表：

```bash
curl -s "$BASE/checkins?date=2026-10-01"
```

**应看到**：`{"code":0,"message":"ok","data":{"total":N,"items":[…]}}`，其中 `items` 的**最后一条**就是 ① 刚写进去的那条
（`text` = "写 Day 18 学习笔记"、`sort` 最大）。

> 想更直观地看首屏效果，也可以读合并接口：`curl -s "$BASE/day?date=2026-10-01"`（同时返回 `planDay` 与当天全部 `checkins`）。

> **注意**：① 每跑一次就会真的往库里加一行（这才是"写入"该有的样子）。验证完如果不想留，
> `tcb db execute --sql "DELETE FROM checkins WHERE client_req_id='shot-0001'"`。

### 7.5 前端接线（Day 20 的两张截图照这里截）

这一天的验收是"**公网首页展示数据库真实数据**"，所以要三样证据：**页面**、**请求地址**、**改库跟着变**。

**① 公网首页 —— 截图 1（主图）**

1. **先把种子数据的日期平移到今天**，否则首页（今天）读到的是空列表：
   ```bash
   tcb db execute --sql "$(cat habit-tracker/db/seed-shift.sql)"   # 幂等，可重复跑
   tcb db execute --json --sql "SELECT count(*) FROM checkins WHERE uid='seed-demo-user' AND date=CURRENT_DATE"
   ```
   应看到今天有 6 条。
2. 浏览器打开 `https://habit-tracker-d9gh0mjel767ff0d2-1499348397.tcloudbaseapp.com/`（**Ctrl+F5 强刷一次**，防旧缓存）。
3. **图里要有的**：**地址栏里完整的公网 URL** + 页面上「今日待做」里那几条**数据库真实待办**（"晨跑 30 分钟""整理下周计划"…）
   + 标题下那行小字「云端数据 · 更新于 …」。

**② 请求地址确实是公网地址 —— 截图 2（F12）**

按 `F12` → **Network（网络）** → `Ctrl+R` 刷新 → 找到 `day?date=…` 这条请求点开看 **Headers → Request URL**。

**应看到**：`https://habit-tracker-d9gh0mjel767ff0d2.service.tcloudbase.com/api/day?date=<今天>`
（**不是** `localhost`，也**不是**静态托管地址 —— 前者说明你打开的是本地版，后者说明你把页面地址当成了接口地址）。
顺便看一眼 **Status 200** 和 **Response** 里的 `{"code":0,…}`。

**③ 改一行真库数据，刷新跟着变 —— 核心考核**

```bash
# 改前先记下页面上的内容，然后改库
tcb db execute --sql "UPDATE checkins SET text='部署手册验证行' WHERE uid='seed-demo-user' AND date=CURRENT_DATE AND sort=1"
# 回浏览器刷新 → 页面上第二条待办的字应变成「部署手册验证行」
# 复原
tcb db execute --sql "UPDATE checkins SET text='整理下周计划' WHERE uid='seed-demo-user' AND date=CURRENT_DATE AND sort=1"
```

**验收标准**：刷新后页面内容跟着变 = 页面显示的**真就是数据库里的数据**。
（再补一刀更直观：`UPDATE plan_days SET mood='joy', updated_at=now()` → 那行小字的时间会立刻前进。）

### 7.6 「我的」页 · 云端检查台（Day 20 补）

「我的」页最下面那张「云端检查台」卡片，是把"页面读的是真数据库"这件事**写成证据**的地方：

| 卡片上的内容 | 数据从哪来 | 期望值 |
|---|---|---|
| 绿灯 + 「服务正常 · Self discipline plan」 | `GET /api/health` | 灯是绿的 |
| 接口地址 | 前端常量 `API_BASE` | `https://…service.tcloudbase.com/api` |
| 数据最后一天 | `GET /api/checkins?limit=100` 里最大的 `date` | = **今天** |
| 今天打卡项 | 同上，按 `date` = 今天过滤 | ≥ 1 条 |
| 库内总条数 | 接口返回的 `total` | 与库里 `count(*)` 一致 |
| 下面那一小段列表 | 今天的条目（最多 3 条） | 内容与库里逐字一致 |

**截图建议**：把整张卡片连同地址栏一起截，加上首页那张 —— 「页面 + 真数据 + 公网地址」三样齐了。

**写入测试入口（默认隐藏）**：网页右下角链接里加 `?debug=1` 打开，卡片上会多出一个
「写入一条测试数据」按钮；点一下会**真的往 `checkins` 表插一行**「检查台写入测试 HH:MM:SS」，
同时卡片上的「今天打卡项」「库内总条数」当场 +1。

```
https://habit-tracker-d9gh0mjel767ff0d2-1499348397.tcloudbaseapp.com/?debug=1#me
```

**为什么默认藏起来**：这条链接是公开的，谁拿到都能打开；写入口藏起来，防止陌生人随手往库里塞数据。
另外每个浏览器**当天最多写 3 条**（本机计数，见 `DIAG_WRITE_MAX`），防手滑刷库。

**验完清理**（想把测试行删掉的话）：

```bash
tcb db execute --sql "DELETE FROM checkins WHERE text LIKE '检查台写入测试%'"
```

### 7.7 改与删（Day 22 的两张截图照这里截）

今天要回答的问题是"**删除为什么比新增更容易出事**"，所以两张图分别证明：**改真的生效**、**删真的生效**（而且没真删行）。

**先准备**（`BASE` 与 `D` 后面几步都要用）：

```bash
BASE=https://habit-tracker-d9gh0mjel767ff0d2.service.tcloudbase.com/api
D=$(date +%F)      # 今天（本机时区即东八区，与页面口径一致）
```

**① 先看这一天有什么 —— 截图 1 的"改之前"**

```bash
curl -s "$BASE/checkins?date=$D"
```

**应看到**：当天全部待办（本项目种子是 6 条）。记下要改的那条的 `id`，以及它的 `text` / `time` / `done`。

**② 改它 —— 截图 1 的"改的动作"（记得把 `8` 换成你自己的 id）**

```bash
curl -s -X PATCH "$BASE/checkins/8" \
  -H "Content-Type: application/json" \
  -d '{"text":"整理下周计划（Day 22 改过）","time":"21:30","done":true}'
```

**应看到**：`{"code":0,"message":"已更新","data":{"id":8,…,"done":true,"doneAt":1791552591198,…}}`
—— `code:0` 是成功，`data` 是**改完之后的整条**（用它就能直接对比，不用再猜）。

**③ 再读同一天 —— 截图 1 的"改之后"**

```bash
curl -s "$BASE/checkins?date=$D"
```

**图里必须有改前/改后的值对比**（四项）：

| 字段 | 改之前 | 改之后 |
|---|---|---|
| `text` | 整理下周计划 | 整理下周计划（Day 22 改过） |
| `time` | `09:00` | `21:30` |
| `done` | `false` | `true` |
| `doneAt` | `null` | 一个毫秒时间戳 |

> `doneAt` 是毫秒数，看不懂就转换一下：`date -d @$((1791552591198/1000))`。
> **挑一条还没打勾的来改**：拿已完成的行做演示，`done` 会是 `true → true`，看着像没生效。

**④ 删一条 —— 截图 2 的"删的动作"**

```bash
curl -s -X DELETE "$BASE/checkins/5" -H "Content-Type: application/json"
```

**应看到**：`{"code":0,"message":"已删除","data":{"id":5}}` —— 只回 `id`，不回整行（它已经"不存在"了）。

**⑤ 再读同一天 —— 截图 2 的"删之后"**

```bash
curl -s "$BASE/checkins?date=$D"
```

**图里要能看出**：④ 那条的 `id` **已经不在返回里了**（当天从 6 条变 5 条）。

**⑥ 顺手证明"软删除"（余力加练，建议一起截）**

```bash
# 它其实还在库里，只是被打了标记
tcb db execute --json --sql "SELECT id, text, done, is_deleted FROM checkins WHERE id=5"

# 想找回就改回来 —— 这就是"删错了还能找回"
tcb db execute --sql "UPDATE checkins SET is_deleted=false WHERE id=5"
curl -s "$BASE/checkins?date=$D"      # 它又回到列表里了
```

**错误路径（建议再截一两张，证明"该拦的拦住了"）**

```bash
# a) 给未来日期的待办打勾 → 409（PRD A5 硬规则，服务端拦）
curl -s -X PATCH "$BASE/checkins/<明天的id>" -H "Content-Type: application/json" -d '{"done":true}'
# b) id 不是数字 → 400
curl -s -X PATCH "$BASE/checkins/abc" -H "Content-Type: application/json" -d '{"done":true}'
# c) 一个字段都没给 → 400
curl -s -X PATCH "$BASE/checkins/8" -H "Content-Type: application/json" -d '{}'
# d) 删不存在的 id → 404
curl -s -X DELETE "$BASE/checkins/999999"
```

> **也能让脚本代跑**：本机工作区里的 `scratch-day22-verify.js` 会把上面的流程跑一遍并打印成
> **排好版的对比表**（改前/改后逐字段对照 + 错误路径逐条），截图比 curl 输出清楚：
> ```bash
> NODE_PATH=<工作区>/node_modules node scratch-day22-verify.js main
> ```

> ⚠️ **验完记得复原**：② 改过的字段、④ 删掉的那条都要还回去 ——
> 否则第二天再看首页，示范数据就少了一条。复原语句见 ⑥ 与本文 §10 的排错对照表。

### 7.8 密钥排查 + `.env` 规则（Day 23 的两张截图照这里截）

Day 23 要回答两件事：**这个仓库里有没有密钥**、**出错时用户看到的是不是人话**。
第一件事的截图就是这一屏 —— 要求「搜索结果为 0 条」。

**① 一条命令扫全仓库（截图 1）：**

```bash
bash habit-tracker/scripts/check-secrets.sh
```

**为什么只扫"被 git 跟踪的文件"**：只有它们会被推到 GitHub。工作区里那些没入库的临时文件
不构成泄露风险，混进结果只会让"0 命中"这个结论变得没法一眼看懂。脚本用 `git grep`
（而不是裸 `grep`）正是为了这个边界。

**应看到**（这一屏可直接截图）：

```
【一】高置信度密钥特征（期望：每一项都是 0）
------------------------------------------------------------------
  命中  特征
  0    JWT 风格密钥（eyJ 开头）
  0    腾讯云 SecretId（AKID 开头）
  …（8 项，全部 0）
  ✔ 小计：0 处命中 —— 没有真密钥入库。

【二】敏感文件跟踪状态（期望：全部「未跟踪」）
  habit-tracker/.env                    未跟踪 ✓
  habit-tracker/.env.local              未跟踪 ✓
  habit-tracker/cloudbaserc.json        未跟踪 ✓
  habit-tracker/.env.example            已跟踪 ✓
  habit-tracker/cloudbaserc.example.json 已跟踪 ✓

 结论：通过 ✓ —— 全仓库搜不到密钥特征词，敏感文件均未入库。
```

退出码 **0** = 通过；**1** = 有高危发现（脚本会把命中的 `文件:行号` 直接列在下面）。
所以它能直接挂进 pre-commit 或 CI，不必靠人记得手敲 `git grep`。

**② `.env` 的现状核验（截图 1 的第二半，或单独一张）：**

```bash
# 应报错（说明没有被跟踪 —— 仓库里根本没有这个文件）
git ls-files --error-unmatch habit-tracker/.env
# 应该看到 .env / .env.local / .env.*.local 三条规则
grep -n "^\.env" .gitignore
```

**应看到**：第一条命令报 `did not match any file(s) known to git`（**这是期望结果**），
第二条打印出三条 `.env` 规则。规则是 Day 18 立的（注释里写着"第 23 天才会用到"）。

**③ 三类错误提示的截图（截图 2）：**

契约 §1.8 把错误分成三类、各给一句人话。三种都截一张（至少要有前两张）：

| 类别 | 怎么造出来 | 应看到 |
|---|---|---|
| **网络层** | 断网（或把 `API_BASE` 改成一个不存在的域名）后刷新页面 | 小字「**网络连不上** · 当前显示本机数据」 |
| **服务端故障** | 让接口回 5xx：`tcb fn` 把函数删掉/停掉，或临时把 `API_BASE` 指向一个会返 502 的地址，再开检查台 | 「**服务器开小差了（HTTP 502）**，过一会儿再试 · 当前显示本机数据」——**关键：这里以前显示的是"云端联系不上"** |
| **业务拒绝** | 打一个未来日期的待办（页面切到明天打勾，或 `curl -X PATCH .../checkins/<明天的id> -d '{"done":true}'`） | Toast / 返回体原样显示服务端那句「**这一天还没到，先别急着打勾**」 |

> **截图里要能看出区别**：网络层与服务端故障**说的是两句不同的话**，这是 Day 23 的核心修复点。
> 改之前两者都显示"云端联系不上"，用户看到 502 会去重启路由器 —— 方向完全错了。

---

## 八、控制台手动路线（CLI 不可用时的备选）

1. **建表**：环境 → 数据库 → PostgreSQL → SQL 编辑器，依次粘贴 `schema.sql` → `seed.sql` → `verify.sql` → `schema-2.sql` → `schema-3.sql`（都是幂等的，顺序不要颠倒）。
2. **API Key**：环境 → API Key → 新建，复制 token。
3. **云函数**：云函数 → 新建（名称必须 `api`，运行时 Node.js 20）→ 把 `cloudfunctions/api/` 里的 **两个代码文件都贴进去**（`index.js` 是路由层、`db.js` 是数据访问层，缺一个都跑不起来）→ 保存并部署 →
   在「函数配置 → 环境变量」里补上 §四 那三个变量（**这一步别忘，否则接口会回 500**）。
4. **HTTP 访问**：HTTP 网关 → 路由管理 → 新建 → 关联资源选「云函数 / api」→ 域名选**默认域名** → 触发路径填 `/api`。
5. **前端**：静态网站托管 → 文件管理 → 上传 `frontend/` 里的**内容**到根目录。

---

## 九、本期刻意不做的事

| 事项 | 为什么不做 | 什么时候做 |
|---|---|---|
| ~~配置跨域 CORS~~ | ✅ **已完成**（Day 20）：实测发现 CloudBase 网关**默认就处理**，本环境托管域名在安全域名白名单里、本地开发地址网关内置放行 —— 云函数代码里一行 CORS 都不用写。详见 §十一 | 已做 |
| 匿名登录 + RLS | 需要先把读写接口都跑通，身份链路下一批做 | 后续 |
| 其余 5 张表 | 按课程节奏逐个追加到 `schema-2.sql`（不改 `schema.sql`） | 需要它们的接口开工那天 |
| 勾选/删除/移动/改心情的写接口 | 只做了"新增"（`POST /api/checkins`）；改与删（`PATCH`/`DELETE`）按 R7 一天一块 | 逐个补 |
| 自定义域名 / HTTPS 证书 | 默认域名够用 | 后续优化 |

> **为什么 Day 17–19 "地址栏能测、页面 fetch 却是本机数据"**：CORS 是浏览器的**同源策略**限制 ——
> 地址栏敲 URL 属于"直接导航"，浏览器不管；页面里的 JS 发 `fetch` 属于"跨域请求"，浏览器会拦。
> 当时页面还没接接口，所以看不出差别。**Day 20 接线后这个区别才真正生效**，也因此必须先确认跨域通不通（§十一）。

---

## 十、排错对照表（Day 17 实测补充）

| 现象 | 原因 | 怎么办 |
|---|---|---|
| `domain ... is a system internal domain` | 默认域名由系统托管，不许手工建路由 | 用 `tcb fn deploy ... --path /api` 自动建，或去控制台 HTTP 网关页面建 |
| `HTTP access service path must start with /` | Git Bash 把 `/api` 篡改成 Windows 路径 | 命令前加 `MSYS_NO_PATHCONV=1` |
| 提示要 `scf_bootstrap` | 误用了 `--httpFn`（这是「Web 函数」形态） | 去掉 `--httpFn`，用事件型 + HTTP 访问服务 |
| 命令静默被杀 / 无输出 | 沙箱拦了外网 | 部署类命令需在放行网络的环境下执行 |
| 接口回 `{"code":500,...}` | 云函数里环境变量没配 / API Key 失效 / 表不存在 | 看云函数日志：`tcb fn log api`；再核对 §四 三个变量 |
| 接口回 `{"code":401,...}` | 没取到身份（`DEMO_UID` 没配，且没有登录上下文） | 补 `DEMO_UID` 环境变量 |
| 接口回 `{"code":404,...,"availableRoutes":[...]}` | 路由没命中 | 看 `availableRoutes` 里真实有哪些路径，核对 URL |
| 返回 HTML 而不是 JSON | 打开的是静态托管地址，不是云函数地址 | 云函数域名是 `*.service.tcloudbase.com`，别搞混 |
| 静态页面白屏 / 图片全裂 | 上传时多带了一层目录，或 `assets/` 没传 | 只传 `frontend/` 里的**内容** |
| 页面打开是旧版本 | 浏览器 / CDN 缓存 | `Ctrl + F5`；CDN 通常几分钟刷新 |
| 控制台「测试」正常但公网访问失败 | 没配 HTTP 访问路径 | 见 §五 |
| 接口 `curl` 能通，但页面上还是本机数据 | 跨域被浏览器拦（或页面没接上接口） | F12 → Console 找 `blocked by CORS policy`；再按 §十一 一条命令验证来源 |
| Console 报 `No 'Access-Control-Allow-Origin' header is present` | 请求来源**不在安全域名白名单**，网关不给 CORS 头 | §十一：`tcb cors list` 看白名单，用 `curl -H "Origin: …"` 复现 |
| 页面显示「本机数据（未连云端）」 | 这个环境没有 `fetch`（很老的浏览器） | 换现代浏览器；正常浏览器不会走到这个分支 |
| 页面显示「云端暂时联系不上」 | 断网 / 超时 / 接口地址写错 | 先地址栏打开 `/api/health` 确认接口活着；再看 F12 Network 里请求的 URL |

---

## 十一、跨域（CORS）：怎么配、怎么认出问题出在哪

> Day 20 主题。**一句话结论**：本项目的跨域由 **CloudBase 网关统一处理**，
> 云函数代码里**不需要写任何 CORS 逻辑**；需要确认的只有一件事 —— **你的来源域名在不在白名单里**。

### 11.1 原理：为什么"地址栏能打开、页面 fetch 却不行"

- **地址栏敲 URL** ="直接导航"，浏览器不管来源，服务器返回什么就显示什么。
- **页面里的 JS 发 `fetch`** = "跨域请求"。只要**协议 / 域名 / 端口**有任何一项不同，就是**跨源**。
  浏览器会**先问服务器**："我这个来源，你允许吗？"（POST/自定义头还会先发一个 `OPTIONS` 预检）。
  服务器回答里没有 `Access-Control-Allow-Origin`，浏览器就**把响应拦下不交给 JS**，
  并在 Console 里打印 `blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present`。

**怎么认出问题出在哪**：这句话翻译过来就是"**服务器没允许我这个来源**"。
所以问题一定在**来源白名单**这一层，**不在**接口逻辑、不在 SQL、不在前端代码、更不是"接口挂了"。
判据只有一个：**看响应里有没有 `Access-Control-Allow-Origin`**。

### 11.2 一条命令当场复现 / 定位

```bash
BASE=https://habit-tracker-d9gh0mjel767ff0d2.service.tcloudbase.com/api

# ① 用"你真正的前端来源"打一下，应看到 access-control-allow-origin: <你的来源>
curl -s -i -H "Origin: https://habit-tracker-d9gh0mjel767ff0d2-1499348397.tcloudbaseapp.com" "$BASE/health" | grep -i "access-control\|^HTTP"

# ② 换一个陌生来源：Should NOT 出现 access-control-allow-origin（= 会被浏览器拦）
curl -s -i -H "Origin: https://evil.example.com" "$BASE/health" | grep -i "access-control\|^HTTP"

# ③ 预检：前端发 POST 前浏览器会先发这个，应回 204 + allow-methods / allow-headers
curl -s -i -X OPTIONS -H "Origin: https://habit-tracker-d9gh0mjel767ff0d2-1499348397.tcloudbaseapp.com" \
  -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: content-type" "$BASE/checkins" | grep -i "access-control\|^HTTP"
```

`curl` 不受 CORS 限制，但它能**如实反映服务器的回答**——所以上面前两步的结果，就等于浏览器内部的判断依据。

### 11.3 本项目实测结果（2026-10-07 Day 20；2026-10-08 复测）

| 来源 | 是否返回 `Access-Control-Allow-Origin` | 结论 |
|---|---|---|
| `https://habit-tracker-d9gh0mjel767ff0d2-1499348397.tcloudbaseapp.com`（本项目前端） | ✅ 原样回显该来源 + `access-control-allow-credentials: true` | 放行 |
| `http://localhost:8765`、`http://127.0.0.1:8765` | ✅ 原样回显 | 放行（本地开发用） |
| `https://evil.example.com`、`https://graciapptd.github.io`、别的环境的 `*.tcloudbaseapp.com` | ❌ 完全没有该响应头 | **会被浏览器拦** |
| `OPTIONS` 预检（本环境前端来源 + `POST`） | ✅ `204` + `allow-methods: POST` + `allow-headers: Content-Type` + `vary: Origin,…` | 预检通过 |

**「只允许自己的域名、不用 `*` 通配符」这条已验证** —— 复测方式（三种来源各打一次，数 `*` 出现的次数）：

```bash
BASE=https://habit-tracker-d9gh0mjel767ff0d2.service.tcloudbase.com/api
for O in "https://habit-tracker-d9gh0mjel767ff0d2-1499348397.tcloudbaseapp.com" "http://localhost:8765" "https://evil.example.com"; do
  echo "$O -> 通配符 $(curl -s -i -H "Origin: $O" "$BASE/health" | grep -ci 'access-control-allow-origin: \*')"
done
# 实测三条都是 0；且放行时回的是**具体来源原样回显**（不是 *），
# 加上 vary: Origin —— 说明网关是"按来源逐个判断"，不是"谁问都放行"。
```

> 注：放行时**不能用 `*`** —— 因为响应里带 `access-control-allow-credentials: true`，
> 而按 CORS 规范，`*` 与 `credentials` **不允许同时出现**。网关回显具体来源是必然的，这也顺便保证了"只放行白名单里的来源"。

### 11.4 白名单怎么查、怎么加

```bash
tcb cors list            # 列出本环境的安全域名（Type=SYSTEM 是平台自带，USER 是我们自己的）
tcb cors add <域名>      # 添加（会先问一次 Y/n；域名不带 https:// 前缀，本地开发写 localhost:端口）
tcb cors rm  <域名>      # 删除
```

- **本项目当前状态**：`habit-tracker-d9gh0mjel767ff0d2-1499348397.tcloudbaseapp.com` **已经在册**（`Type=USER`，
  平台创建静态托管默认域名时自动登记的）—— 这就是"页面本来就能 fetch 成功"的直接原因。
- **本地开发地址**（`localhost` / `127.0.0.1`）由**网关内置放行**，不在列表里也能用（已实测）。
- ⚠️ **免费体验版的限制**：尝试再添加安全域名会报 `[CreateAuthDomain] 当前套餐无法执行此操作`
  （试过 `localhost:8765` 与 `localhost` 两种写法都一样，说明是**套餐额度**而不是格式问题）。
  **不影响本项目**：需要放行的那一条已经在位。将来换自定义域名时，把前端域名加进白名单即可。

> **换到别的托管平台就会踩到**：如果哪天把前端放到 GitHub Pages（`*.github.io`）或自己的域名上，
> 来源变了、白名单里没有 → 页面立刻 `fetch` 失败。那时要么把新域名加进白名单，要么把前端放回本环境托管。

---

## 十二、把链接发给同伴，让对方帮你看一眼（Day 20 补）

**要发出去的链接（就这一条）**：

```
https://habit-tracker-d9gh0mjel767ff0d2-1499348397.tcloudbaseapp.com/
```

**照抄给同伴的话**（对方不需要懂技术）：

> 帮我打开这条链接看看：
> ① 上面「今日待做」里有没有几条待办（比如"晨跑 30 分钟""整理下周计划"）？
> ② 标题下面有没有一行小字「云端数据 · 更新于 …」？
> ③ 点底部「我的」，拉到底部看那张「云端检查台」：灯是不是**绿色**？「数据最后一天」是不是**今天**？
> 把这三条结果告诉我就行。

**对方看到的和你看到的一样**，就说明这个链接是"别人也能打开、而且读的是真数据库"的。

**对方要点写入测试入口**（默认隐藏）时，把链接换成这条：

```
https://habit-tracker-d9gh0mjel767ff0d2-1499348397.tcloudbaseapp.com/?debug=1#me
```

点「写入一条测试数据」→ 会真的往库里的 `checkins` 表加一行，
检查台上的「今天打卡项」「库内总条数」会当场 +1。**同一个浏览器当天最多写 3 条**。

**发出去之前自己先过一遍（30 秒自检，三条都应通过）**：

```bash
# ① 线上产物是新的（期望 ≥ 2：检查台标记 + Day 22 的改/删出口；0 说明还没部署 / CDN 没刷新）
curl -s -H "Cache-Control: no-cache" \
  "https://habit-tracker-d9gh0mjel767ff0d2-1499348397.tcloudbaseapp.com/index.html" | grep -cE "diag-card|const apiPatch"

# ② 接口活着（期望 {"ok":true,"service":"Self discipline plan"}）
curl -s "https://habit-tracker-d9gh0mjel767ff0d2.service.tcloudbase.com/api/health"

# ③ 今天有数据（期望 code:0 且 items 非空 —— 空了就去跑 §六 里的 seed-shift）
curl -s "https://habit-tracker-d9gh0mjel767ff0d2.service.tcloudbase.com/api/checkins?date=$(date +%F)&limit=100"
```

---

## 十三、最可能的卡点（按"最容易撞到"排序）

| # | 卡点 | 长什么样 | 怎么处理 |
|---|---|---|---|
| 1 | **数据过期 → 首页空的** | 页面打得开，但「今日待做」空、检查台「今天打卡项 0 条」 | 种子数据的日期锚定在"跑脚本那天"，隔天就脱节。跑 `tcb db execute --sql "$(cat habit-tracker/db/seed-shift.sql)"`（幂等）即可挪到今天。**这是本项目最常撞的一条** |
| 2 | **跨域被拦** | F12 Console 红字 `blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present`；页面回落成「本机数据」 | 判据：响应里**有没有** `Access-Control-Allow-Origin`。用 `curl -H "Origin: <你的来源>"` 复现（§11.2）。本项目来源已在白名单；换成 GitHub Pages / 自定义域名就要先加白名单（免费版有额度限制，见 §11.4） |
| 3 | **环境变量没配 / 失效** | 接口回 `{"code":500,…}`；云函数日志写 `数据库未配置：缺少环境变量 TCB_ENV 或 CLOUDBASE_API_KEY` | 控制台 → 云函数 `api` → 函数配置 → 环境变量，确认三个都在（`tcb fn detail api` 也能看）。改完**要重新部署函数**才生效 |
| 4 | **密钥被写进代码 / 提交上去** | 扫描脚本报出命中行 | 本项目的做法：真值只存在于 `cloudbaserc.json`（已被 `.gitignore` 忽略）和云函数环境变量里；入库的只有无密钥模板 `cloudbaserc.example.json` 与 `.env.example`。**提交前跑一次** `bash habit-tracker/scripts/check-secrets.sh`（Day 23 起）：它扫 8 类特征词 + 断言敏感文件的跟踪状态，期望**全部 0 命中、结论「通过 ✓」、退出码 0** |
| 5 | **改了前端忘了部署** | 本地预览是新的，公网还是旧的 | 前端**没有构建步骤**（零依赖单文件），所以不存在"构建报错"；唯一容易忘的是 `tcb hosting deploy habit-tracker/frontend`。部署后用 §十二 的 ① 号命令确认产物是新的 |
| 6 | **CDN / 浏览器缓存** | 部署完页面没变 | `Ctrl + F5` 强刷；`curl -H "Cache-Control: no-cache"` 复核；CDN 通常几分钟内刷新 |
| 7 | **把两个地址搞混** | 页面白屏、或返回 HTML 而不是 JSON | 前端是 `*.tcloudbaseapp.com`，接口是 `*.service.tcloudbase.com/api`。F12 Network 里看 Request URL 是不是 `/api/...` |
| 8 | **写入被拒（409）** | `{"code":409,"message":"请勿重复提交…"}` | 这是**正常防护**。检查台的按钮每次都会生成新的幂等键，不会撞；手动 curl 复测时别复用同一个 `Idempotency-Key` |
| 9 | **首次打开偶发「网络连不上」** | 页面正常打开，但显示的是本机数据、检查台红灯 | 云函数**冷启动**（1–3 秒）+ 前端 5 秒超时的组合，首次访问偶发触发（本轮验证实测遇到 1 次，**刷新一次即恢复**）。这也是"本机兜底"的设计目的：宁可先显示缓存，也不让页面卡住或白屏。**注意区分**：若小字写的是「服务器开小差了（HTTP 502）」那是服务端故障，不是超时 |
| 10 | **删掉的待办又冒出来了** | `DELETE` 回 `{"code":0,"message":"已删除"}`，但刷新后它还在列表里 | **九成是"软删除只做了一半"**：`DELETE` 把 `is_deleted` 置成了 `true`，但某个读取没带 `is_deleted = false` 条件。查法：`tcb db execute --json --sql "SELECT id, text, is_deleted FROM checkins WHERE id=<id>"` —— 若是 `true`，说明删除成功、是**读取漏过滤**。本项目为此把过滤条件抽成常量 `NOT_DELETED`（`db.js`），全文件搜一下就知道该带的地方有没有带 |
| 11 | **勾选/删除点了没反应，或回 `400 待办 id 不合法`** | 页面点了，Toast 说云端没接受 | 前端按 **id 的类型**分流：云端记录的 id 是数字、本机兜底记录是 `'local-…'` 字符串（`isCloudId()`）。字符串 id 发到云端必然 400 —— 这是**设计如此**（本地记录云端不认识）。若整页的勾选都发不出请求，先确认线上是 Day 22 之后的版本（§十二 ①） |
| 12 | **改/删成功了，但刷新后又变回去** | 操作当下生效，刷新恢复原样 | 与第 5 条同源：**线上那份前端还是旧版**（还走着"勾选/删除暂存本机"的老代码）。判据：页面标题下的小字写的是「云端数据 · 更新于 … · **移动/心情暂存本机**」（新版）还是「…**勾选/删除暂存本机**」（旧版）。重跑 `tcb hosting deploy habit-tracker/frontend` 再 `Ctrl + F5` |
| 13 | **把"服务端出问题"说成"你网络不好"** | 网关 502 / 云函数冷启动超时，用户看到的却是"云端联系不上"，于是跑去反复重启路由器 | 这是 Day 23 修掉的老毛病：以前 `apiFetch` 的 `catch` 把**断网**与**服务端 5xx** 糊成同一个 `offline`。现在按契约 §1.8 分三类——网络层「网络连不上」、服务端故障「服务器开小差了（HTTP 502）」、业务拒绝**原样转述服务端中文原因**。**排查时先看那句话属于哪一类**，再决定查网络还是查云函数日志 |
| 14 | **密钥扫描扫错了范围** | 用裸 `grep` / `rg` 扫整个工作区，被一堆没入库的临时文件刷屏；或反过来只扫某个子目录，漏掉真正会被推上去的文件 | 判据只有一条：**这个文件会不会被推到 GitHub** —— 所以要用 `git grep`（只扫被跟踪的文件）。`scripts/check-secrets.sh` 已按这个边界写死，别改回裸 `grep`；结果里那些"说明性文字"命中（`service_role` 等）是正常的，判据是**后面跟的是不是真值** |

> **关于"构建报错"这类卡点**：本项目前端是**零依赖单文件**（没有 npm、没有打包器），云函数也是**零依赖**
> （只用 Node 内置能力，`installDependency: false`）—— 所以**"构建/装包报错"这一整类问题在本项目不存在**。
> 真正需要盯的是"**忘没忘部署**"和"**数据日期过没过期**"。
>
> **密钥怎么"走环境变量"**（任务里那条要求的落实方式）：
> ① 数据库的 `service_role` API Key 只在云函数环境变量 `CLOUDBASE_API_KEY` 里；
> ② 环境 ID 走 `TCB_ENV`；③ 演示身份走 `DEMO_UID`；
> ④ 前端**只有公开的接口地址**（`API_BASE`，不含任何密钥）；⑤ 含真值的 `cloudbaserc.json` 从不入库。
>
> **`.env` 在本项目的真实角色**（Day 23 补，别误解）：
> 本项目的密钥下发走的是上面那两条云端路径，**渲染流程里没有任何一份代码会读 `.env`**。
> `.env.example` 入库只是"把需要哪些变量写下来" + 给 `.gitignore` 那条 `.env` 规则一个落点。
> 将来若真出现本地脚本（离线批处理、数据迁移），它可以按这份模板建一个 `.env`（已被忽略）。
> **不要把 `.env` 写成"本项目的密钥来源"** —— 那是与事实不符的描述。

---

## 附：v1.0（Day 15）订正表 —— 为什么必须重写

| v1.0 的说法 | 实测结论 |
|---|---|
| 环境 ID `habit-tracker-d3ghf0mjer76ffo02` | ❌ 错的，真实是 `habit-tracker-d9gh0mjel767ff0d2` |
| 在控制台手工配「HTTP 访问服务」路径 `/api` | 新版叫 **HTTP 网关**；默认域名**不许手工加路由**，要用 `fn deploy --path` |
| 用 `tcb hosting deploy` 部署前端 | ✅ 仍然正确 |
| 「云函数默认没有公网地址」 | ⚠️ 方向对，但新版是「HTTP 网关路由」而非旧版「HTTP 访问服务」配置项 |
| 没说云函数怎么读数据库 | ❌ 漏了：需要**环境 API Key + 三个环境变量**（Day 17 补） |
