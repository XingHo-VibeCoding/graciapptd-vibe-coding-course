# 安全自查清单（Security Checklist）

- 版本：**v1.0（2026-10-10 Day 24 建立）** —— 错误处理与安全审计当日产出。
- 用途：**提交前 / 演示前**的安全自检。每一项都配一条**可直接粘贴的验证命令**，
  结论以命令输出为准，不靠"我觉得应该没问题"。
- 一键跑全部检查：

```bash
bash habit-tracker/scripts/check-secrets.sh    # 退出码 0 = 全过；1 = 有高危项
```

---

## 怎么用这份清单

1. **每次 `git commit` 之前**：在仓库根目录跑上面那一条命令。有 ✗ 就停下。
2. **要逐项核对时**：照下面每一节的「验证方法」把命令粘过去，对照「期望输出」。
3. **任何一项 ✗ 都不要"先提交再修"** —— 密钥一旦进了 Git 历史，
   后面所有提交都会带着它，处理成本从"改一行"变成"作废密钥 + 重写历史 + 通知所有人"。
4. 本文档里出现的所有密钥相关字样**都是变量名或说明文字**，不含真值。

---

## 一、硬编码密钥 —— 当前工作区

| # | 检查项 | 验证方法 | 期望 |
|---|---|---|---|
| 1.1 | 高置信度密钥特征（JWT / AKID / sk- / ghp_ / 私钥 / 明文密码 / PG 连接串 / 长随机串，共 8 类） | `bash habit-tracker/scripts/check-secrets.sh` 的 **【一】** 节 | 每类都是 **0 命中** |
| 1.2 | 手工复核（不想跑脚本时） | `git grep -n -E 'eyJ[A-Za-z0-9_-]{10,}\|AKID[A-Za-z0-9]{10,}\|sk-[A-Za-z0-9]{20,}\|ghp_[A-Za-z0-9]{20,}' -- .` | 只命中**文档说明**，无真值 |
| 1.3 | 敏感文件是否被跟踪 | `git ls-files --error-unmatch habit-tracker/cloudbaserc.json` | 报错（= 未跟踪） |
| 1.4 | 只含占位符的模板是否**确实**入库 | `git ls-files --error-unmatch habit-tracker/.env.example habit-tracker/cloudbaserc.example.json` | 两个路径都打印出来 |

**为什么只扫"被 git 跟踪的文件"**：只有它们会被推到 GitHub。工作区里没入库的临时文件
（比如你自己本地的 `.env`）混进来只会让结果变脏，不会构成泄露。

**不通过怎么办**：先把密钥从代码里挪走（见第三节），再作废重建（见第八节）。

---

## 二、硬编码密钥 —— **Git 全历史**

> **这一节是整份清单里最容易被忽略、后果最严重的一项。**
> 删掉一个提交 **≠** 消除泄露：字符串仍然躺在 `.git` 对象库里，
> `git log -p` 随时能翻出来，clone 过仓库的人手上也已经有了。

| # | 检查项 | 验证方法 | 期望 |
|---|---|---|---|
| 2.1 | 全历史密钥特征 | `bash habit-tracker/scripts/check-secrets.sh` 的 **【四】** 节 | 9 类特征**全部 0 命中** |
| 2.2 | 历史上是否出现过敏感文件名 | `git log --all --pretty=format: --name-only --diff-filter=A \| sort -u \| grep -E '\.env$\|cloudbaserc\.json$\|\.pem$\|\.key$'` | 输出为空 |
| 2.3 | 指定文件是否进过任何一次提交 | `git log --all --oneline --name-only -- habit-tracker/cloudbaserc.json habit-tracker/.env` | 输出为空 |
| 2.4 | 历史上所有版本里的长随机串 | `git rev-list --all \| while read c; do git grep -I -oE '"[A-Za-z0-9_-]{32,}"' $c -- . ; done` | 只有分隔线之类，无真值 |

**判据**：`git rev-list --all` 覆盖**每一个提交的每一个文件版本**（含已删除的分支与文件）。
只看当前工作区会得出**错误的安全感**。

**不通过怎么办**：走第八节的处置流程。**顺序不能颠倒** —— 先作废密钥，再谈清理历史。

---

## 三、凭据管理 —— 环境变量 + `.env.example`

| # | 检查项 | 验证方法 | 期望 |
|---|---|---|---|
| 3.1 | 密钥是否只走环境变量 | `grep -rn "process.env" habit-tracker/cloudfunctions/api/` | 只读 `TCB_ENV` / `CLOUDBASE_API_KEY` / `DEMO_UID`，无字面量 |
| 3.2 | 前端是否混进了密钥 | `grep -c "API_KEY\|service_role\|eyJ" habit-tracker/frontend/index.html` | **0** |
| 3.3 | 模板存在且只有占位符 | `cat habit-tracker/.env.example` | 每行都是 `变量名=` 或注释，**没有真值** |
| 3.4 | `.env.example` 未被忽略（关键回归） | `git check-ignore -v habit-tracker/.env.example` | **无输出**（未忽略） |
| 3.5 | 真值文件被忽略 | `git check-ignore -v habit-tracker/.env habit-tracker/cloudbaserc.json` | 两条都命中 `.gitignore` |
| 3.6 | 渲染流程是否真的读了 `.env` | `grep -rn "dotenv\|readFileSync.*\.env" habit-tracker/` | 无命中 |

**本项目的事实口径（别写错）**：真值**不走 `.env`** —— 走 `cloudbaserc.json` 的
`functions[].envVariables` 下发到云函数环境变量。`.env.example` 入库只是为了
**写清"需要配哪些变量"**，并给 `.gitignore` 里那条 `.env` 规则一个落点。

**为什么 `cloudbaserc.json` 不入库**：它里面是**展开写好的函数环境变量**，
包含数据库 `service_role` 级别的 API Key —— 前端绝不能有这个 Key，
它能绕过 RLS 直接读写全库。

---

## 四、忽略规则（`.gitignore`）完整性

| # | 检查项 | 验证方法 | 期望 |
|---|---|---|---|
| 4.1 | 覆盖度实测（**不靠读规则，靠实测**） | `bash habit-tracker/scripts/check-secrets.sh` 的 **【二】B** 节 | 12 个敏感文件名全部「已忽略 ✓」 |
| 4.2 | 逐个手工核对 | 见下方命令 | 全部命中 |
| 4.3 | 关键回归：模板别被误伤 | `git check-ignore -q habit-tracker/.env.example && echo 误伤 || echo 正常` | 打印 `正常` |
| 4.4 | 现有已跟踪文件有没有被新规则误伤 | `git ls-files \| git check-ignore --stdin` | 输出为空 |

```bash
# 4.2 的手工版：逐个实测（应全部打印路径 = 已忽略）
for f in .env .env.local .env.production .env.staging .env.test .env.development \
         deploy.pem server.key id_rsa id_ed25519 credentials.json serviceAccountKey.json; do
  git check-ignore -v "habit-tracker/$f"
done
```

**Day 24 修的两处缝隙**（原规则只写了 `.env` / `.env.local` / `.env.*.local`）：

1. `.env.production`、`.env.staging`、`.env.test` 这类**"点号后缀但不是 local"**的写法会漏网
   → 放宽成 `.env.*`，再用 `!.env.example` 把占位符模板捞回来；
2. `*.pem` / `*.key` / `*.p12` / `*.pfx` / `id_rsa` / `id_ed25519` / `credentials.json` /
   `serviceAccountKey.json` 这类**密钥凭据文件**原先没有任何规则 → 一并补上。

**顺序原则**：规则要**先立好、再落密钥**。反过来做（先建文件后补规则）就可能把密钥提交上去，
而仓库是公开的。

---

## 五、裸报错 —— 不许把异常对象甩给用户

| # | 检查项 | 验证方法 | 期望 |
|---|---|---|---|
| 5.1 | 前端有没有把 `e.message` / `String(e)` 直接显示 | `grep -n "e\.message\|err\.message\|String(e)\|JSON\.stringify(e" habit-tracker/frontend/index.html` | **无命中** |
| 5.2 | 网络出口是否唯一 | `grep -n "fetch(" habit-tracker/frontend/index.html` | **只有 2 处**（`apiFetch` / `apiHealth`） |
| 5.3 | 三类错误是否都走统一出口 | `grep -c "errKindText(" habit-tracker/frontend/index.html` | ≥ 9（定义 1 + 调用 8 以上） |
| 5.4 | 后端有没有把堆栈/SQLSTATE 透给前端 | `grep -n "err.stack\|err.message" habit-tracker/cloudfunctions/api/index.js` | 只出现在 `console.error` 里 |
| 5.5 | 后端所有对外提示是否中文 | `grep -oE "reply\([0-9]+, '[^']+'" habit-tracker/cloudfunctions/api/index.js \| sort -u` | 全中文，无英文异常名 |

**三类错误的口径**（契约 §1.8，前端唯一出口 `errKindText`）：

| 类别 | 判定 | 用户看到 |
|---|---|---|
| 网络层 | `fetch` 抛异常（断网 / 超时 >5s / 跨域被拦） | 「网络连不上」 |
| 服务端故障 | 网关 HTTP ≥500，或响应不是 JSON | 「服务器开小差了（HTTP 502），过一会儿再试」 |
| 业务拒绝 | HTTP 200 但 `code ≠ 0` | **原样转述**服务端中文原因 |

> 典型反面教材：把网关 502 说成「云端联系不上」，用户会去反复重启路由器 —— **方向完全错了**。

---

## 六、非法输入 —— 服务端是最后防线

| # | 检查项 | 验证方法 | 期望 |
|---|---|---|---|
| 6.1 | 校验函数齐备 | `grep -n "const isDate\|const isTime\|const isReqId\|const parseId\|const QUADS" habit-tracker/cloudfunctions/api/index.js` | 5 个都在 |
| 6.2 | 错误面清单 | `grep -oE "reply\([0-9]{3}, '[^']+'" habit-tracker/cloudfunctions/api/index.js \| sort -u` | 20+ 条，全中文 |
| 6.3 | 参数校验有测试守着 | `grep -c "400" habit-tracker/cloudfunctions/api/selftest.js` | > 0 |
| 6.4 | 结构约束落在数据库 | `grep -n "CHECK\|UNIQUE\|NOT NULL" habit-tracker/db/schema.sql` | 有（not null / 枚举 / 唯一索引） |

**已覆盖的输入面**：日期格式（`YYYY-MM-DD` 且真存在）、时间（`HH:mm` 24 小时制）、
象限枚举（`q1`~`q4`）、内容非空且 ≤60 字、路径 `:id` 必须正整数、
请求体必须是合法 JSON、`limit` 1~100、`from` 不晚于 `to`、`date` 与 `from/to` 互斥、
幂等键 1~64 位。

**三层防线**：
① 前端校验（体验层，能即时反馈）→ ② **服务端硬校验（规则的最后防线）** →
③ 数据库约束（`NOT NULL` / `CHECK` 枚举 / 部分唯一索引兜并发）。

> 前端禁用**不算**校验 —— 请求可以绕过前端直接发。所以 A5「不能给未来日期打勾」
> 这类业务规则必须在服务端也拦住（`409`）。

---

## 七、本次审计结论（2026-10-10）

| 审计项 | 结果 | 依据 |
|---|---|---|
| 硬编码密钥（工作区，53 个跟踪文件） | ✅ **0 命中** | 脚本【一】8 类特征全 0 |
| 硬编码密钥（**Git 全历史，61 个提交**） | ✅ **0 命中** | 脚本【四】9 类特征全 0；`cloudbaserc.json` 与 `.env` **从未进过任何一棵树** |
| 裸报错 | ✅ **0 处残留** | 前端 19 个 `catch` 全有中文出口；后端兜底只写服务端日志 |
| 三类错误统一中文 | ✅ 已统一 | `errKindText`（契约 §1.8） |
| 非法输入校验 | ✅ 25 条错误面全中文 | 见第六节 |
| `.gitignore` 完整性 | ⚠️→✅ **补掉 2 处缝隙** | `.env.*` 变体与密钥文件后缀原先漏网，本次已修 |

**结论：未发现任何真实密钥泄露，因此不需要作废或重新生成任何密钥。**
本清单的价值在于**证明"没有泄露过"**，而不是事后补救。

---

## 八、万一真的发现泄露：处置流程（顺序不能颠倒）

1. **先作废、重建密钥**（最高优先级，且**不能省**）
   - 数据库 API Key：`tcb env apikey create`（旧 Key 一并吊销）
   - 其他凭据同理：先让旧值失效，再生成新值
   - **原因**：清理 Git 历史**改不掉"已经泄露过"这个事实** —— 密钥只要存在过就要当作已泄露。
     而且公开仓库可能已经被爬虫抓走，改历史对已抓走的那份毫无作用。
2. **更新存放位置**：写进 `cloudbaserc.json` 的 `envVariables` / 云端环境变量，重新部署云函数。
3. **修根因**：如果是 `.gitignore` 漏了规则，先补规则（本节第四项）再提交。
4. **最后才清理历史**（可选、且代价高）：
   `git filter-repo --path <文件> --invert-paths` + 强推 + **通知所有协作者重新 clone**。
   协作者本地那份历史不清，密钥会随他下一次 push 再回来。
5. **复盘**：把这次的漏网特征补进 `scripts/check-secrets.sh` 的特征表，让同类问题下次自动被拦。

---

## 附：相关文件

| 文件 | 作用 |
|---|---|
| `scripts/check-secrets.sh` | 一键自查脚本（工作区 + 忽略规则 + 全历史），退出码 0/1 |
| `.env.example` | 需要配哪些环境变量的占位符模板（**不含真值**） |
| `cloudbaserc.example.json` | 云函数部署配置模板（**不含真值**） |
| `api-contract.md` §1.8 | 三类错误提示的约定（前端唯一出口 `errKindText`） |
| `DEPLOY.md` §十四 | 本文档的部署侧快速版 |
