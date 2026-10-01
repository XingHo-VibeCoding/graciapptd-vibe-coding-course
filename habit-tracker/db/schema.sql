-- ============================================================================
-- 自律计划 · 建表脚本（schema.sql）
-- Day 16（2026-10-01）建立 · 版本 v1.0
-- ----------------------------------------------------------------------------
-- 今天只建**两张核心表**（课程要求的两张）：
--
--   1) plan_days  计划日 —— "哪一天"。**一天一条**，存当天的心情。
--   2) checkins   打卡项 —— "那一天要做/已做的事"。**一天多条**，就是待办。
--
-- 两张表靠 **date** 关联（同一天的打卡项属于同一天的"计划日"）；
-- 另有一个 uid 字段标记"这是谁的数据"，所以完整关联是 (uid, date)。
--   例：plan_days 里 2026-10-01 那一条 = "用户 seed-demo-user 在 10 月 1 日这天心情平静"
--       checkins 里 date='2026-10-01' 的 5 条 = "这天的 5 件打卡事"
--
-- 为什么这两张是"核心"：今天页（首页）就是它们的一次合并读取——
--   上方日期/心情来自 plan_days，下面的待办列表来自 checkins。
--   其余 5 张表（users / notes / focus_sessions / anniversaries / affirm_likes）
--   按课程安排 Day 18 之前陆续补，不在今天范围。
--
-- 执行方式（CloudBase 控制台）：
--   环境 → 左侧「数据库」→ 选 PostgreSQL → 「SQL 编辑器」→ 粘贴本文件全部内容 → 执行
--
-- 可重复执行：全部用 IF NOT EXISTS，跑第二遍不会报错、不会重建。
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 表 1：plan_days —— 计划日（一天一条）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plan_days (
  uid        TEXT        NOT NULL,                                  -- 谁的数据：CloudBase 匿名登录生成的 uid
  date       DATE        NOT NULL,                                  -- 哪一天：本机自然日（不是 UTC 日期，见 PRD 裁定）
  mood       TEXT,                                                  -- 当天心情：sad/blue/calm/cozy/joy；还没打卡就是 NULL
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),                    -- 这条记录什么时候建的（带时区，跨国/夏令时都不会错）
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),                    -- 心情被改过的时间（覆盖更新时刷新）

  -- 主键 = (uid, date)：物理上就保证了「一个人一天只有一条」，重复写入会被数据库挡住
  CONSTRAINT plan_days_pkey PRIMARY KEY (uid, date),

  -- 心情只能是这五个值之一，别的一律拒绝（前端传错、以后改代码写错都拦得住）
  CONSTRAINT plan_days_mood_enum CHECK (mood IS NULL OR mood IN ('sad','blue','calm','cozy','joy'))
);

COMMENT ON TABLE  plan_days            IS '计划日：一天一条，记录当天心情；与 checkins 靠 (uid, date) 关联';
COMMENT ON COLUMN plan_days.uid        IS '用户标识，来自 CloudBase 匿名登录，前端不许明传';
COMMENT ON COLUMN plan_days.date       IS '归属日期（本地自然日 YYYY-MM-DD）';
COMMENT ON COLUMN plan_days.mood       IS '当日心情：sad/blue/calm/cozy/joy，未打卡为 NULL';
COMMENT ON COLUMN plan_days.created_at IS '创建时间';
COMMENT ON COLUMN plan_days.updated_at IS '最近一次修改心情的时间';


-- ---------------------------------------------------------------------------
-- 表 2：checkins —— 打卡项（一天多条，就是待办）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS checkins (
  id         BIGSERIAL   PRIMARY KEY,                               -- 自增主键；接口里的 :id 用的就是它
  uid        TEXT        NOT NULL,                                  -- 谁的数据
  date       DATE        NOT NULL,                                  -- 属于哪一天（与 plan_days.date 同一套口径）
  text       TEXT        NOT NULL,                                  -- 要做的事，1~60 字
  time       TEXT,                                                  -- 安排时间 'HH:mm'；NULL = 没安排具体时间
  quad       TEXT,                                                  -- 四象限：q1/q2/q3/q4；NULL = 未分类
  done       BOOLEAN     NOT NULL DEFAULT FALSE,                    -- 是否已完成
  done_at    TIMESTAMPTZ,                                           -- 完成时刻；没完成就是 NULL
  sort       INTEGER     NOT NULL DEFAULT 0,                        -- 同一天内的排序位（"移动到其他日期"后保持顺序）
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),                    -- 创建时间

  -- 内容不能是空白（防止有人存一堆空格）
  CONSTRAINT checkins_text_not_blank CHECK (btrim(text) <> ''),
  -- 内容长度上限 60，与前端输入框 maxlength 保持一致（服端是最后防线）
  CONSTRAINT checkins_text_len       CHECK (char_length(text) <= 60),
  -- 时间格式必须严格是 HH:mm，24 小时制（00:00 ~ 23:59）
  CONSTRAINT checkins_time_fmt       CHECK (time IS NULL OR time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  -- 象限只能是这四个之一
  CONSTRAINT checkins_quad_enum      CHECK (quad IS NULL OR quad IN ('q1','q2','q3','q4')),
  -- 完成状态和完成时刻必须一致：打了勾就得有完成时刻，没打勾就不能有
  CONSTRAINT checkins_done_consistent CHECK ((done AND done_at IS NOT NULL) OR (NOT done AND done_at IS NULL))
);

-- 最常用的查询是"某人的某一天"（今天页）和"某人的一段日期"（周历/报告），
-- 所以按 (uid, date) 建索引——有它，数据量大时也不会全表扫描。
CREATE INDEX IF NOT EXISTS checkins_uid_date_idx ON checkins (uid, date);

COMMENT ON TABLE  checkins            IS '打卡项：一天多条，即待办列表；与 plan_days 靠 (uid, date) 关联';
COMMENT ON COLUMN checkins.id         IS '自增主键，接口路径 :id 用它';
COMMENT ON COLUMN checkins.uid        IS '用户标识，来自 CloudBase 匿名登录，前端不许明传';
COMMENT ON COLUMN checkins.date       IS '归属日期（本地自然日），与 plan_days.date 口径一致';
COMMENT ON COLUMN checkins.text       IS '要做的事，1~60 字';
COMMENT ON COLUMN checkins.time       IS '安排时间 HH:mm，NULL 表示未安排';
COMMENT ON COLUMN checkins.quad       IS '四象限分类 q1~q4，NULL 表示未分类';
COMMENT ON COLUMN checkins.done       IS '是否已完成';
COMMENT ON COLUMN checkins.done_at    IS '完成时刻，未完成为 NULL';
COMMENT ON COLUMN checkins.sort       IS '同一天内的排序位';
COMMENT ON COLUMN checkins.created_at IS '创建时间';


-- ---------------------------------------------------------------------------
-- 刻意没做的两件事（说清楚，免得以为是漏了）
-- ---------------------------------------------------------------------------
-- 1) 没有给 checkins 加指向 plan_days 的外键。
--    原因：产品的真实用法是"用户直接加一条待办"，很可能一整天都不去点心情——
--    如果加了外键，加待办前就必须先有 plan_days 那一行，会凭空多一步。
--    所以两张表是**逻辑关联**（靠 uid + date），由服务层保证一致性。
--    将来若确认"每天首次写入必先 upsert plan_days"，再补外键也不迟（改动很小）。
--
-- 2) 没有建统计表。
--    完成数、连续天数、心情分布这些一律**现算不存**（PRD 原则），
--    由 report 接口用 SELECT 聚合直接算，不落表——避免"统计表和真实数据对不上"的经典问题。


-- ---------------------------------------------------------------------------
-- 其余 5 张表（Day 18 之前补，今天不建）
-- ---------------------------------------------------------------------------
--   users            我的页：姓名 + 主题偏好
--   notes            思考页：想法流
--   focus_sessions   应用·专注计时：每次计时的分钟数
--   anniversaries    应用·纪念&倒数日
--   affirm_likes     应用·肯定语：点过赞的语录索引
--   字段定义见 api-contract.md §二，届时另写 db/schema-2.sql 追加，不改本文件。
