-- ============================================================================
-- 自律计划 · 增量建表脚本（schema-4.sql）
-- Day 29（2026-10-27）建立 · 版本 v1.0
-- ----------------------------------------------------------------------------
-- 为什么另起文件：契约 §二的约定 —— schema.sql 是 Day 16 的定稿、schema-2/3 是
-- Day 18/22 的定稿，**历史不改写**；后续增量一律追加到新文件，按日期分节往下写。
--
-- 本文件**可重复执行**：全部 CREATE ... IF NOT EXISTS，跑第二遍不报错、不改数据。
--
-- 执行方式（二选一）：
--   · 控制台：环境 → 数据库 → PostgreSQL → SQL 编辑器 → 粘贴本文件全部内容 → 执行
--   · 命令行：tcb db execute --sql "$(cat db/schema-4.sql)"
--
-- 这一轮解决什么问题：打卡（每天 N 次）原先只存在浏览器本机，换设备就没了。
-- 现在把它拆成两张表：
--   1) habits      打卡定义 —— "要打卡什么、每天几次、什么时间段内有效"
--   2) habit_logs  每日次数 —— "某一天这条打卡打了几次"
-- 和 plan_days / checkins 一样，两张表靠 (uid, client_id) 逻辑关联，不加外键
-- （理由同 schema.sql 末尾：先建打卡、后建某天的记录是常态，外键会凭空多一步）。
-- ============================================================================


-- ============================================================================
-- 【Day 29】表 3：habits —— 打卡定义
-- ----------------------------------------------------------------------------
-- 一个关键设计：**client_id 而不是让前端用服务端自增 id**。
--   本机老数据里的打卡 id 形如 "h1729..."，而 habit_logs 是按这个 id 索引的
--   （habitLogs[habitsId][date]）。如果上云后换成数据库自增 id，就得把本机
--   所有日志的键重写一遍，还要处理"两台设备各建一条、id 都叫 h1729"的冲突。
--   所以：**本机生成的 id 原样当 client_id 上传**，服务端只额外有自己的自增
--   id（给排查用，接口不暴露）。两边 id 永远一致，前端一行映射都不用写。
--   唯一约束 (uid, client_id) 保证"同一个人的同一条打卡只有一行"，
--   重传 = 覆盖（upsert），断网重试天然安全。
-- ============================================================================
CREATE TABLE IF NOT EXISTS habits (
  id         BIGSERIAL   PRIMARY KEY,                               -- 服务端自增主键（仅供排查，接口用 client_id）
  uid        TEXT        NOT NULL,                                  -- 谁的数据
  client_id  TEXT        NOT NULL,                                  -- 前端生成的稳定 id（h + 时间戳），两边共用
  name       TEXT        NOT NULL,                                  -- 打卡名称，1~20 字
  per_day    SMALLINT    NOT NULL DEFAULT 1,                        -- 每天（每个有效日）要打几次，1~9
  time       TEXT,                                                  -- 安排时间 'HH:mm'；NULL = 没安排
  quad       TEXT,                                                  -- 四象限 q1~q4；NULL = 未分类
  start_date DATE        NOT NULL,                                  -- 从哪天开始生效
  end_date   DATE,                                                  -- 到哪天结束；NULL = 永久
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),                    -- 创建时间
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),                    -- 最近一次修改（编辑打卡时刷新）

  -- 同一个人的同一条打卡只能有一行：重传走 upsert 合并，不会长出一堆重复打卡
  CONSTRAINT habits_uid_client_uk UNIQUE (uid, client_id),

  -- 下面四条与前端输入限制、云函数校验一一对应（服务端管"好用"，数据库管"最后防线"）
  CONSTRAINT habits_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT habits_name_len       CHECK (char_length(name) <= 20),
  CONSTRAINT habits_per_day_range  CHECK (per_day BETWEEN 1 AND 9),
  CONSTRAINT habits_time_fmt       CHECK (time IS NULL OR time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT habits_quad_enum      CHECK (quad IS NULL OR quad IN ('q1','q2','q3','q4')),
  -- 结束日期要么没填（永久），要么不能早于开始日期
  CONSTRAINT habits_range_order    CHECK (end_date IS NULL OR end_date >= start_date)
);

-- 主要查询是"这个人的全部打卡定义"，按创建时间排（列表顺序稳定）
CREATE INDEX IF NOT EXISTS habits_uid_idx ON habits (uid, created_at);

COMMENT ON TABLE  habits             IS '打卡定义：每天 N 次、起止日期；与 habit_logs 靠 (uid, client_id) 关联';
COMMENT ON COLUMN habits.uid         IS '用户标识，来自 CloudBase 匿名登录，前端不许明传';
COMMENT ON COLUMN habits.client_id   IS '前端生成的稳定 id，本机与服务端共用，避免 id 映射';
COMMENT ON COLUMN habits.name        IS '打卡名称，1~20 字';
COMMENT ON COLUMN habits.per_day     IS '每天要打几次（1~9）';
COMMENT ON COLUMN habits.time        IS '安排时间 HH:mm，NULL 表示未安排';
COMMENT ON COLUMN habits.quad        IS '四象限分类 q1~q4，NULL 表示未分类';
COMMENT ON COLUMN habits.start_date  IS '开始生效日期';
COMMENT ON COLUMN habits.end_date    IS '结束日期，NULL 表示永久';
COMMENT ON COLUMN habits.updated_at  IS '最近一次修改时间（编辑打卡时刷新）';


-- ============================================================================
-- 【Day 29】表 4：habit_logs —— 每日打卡次数
-- ----------------------------------------------------------------------------
-- 粒度是"一条打卡 × 一天 = 一行"，主键 (uid, client_id, date)：
--   ① 同一天重复打卡 → 撞主键 → 走 upsert 覆盖次数，物理上不可能出现两行；
--   ② 点一次 +1，减到 0 时接口直接删行（不留 count=0 的垃圾行）。
-- 为什么不像 checkins 那样存 done_at：打卡的语义是"这一天打了几次"，
--   次数本身就是事实；完成与否 = count >= per_day，**现算不存**（PRD 原则）。
-- ============================================================================
CREATE TABLE IF NOT EXISTS habit_logs (
  uid        TEXT        NOT NULL,                                  -- 谁的数据
  client_id  TEXT        NOT NULL,                                  -- 对应 habits.client_id
  date       DATE        NOT NULL,                                  -- 哪一天（本地自然日）
  count      SMALLINT    NOT NULL,                                  -- 这一天打了几次（1~9；0 不落库）
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),                    -- 最近一次改动时间

  CONSTRAINT habit_logs_pkey PRIMARY KEY (uid, client_id, date),
  CONSTRAINT habit_logs_count_range CHECK (count BETWEEN 0 AND 9)
);

-- 查"某人某天所有打卡次数"与"某人一条打卡的历史"都要用
CREATE INDEX IF NOT EXISTS habit_logs_uid_date_idx ON habit_logs (uid, date);

COMMENT ON TABLE  habit_logs            IS '每日打卡次数：(uid, client_id, date) 一天一行，count 为当天次数';
COMMENT ON COLUMN habit_logs.client_id  IS '对应 habits.client_id（逻辑关联，不建外键）';
COMMENT ON COLUMN habit_logs.date       IS '归属日期（本地自然日 YYYY-MM-DD）';
COMMENT ON COLUMN habit_logs.count      IS '当天打卡次数；减到 0 时接口直接删行';


-- ============================================================================
-- 刻意没做的事
-- ----------------------------------------------------------------------------
-- 1) 没有建"打卡统计表"（连续天数、完成率、月历）—— 统计一律现算不存，
--    由 SELECT 聚合直接算，避免"统计表和真实数据对不上"。
-- 2) 没有加外键 habit_logs → habits：删除打卡时由服务端先删日志、再删定义，
--    顺序写死在 db.js 里（删一半失败可重试，接口幂等）。
-- 3) 没有改 schema.sql / schema-2.sql / schema-3.sql —— 历史脚本当天可复现，不改写。
-- ============================================================================
