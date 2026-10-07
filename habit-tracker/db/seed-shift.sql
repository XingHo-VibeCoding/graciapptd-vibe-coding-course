-- ============================================================================
-- 自律计划 · 种子数据日期平移（seed-shift.sql）
-- Day 20（2026-10-07）建立 · 版本 v1.0
-- ----------------------------------------------------------------------------
-- 为什么要有这个脚本：
--   seed.sql 里的示例数据写死了固定日期（2026-09-25 ~ 2026-10-01）。
--   等到 Day 20 前端接上真接口、要"首页展示数据库真实数据"时，
--   那些日期早就过去了 —— 首页（今天）读到的是空列表，看不出任何效果。
--
--   本脚本把**两个表里的种子数据整体平移**，让最后一天正好落在「今天」，
--   今天页就有真实数据可显示了。
--
-- 【怎么做的】算出一个天数差 off，然后把所有 date 都加上 off。
--   off = 今天 - 种子数据里最晚的那一天     （例：今天 10-07、种子最晚 10-01 → off = 6）
--   两个表共用**同一个 off**，所以 09-30 / 10-01 的相对前后关系完全不变。
--   done_at（完成时刻）也一起平移，否则会出现"完成时间早于所属日期"的怪数据。
--
-- 【为什么不能一步到位 UPDATE】plan_days 的主键是 (uid, date)，一天只能有一条。
--   整体 +6 天时，09-25 那行要变成 10-01，可 10-01 那行**还没搬走** → 撞主键，
--   数据库直接报 SQLSTATE 23505。所以分两段搬：先全部挪到一段没人用的远期日期，
--   再挪回来。两段在同一个事务里（DO 块），中途出错会整体回滚，不会留半截数据。
--
-- 【可重复执行】跑第二遍时"种子最晚那天"已经是今天 → off = 0 → 直接跳过，
--   不会一直往外推。（这也是不能用写死日期偏移量的原因：跑两次就偏两次。）
--
-- 【怎么回退】把 off 取反再跑一遍（date 减回去）；或直接重跑 schema.sql + seed.sql
--   恢复成固定日期的原始样子（seed.sql 是幂等的）。
--
-- 执行方式：
--   tcb db execute --sql "$(cat habit-tracker/db/seed-shift.sql)"
--   或控制台 → 数据库 → PostgreSQL → SQL 编辑器 → 粘贴执行
-- ============================================================================

DO $$
DECLARE
  off int;                     -- 要平移的天数（正数 = 往后挪）
BEGIN
  -- 1) 以 plan_days 里最晚的一天为锚，算出天数差。
  --    注意：两个表共用这一个 off —— 所以先算好、再动数据，中间不重算。
  SELECT (CURRENT_DATE - max(date)) INTO off
  FROM plan_days WHERE uid = 'seed-demo-user';

  IF off IS NULL THEN
    RAISE NOTICE '跳过：plan_days 里没有 seed-demo-user 的种子数据（先执行 seed.sql）';
    RETURN;
  END IF;

  IF off = 0 THEN
    RAISE NOTICE '跳过：种子数据的最后一天已经是今天，无需平移（本脚本可重复执行）';
    RETURN;
  END IF;

  -- 2) plan_days 平移（分两段搬，避开主键冲突，见文件开头说明）。
  --    P.S. +10000 天 ≈ 27 年后的日期，实际数据不可能落在那儿，只是借它当"中转站"。
  UPDATE plan_days SET date = date + 10000 WHERE uid = 'seed-demo-user';
  UPDATE plan_days SET date = date - 10000 + off,
                      updated_at = now()          -- 这几行确实刚被改过，首页「更新于」读它
  WHERE uid = 'seed-demo-user';

  -- 3) checkins 平移（同一个 off）；done_at 不是空的时候一起挪
  UPDATE checkins SET date = date + 10000 WHERE uid = 'seed-demo-user';
  UPDATE checkins
  SET date = date - 10000 + off,
      done_at = CASE WHEN done_at IS NULL THEN NULL
                     ELSE done_at + (off || ' days')::interval END
  WHERE uid = 'seed-demo-user';

  RAISE NOTICE '已把种子数据整体平移 % 天（plan_days + checkins）', off;
END $$;


-- ---------------------------------------------------------------------------
-- 执行结果自述（跑完应看到：最后一天 = 今天，今天这天有若干条打卡项）
-- ---------------------------------------------------------------------------
SELECT 'plan_days 最后一天' AS "检查项",
       max(date)::text      AS "值"
FROM plan_days WHERE uid = 'seed-demo-user'
UNION ALL
SELECT 'checkins 最后一天', max(date)::text
FROM checkins WHERE uid = 'seed-demo-user'
UNION ALL
SELECT '今天这天的打卡项条数', count(*)::text
FROM checkins WHERE uid = 'seed-demo-user' AND date = CURRENT_DATE
UNION ALL
SELECT '今天的心情', coalesce(max(mood), '（无记录）')
FROM plan_days WHERE uid = 'seed-demo-user' AND date = CURRENT_DATE;
