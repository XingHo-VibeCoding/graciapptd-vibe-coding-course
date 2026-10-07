# 自律计划 · 部署手册（DEPLOY.md）

- 版本：**v2.4（2026-10-07）** — 新增 §十一「跨域（CORS）」：实测矩阵 + 诊断方法 + 免费版套餐限制；§六 补「前端改动后重新部署与缓存」；§七 加 Day 20 验证方法；§九 把"配置跨域"移出"本期不做"。v2.3（2026-10-05）§五 补「上传的是整个函数目录」；v2.2（2026-10-05）§7.4 补「⑤ 读回验证」；v2.1（Day 18）增加写入接口部署与验证；v2.0（Day 17）基于实测跑通重写；v1.0（Day 15）按旧版 CloudBase 写，多处与实际不符（见文末「v1.0 订正表」）。
- 用途：把**云函数 `api`**、**数据库表**、**前端页面**推上公网的可复现步骤。以后每次重新部署照这份做。
- 本版配套脚本：`db/schema.sql`、`db/schema-2.sql`（增量）、`db/seed.sql`、`db/verify.sql`；云函数 `cloudfunctions/api/index.js`（零依赖）；部署配置模板 `cloudbaserc.example.json`。

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

> **顺序很重要**：`.gitignore` 里 `cloudbaserc.json` 这条规则是**先把规则立好、再落密钥**的。
> 反过来做（先建文件后补规则）就可能把密钥提交上去 —— 仓库是 public 的。

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

---

## 八、控制台手动路线（CLI 不可用时的备选）

1. **建表**：环境 → 数据库 → PostgreSQL → SQL 编辑器，依次粘贴 `schema.sql` → `seed.sql` → `verify.sql` → `schema-2.sql`。
2. **API Key**：环境 → API Key → 新建，复制 token。
3. **云函数**：云函数 → 新建（名称必须 `api`，运行时 Node.js 20）→ 粘贴 `cloudfunctions/api/index.js` → 保存并部署 →
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

### 11.3 本项目实测结果（2026-10-07 Day 20）

| 来源 | 是否返回 `Access-Control-Allow-Origin` | 结论 |
|---|---|---|
| `https://habit-tracker-d9gh0mjel767ff0d2-1499348397.tcloudbaseapp.com`（本项目前端） | ✅ 原样回显该来源 | 放行 |
| `http://localhost:8765`、`http://127.0.0.1:8765` | ✅ 原样回显 | 放行（本地开发用） |
| `https://evil.example.com`、`https://graciapptd.github.io`、别的环境的 `*.tcloudbaseapp.com` | ❌ 完全没有该响应头 | **会被浏览器拦** |
| `OPTIONS` 预检（本环境前端来源 + `POST`） | ✅ `204` + `allow-methods: POST` + `allow-headers: content-type,idempotency-key` | 预检通过 |

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

## 附：v1.0（Day 15）订正表 —— 为什么必须重写

| v1.0 的说法 | 实测结论 |
|---|---|
| 环境 ID `habit-tracker-d3ghf0mjer76ffo02` | ❌ 错的，真实是 `habit-tracker-d9gh0mjel767ff0d2` |
| 在控制台手工配「HTTP 访问服务」路径 `/api` | 新版叫 **HTTP 网关**；默认域名**不许手工加路由**，要用 `fn deploy --path` |
| 用 `tcb hosting deploy` 部署前端 | ✅ 仍然正确 |
| 「云函数默认没有公网地址」 | ⚠️ 方向对，但新版是「HTTP 网关路由」而非旧版「HTTP 访问服务」配置项 |
| 没说云函数怎么读数据库 | ❌ 漏了：需要**环境 API Key + 三个环境变量**（Day 17 补） |
