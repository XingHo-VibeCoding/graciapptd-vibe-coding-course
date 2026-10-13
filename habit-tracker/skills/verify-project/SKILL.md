---
name: verify-project
description: 项目验证清单 + 一键脚本。当需要确认「这个项目现在是不是好的」（交付前 / 演示前 / 改完代码回归 / 改过检查脚本之后）时使用。检查项全部来自本项目真实踩过的坑——跨域被拦、环境变量没配、重复写入、软删除只做一半、favicon 404、种子数据过期、错误提示不是人话等——每项写明执行命令与通过标准，输出逐项 PASS/FAIL + 证据文件。脚本自带「判据自证」一组：跑完必须确认它全过，否则后面所有 ✓ 都不可信。出现 FAIL 即 must-fix，修完用同一条命令重跑并比对证据。
agent_created: true
---

# 项目验证（verify-project）

## 用途

一句话：**一条命令确认「这个项目现在是不是好的」，并且保证这条命令自己不会骗人。**

检查项不是拍脑袋列的 —— 每一项都来自本项目**真实踩过的坑**：

- `DEPLOY.md` §十三「最可能的卡点」共 15 条
- `FLOW-TEST.md` §八「已知边界」共 7 条
- `SECURITY.md` 安全自查清单

把这些坑变成**可复跑的探针**，就不必每次靠记忆去猜"还有哪里可能坏"。每一项后面都标着它对应哪一条坑。

## 何时使用

- **交付 / 演示 / 发布之前**，想要一份"现在到底行不行"的结论
- 改完代码做**快速回归**（比翻文档一条条手打快得多）
- **改过检查脚本本身之后** —— 判据坏了的话，后面所有 ✓ 都不可信

## 使用方式

```bash
# 全套（约 1–3 分钟：G5 会顺带跑一遍核心链路自检）
bash habit-tracker/scripts/verify-project.sh

# 只跑快的（跳过最慢的六环自检）
SKIP_FLOW=1 bash habit-tracker/scripts/verify-project.sh

# 离线环境（跳过全部联网项，本地检查照跑）
bash habit-tracker/scripts/verify-project.sh --no-net

# 证据存到指定文件（默认自动命名，落在当前目录）
bash habit-tracker/scripts/verify-project.sh my-evidence.txt
```

退出码：**0** 全过 / **1** 有 ✗ 必须先修 / **2** 不在 git 仓库里。
输出会**同时**写进证据文件 —— 可截图交差，也可前后两次 diff。

## 检查清单

> 格式：`编号 检查项` —— **执行命令** ｜ **通过标准** ｜ **它对应的真实坑**

### A. 安全红线（对应卡点 4「密钥被写进代码 / 提交上去」）

- **A1 密钥特征未入库** —— `bash habit-tracker/scripts/check-secrets.sh` ｜ 退出码 0，【一】段 8 类特征**全 0 命中** ｜ 卡点 4
- **A2 敏感文件跟踪状态 + 忽略规则覆盖** —— 同上脚本【二】段 ｜ `.env*` / `cloudbaserc.json` / `*.pem` 等全部「未跟踪 + 已忽略」，`.env.example` 反而**必须**能入库 ｜ 卡点 4、Day 24 的两处 `.gitignore` 缝隙
- **A3 Git 全历史无密钥** —— 同上脚本【四】段 ｜ 全部历史版本 0 命中 ｜ **删掉一个提交 ≠ 消除泄露**（Day 24 的核心结论）

### B. 自动化测试

- **B1 前端 jsdom 行为级测试** —— `NODE_PATH=<node_modules> node <test-home.js>` ｜ 汇总结论为「N 通过 / 0 失败」，退出码 0 ｜ 改动前端交互后的基本盘
- **B2 云函数自测** —— `node habit-tracker/cloudfunctions/api/selftest.js` ｜ 「全部通过 ✓」，退出码 0 ｜ 路由层静态断言（不许出现 `fetch(` / 列名）就在这里面

### C. 线上可达性（对应卡点 5·7·15）

- **C1 前端首页可打开** —— `curl -o /dev/null -w '%{http_code} %{size_download}' "$SITE/"` ｜ HTTP 200 且体积 > 1KB ｜ 卡点 5「改了前端忘了部署」、卡点 7「两个地址搞混」
- **C2 接口健康检查** —— `curl "$BASE/health"` ｜ 返回 `{"ok":true,"service":"Self discipline plan"}` ｜ 检查台红灯的第一诊断口
- **C3 站点图标可达** —— `curl -o /dev/null -w '%{http_code}' "$SITE/assets/favicon.png"` ｜ 200 ｜ 卡点 15「控制台常年挂着一条 /favicon.ico 404 红字」
- **C4 跨域头存在** —— `curl -D - -H "Origin: $SITE" "$BASE/health"` ｜ 响应含 `Access-Control-Allow-Origin` ｜ 卡点 2「跨域被拦」

### D. 静态资源（对应卡点 15）

- **D1 引用完整性** —— `grep -oE 'assets/[A-Za-z0-9._-]+' frontend/index.html` 逐项比对磁盘 ｜ 页面上写的每个路径**都真实存在** ｜ 卡点 15 的通用形态：写了却没传
- **D2 线上资源可达** —— 对 D1 的每个资源 `curl` ｜ 全部 200 ｜ 卡点 5「本地是新的、公网还是旧的」
- **D3 重复资源**（⚠️ 仅提示、不阻断） —— `md5sum frontend/assets/*` 找相同哈希 ｜ 无重复 ｜ 已知项：`affirm-5.jpg` 与 `hero.jpg` 内容相同（换素材才能修）

### E. 数据新鲜度（对应卡点 1，**本项目最常撞的一条**）

- **E1 库内最后一天 = 今天** —— `tcb db execute --json --sql "SELECT max(date) FROM checkins WHERE is_deleted = false"` ｜ 等于今天；落后就是 ⚠️ ｜ 卡点 1：种子日期锚定在"跑脚本那天"，隔天首页就空。修法：跑一次（幂等）`seed-shift.sql`

### G. 踩坑复验（把真实踩过的坑变成探针）

- **G1 跨域预检** —— `curl -X OPTIONS -H "Origin: $SITE" -H "Access-Control-Request-Method: POST" "$BASE/checkins"` ｜ 响应含 `Access-Control-Allow-Origin` ｜ 卡点 2。**注意**：光查 GET 的 ACAO 是不够的 —— 浏览器写请求前先发 `OPTIONS`，预检不过照样拦
- **G2 环境变量生效** —— `curl "$BASE/day?date=<今天>"` ｜ `code=0` ｜ 卡点 3。**关键**：`/health` 不查库，环境变量坏了它也可能回 ok —— 只有打一个**真读库**的接口才能验出「环境变量没配 / 失效」
- **G3 列名不外泄** —— `curl "$BASE/checkins?limit=1"` ｜ 响应里不出现 `is_deleted` / `client_req_id` / `done_at` 等库内 snake_case 列名 ｜ 契约：字段翻译是 `db.js` 的职责，漏了就是把库结构泄给前端
- **G4 错误分级是中文人话** —— `curl -X PATCH "$BASE/checkins/abc" -d '{"text":"探针"}'` ｜ 回 400 且 `message` 是给人看的中文，不含 `Error` / `Exception` / 堆栈 ｜ 卡点 13「把服务端出问题说成你网络不好」
- **G5 核心链路（重复写入 + 软删除）** —— `bash habit-tracker/scripts/core-flow-check.sh` ｜ 退出码 0（六环全过） ｜ 卡点 8「重复写入被拒 409」是**防护不是 bug**、卡点 10「删掉的待办又冒出来 = 软删除只做了一半」

### F. 仓库状态

- **F1 工作区干净** —— `git status --porcelain` ｜ 输出为空 ｜ 有未提交改动 → 线上跑的不是你本地这份
- **F2 已推送** —— `git status -sb` 无 `ahead`，再 `git ls-remote origin refs/heads/main` 对 SHA ｜ 本地 = 远程 ｜ **`push` 无输出且退出码 0 ≠ 成功**（Day 22 真实踩过）。联网受限时这一项**降级为说明**，不误报

### ＋ 判据自证（本 Skill 的抗虚报机制）

- **P1 各条判据的灵敏度** —— 把「必然命中」的样本回灌给判据本身 ｜ 全部 ✓ ｜ 见下一节
- **P2 反向验证：没有假阳性** —— 拿一条纯分隔线喂给「32 位随机串」判据 ｜ 必须**不**命中 ｜ 同一个坑 `check-secrets.sh` 与 `core-flow-check.sh` 都栽过

## 抗虚报设计（本 Skill 最重要的一节）

检查清单最常见的失败**不是漏检，而是虚报通过**：正则写错、文件路径改了没同步、阈值设反 —— 结果每一栏都打 ✓，人却以为万事大吉。

所以本脚本每次运行都会做两件事：

1. **自证**：拿几个必然命中的样本（假密钥、假 JWT、假 token、假私钥头）回灌给判据，任何一条正则写坏都会当场变成 ✗。
2. **反向自证**：拿一条**不该命中**的样本（纯 `----` 分隔线）喂给随机串判据，确认没有假阳性。

**跑完必须确认「自证」那一组是全 ✓。** 判据坏了的话，后面所有的 ✓ 都不算数 —— 这是本 Skill 与"看起来在检查"的清单之间唯一的区别。

> 这条规矩是从两次真实事故里长出来的：`check-secrets.sh` 第 8 条特征（32 位随机串）先后**两次**被脚本自己的分隔线命中，导致密钥门禁长期是红的（Day 23 自己中过一次，Day 24 的 `core-flow-check.sh` 又中一次）。见 `usage-log.md` 调用 1。

## 记录格式

每次调用追加一条：

```md
## 调用 N · 日期 · 被验对象
- 触发场景：
- 结果：✓ x 项 / ⚠️ y 项 / ✗ z 项（退出码）
- ✗ 明细（must-fix）：编号 + 现象 + 证据文件行号
- 误报 / 漏报（本次发现的判据问题）：编号 + 为什么错 + 怎么改
- 处置与复查：
```

## 本项目的落点（habit-tracker）

| 东西 | 位置 |
|---|---|
| 一键脚本 | `habit-tracker/scripts/verify-project.sh` |
| 被它编排的脚本 | `check-secrets.sh`（A 组）、`core-flow-check.sh`（G5） |
| 测试入口 | `test-home.js`（仓库外，用 `TEST_HOME=` 指定）、`cloudfunctions/api/selftest.js` |
| 线上地址 | 前端 `$SITE`、接口 `$BASE`（都在脚本头部，可用同名环境变量覆盖） |
| 坑的出处 | `DEPLOY.md` §十三 卡点表、`FLOW-TEST.md` §八 已知边界、`SECURITY.md` |
| 调用记录 | `habit-tracker/skills/verify-project/usage-log.md` |

## 常见失败模式

- **只查"能不能连"不查"查得到吗"**：`/health` 是硬编码返回，环境变量坏了它照样绿 → 必须打一个真读库的接口
- **只查 GET 的跨域头**：浏览器写请求前先发 `OPTIONS` 预检，只验 GET 会漏掉真实的写失败
- **把"网络受限"当成"项目有问题"**：拿不到远程 SHA、curl 超时，这些是**环境**问题，检查项要能区分并降级为说明，而不是报 ✗
- **测试脚本在仓库外**：`test-home.js` 不在 git 里，换机器就会"文件不存在"—— 用 `TEST_HOME=` 指定，找不到时**明确报跳过**，绝不假装通过
- **跳过 = 通过**：任何跳过都必须打印 `⚠️` 并计数，否则"没跑"会被读成"没问题"
