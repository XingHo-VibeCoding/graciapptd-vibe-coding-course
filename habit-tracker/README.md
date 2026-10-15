# 自律计划（habit-tracker）

一个纯网页版的自律小工具：时间轴待办 + 心情五选一 + 无压力思考 + 周月报。
前端是**零构建的单文件 HTML**，后端是 **CloudBase 云函数 + PostgreSQL**。

- 线上前端：https://habit-tracker-d9gh0mjel767ff0d2-1499348397.tcloudbaseapp.com/
- 线上接口：https://habit-tracker-d9gh0mjel767ff0d2.service.tcloudbase.com/api

> 想跑起来 / 想部署：看 **`RUN.md`**（运行说明）与 **`DEPLOY.md`**（部署手册）。
> 只想确认"现在好不好"：直接跳到最后那一节。

## 目录

| 目录 | 放什么 |
|---|---|
| `frontend/` | 前端（`index.html` 单文件 + `assets/`）。**没有构建步骤**，这里的东西就是最终产物 |
| `cloudfunctions/api/` | 云函数 `api`：`index.js`（路由层）/ `db.js`（唯一碰库的地方）/ `selftest.js`（自测） |
| `db/` | 建表与种子 SQL（`schema.sql` / `schema-2.sql` / `schema-3.sql` / `seed.sql` / `seed-shift.sql` / `verify.sql`）；`db/backups/` 放数据快照（**不入库**，见 `RELEASE.md` §5.2） |
| `scripts/` | 质量工具：`verify-project.sh` / `check-secrets.sh` / `core-flow-check.sh` / `repeat-check.sh` / `rollback-drill.sh` / `db-snapshot.sh` / `drive-user-flow.js` / `make-favicon.py` |
| `skills/` | 可复用的检查 Skill：`verify-project` / `filter-interaction-check` |
| `releases/` | 发布与演练的记录（`v1.0-rollback-drill-record.md` / `v1.0-quota-20261015.txt` / `v1.0-repeat-check-20261015.txt`） |
| `trial/` | 第三方试用材料：任务脚本（`task-card.md`）/ 观察员记录表（`record-sheet.md`）/ 反馈收集表 / 分诊与复验（`triage.md`）/ 自测预演记录 |
| 根目录 `*.md` | 文档（见下面的索引） |

## 文档索引

| 文件 | 作用 |
|---|---|
| `PRD.md` | 要做什么、验收标准 |
| `TECH_DESIGN.md` | 怎么做的 |
| `api-contract.md` | 接口契约（**建表与写接口的唯一依据**） |
| `RUN.md` | 运行说明（本地怎么跑） |
| `DEPLOY.md` | 部署手册（怎么推上公网）+ §十三 卡点表 |
| `SECURITY.md` | 安全自查清单（每项含验证方法） |
| `FLOW-TEST.md` | 核心链路测试清单 + 四步诊断协议 + 原因候选池 |
| `RELEASE.md` | **发布清单**（版本标记 / 发布前验证 / 发布步骤 / 发布后验证 / 代码与数据备份） |
| `ROLLBACK.md` | **回滚手册**（什么情况必须回滚的判断表 + 已演练的回退四步 + 云函数回退 + 演练记录模板） |
| `RESOURCES.md` | **资源与到期说明**（当前用量 / 怎么看 / 导出数据三步 / 到期倒排清单；**不含任何密钥**） |
| `FINAL-ACCEPT.md` | **结营验收表 v1.1**（交付物总清单逐项能当场打开 / 重复执行检测 / 独立盲审结论 / **学员指定 10 项逐条检查**） |
| `RETRO.md` | **28 天结营复盘**（最大的认知改变 + 数据 + 诚实清单） |
| `DEMO-FINAL.md` | **终期演示提纲 3–5 分钟**（六段：用户问题 / 核心流程 / 提示词改写 / 验证方式 / 平台限制 / 后续优化） |

## 质量与验证

改完代码，按这个顺序跑：

### 1. 一键项目验证（推荐先跑这个）

```bash
bash habit-tracker/scripts/verify-project.sh
```

七组检查，逐项 PASS/FAIL（或 ⚠️ 提示），输出同时写进证据文件：

| 组 | 查什么 | 对应本项目真实踩过的坑 |
|---|---|---|
| A | 密钥特征 / 敏感文件 / **Git 全历史** | 卡点 4 |
| B | 前端 jsdom + 云函数自测 | — |
| C | 首页 / 健康检查 / 图标 / 跨域头 | 卡点 5·7·15 |
| D | 静态资源引用完整性 + 线上可达 + 重复检测 | 卡点 15 |
| E | 库内最后一天 vs 今天 | 卡点 1（最常撞） |
| G | 跨域预检 / 环境变量生效 / 列名外泄 / 错误分级 / **核心链路（含重复写入与软删除）** | 卡点 2·3·8·10·13 |
| F | 工作区是否干净 / 是否真的推上去了 | Day 22 的静默 push 失败 |
| ＋ | **判据自证**：拿必然命中的样本回灌给判据，证明检查不是摆设 | — |

常用参数：

```bash
SKIP_FLOW=1 bash habit-tracker/scripts/verify-project.sh   # 跳过最慢的核心链路自检
bash habit-tracker/scripts/verify-project.sh --no-net       # 离线（跳过全部联网项）
bash habit-tracker/scripts/verify-project.sh my-evidence.txt # 证据存到指定文件
```

退出码 **0** 全过 / **1** 有 ✗ / **2** 不在 git 仓库里。

> **跑完先看「自证」那一组。** 它全 ✓ 才说明判据是活的 —— 判据坏了的话，
> 后面所有的 ✓ 都不算数。完整说明见 `skills/verify-project/SKILL.md`。

### 2. 提交 / 部署前：密钥排查

```bash
bash habit-tracker/scripts/check-secrets.sh
```

四段：工作区 8 类特征 / 敏感文件跟踪状态 + 忽略规则覆盖度 / 人眼复核 / **Git 全历史 9 类特征**。
**删掉一个提交 ≠ 消除泄露** —— 必须扫历史。

### 3. 改动涉及核心链路时：六环自检

```bash
bash habit-tracker/scripts/core-flow-check.sh
```

走完「打开检查台 → 读两张表 → 写入 → 刷新确认 → 修改 → 删除」，逐环 ✓/✗ 且**每环都跟真库对照**。
它自己造数据、自己物理删掉，可以反复跑不脏库。

诊断流程（拿到失败项之后怎么办）见 `FLOW-TEST.md` §五。

#### 3.1 反复跑会不会留下痕迹？（Day 28 新增）

```bash
bash habit-tracker/scripts/repeat-check.sh
```

`core-flow-check.sh` 回答"**这一遍**对不对"，`repeat-check.sh` 回答"**连着跑两遍**会不会变"：
两遍逐环结论逐字比对 + 残留检查 + 库内总条数是否回到基线 + 幂等键是否真的在
**数据库层**挡住重复（同键第 2 次必须 409，且物理行数只能是 1）。

它开头有一组**「判据自证」**：先拿"必然命中"的样本证明自己的判据没写坏
（包括反向验证"全绿时不许报失败"），**再**去检查项目。加这组的原因见
`releases/v1.0-repeat-check-20261015.txt` 里第一轮的误报对照：
判据里 `grep -c` 无匹配会打印 `0` 但退出码为 1，多接一个 `|| echo 0` 就会把
"全绿"读成"有失败"。**判据错了，后面每一栏 ✓ 都不算数。**

### 4. 发布 / 回滚（Day 26 起）

**发布**：照 **`RELEASE.md`** 从上往下走 —— 版本标记 → 发布前门禁（第 1 节那条命令）→ 打 tag → 部署 → 发布后验证 → 记录。

发布前先备份数据（**唯一无法从代码重建的东西**）：

```bash
bash habit-tracker/scripts/db-snapshot.sh          # 导出两表 → db/backups/<时间>.sql
bash habit-tracker/scripts/db-snapshot.sh --list   # 看已有快照
```

**回滚演练 / 真实回退**：

```bash
bash habit-tracker/scripts/rollback-drill.sh drill-evidence.txt
```

真实走一遍「回退到上一版 → 验证 → 恢复当前版本 → 验证」，逐步计时（最近实测：回退 4s + 恢复 4s，全程 18s）。
回退锚点默认取**最新版本 tag 的父提交**；若锚点产物与当前版本相同，脚本会当场拒绝执行（防止跑出"看起来全绿其实什么都没验证"的记录）。

**什么情况该回滚、什么情况不该**：先看 `ROLLBACK.md` §一 的判断表 —— 数据问题回滚版本没用。
演练记录怎么写：`ROLLBACK.md` §七 模板；填好的实例见 `releases/v1.0-rollback-drill-record.md`。

### 5. 第三方试用 / 真实用户视角（Day 27 起，Day 28 升级为"观察版"）

**请真人试用**：把 **`trial/task-card.md`** 直接转发给对方（自包含，含"首访会先看到
腾讯云风险提醒页"的说明）。Day 28 起它升级为**观察版**：每步只说"做什么"，
**故意有 2 处不写"怎么点"**（打卡 / 修改），专门用来测外行第一反应点哪里。

用完在旁边的**观察员**照 **`trial/record-sheet.md`** 逐步骤记（到达时刻 / 停留秒数 /
他实际点了什么 / 原话），试用者自己填的走 `trial/feedback-form.md`；
拿到记录后照 **`trial/triage.md`** 打分选出"本次只修哪一条"，再用它的**修复提示词模板**
下指令、用**复验最小任务模板**让用户回验。

> 为什么两张表都要：试用者填的是**事后回忆**（会自动补全逻辑），观察员记的是
> 卡住那 20 秒里**手指点了哪** —— 真问题通常藏在后者里。
> 预演记录见 `trial/selftest-record.md`。

以「真实用户视角」驱动真浏览器（Edge/Chrome 无头 + CDP 真实鼠标键盘事件）走完
核心流程，适合**手机宽度自测**与真人试用前的回归：

```bash
node habit-tracker/scripts/drive-user-flow.js                       # 390px 手机宽度，跑线上
node habit-tracker/scripts/drive-user-flow.js --width=430 --out=ev  # 指定宽度与截图目录
```

每步截图 + 逐项 ✓/✗，退出码 0/1；自造数据跑完自删。与 jsdom 测试（`test-home.js`，
400+ 行为断言）的分工：那边快而细，这边慢但**所见即真人所见**。

### 6. 结营验收（Day 28）

交付当天要"一条条点给验收人看"时，直接翻这三份：

- **`FINAL-ACCEPT.md`** —— 交付物总清单，按 **能当场打开 / 能当场复现 / 能当场查阅** 三类排好，
  每项都带 `线上:` 地址或 `复现:` 命令；另含重复执行检测结论、**独立盲审**（未参与项目的外部代理）
  提出的问题清单及逐条复核，以及**学员指定 10 项逐条检查**（结论只有"可当场展示 / 部分完成 / 未完成"）。
- **`DEMO-FINAL.md`** —— 3–5 分钟演示提纲（六段结构 + 现场动作单 + 两张截图要求）。
- **`RETRO.md`** —— 28 天结营复盘。

盲审的价值在于**它是外部视角**：它抓到的第一条问题（「添加待办」弹窗空输入静默失败）
是本项目自查 8 个脚本、400+ 断言都没覆盖到的——因为那些检查都在验"我实现了什么"，
而它验的是"用户以为发生了什么"。**这两条（P1 / P2）已在 v1.1 修掉并补了断言**：
产物指纹变了，所以页脚版本、tag、`RELEASE.md` 发布记录三处一起改，见 `FINAL-ACCEPT.md` §三.1。
