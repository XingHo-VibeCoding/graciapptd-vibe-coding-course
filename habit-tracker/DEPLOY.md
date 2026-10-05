# 自律计划 · 部署手册（DEPLOY.md）

- 版本：**v2.3（2026-10-05）** — §五 补「上传的是整个函数目录（含新拆出的 db.js）」说明；v2.2（2026-10-05）§7.4 补「⑤ 读回验证」；v2.1（Day 18）增加写入接口部署与验证；v2.0（Day 17）基于实测跑通重写；v1.0（Day 15）按旧版 CloudBase 写，多处与实际不符（见文末「v1.0 订正表」）。
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

**应看到**：自律计划首页（顶部落日大图 + 今天待办 + 底部导航），导航都能切。
**注意**：本期**没配跨域 CORS**，所以页面里的 `fetch` 会被浏览器拦，页面数据仍是**浏览器本地的 mock 数据** —— 这是**预期**的（见 §九）。

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
| 配置跨域 CORS | 页面还没接接口；地址栏/curl 测不受 CORS 限制 | 前端开始 `fetch` 时（Day 18+） |
| 匿名登录 + RLS | 需要先把读接口跑通，身份链路下一批做 | Day 18 |
| 其余 5 张表 | 按课程节奏 Day 18 前追加到 `schema-2.sql`（不改 `schema.sql`） | Day 18 |
| 业务写入接口 | 读接口先验证通过 | Day 18 |
| 自定义域名 / HTTPS 证书 | 默认域名够用 | 后续优化 |

> **为什么「地址栏能测、页面 fetch 会失败」**：CORS 是浏览器的**同源策略**限制 —— 地址栏敲 URL 属于"直接导航"，浏览器不管；
> 页面里的 JS 发 `fetch` 属于"跨域请求"，浏览器会先问服务器"允不允许"，没配就拦。
> 所以今天能验证，不代表接口能被页面调用。

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

---

## 附：v1.0（Day 15）订正表 —— 为什么必须重写

| v1.0 的说法 | 实测结论 |
|---|---|
| 环境 ID `habit-tracker-d3ghf0mjer76ffo02` | ❌ 错的，真实是 `habit-tracker-d9gh0mjel767ff0d2` |
| 在控制台手工配「HTTP 访问服务」路径 `/api` | 新版叫 **HTTP 网关**；默认域名**不许手工加路由**，要用 `fn deploy --path` |
| 用 `tcb hosting deploy` 部署前端 | ✅ 仍然正确 |
| 「云函数默认没有公网地址」 | ⚠️ 方向对，但新版是「HTTP 网关路由」而非旧版「HTTP 访问服务」配置项 |
| 没说云函数怎么读数据库 | ❌ 漏了：需要**环境 API Key + 三个环境变量**（Day 17 补） |
