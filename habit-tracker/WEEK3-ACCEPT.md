# 第 3 周验收表（Day 15–21 · 后端上云周）

> - 验收日期：2026-10-08（Day 21）｜验收人：本人（同伴交叉验证见 §四，**未执行**）
> - 验收范围：本周 5 项核心产出（§一）+ 3 项验收动作（§二）
> - 结论枚举：**PASS / FAIL / 未执行**（无第四种写法）
> - 证据形式：`commit:<hash>` GitHub 提交页｜`线上:` 可打开的公网地址｜`复现:` 可粘贴重跑的命令｜实测输出直接引用原文

## 结论总览

| 分区 | PASS | FAIL | 未执行 |
|---|---|---|---|
| §一 五项核心产出 | 5 | 0 | 0 |
| §二 三项验收动作 | 1 | 0 | 2 |
| **合计** | **6** | **0** | **2** |

未执行的 2 项：**同伴交叉验证**（需真人，说明已备好，见 §四）、**演示视频**（余力加练项）。其余全部 PASS，无 FAIL。

---

## 一、本周五项核心产出（逐项验收）

### 产出 1｜建表与种子脚本 `db/schema.sql` / `schema-2.sql` / `seed.sql`

**产出链接**：commit:[ccb2d31](https://github.com/XingHo-VibeCoding/graciapptd-vibe-coding-course/commit/ccb2d31)（Day 16 建表）、commit:[0a8d7af](https://github.com/XingHo-VibeCoding/graciapptd-vibe-coding-course/commit/0a8d7af)（Day 18 增量 `schema-2.sql`）；文件：`habit-tracker/db/schema.sql`、`db/schema-2.sql`、`db/seed.sql`

**验证方法**（4 步，本日实测）：
1. `tcb db execute --sql "$(cat db/schema.sql)"` **连跑两遍** → 两遍都应成功且 **0 行受影响**（幂等）
2. `tcb db execute --sql "$(cat db/schema-2.sql)"` 再跑一遍 → 应输出「`checkins_uid_reqid_uniq` 索引已就绪」
3. `tcb db execute --sql "$(cat db/seed.sql)"` **跑两遍** → 第一遍应新增 7（plan_days）+ 8（checkins）行，**第二遍行数必须不变**
4. 跑完后按日期清理实测插入的行，核对库内行数回到原值

**实测输出**（2026-10-08）：
```
schema.sql 第一遍：Affected rows: 0, completed in 13 ms
schema.sql 第二遍：Affected rows: 0, completed in 18 ms
schema-2.sql     ：│ checkins_uid_reqid_uniq 索引已就绪 │ 1 │
seed.sql 第一遍  ：plan_days 14 / checkins 17   ← 原值 7 / 9，正好 +7 / +8
seed.sql 第二遍  ：plan_days 14 / checkins 17   ← 数字不变 = 重复执行零新增
清理后           ：checkins 9 / plan_days 7 / 历史日期残留 0
```
> 幂等实现：建表用 `CREATE TABLE IF NOT EXISTS`、`ADD COLUMN IF NOT EXISTS`、`CREATE UNIQUE INDEX IF NOT EXISTS`；种子用 `ON CONFLICT (uid, date) DO NOTHING`（plan_days 天然唯一键）+ `WHERE NOT EXISTS`（checkins 无天然唯一键，按「同人同天同内容」跳过）。

**结论：PASS**（证据：上述 4 步实测输出；清理后数据完全复原，无残留）

---

### 产出 2｜公网 GET / POST 接口

**产出链接**：commit:[ebb6d9d](https://github.com/XingHo-VibeCoding/graciapptd-vibe-coding-course/commit/ebb6d9d)（health）、commit:[b74a5b3](https://github.com/XingHo-VibeCoding/graciapptd-vibe-coding-course/commit/b74a5b3)（GET 上公网）、commit:[0a8d7af](https://github.com/XingHo-VibeCoding/graciapptd-vibe-coding-course/commit/0a8d7af)（POST）

**接口地址**：`https://habit-tracker-d9gh0mjel767ff0d2.service.tcloudbase.com/api`（4 条路由：`GET /api/health`、`GET /api/day`、`GET /api/checkins`、`POST /api/checkins`）

**验证方法**（9 条 curl，覆盖正常 + 全部异常分支）：
```bash
BASE=https://habit-tracker-d9gh0mjel767ff0d2.service.tcloudbase.com/api
curl -s -w '\n[HTTP %{http_code}]\n' "$BASE/health"                    # ① 健康
curl -s "$BASE/day?date=2026-10-08"                                    # ② 读某天（真库）
curl -s "$BASE/checkins?limit=100"                                     # ③ 读列表 + total
curl -s "$BASE/day?date=2026-13-99"                                    # ④ 非法日期
curl -s "$BASE/nope"                                                   # ⑤ 未知路由
curl -s -X POST "$BASE/checkins" -H 'Content-Type: application/json' \
  -d '{"date":"2026-10-08","text":"验收实测写入","time":"09:30","quad":"q1","clientReqId":"<新键>"}'   # ⑥ 正常写入
# ⑦ 同 clientReqId 再发一次（重复）  ⑧ 缺 text  ⑨ time 非法
```

**实测输出**（2026-10-08）：
| # | 请求 | 实测返回 |
|---|---|---|
| ① | `GET /api/health` | `{"ok":true,"service":"Self discipline plan"}` **HTTP 200** |
| ② | `GET /api/day?date=2026-10-08` | `code=0 message=ok 条数=6 mood=calm` |
| ③ | `GET /api/checkins?limit=100` | `total=9 返回=9`，字段 `['date','done','doneAt','id','quad','sort','text','time']` |
| ④ | `GET /api/day?date=2026-13-99` | `{"code":400,"message":"日期格式不对，应为 YYYY-MM-DD"}` |
| ⑤ | `GET /api/nope` | `{"code":404,"message":"接口不存在：GET /api/nope","data":{"availableRoutes":[…4条…],"version":"0.4.0"}}`（**HTTP 恒 200**，见下方说明） |
| ⑥ | `POST /api/checkins`（新幂等键） | `code=0 message=已添加`，插入行 `sort=6`（自动接尾） |
| ⑦ | 同幂等键重复提交 | `{"code":409,"message":"请勿重复提交：这条待办刚刚已经添加过了"}` |
| ⑧ | 缺 `text` | `{"code":400,"message":"缺少必填字段 text（待办内容）"}` |
| ⑨ | `time:"25:99"` | `{"code":400,"message":"时间格式不对，应为 HH:mm（24 小时制）"}` |
| ⑩ | 写后读回 | `GET /api/day` 由 **6 条 → 8 条**，新行 `sort=6`、`sort=7` 排在最后 |
| ⑪ | 库内核对 + 清理 | 实测行删除后：`checkins 9 行 / 今天 6 条 / 残留 0` |

> **关于 ⑤ 的 HTTP 状态码**：契约规定响应外壳 `{code,message,data}` 且 **HTTP 恒 200**（`GET /api/health` 是唯一例外，返回扁平体），所以「未知路由」表现为信封 `code=404` 而非 HTTP 404。这是**契约既定行为**，不是缺陷。

**结论：PASS**（证据：①–⑪ 全部实测，异常分支与正常分支均有原文输出；写入的实测数据已清理）

---

### 产出 3｜云函数分层重构（数据访问层 `db.js`）

**产出链接**：commit:[b0f5828](https://github.com/XingHo-VibeCoding/graciapptd-vibe-coding-course/commit/b0f5828)；文件：`cloudfunctions/api/index.js`（v0.4.0，路由层）、`cloudfunctions/api/db.js`（数据访问层）

**验证方法**（4 条，本日实测）：
1. `grep -n "fetch(" cloudfunctions/api/index.js` → **应为空**（网络请求已全部搬进 db.js）
2. `ls cloudfunctions/api/` → 应有 `index.js` + `db.js` 两个代码文件
3. `git show --stat b0f5828 -- api-contract.md` → **应无文件改动**（重构当日契约零修改）
4. `node cloudfunctions/api/selftest.js` → **162/162**，其中第 9 节用静态断言证明「数据库代码真的搬走了」（index.js 内无 `fetch(`、无 REST 基址、无数据库列名），并直接调用 `db.js` 验证数据层可脱离路由独立工作

**实测输出**（2026-10-08）：
```
index.js 路由表：'GET /api/health' / 'GET /api/day' / 'GET /api/checkins' / 'POST /api/checkins'
index.js 内 fetch( ：0 处（全部在 db.js）
重构提交 b0f5828 对 api-contract.md 的改动：无（提交说明原文：「api-contract.md 本次零修改——接口路径与字段名一个都没动」）
云函数本地自测：162/162 通过
改动前基线：140/140 → 改动后同命令 162/162 一次通过（未出现「改坏了再修」）
```

**结论：PASS**

---

### 产出 4｜公网检查台 URL

**公网地址**：`https://habit-tracker-d9gh0mjel767ff0d2-1499348397.tcloudbaseapp.com/?debug=1#me`（`?debug=1` 才显示「写入一条测试数据」按钮；不带参数访问则按钮不存在）
**产出链接**：commit:[cbc582a](https://github.com/XingHo-VibeCoding/graciapptd-vibe-coding-course/commit/cbc582a)

**验证方法**（3 条，本日实测）：
1. `curl -o /dev/null -w "%{http_code}"` 打首页 URL 与检查台 URL → 都应 200
2. 用 jsdom 加载**线上那份 index.html**、用真实网络打公网接口 → 断言 11 项
3. 在页面里用首页添加表单**真写一条**，然后**销毁页面重新加载**（等价刷新）→ 新条目必须仍在

**实测输出**（2026-10-08 21:52）：
```
首页 URL           HTTP 200
检查台 URL(?debug=1#me)  HTTP 200
jsdom 端到端（线上产物 + 真网络）：11 通过 / 0 失败
  ✅ 健康指示灯为绿  ✅ 健康文案含服务名  ✅ 接口地址是公网地址
  ✅ 数据最后一天 = 今天（2026-10-08）  ✅ 今天打卡项 6 条  ✅ 库内总条数 9 条
  ✅ 检查台列出真实条目  ✅ 调试模式下写入按钮可见  ✅ 副标题标注调试模式
真实写入 + 刷新持久化：6 通过 / 0 失败
  ① 打开公网首页：6 条（真库）
  ② 提交后：7 条 | toast: 已添加到云端
  ③ 重新加载页面（等价刷新）：7 条 → ✅ 新条目仍在（云端持久化）  ✅ 条数比写入前 +1
  小字：云端数据 · 更新于 10月8日 21:38 · 勾选/删除暂存本机
  写入内容「演示持久化写入 21:52:07」已删除，库内复原 9 行 / 今天 6 条
```

**结论：PASS**

---

### 产出 5｜`api-contract.md` 完整性

**文件**：`habit-tracker/api-contract.md`，当前 **v1.5**

**验证方法**（4 条，本日实测）：
1. **已实现接口逐条登记**：4 条路由在契约中的出现次数必须 > 0
2. **字段名逐字一致**：把接口实测返回的字段集与契约响应示例对比
3. **错误消息逐字一致**：把接口实测的错误消息与契约错误表对比
4. **验收入档**：契约 §6 应逐日留有验收记录

**实测输出**（2026-10-08）：
```
① 登记情况：GET /api/health 6 次、GET /api/day 11 次、GET /api/checkins 11 次、POST /api/checkins 7 次 → 4/4 全部登记
② 字段集比对：实测返回 ['date','done','doneAt','id','quad','sort','text','time']
   契约 §三 POST 响应示例 data = {id, date, text, time, quad, done, doneAt, sort} → 完全一致（8/8）
③ 错误消息逐字比对（契约 §三 错误表 ↔ 实测）
   契约「缺少必填字段 text（待办内容）」        ↔ 实测 一致
   契约「时间格式不对，应为 HH:mm（24 小时制）」 ↔ 实测 一致
   契约「请勿重复提交：这条待办刚刚已经添加过了」↔ 实测 一致（409）
④ 验收记录：§6.1 Day 17 / §6.2 Day 18 / §6.3 Day 20 / §6.4 Day 20 补，四条齐全
```

**结论：PASS**（无缺项、无与实现不符的登记）

---

## 二、三项验收动作

| # | 动作 | 验证方法 | 结论 | 证据 |
|---|---|---|---|---|
| 1 | 演示提纲已写出并完整走通一遍 | 按提纲演示步骤真实执行 5 步（打开首页 → 检查台 → 真实写入 → 刷新持久化 → 跨域实测），逐步留有输出 | **PASS** | `DEMO.md`（四段/五段结构见文件）＋本节上方实测输出 |
| 2 | 同伴交叉验证（三行结论） | 同伴打开链接给出「能否打开 / 能否真实读写 / 有无报错」 | **未执行** | 说明与结论模板见 §四；**结论回来前本表不视为闭合** |
| 3 | 演示视频（3 分钟，余力加练） | 录制并按提纲讲解 | **未执行** | 提纲与走查证据已备齐，随时可录 |

---

## 三、周复盘：这周最花时间的是哪一步？值吗？

**最花时间的一步：Day 17「部署 + 真库验证」**，而且不是花在写代码上，是花在**三件"以为做好了、其实没有"的事**：

1. **环境 ID 记错一个字符**（`d3ghf0mjer76ffo02` ❌ → `d9gh0mjel767ff0d2` ✅），文档和记忆里全错；
2. **建表脚本写好了，却从没在真库执行过**——`information_schema` 一查是空的；
3. **新版默认域名不允许手工加路由**，`--httpFn` 是给 Web 函数用的，试错后才摸到 `tcb fn deploy --path /api` 这条正路。

**值。** 三个理由：
- 这一步逼出了 `DEPLOY.md` **基于实测的完全重写**（v1.0 → v2.x），之后 Day 18/19/20 每次部署照文档一遍过，返利远超成本；
- 它确立了这周最重要的一条判断标准：**部署的完成标准不是命令跑完，而是公网 URL 返回真库数据**——今天 11 条 curl 全部按这套标准执行；
- 踩坑过程沉淀成了可复用的排查方法（错误 → 逐层缩小 → 命令当场复现），Day 20 排查跨域时直接复用，从发现问题到确认安全只花了一轮 curl。

---

## 四、同伴交叉验证（未执行 · 说明已备好）

### 4.1 发给同伴的话（可直接复制）

> 帮我做个 2 分钟的交叉验证，我的自律打卡网站刚上线：
>
> 1. **能否打开**：浏览器打开 `https://habit-tracker-d9gh0mjel767ff0d2-1499348397.tcloudbaseapp.com/`，能看到「今日待做」列表（应该有几条待办）就算通过；
> 2. **能否真实读写**：换到这个链接 `https://habit-tracker-d9gh0mjel767ff0d2-1499348397.tcloudbaseapp.com/?debug=1#me`（会停在「我的」页），页面底部有「云端检查台」——
>    ① 看健康状态是不是绿色「服务正常」；② 记下「今天打卡项」的数字；
>    ③ 点「写入一条测试数据」，提示成功后数字应该 +1；④ 把页面刷新一下，这条还在；
> 3. **有无报错**：按 F12 切到 Console 刷新页面，看有没有红色报错；手机上就跳过这步。
>
> 请按下面三行回我（照抄填空即可）。

### 4.2 三行结论模板

```
能否打开：是 / 否（打开的是 ______ 页面）
能否真实读写：是 / 否（健康状态 ______；写入前 ______ 条 → 写入后 ______ 条；刷新后 ______）
有无报错：是 / 否（控制台 ______ 条红色报错）
```

### 4.3 回填区（同伴回复后填入，并把 §二 第 2 行的「未执行」改为 PASS/FAIL）

| 能否打开 | 能否真实读写 | 有无报错 | 同伴 / 日期 |
|---|---|---|---|
| （待填） | （待填） | （待填） | （待填） |

---

## 五、未完成项与遗留（记录在案，下周处理）

| 事项 | 状态 | 说明 |
|---|---|---|
| 同伴交叉验证三行结论 | 未执行 | 说明已备好（§4.1），需真人操作；结论回来后回填 §4.3 |
| 演示视频（3 分钟） | 未执行 | 余力加练项；提纲 `DEMO.md` 与走查证据已备齐，随时可录 |
| 勾选 / 删除 / 移动 / 改心情的后端接口 | 未实现 | `PATCH` / `DELETE` / `PUT /api/days/mood`，契约 §四「待实现」；目前这些操作仍是本机行为，刷新后以云端为准 |
| 匿名登录 + RLS | 未实现 | RLS 未开启，`uid` 固定为种子身份；契约 §1.4 已把登录承诺改期 |
| 数据日期会自然过期 | 已知卡点 | 种子的日期锚在「跑脚本那天」，隔天首页会空；已写入 DEPLOY §六 流程：部署/验收前先跑 `db/seed-shift.sql`（幂等） |
