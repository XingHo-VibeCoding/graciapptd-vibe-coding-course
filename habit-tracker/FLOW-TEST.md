# 核心流程测试清单（六环全链路）

- 版本：**v1.0（2026-10-10 建立）**
- 用途：给「打开检查台 → 读取 plan_days/checkins → 写入打卡 → 刷新确认 → 修改 → 删除」这条**完整链路**一份可复跑的验收清单 + 一套问题诊断协议。
- 配套脚本：`habit-tracker/scripts/core-flow-check.sh`（一条命令走完六环，输出即证据）
- 相关文档：接口定义看 `api-contract.md` §三；部署与排错看 `DEPLOY.md` §七、§十、§十三；安全清单看 `SECURITY.md`

---

## 〇、这份清单怎么用（三步）

```bash
# ① 修之前跑一次，留「前」证据
bash habit-tracker/scripts/core-flow-check.sh ~/core-flow-before.txt

# ② 定位并修复（按 §五 诊断协议走）

# ③ 修之后再跑同一条命令，留「后」证据，然后对比
bash habit-tracker/scripts/core-flow-check.sh ~/core-flow-after.txt
diff ~/core-flow-before.txt ~/core-flow-after.txt
```

**关键**：前后两次跑的是**同一条命令、同一份清单**，所以差异只可能来自"你改了什么"。脚本会自己造一条测试行、跑完再物理删掉，**终态与跑之前完全一致**（所以可以反复跑，演示库不会被弄脏）。

想手工跑也可以 —— §三 每一环都给了「页面口径」（用浏览器点）与「命令口径」（用 curl）两种做法。

---

## 一、链路总览（六环 + 每环的落点）

| 环 | 页面上的动作 | 实际发出的请求 | 真库对照物 |
|---|---|---|---|
| ① 打开检查台 | 「我的」页 → 云端检查台卡片 | `GET /api/health` + `GET /api/checkins?limit=100` | — |
| ② 读取 plan_days/checkins | 首页今日页首屏 | `GET /api/day?date=<今天>` | `plan_days` / `checkins` 两张表 |
| ③ 写入打卡 | 首页加一条待办 | `POST /api/checkins`（带 `clientReqId` 幂等键） | `checkins` 新增一行 |
| ④ 刷新确认 | `Ctrl + F5` | 同 ② | 行数 +1、`sort` 递增 |
| ⑤ 修改 | 点勾选 / 改内容 | `PATCH /api/checkins/:id` | `done` / `done_at` / `text` / `time` / `quad` |
| ⑥ 删除 | 删除按钮 → 二次确认 | `DELETE /api/checkins/:id` | `is_deleted` false → **true（行还在）** |

**为什么是这六环**：前三环回答"**页面读的是不是真数据库**"，后三环回答"**改动是不是真落库**"。中间少了任何一环，都可能出现"看起来能用、其实全是本机缓存"的假象。

检查台卡片上四个数字各有出处，可逐一对账：

| 卡片上的位置 | 元素 id | 数据出处 |
|---|---|---|
| 绿灯 / 红灯那一行 | `#diag-led` `#diag-health` | `GET /api/health` |
| 接口地址 | `#diag-base` | 前端常量 `API_BASE` |
| 数据最后一天 | `#diag-lastday` | `GET /api/checkins?limit=100` 里最大的 `date` |
| 今天打卡项 | `#diag-today` | 同上，按 `date` = 今天过滤 |
| 库内总条数 | `#diag-total` | 接口返回的 `total` |
| 下面那一小段列表 | `#diag-list` | 今天（或最近）最多 3 条 |
| 备注那一行 | `#diag-note` | 读不到时的中文原因 / 截断说明 |

---

## 二、跑之前：前置条件（三条，不知道会白折腾）

1. **检查台的写入按钮是藏起来的**。它只在 URL 带 `?debug=1` 时出现，且**同一浏览器当日最多写 3 条**。

   ```
   带写入按钮：https://habit-tracker-d9gh0mjel767ff0d2-1499348397.tcloudbaseapp.com/?debug=1#me
   不带（只看）：https://habit-tracker-d9gh0mjel767ff0d2-1499348397.tcloudbaseapp.com/#me
   ```

2. **种子数据的日期会过期**。种子锚定在"跑脚本那天"，隔一天首页就是空的 —— 这是**已知的第 1 号卡点**，不是 bug。

   ```bash
   tcb db execute --sql "$(cat habit-tracker/db/seed-shift.sql)"     # 幂等，可反复跑
   ```

3. **脚本的真库对照需要 CLI 已登录**。没登录也能跑，只是标「真库」的项会跳过：

   ```bash
   tcb login        # 扫码，一次就够
   ```

---

## 三、六环逐条清单

每一环都按同一套写：**要证明什么 → 页面怎么做 → 命令怎么做 → 期望看到什么 → 取证 → 不通过时先看 §六 哪一条**。

### 3.1 ① 打开检查台

- **要证明**：云端活着，接口地址是对的，核心表读得到。
- **页面**：打开 `…/#me` → 拉到最下面那张「云端检查台」卡片 → 点「重新检查」。
- **命令**：

  ```bash
  BASE=https://habit-tracker-d9gh0mjel767ff0d2.service.tcloudbase.com/api
  curl -s "$BASE/health"
  curl -s "$BASE/checkins?limit=100"
  ```

- **期望**：`{"ok":true,"service":"Self discipline plan"}`；卡片绿灯 + 「服务正常 · Self discipline plan」；`diag-total` 与`SELECT count(*)`一致。
- **取证**：整张卡片连地址栏一起截；`curl /health` 的输出也留一份（两条互相印证）。
- **不通过**：见 §六 **现象 C（检查台红灯）**、**现象 A（打不开）**。

> 注意：`/api/health` 是契约里**唯一的扁平响应**（回 `{ok,service}` 而不是 `{code,message,data}` 信封），所以前端给它单开了一个 `apiHealth()`，别拿 `apiGet()` 的口径去套它。

### 3.2 ② 读取 plan_days / checkins

- **要证明**：首页那一次请求，真的把两张表的东西一起取回来了。
- **页面**：首页（`…/` ）→ 看「今日待做」列表 + 上方日期/心情。
- **命令**：

  ```bash
  D=$(date +%F)
  curl -s "$BASE/day?date=$D"
  # 真库对照
  tcb db execute --json --sql "SELECT count(*) FROM checkins WHERE date = DATE '$D' AND is_deleted = false"
  tcb db execute --json --sql "SELECT date, mood FROM plan_days WHERE date = DATE '$D'"
  ```

- **期望**：`code=0`，`data.date` = 你传的日期，`data.planDay` 有值（没有记录时是 `null`，**这不是错误**），`data.checkins` 条数 = 真库今天未删行数。
- **取证**：接口 JSON 与真库 `SELECT` 输出并排。
- **不通过**：见 §六 **现象 B（首页空的）**、**现象 I（数字对不上）**。

> ⚠️ **`plan_days` 目前是只读环**：`GET /api/day` 能读到它，但写心情的 `PUT /api/days/mood` 在契约 §四 还标着待实现。所以这一环**只验读、不验写**，不要去找一个不存在的写接口。

### 3.3 ③ 写入打卡

- **要证明**：真往 `checkins` 表插了一行，而且**同一份请求重发第二次会被挡住**。
- **页面**：首页加一条待办；或检查台（`?debug=1`）点「写入一条测试数据」。
- **命令**：

  ```bash
  curl -s -X POST "$BASE/checkins" -H "Content-Type: application/json" \
    -d '{"date":"'"$D"'","text":"流程测试 一条","clientReqId":"manual-test-001"}'
  # 同一份请求再发一次 —— 必须被 409 挡住
  ```

- **期望**：第一次 `{"code":0,"message":"已添加","data":{"id":…,"done":false,"sort":…}}`；第二次 `{"code":409,"message":"请勿重复提交：这条待办刚刚已经添加过了"}`。
- **取证**：两次响应 + 真库 `SELECT id, text, sort FROM checkins WHERE client_req_id='manual-test-001'`。
- **不通过**：见 §六 **现象 D（加待办失败）**。

> `sort` 是服务端补的（当天最大 `sort` + 1），`done` 恒为 `false`，`uid` 取登录身份 —— 这三个字段前端传了也会被忽略。

### 3.4 ④ 刷新确认

- **要证明**：那条数据是**落了库**的，不是页面上的假象。
- **页面**：`Ctrl + F5` 强刷 → 那条还在。
- **命令**：重复 3.2 的两条读命令，确认新 `id` 出现在返回里，且本日 `total` = 之前 +1。
- **期望**：新 `id` 仍在；本日条数 +1；真库 `count(*)` 同步 +1。
- **取证**：刷新前后各一张（或一条命令的 `total` 前后值）。
- **不通过**：见 §六 **现象 E（写成功但刷新后没了）**。

> 这一步是整条链路里**最重要的一步**：只有它能把"真写进数据库"和"只写到了内存/localStorage"区分开。

### 3.5 ⑤ 修改

- **要证明**：`PATCH` **只改传了的字段**，没传的原样不动；`done` 由假变真时服务端会同时写 `done_at`。
- **页面**：点待办前的勾选（或检查台的写入之后再改）。
- **命令**：

  ```bash
  curl -s -X PATCH "$BASE/checkins/<id>" -H "Content-Type: application/json" \
    -d '{"text":"流程测试 改过","time":"21:30","done":true}'
  ```

- **期望**：`code=0`，`data` 是**改完之后的整条**；对比四个字段：

  | 字段 | 改前 | 改后 |
  |---|---|---|
  | `text` | 流程测试 一条 | 流程测试 改过 |
  | `time` | `null` | `21:30` |
  | `done` | `false` | `true` |
  | `doneAt` | `null` | 一个毫秒数 |
  | `quad` | 没传 | **原样不动**（部分更新的证据） |

- **取证**：改前/改后逐字段对照表（脚本会把这一段排版好，直接截）。
- **不通过**：见 §六 **现象 F（勾选没反应）**。

> 服务端判定顺序本身就是防线：**身份 401 → 参数 400 → 查行 404 → 归属 403 → 已软删除 404 → 未来日期打勾 409**。给未来日期的待办打勾会被 `409「这一天还没到，先别急着打勾」` 拦住，**取消打勾任何时候都允许**。

### 3.6 ⑥ 删除

- **要证明**：删了之后 `GET` 不再返回它；而且**库里那一行还在，只是 `is_deleted` 变成了 `true`**（软删除）。
- **页面**：点删除 → 会弹二次确认「确定删除这条待办吗？」→ 确定。
- **命令**：

  ```bash
  D=$(date +%F)
  curl -s -X DELETE "$BASE/checkins/<id>"
  curl -s "$BASE/checkins?date=$D"                                  # 该 id 应消失、total 回落
  tcb db execute --json --sql "SELECT id, text, is_deleted FROM checkins WHERE id=<id>"
  curl -s -X DELETE "$BASE/checkins/<id>"                           # 再删一次 → 404
  ```

- **期望**：`{"code":0,"message":"已删除","data":{"id":…}}`（`data` 只回 `id`，因为整行已经"不存在"了）；再 `GET` 该 `id` 已消失、本日 `total` 回到基线；真库那行**还在**且 `is_deleted=true`；再删一次 → `404「这条待办不存在或已删除」`。
- **取证**：`GET` 前后对比 + 真库 `is_deleted` 那一行（这条 SELECT 是软删除的硬证据，务必截）。
- **不通过**：见 §六 **现象 G（删了刷新又出现）**。

> **为什么删除要格外小心**：新增错了是"多了一条"（可逆），删除错了是"少了一条"（不可逆）。所以删除在三层各有一道确认 —— 交互层的 `confirm`、服务层的 `uid` 限定（防越权删别人的）、存储层的软删除（不真删，撤标记就能找回）。

---

## 四、问题反馈格式（你填这四栏）

发现问题时按这个格式给我，**四栏都要**，缺哪栏我就得猜：

```
【现象】    一句话说清"看到了什么"。例：首页刷新后今天那条待办不见了。
【复现步骤】从哪个页面、点了什么、第几步开始不对。例：①打开首页 ②加一条"测试"
           ③Ctrl+F5 ④那条没了。
【报错原文】F12 Console 的红字 / Network 里那条请求的状态码与响应体 / Toast 上的文字。
           **原样粘贴，不要转述** —— "报了个错"和"code:409 请勿重复提交"是两条完全不同的线索。
【已尝试动作】你已经做过什么（清缓存 / 换浏览器 / 重跑脚本 / 查过哪张表）。
           这栏用来排除,免得我让你重复你已经做过的事。
```

**能顺手带上的话，这三样最有用**（比截图更省事）：

1. `bash habit-tracker/scripts/core-flow-check.sh ~/core-flow-now.txt` 的输出（一整条链路的体检报告）
2. F12 → Network → 那条请求 → **Request URL** 与**响应体原文**
3. 真库那条记录：`tcb db execute --json --sql "SELECT * FROM checkins WHERE id=<id>"`

---

## 五、诊断协议（我收到反馈后按这四步答）

1. **原因排序** —— 列出**所有**可能的原因，按"最可能是它"排序，每条注明**支持它的证据**与**反对它的证据**。不先给结论、不跳过中间步骤。
2. **每个原因的验证方法** —— 每条给**一条可直接粘贴的命令**（或一个具体的页面动作），并写清「期望看到什么」「看到别的说明什么」。用**排除法**逐个划掉，直到只剩一个。
3. **修复方案** —— 针对已锁定的原因给改动方案，同时写明**这次不改什么**（避免顺手牵羊扩大改动面）。
4. **回归验证清单** —— 列出"修完之后必须重跑哪些项"，**默认就是 §三 的全部六环**（重跑 `core-flow-check.sh` 留「后」证据），加一个"这次的失败项现在通过了"的对照。

> **为什么坚持先排序再验证**：同一个现象往往有 3~4 个可能原因，凭直觉挑一个去修，很可能"改对了症状、改错了地方"——改完看起来好了，下次换个入口又冒出来。排序 + 排除法能把"哪条证据支持哪个假设"摊开看。

---

## 六、原因候选池（按可能性预排序）

这是**先备好的答案库**：你报现象，我从对应那组里按序排查，省掉来回问的时间。每组都给了现成命令。

### 现象 A：页面白屏 / 卡在「加载中」/ 进了错误页

| 序 | 原因 | 验证命令 | 判据 |
|---|---|---|---|
| A1 | 云函数冷启动（1~3s）+ 前端 5s 超时 | `curl -s -o /dev/null -w '%{time_total}\n' "$BASE/health"` | 数字 >5 就是它；**刷新一次即恢复** |
| A2 | 接口地址不对 / 线上是旧版前端 | 页面上看 `#diag-base`；F12 Network 看 Request URL | 应形如 `…service.tcloudbase.com/api/…`，不是 `tcloudbaseapp.com` |
| A3 | 跨域被拦（换过域名 / GitHub Pages） | `curl -s -D - -o /dev/null -H "Origin: https://你的来源" "$BASE/health"` | 响应头**有没有** `Access-Control-Allow-Origin` |
| A4 | 静态资源没部署 / CDN 缓存 | `curl -s -o /dev/null -w '%{http_code} %{size_download}\n' -H 'Cache-Control: no-cache' "https://…tcloudbaseapp.com/"` | 200 且字节数是新版（部署后 `Ctrl+F5`） |

### 现象 B：首页空的（今日待做 0 条），但页面正常

| 序 | 原因 | 验证命令 | 判据 |
|---|---|---|---|
| B1 | **种子日期落后**（第 1 号卡点） | `tcb db execute --json --sql "SELECT max(date) FROM checkins WHERE is_deleted = false"` | 小于 `date +%F` → 跑 `seed-shift.sql` |
| B2 | 今天确实还没加待办 | 检查台 `#diag-today` | 显示 `0 条` 且库内最后一天 = 今天 = 正常 |
| B3 | 本机日期 vs 服务端日期不一致（时区） | `curl -s "$BASE/day"`（**不传 date**）比 `date +%F` | 两个日期不同 → 时区口径问题 |
| B4 | 读取漏带 `is_deleted = false` | 对比接口 `total` 与 `SELECT count(*) … AND is_deleted = false` | 接口偏大 → 已删行被算进来了 |

### 现象 C：检查台红灯

| 序 | 原因 | 判据 |
|---|---|---|
| C1 | 网络层（断网 / 超时 / 跨域被拦） | 灯旁文案是「**网络连不上**」 |
| C2 | 服务端故障（网关 5xx / 响应不是 JSON） | 灯旁文案是「**服务器开小差了（HTTP 502）**，过一会儿再试」 |
| C3 | 环境变量没配 / 失效 | 接口回 `{"code":500,…}`；云函数日志写「数据库未配置：缺少环境变量 TCB_ENV 或 CLOUDBASE_API_KEY」→ `tcb fn detail api` 看，改完**要重新部署函数** |
| C4 | 核心表读不到（表不存在 / 权限） | `#diag-note` 写「核心表没读到：…」 |

> **C1 与 C2 必须分清** —— 这是 Day 23 修掉的老毛病。以前两类被糊成同一句"联系不上"，用户会跑去重启路由器；现在按契约 §1.8 分三类，**先看那句话属于哪一类，再决定查网络还是查云函数日志**。

### 现象 D：加待办失败（Toast 报错）

| 序 | 原因 | 判据 |
|---|---|---|
| D1 | 网络层 | Toast 是「网络连不上」→ 数据会**回落存本机**，联网后不会自动补传 |
| D2 | `409` 幂等冲突 | `请勿重复提交…`。**这是正常防护**：检查台的按钮每次都会生成新幂等键；手动 curl 复测时别复用同一个 `Idempotency-Key` |
| D3 | `400` 参数被拒 | 文案直接点名哪个字段（如「内容不能为空，且不超过 60 字」） |
| D4 | `500` 服务端 / 数据库 | 看云函数日志（`tcb fn log api`） |

### 现象 E：写成功但刷新后没了

| 序 | 原因 | 判据 |
|---|---|---|
| E1 | **线上那份前端是旧版** | 看标题下小字写的是「**移动/心情暂存本机**」（新版）还是「**勾选/删除暂存本机**」（旧版）→ 重跑 `tcb hosting deploy habit-tracker/frontend` + `Ctrl+F5` |
| E2 | 当时断网，写到了本机 | 小字提示过「网络连不上，已先存本机」；本机数据不会自动上云 |
| E3 | 身份变了（`DEMO_UID` 改过 / 换了浏览器） | 真库里查 `uid`：`SELECT DISTINCT uid FROM checkins` |

### 现象 F：勾选点了没反应 / 回 `400 待办 id 不合法`

| 序 | 原因 | 判据 |
|---|---|---|
| F1 | 点的是**本机记录**（`id` 形如 `local-…`） | 设计如此：本机记录云端不认识。数字 id 才发云请求（`isCloudId()`） |
| F2 | 线上是旧版（勾选还没接线） | 同 E1 的判据 |
| F3 | 给未来日期打勾 | `409「这一天还没到，先别急着打勾」`（服务端硬拦，前端禁用只是体验层） |

### 现象 G：删了刷新又出现

| 序 | 原因 | 验证 | 判据 |
|---|---|---|---|
| G1 | **软删除只做了一半**：`DELETE` 把 `is_deleted` 置成了 `true`，但某个读取漏带过滤 | `tcb db execute --json --sql "SELECT id, text, is_deleted FROM checkins WHERE id=<id>"` | 若 `is_deleted=true` → 删除成功、是**读取漏过滤**。本项目把过滤抽成常量 `NOT_DELETED`（`db.js`），全文件搜一下就知道该带的地方有没有带 |
| G2 | 线上是旧版前端 | 同 E1 |
| G3 | 浏览器缓存 | `Ctrl+F5` |

### 现象 H：F12 控制台有红字

| 序 | 原因 | 判据 |
|---|---|---|
| H1 | `/favicon.ico` 404 | Day 24 已修（`assets/favicon.png` + head 声明）。若再现，说明线上还是旧版前端 |
| H2 | 跨域红字 `blocked by CORS policy` | 见 A3 |
| H3 | 静态资源 404 | 逐个探测：`for f in hero.jpg favicon.png icon-todo.png; do curl -s -o /dev/null -w "%{http_code} $f\n" "$U/assets/$f"; done` |

> **排查教训（Day 24 实测）**：控制台红字**先看请求 URL 再下结论**。那条 favicon 404 与接口、部署、JS 全无关，是"浏览器按标准约定自动请求根目录 favicon 落了空"——当时用排除法（接口 → 静态资源 → JS → 后端校验）才锁定真因，别被红字吓得先去重启服务。

### 现象 I：接口正常但数字对不上

| 序 | 原因 | 判据 |
|---|---|---|
| I1 | `total` 与 `items.length` 口径不同 | `total` 是**满足条件的总条数**（不是本页条数），前端靠它判断还有没有下一页 |
| I2 | 已软删除的行被计入 `total` | 见 B4 |
| I3 | `limit` 截断 | `limit` 范围 1~100，默认 20；`#diag-note` 会写「库内共 N 条，本次只统计返回的 M 条」 |
| I4 | 只看了 100 条窗口内的 `date` | 检查台的"数据最后一天"取自 `limit=100` 的窗口，超出窗口的更晚数据不计入 |

---

## 七、证据留存与对比（「前后各留一份」怎么做）

### 建议做法

```bash
# 修之前
bash habit-tracker/scripts/core-flow-check.sh ~/core-flow-before.txt
# 修之后
bash habit-tracker/scripts/core-flow-check.sh ~/core-flow-after.txt
# 对比：只看 ✓/✗ 与数字有没有变
diff ~/core-flow-before.txt ~/core-flow-after.txt
```

证据文件里已经排好版：结论行会写 `通过 N 项 · 跳过 M 项 · 失败 K 项`，退出码 `0` = 全过、`1` = 有失败项。

### diff 时哪些行**必然**不同（别误判）

| 必然不同的行 | 为什么 |
|---|---|
| `生成时间` | 两次跑的时间不同 |
| `id=…`、`sort=…`、`doneAt=…` | 每次新建的自增 id 与时间戳不同 |
| `[流程自检] … flowcheck-…` | 每次运行有专属标记（脚本靠它定位并清理自己造的数据） |
| `证据文件` | 文件名不同 |

**要盯的是**：`✓` / `✗` 的数量与位置、`通过 N 项 · 失败 K 项`、以及各环的条数与真库对照值。

### 证据放哪

- **默认放在仓库外**（如 `~/` 或工作区），避免污染 `git status`。
- 想留档入库的话放 `habit-tracker/docs/`，**但要注意里面含数据库真实 id 与内容**，按 SECURITY.md 的口径判断是否合适。
- 截图与命令输出**都要**：截图证明"页面看起来对"，命令输出证明"数据库里真的是这样"。

---

## 八、已知边界（跑之前先知道，免得当成 bug 报）

| 边界 | 说明 |
|---|---|
| **`plan_days` 只读** | `GET /api/day` 能读，写心情的 `PUT /api/days/mood` 在契约 §四 **待实现**。② 环只验读 |
| **检查台写入按钮默认隐藏** | 需要 `?debug=1`，且同一浏览器**当日最多 3 条**（`DIAG_WRITE_MAX`）—— 公网链接人人可开，不能让访客随手写库 |
| **种子日期会过期** | 隔天不跑 `seed-shift.sql`，首页就是空的（第 1 号卡点） |
| **勾选/删除上云，移动/心情仍在本机** | 页面小字会写「移动/心情暂存本机」。所以 `date`/`sort` **不能**通过接口改（契约 §三 PATCH 明确忽略这两个字段） |
| **curl 手测的身份是 `DEMO_UID`** | 前端没有登录流程，服务端用环境变量里的演示 uid 兜底。所以 curl 和页面看到的是同一批数据 |
| **断网时页面照常可用** | 数据回落本机缓存，不白屏；但断网期间的改动**不会自动补传** |
| **首次访问偶发「网络连不上」** | 云函数冷启动 + 5s 超时的组合，刷新一次即恢复（已记在 DEPLOY.md 卡点 9） |

---

## 附：变更记录

- **v1.0（2026-10-10）** 建立。六环清单 + 问题回报格式 + 四步诊断协议 + 9 组原因候选池（共 30 条原因）+ 证据留存规范 + 7 条已知边界。配套脚本 `scripts/core-flow-check.sh` 首次跑通：**22 项通过 / 1 项跳过 / 0 失败**（跳过项 = 种子日期落后一天，属已知卡点）。
