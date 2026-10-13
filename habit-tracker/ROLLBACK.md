# 自律计划 · 回滚手册（ROLLBACK.md）

- 版本：**v1.0（2026-10-13 Day 26 建立）** —— 正式发布 v1.0 当日产出；§三 的四步**当日真实演练过**，耗时来自实跑。
- 定位：出事时照着做的一页纸。**先看 §一 判断要不要回滚，再动手** —— 数据问题回滚版本没用（代码退回去，脏数据还在库里）。
- 配套：`scripts/rollback-drill.sh`（可复跑演练脚本，§三 的命令与耗时来自它）。

---

## 一、什么情况必须回滚（判断表）

> 判定原则：**只回滚"版本"引起的问题**。单条数据错误、缓存没刷新、首次访问提示页，都不是版本问题，回滚解决不了。

| # | 现象 | 先做什么确认（30 秒内） | 判定 | 动作 |
|---|---|---|---|---|
| 1 | 首页白屏 / 控制台 JS 报错 / 功能坏了 | `curl -s -H "Cache-Control: no-cache" <站点>/ \| md5sum`，与 `git rev-list -n1 v1.0` 那笔提交的产物比对；换无痕窗口再开一次 | 新部署的前端有 bug | **回滚静态托管**（§三） |
| 2 | 页面能开，但接口全部报错（小字显示「服务器开小差了」） | `curl <API基址>/health` 与 `curl "<API基址>/day?date=今天"`（**必须打真读库的接口**，`/health` 是硬编码返回，环境变量坏了照样绿） | 云函数故障 / 部署坏了 | **回滚云函数**（§四，未演练）|
| 3 | 数据"丢了 / 多了 / 被改错" | `tcb db execute --sql "SELECT …"` 查真库（记得 `--json`） | 数据问题，不是版本问题 | **不要回滚代码**；按 §五 处理数据（未演练）|
| 4 | 部分用户看到新版、部分看到旧版 | `curl` 带 `Cache-Control: no-cache` 与不带各打一次 | **CDN 缓存**，不是故障 | 不回滚；等缓存过期或无痕验证（§六-4）|
| 5 | 首次访问出现「页面访问提示 / 确定访问」蓝页 | 这是 CloudBase 对**未审核域名**的一次性提示，点一次「确定访问」后不再出现 | 正常现象 | 不回滚（DEPLOY.md §十二）|
| 6 | 改了前端忘了部署，本地是新的线上是旧的 | 对比页面底部**版本标识**（`自律计划 v1.0 · 日期`）或 curl 指纹 | 版本错位 | 重新部署正确版本（不是回滚，DEPLOY.md 卡点 12）|
| 7 | 单条待办显示错误 / 删错了 | 真库 SELECT 该条，`is_deleted` 看是不是被软删 | 单条数据问题 | 改/恢复那一条（软删除恢复见 §五），不动版本 |

## 二、可回退锚点：v1.0

| 项 | 值 |
|---|---|
| 发布标识 | Git tag **`v1.0`**（SHA 以 `git rev-list -n1 v1.0` 为准，不写死在本文件里）|
| v1.0 前端产物 | `frontend/index.html` **206272 B**，md5 `dc163380cc2800af74cba9c40a2c8984` |
| 上一版产物（Day 24 起 frontend 未再变）| **205286 B**，md5 `e7c19b5498bcf6534406dfec5857b0ab` |
| 托管侧版本管理 | **没有**。`tcb hosting deploy` 官方说明 "file upload only, **no version management**" —— 无版本列表、无「回上一版」按钮 |
| 结论 | **可回退历史 = Git 提交历史**。锚点 = tag + 指纹；回退 = 把历史那一版重新部署 |
| 远期备选 | `tcb app deploy` 支持云构建 + 版本管理 + 回滚（CLI 提示原文："Use tcb app deploy for cloud builds, rollbacks, and service name management"）。本项目未用（免费版功能受限、当前规模用不上），若将来接构建流程再评估 |

版本标识怎么看：页面底部一行 muted 小字「**自律计划 v1.0 · 2026-10-13**」（`#app-ver`）。它同时是回滚演练的**肉眼观测点** —— 部署旧版后这行消失，部署回 v1.0 后这行回来。

## 三、静态托管回退（已演练 ✅，四步）

> 演练记录：2026-10-13 22:53，`scripts/rollback-drill.sh` 实跑，**8 项全过 / 0 失败**。
> 耗时：**部署上一版 4s + 部署 v1.0 5s = 合计 9s**（不含验证，全程含验证约 1 分钟）。

```bash
# 第 0 步（可选但强烈建议）：先跑一遍演练，确认流程本身是通的
bash habit-tracker/scripts/rollback-drill.sh drill-evidence.txt

# 第 1 步：取上一版产物的【原始字节】到临时目录
#   ⚠ 必须用 git show，不要用 git archive —— 后者受 core.autocrlf=true 影响
#     会把 LF 改写成 CRLF，md5 就对不上了（Day 26 实测踩过）
STAGE=$(mktemp -d) && STAGE_WIN=$(cygpath -m "$STAGE")
git show v1.0^:habit-tracker/frontend/index.html > "$STAGE/index.html"
git archive v1.0^ habit-tracker/frontend/assets | tar -x --strip-components=2 -C "$STAGE"
md5sum "$STAGE/index.html"        # 应等于 §二 表里上一版的 md5

# 第 2 步：部署上一版（在仓库根执行；路径必须是 Windows 形式，见 §六-2）
MSYS_NO_PATHCONV=1 tcb hosting deploy "$STAGE_WIN" --env-id habit-tracker-d9gh0mjel767ff0d2

# 第 3 步：验证回退生效（两个口径都看）
curl -s -H "Cache-Control: no-cache" https://<环境ID>-<随机串>.tcloudbaseapp.com/ | md5sum
curl -s -H "Cache-Control: no-cache" https://<环境ID>-<随机串>.tcloudbaseapp.com/ | grep -c app-ver   # 期望 0（标识消失）

# 第 4 步：问题排除后，恢复 v1.0（工作区就是 v1.0 时直接部署；否则先 git checkout v1.0）
MSYS_NO_PATHCONV=1 tcb hosting deploy habit-tracker/frontend --env-id habit-tracker-d9gh0mjel767ff0d2
curl -s -H "Cache-Control: no-cache" https://<环境ID>-<随机串>.tcloudbaseapp.com/ | md5sum   # 应 = §二 v1.0 的 md5
```

**验证不是"跑了就算"**：每一步都用 md5 + 字节数双口径比对线上与本地/历史产物。演练脚本里那套 ✓/✗ 判据真的拦得住 —— 首次实跑就因为路径形态 bug 部署没生效，被【二】回退验证当场拦下（见 §六-2）。

## 四、云函数回退（只备查，⚠ 未演练）

> 按今日范围约定，本节**只写思路不实操**；用时先照 §三 的模式先演练一遍再动真格。

```bash
# 思路：云函数代码同样在 Git 里，回退 = 检出旧版重新部署
git checkout <旧提交> -- habit-tracker/cloudfunctions/api
MSYS_NO_PATHCONV=1 tcb fn deploy api --env-id habit-tracker-d9gh0mjel767ff0d2 --force
git checkout HEAD -- habit-tracker/cloudfunctions/api   # 恢复工作区
```

**三个必须想清楚的风险**：
1. **前后端要配套回退**：旧云函数若没有 `PATCH`/`DELETE /api/checkins/:id`（Day 22 才加），新版前端调它们会 404 → 前端按三类错误回落本机。要么两端一起退，要么确认旧接口是前端在调的超集。
2. **数据库不跟着回滚**：表结构是增量迁移（`schema.sql` → `schema-2.sql` → `schema-3.sql`），回滚代码**不回滚表**；旧代码遇到新列一般兼容（SELECT 指定列名），但别反过来——新代码配旧表会 `PGRST204`（DEPLOY.md 卡点表）。
3. **DDL 后网关持旧 schema 缓存**：若为配合回滚改过表，建完先跑一条写测试（踩坑记录）。

## 五、数据恢复（只备查，⚠ 未演练）

| 场景 | 做法 | 验证 |
|---|---|---|
| 误删（软删除，最常见） | `UPDATE checkins SET is_deleted=false WHERE id=<id>;`（`tcb db execute --sql`）| `GET /api/checkins` 该条回来了 |
| 误改单条 | 按 `api-contract.md` 的字段语义 `UPDATE` 回正确值；先 `SELECT` 留底 | 页面刷新后对照 |
| 真删了 / 批量坏数据 | CloudBase 控制台的数据回档能力（免费版是否有 PITR **未验证**） | 恢复后跑 `core-flow-check.sh` 全绿 |

原则：**能恢复单条就不动全表**；任何 UPDATE 前先把现状 SELECT 存档。

## 六、已知边界与踩坑（都在演练里真实撞过）

1. **演练期间线上短暂处于旧版**（两次部署间隔约 10s）。别挑有人正在用的时候跑；正式回滚同理 —— 回滚本身就是一次"故意退回旧版"。
2. **路径形态坑**：`MSYS_NO_PATHCONV=1` 会连 `/tmp/...` 的自动转换一起关掉，tcb（Windows 程序）拿到不存在的 `C:\tmp\...` → **静默失败**（部署清单里根本没上传）。传给 deploy 的目录一律 `cygpath -m` 转 Windows 形式；仓库内相对路径不受影响。
3. **CRLF 坑**：`git archive` 会按 `core.autocrlf=true` 把 LF 产物改写成 CRLF，md5 对不上历史指纹；取历史字节一律 `git show <ref>:<path>`。判行尾别用 `grep -q $'\r'`（误报），用 `tr -dc '\r' | wc -c`。
4. **CDN 缓存**：验证一律带 `-H "Cache-Control: no-cache"`；不带的话可能读到旧缓存，误判"回滚没生效"。托管响应头本身是 `no-store, no-cache`，但 CLI 仍提示 CDN 可能有几分钟延迟 —— curl 指纹对不上时先怀疑这个，等 1 分钟再打。
5. **首次演练的误报教训**：演练脚本的部署输出过滤太狠，把"目录不存在"的报错吞了，看起来像"部署了但没生效"。修法 = 过滤器里保留失败分支的原文输出。**任何"没生效"先看完整部署输出，再怀疑 CDN**。
6. 本手册 **§四、§五 未实操**，用前先按 §三 的模式演练一遍；`tcb fn deploy` 偶发 `socket hang up`，原样重跑即可（踩坑记录）。
