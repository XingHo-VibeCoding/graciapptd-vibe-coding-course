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
| `db/` | 建表与种子 SQL（`schema.sql` / `schema-2.sql` / `schema-3.sql` / `seed.sql` / `seed-shift.sql` / `verify.sql`） |
| `scripts/` | 质量工具：`verify-project.sh` / `check-secrets.sh` / `core-flow-check.sh` / `make-favicon.py` |
| `skills/` | 可复用的检查 Skill：`verify-project` / `filter-interaction-check` |
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
