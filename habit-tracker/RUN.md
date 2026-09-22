# RUN.md · 自律计划 MVP 运行说明（Day 7 第一版）

> 第一版用最朴素的方式跑起来：**纯 HTML + CSS + JS 单文件**，无需 npm install / 构建步骤。这是为了在 Day 7 把"能打开页面"这件事验证掉；React/Vite 重构放在第 2 周（届时本文件同步更新）。

---

## 一、运行命令（任选其一）

### 方式 A · Python 自带静态服务器（推荐，零依赖）

```bash
cd "C:\Users\Lenovo\Desktop\vibe-coding-course\habit-tracker\frontend"
python -m http.server 8000
```

启动后打开浏览器访问 **http://localhost:8000**（或 `http://localhost:8000/index.html`）。

### 方式 B · Node 静态服务器（如有 Node）

```bash
cd "C:\Users\Lenovo\Desktop\vibe-coding-course\habit-tracker\frontend"
npx --yes http-server -p 8000
```

### 方式 C · 直接双击打开（不推荐）

可以直接双击 `frontend/index.html` 用浏览器打开，但部分浏览器在 `file://` 协议下会限制 localStorage，多 tab 间可能不同步；调试时建议用方式 A。

---

## 二、首次看到的内容

打开后默认显示「今日」视图，底部三 tab：**今日 / 思考 / 我的**。

页面默认是空的（遵守 R6：不预填真实数据）。想看效果：
1. 切到「我的」→ 点 **填充示例** → 会有 3 天编造的待办/心情/笔记（含月历表情）
3. 切回**今日**看时间轴
4. 切到**思考**看每日一问

**所有示例数据为编造，不是真实个人内容。**

---

## 三、Day 7 验收对照（自检报告）

| 验收标准 | 状态 | 实现位置 / 说明 |
|----------|------|----------------|
| A1 ≤3 秒可见今日 | ✅ | 单文件加载，无构建链 |
| A2 时间轴按时排序 | ✅ | `renderToday()` 内 sort：有时在前，无时末尾 |
| A3 勾选/取消/刷新保留 | ✅ | localStorage `todos[day]`；A21 同源 |
| A4 删除带确认 | ✅ | `confirm()` 弹窗 |
| A5 未来日不可勾 | ⏳ 未做 | 当前只有一个"今天"视图，前后日切换未实现（第 2 周） |
| A6 没完成不显心情 | ✅ | `doneCount > 0` 才显示 |
| A7 三表情出现 | ✅ | 😊😐😣 三按钮 |
| **A8 哭脸无负面文案** | ✅ | `moodMsg('sad')` = "辛苦了，完成本身就是赢。" |
| A9 重复选覆盖 | ✅ | `data.moods[day] = mood` 直接覆盖 |
| A10 进入思考光标就位 | ✅ | textarea 渲染即可聚焦；autofocus 未强制以避免抢焦点 |
| A11 不答问题也能存 | ✅ | 笔记保存不依赖问题 |
| A12 卡片倒序+时间戳 | ✅ | `slice().reverse()` + `ts` |
| A13 换题 ≤3 次/不重复 | ✅ | `meta.rotates` 计数 + `shownQuestions` |
| A14 周报入口 | ⏳ 未做 | F4 留第 3 周 |
| A15-A17 周报统计 | ⏳ 未做 | 同上 |
| A18 改名同步 | ✅ | greeting 同步，刷新后从 localStorage 读回 |
| A19 3 主题换肤 | ✅ | `data-theme` 属性切换 CSS 变量 |
| A20 月历表情 | ✅ | `renderCalendar()`，无记录为空格 |
| **A21 刷新不丢** | ✅ | localStorage 唯一存储 |
| **A22 无登录/付费/推荐** | ✅ | 全程无网络请求 |

**must-fix：无**。3 项留 ⏳ 是 Day 7 范围之外的（前后日切换、周报）。

---

## 四、文件结构（截至 Day 7）

```
habit-tracker/
├── docs/                     ← 文档
├── frontend/
│   └── index.html            ← MVP 单文件（HTML+CSS+JS 全在一起）
├── scratch/                  ← 试验文件暂存（R6 要求当天清空）
├── research.md               ← Day 3
├── PRD.md                    ← Day 4
├── TECH_DESIGN.md            ← Day 5
└── RUN.md                    ← Day 7（本文件）
```

`scratch/` 当前为空（没用到）。

---

## 五、待办（Day 8+ 接续）

| 优先级 | 任务 | 备注 |
|--------|------|------|
| 高 | 前后日切换（A5）+ 周报入口（A14-A17） | 接 F4 |
| 高 | React/Vite 化（TECH_DESIGN v2.0 默认路线） | 把 `frontend/index.html` 拆为 `src/App.jsx` + 组件 |
| 中 | 移动端适配 | 当前 min-width 设计，需实测 |
| 中 | 数据导出 | localStorage 导出 JSON 备份 |
| 低 | 每日一问问题池扩充到 60 题 | 当前 30 题够 1 个月不重复 |

---

## 六、踩坑与决策记录

- **为什么不上 React**：Day 7 要"能跑起来"，而 npm install + vite dev 服务对零基础学员的诊断链条更长。先用纯 HTML 把 A1/A21 验证掉，Day 8-9 再切。
- **为什么不接 CloudBase**：TECH_DESIGN v2.0 默认是 B 方案（云函数 + PostgreSQL），但 PRD 明确 A22 无登录、云同步列入不做清单（#5）。Day 7 纯本地即可，第 3 周才接云。
- **测试数据为什么需要"填充示例"按钮**：遵守 R6（真实心情内容永不进 public 仓库）。默认空状态，自己手填；想看效果再点按钮填充编造的。