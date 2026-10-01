-- ============================================================================
-- 自律计划 · 建表与种子验证（verify.sql）
-- Day 16（2026-10-01）· 版本 v1.0
-- ----------------------------------------------------------------------------
-- 用法：先执行 schema.sql → 再执行 seed.sql → 最后执行本文件。
-- 目的：用 SELECT 证明三件事——
--   ① 两张核心表都建好了，且各自有 ≥5 行数据；
--   ② 两张表靠 (uid, date) 真的能关联起来（今天页的数据形状）；
--   ③ 种子脚本重复执行后行数不变（幂等）。
--
-- CloudBase 控制台截图就截"验证 1 / 验证 2"的结果（表名 + ≥5 行数据）。
-- ============================================================================


-- ── 验证 1：plan_days（计划日）全部数据 —— 应 ≥5 行 ──────────────────────
SELECT date           AS "日期",
       mood           AS "心情",
       updated_at     AS "最近修改"
FROM   plan_days
WHERE  uid = 'seed-demo-user'
ORDER  BY date;


-- ── 验证 2：checkins（打卡项）全部数据 —— 应 ≥5 行 ───────────────────────
SELECT id             AS "编号",
       date           AS "日期",
       time           AS "时间",
       text           AS "要做的事",
       quad           AS "象限",
       done           AS "已完成"
FROM   checkins
WHERE  uid = 'seed-demo-user'
ORDER  BY date, sort;


-- ── 验证 3：两张表的关联 —— 按 (uid, date) 连起来，就是"今天页"的数据形状 ──
-- 左边 plan_days 提供"这一天 + 心情"，右边 checkins 提供"这天的打卡项"和完成情况。
SELECT d.date                                       AS "日期",
       d.mood                                        AS "心情",
       count(c.id)                                   AS "打卡项数",
       count(c.id) FILTER (WHERE c.done)              AS "已完成数"
FROM   plan_days d
LEFT   JOIN checkins c
       ON c.uid = d.uid AND c.date = d.date          -- ← 关联条件：uid 相同 + date 相同
WHERE  d.uid = 'seed-demo-user'
GROUP  BY d.date, d.mood
ORDER  BY d.date;


-- ── 验证 4：单日读取 —— Day 17 的 GET /api/day 要跑的就是这类查询 ─────────
SELECT c.time  AS "时间",
       c.text  AS "要做的事",
       c.done  AS "已完成"
FROM   checkins c
WHERE  c.uid = 'seed-demo-user'
  AND  c.date = DATE '2026-10-01'
ORDER  BY c.done, c.sort;                            -- 未完成的排前面（与前端展示顺序一致）


-- ── 验证 5：约束真的在生效（每条都应报错，被数据库挡住）─────────────────
--   a) 心情写一个不存在的值 → 违反 plan_days_mood_enum
--   b) 时间写成 25:99        → 违反 checkins_time_fmt
--   c) 打了勾却没有完成时刻  → 违反 checkins_done_consistent
--   d) 同一个人同一天插两条 plan_days → 违反主键
-- 把下面任一行的注释去掉执行，应看到 ERROR；验证完再改回注释。
--
-- INSERT INTO plan_days (uid, date, mood) VALUES ('seed-demo-user', DATE '2026-10-02', '开心');      -- a)
-- INSERT INTO checkins  (uid, date, text, time) VALUES ('seed-demo-user', DATE '2026-10-02', 'x', '25:99'); -- b)
-- INSERT INTO checkins  (uid, date, text, done) VALUES ('seed-demo-user', DATE '2026-10-02', 'x', TRUE);    -- c)
-- INSERT INTO plan_days (uid, date, mood) VALUES ('seed-demo-user', DATE '2026-10-01', 'joy');       -- d)


-- ── 验证 6：幂等复验 —— 再跑一遍 seed.sql 后执行本句，数字应与首次一致 ────
SELECT 'plan_days' AS "表", count(*) AS "行数" FROM plan_days WHERE uid = 'seed-demo-user'
UNION ALL
SELECT 'checkins',          count(*)          FROM checkins  WHERE uid = 'seed-demo-user'
ORDER  BY "表";
