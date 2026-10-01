-- ============================================================================
-- 自律计划 · 种子数据（seed.sql）
-- Day 16（2026-10-01）建立 · 版本 v1.0
-- ----------------------------------------------------------------------------
-- 作用：往两张核心表塞一批**编造的示例数据**，用来验证建表成功、结构可用。
--   ⚠️ 隐私红线（AGENTS.md R6）：这里的内容全部是编的示例，
--      绝不允许把真实的心情、想法、待办写进仓库（仓库是 public 的）。
--
-- 数据量：plan_days 7 行（近 7 天）、checkins 8 行（其中 10-01 这天 5 条）。
--
-- 【重点】可重复执行：跑第二遍、第三遍都不报错、也不会插出重复数据。
--   plan_days 用 ON CONFLICT (uid, date) DO NOTHING —— 主键就是"某人某天"，
--             已存在就跳过，天然幂等。
--   checkins  没有天然唯一键（"写周报"理论上可以一天出现两次），
--             所以用 WHERE NOT EXISTS 判断"(同一个人 + 同一天 + 同样内容)已存在就跳过"。
--             这样既能重复执行，又不会为了种子数据去给业务表加一个假的唯一约束。
--
-- 关于 uid：这里统一用种子账号 'seed-demo-user'。
--   等 Day 17 接口接上真实身份后，想让自己的账号看到这批数据，
--   执行一次：UPDATE plan_days SET uid = '<你的uid>' WHERE uid = 'seed-demo-user';
--            UPDATE checkins  SET uid = '<你的uid>' WHERE uid = 'seed-demo-user';
--
-- 执行方式：CloudBase 控制台 → 数据库 → PostgreSQL → SQL 编辑器 → 粘贴执行（先执行 schema.sql）
--
-- 提示：想让日期跟着"今天"走，把下面的 DATE '2026-xx-xx' 换成
--       CURRENT_DATE、CURRENT_DATE - 1、CURRENT_DATE - 2 ……即可。
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1) plan_days：近 7 天的"计划日"记录（每天一条，带心情）
-- ---------------------------------------------------------------------------
INSERT INTO plan_days (uid, date, mood)
VALUES
  ('seed-demo-user', DATE '2026-09-25', 'joy'),    -- 喜悦
  ('seed-demo-user', DATE '2026-09-26', 'calm'),   -- 平静
  ('seed-demo-user', DATE '2026-09-27', 'cozy'),   -- 惬意
  ('seed-demo-user', DATE '2026-09-28', 'blue'),   -- 忧郁
  ('seed-demo-user', DATE '2026-09-29', 'calm'),   -- 平静
  ('seed-demo-user', DATE '2026-09-30', 'joy'),    -- 喜悦
  ('seed-demo-user', DATE '2026-10-01', 'calm')    -- 平静（今天）
ON CONFLICT (uid, date) DO NOTHING;               -- 已存在就跳过：重复执行不报错、不重复插


-- ---------------------------------------------------------------------------
-- 2) checkins：打卡项（一天多条）
-- ---------------------------------------------------------------------------
WITH seed_data (date, text, time, quad, done, done_at, sort) AS (
  VALUES
    -- 9 月 30 日：3 条（2 条完成）
    (DATE '2026-09-30', '晨跑 30 分钟',   '07:30', 'q2', TRUE,  TIMESTAMPTZ '2026-09-30 07:58:00+08', 0),
    (DATE '2026-09-30', '写周报',         '14:00', 'q1', TRUE,  TIMESTAMPTZ '2026-09-30 15:20:00+08', 1),
    (DATE '2026-09-30', '读 20 页书',     NULL,    'q2', FALSE, NULL,                               2),
    -- 10 月 1 日（今天）：5 条（1 条完成）
    (DATE '2026-10-01', '晨跑 30 分钟',   '07:30', 'q2', TRUE,  TIMESTAMPTZ '2026-10-01 08:02:00+08', 0),
    (DATE '2026-10-01', '整理下周计划',   '09:00', 'q1', FALSE, NULL,                               1),
    (DATE '2026-10-01', '给妈妈打电话',   NULL,    'q2', FALSE, NULL,                               2),
    (DATE '2026-10-01', '写今日复盘',     '21:00', 'q4', FALSE, NULL,                               3),
    (DATE '2026-10-01', '泡脚放松',       '22:00', NULL, FALSE, NULL,                               4)
)
INSERT INTO checkins (uid, date, text, time, quad, done, done_at, sort)
SELECT 'seed-demo-user', s.date, s.text, s.time, s.quad, s.done, s.done_at, s.sort
FROM seed_data s
WHERE NOT EXISTS (                                -- 同一人 + 同一天 + 同样内容 已存在，就跳过
  SELECT 1 FROM checkins c
  WHERE c.uid = 'seed-demo-user'
    AND c.date = s.date
    AND c.text = s.text
);


-- ---------------------------------------------------------------------------
-- 执行结果自述（跑完在 SQL 编辑器里应看到这两行数字）
--   plan_days : 7
--   checkins  : 8
-- 具体校验语句见同目录 verify.sql
-- ---------------------------------------------------------------------------
SELECT 'plan_days' AS "表", count(*) AS "行数" FROM plan_days WHERE uid = 'seed-demo-user'
UNION ALL
SELECT 'checkins',          count(*)          FROM checkins  WHERE uid = 'seed-demo-user';
