# 第 3 周验收表（Day 15–21：后端上云周）

> - 验收日期：2026-10-08（Day 21）
> - 验收范围：Day 15–20 的全部提交 + Day 21 验收动作本身
> - 本周主线：给纯前端 mock 应用接上真后端——环境注册 → 建表 → 读接口 → 写接口 → 分层重构 → 前端接线 → 检查台
> - 证据链接格式：`commit:<hash>` = GitHub 提交页；`线上:` = 可直接打开的公网地址；`复现:` = 可粘贴重跑的命令；`文档:` = 仓库内文件+章节

---

## 一、验收条目（逐项证据）

| # | 验收条目 | 结论 | 证据 |
|---|---|---|---|
| 1 | 云环境注册并登记环境 ID | ✅ PASS | commit:[a58dcb6](https://github.com/XingHo-VibeCoding/graciapptd-vibe-coding-course/commit/a58dcb6)；环境 `habit-tracker-d9gh0mjel767ff0d2`（免费体验版，PostgreSQL） |
| 2 | 健康接口上线 | ✅ PASS | commit:[ebb6d9d](https://github.com/XingHo-VibeCoding/graciapptd-vibe-coding-course/commit/ebb6d9d)；线上:`https://habit-tracker-d9gh0mjel767ff0d2.service.tcloudbase.com/api/health` → `{"ok":true,"service":"Self discipline plan"}` |
| 3 | 核心两表建成 + 种子可重复执行 | ✅ PASS | commit:[ccb2d31](https://github.com/XingHo-VibeCoding/graciapptd-vibe-coding-course/commit/ccb2d31)；复现:`tcb db execute --sql "$(cat db/schema.sql)"` 跑两遍不报错；文档:`db/README.md` |
| 4 | GET 读接口上公网 + 真库验证 | ✅ PASS | commit:[b74a5b3](https://github.com/XingHo-VibeCoding/graciapptd-vibe-coding-course/commit/b74a5b3)；线上:`…/api/day?date=2026-10-08` 返回今天 6 条真库打卡（2026-10-08 21:30 实测）；文档:`DEPLOY.md` §7.1 |
| 5 | POST 写接口：写入 + 读回 | ✅ PASS | commit:[0a8d7af](https://github.com/XingHo-VibeCoding/graciapptd-vibe-coding-course/commit/0a8d7af)；复现：正常 POST 返回插入行 → `GET /api/checkins` 能读回该行；文档:`api-contract.md` §6.2 验收记录 |
| 6 | 重复提交被拒（幂等） | ✅ PASS | 同 `Idempotency-Key` 连发两次 → 第二次 `{"code":409,…}`；换新键同内容正常写入；DB 侧部分唯一索引 `checkins_uid_reqid_uniq` 兜底（`db/schema-2.sql`）；文档:`api-contract.md` §1.6 |
| 7 | 缺必填字段被拒 + 中文提示 | ✅ PASS | 复现:`curl -X POST …/api/checkins -d '{"date":"2026-10-08"}'` → `{"code":400,"message":"缺少必填字段：text"}` |
| 8 | 契约与课程要求对齐（对照落档） | ✅ PASS | commit:[bb6a188](https://github.com/XingHo-VibeCoding/graciapptd-vibe-coding-course/commit/bb6a188)；文档:`api-contract.md` §1.1 接口名对照、§1.2 C 节响应外壳对照表 |
| 9 | 数据访问层拆出（分层重构） | ✅ PASS | commit:[b0f5828](https://github.com/XingHo-VibeCoding/graciapptd-vibe-coding-course/commit/b0f5828)；`cloudfunctions/api/db.js` 独立成层；接口路径/字段名零变化（当日契约 `git diff` 为空）；文档:`TECH_DESIGN.md` §二.1 |
| 10 | 重构后全接口回归 | ✅ PASS | 云函数自测 162/162（`node cloudfunctions/api/selftest.js`）；改前基线 140 → 改后同命令 162 一次通过 |
| 11 | 公网首页展示数据库真实数据 | ✅ PASS | 线上:`https://habit-tracker-d9gh0mjel767ff0d2-1499348397.tcloudbaseapp.com/`（2026-10-08 实测 HTTP 200，首页 6 条待办全部来自 checkins 表）；commit:[60304aa](https://github.com/XingHo-VibeCoding/graciapptd-vibe-coding-course/commit/60304aa) |
| 12 | 控制台改数据 → 刷新跟着变 | ✅ PASS | 复现（2026-10-08 实测并已复原）：`tcb db execute` 改一条待办文本+今天心情 → 重开首页两处都变 → 复原；文档:`DEPLOY.md` §7.2 |
| 13 | F12 请求地址是公网地址 | ✅ PASS | 页面 `fetch` 出口唯一（`API_BASE` 段），源码无 `localhost`/`127.0.0.1`（`grep` 为空）；请求指向 `…service.tcloudbase.com/api/…` |
| 14 | 前端行为回归 | ✅ PASS | jsdom 自测 391/391（Day 20 接线前 360 全绿 + 云模式 14 + 检查台 17） |
| 15 | 检查台（健康/核心表数据/写入入口） | ✅ PASS | commit:[cbc582a](https://github.com/XingHo-VibeCoding/graciapptd-vibe-coding-course/commit/cbc582a)；「我的」页云端检查台：健康灯 + checkins 总数/最后一天/今天条数 + `?debug=1` 写入入口（当日限 3 条）；线上端到端实测通过 |
| 16 | 跨域：只允许自己的域名、无 `*` 通配符 | ✅ PASS | 实测矩阵（`DEPLOY.md` §十一）：本项目托管域名/localhost 放行；陌生域名无 CORS 头被拦；全部响应 `Access-Control-Allow-Origin: *` 出现次数为 0；云函数代码零 CORS 手写（网关层处理） |
| 17 | 密钥走环境变量、无硬编码 | ✅ PASS | 函数密钥在 `envVariables`（`CLOUDBASE_API_KEY` 等）；`cloudbaserc.json` 被 `.gitignore` 忽略、仓库只有无密钥模板 `cloudbaserc.example.json`；全仓库 `git grep "eyJhbGciOi"` 式扫描无真值（仅文档示例） |
| 18 | 部署文档可复核 | ✅ PASS | `DEPLOY.md` v2.5：部署步骤、验证方法、v1.0 订正表、卡点清单（含冷启动超时实测 1 次，commit:[490a93b](https://github.com/XingHo-VibeCoding/graciapptd-vibe-coding-course/commit/490a93b)） |
| 19 | 演示提纲已写出并走通一遍 | ✅ PASS | 文档:`DEMO.md`（四段结构）；走查证据见 §三 |
| 20 | **同伴交叉验证（三行结论）** | ⏳ **待同伴回复** | 验证说明与三行结论模板见本文 §四；说明已备好，结论回来后回填本表并把 ⏳ 改为 ✅/❌ |
| 21 | 演示视频（余力加练） | ❌ **未执行** | 如实标记：3 分钟演示视频未录制；提纲与走查已备齐，随时可录 |

**统计：PASS 19 项；待同伴回复 1 项；未执行（如实标记）1 项。**

> ⚠️ 按课程要求，缺项不粉饰：#20 未完成前不算周验收闭合（等同伴三行结论回填后本表才生效）；
> #21 属余力项，未执行不影响主线验收。

---

## 二、本周复盘：最花时间的一步，值不值？

**最花时间的一步：Day 17 的「部署 + 真库验证」**（Day 15–16 合计都比不过它）。

不是写代码花时间——是**三件「以为做好了、其实没有」的事**连环翻车：

1. 环境 ID 记错了一个字符（`d3ghf0mjer76ffo02` ❌ → `d9gh0mjel767ff0d2` ✅），文档和记忆里全是错的；
2. 建表脚本写好了，但**从来没在真库执行过**——`information_schema` 一查是空的；
3. 新版 CloudBase 默认域名不允许手工加路由，`--httpFn` 又是给 Web 函数用的，反复试错才摸到 `tcb fn deploy --path /api` 这条正路。

**值。** 理由有三：

- 这一步翻的车，逼出了 `DEPLOY.md` 从 v1.0 到 v2.x 的**基于实测的完全重写**——之后 Day 18/19/20 的每次部署都是照着文档一遍过，返利远超成本；
- 「以为做好了」和「验证过做好了」之间的差距，就是这周最大的课程收获：**部署的完成标准不是命令跑完，是公网 URL 返回真库数据**；
- 踩坑过程沉淀成了可复用的排查方法（错误 → 逐层缩小 → 用命令当场复现），Day 20 排查跨域时直接复用了这套思路，从发现问题到确认安全只花了一轮 curl。

---

## 三、演示走查证据（Day 21 实测）

走查脚本按 `DEMO.md` 的演示步骤逐步执行，2026-10-08 21:35–21:38 实测：

| 演示步骤 | 预期 | 实测结果 |
|---|---|---|
| ① 打开公网首页 | 显示真库 6 条待办 + 心情 calm | ✅（6/6 条渲染，数据源小字「云端数据 · 更新于 …」） |
| ② 「我的」页检查台 | 健康灯绿 + 核心表数据 | ✅（健康 `ok:true`；总数/今天条数/数据最后一天三项渲染） |
| ③ `?debug=1` 写入一条 | 写入成功、列表 +1 | ✅（落库 id=15，今日 6→7 条；测试行已清理复原） |
| ④ 控制台改库 → 刷新 | 待办文本与心情跟着变 | ✅（两处都变，复测后已复原） |
| ⑤ 跨域安全 | 陌生域名被拦、无 `*` | ✅（evil 域名无 CORS 头；通配符计数 0） |

---

## 四、同伴交叉验证（待回填）

### 4.1 发给同伴的话（可直接复制转发）

> 我做完一个自律打卡网站的后端周验收，需要你帮忙做一次**交叉验证**，大概 2 分钟：
>
> 1. **可打开**：用手机或电脑浏览器打开这个链接——
>    `https://habit-tracker-d9gh0mjel767ff0d2-1499348397.tcloudbaseapp.com/`
>    能看到页面（顶部落日大图 + 今日待办列表）就算通过；
> 2. **可读写**：页面拉到底部导航，点「我的」，找到「云端检查台」卡片——
>    健康状态应该是绿色「正常」，下面有几条打卡数据；
>    再在链接后面加上 `?debug=1` 重新打开，回到「我的」页，点「写入一条测试数据」按钮，
>    提示成功、且「今日条数」+1，就算通过；
> 3. **无报错**：按 F12（手机就算了）打开控制台切到 Console，刷新页面，
>    没有红色报错就算通过。
>
> 最后请按下面三行格式回我结论。

### 4.2 三行结论模板（同伴照抄填空即可）

```
可打开：是 / 否（打开的是 ______ 页面）
可读写：是 / 否（检查台健康状态 ______，写入后条数 ______ → ______）
无报错：是 / 否（控制台 ______ 条红色报错）
```

### 4.3 回填区（同伴回复后由我填入）

| 可打开 | 可读写 | 无报错 | 同伴 / 日期 |
|---|---|---|---|
| （待填） | （待填） | （待填） | （待填） |

---

## 五、遗留事项（下周处理，今日不动）

| 事项 | 来源 | 计划 |
|---|---|---|
| 同伴三行结论回填本表 §4.3 | 本日 #20 | 结论到手当天回填，⏳ 改终态 |
| 勾选/删除/移动/改心情的后端接口（`PATCH`/`DELETE`/`PUT`） | 契约 §四「待实现」 | 第 4 周按需实现 |
| 匿名登录 + RLS（目前 RLS 未开启，uid 固定 demo 值） | 契约 §1.4 登录承诺改期 | 第 4 周 |
| 演示视频录制（余力项） | 本日 #21 | 提纲已备，随时可录 |
