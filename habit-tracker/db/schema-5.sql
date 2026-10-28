-- ============================================================================
-- 自律计划 · 增量建表脚本（schema-5.sql）
-- Day 31 二轮（2026-10-28）建立 · 版本 v1.0
-- ----------------------------------------------------------------------------
-- 为什么另起文件：契约 §二的约定 —— schema.sql / -2 / -3 / -4 都是当天定稿，
-- **历史不改写**；后续增量一律追加到新文件。
--
-- 本文件**可重复执行**：全部 CREATE ... IF NOT EXISTS，跑第二遍不报错、不改数据。
--
-- 执行方式（二选一）：
--   · 控制台：环境 → 数据库 → PostgreSQL → SQL 编辑器 → 粘贴本文件全部内容 → 执行
--   · 命令行：tcb db execute --sql "$(cat db/schema-5.sql)"
--
-- 这一轮解决什么问题：**同学写的待办在我这里也能看到**。
-- 根因不在数据库（四张业务表每条数据都带 uid，13 条接口全按 uid 过滤），
-- 而在「身份从哪来」：没有登录，云函数只能退化到环境变量里那个固定的
-- DEMO_UID，于是所有人都是同一个人。
--
-- 所以这一轮只补两张**身份表**，业务表一行不动：
--   1) app_users   账号 —— 用户名 + 密码哈希（scrypt，服务端算）+ 角色
--   2) auth_tokens 令牌 —— 登录后发的随机串（库里只存 sha256，泄库也不能直接用）
--
-- 为什么不复用平台匿名登录：本项目的诉求是「换设备/换浏览器还能拿回自己的数据」，
-- 匿名登录恰恰换浏览器就是新人；手机号登录要短信配额（收费）。自建最小账号更合适，
-- 而且密码哈希用 Node 内置 crypto，不引第三方依赖。
--
-- 密码为什么存 hash + salt 两列：scrypt 每次要随机 salt，salt 必须与 hash 一起存；
-- 校验时用同样的 salt 重算再比对（服务端 timingSafeEqual，避免计时侧信道）。
-- ============================================================================


-- ============================================================================
-- 【Day 31】表 1：app_users —— 账号
-- ----------------------------------------------------------------------------
-- uid 由服务端生成（u_ + 12 位随机），**不沿用用户名**：
--   ① 用户以后改昵称，数据不用跟着搬；
--   ② 用户名可含中文/空格，拿去当 uid 会污染四张业务表；
--   ③ 与平台 uid（context.userInfo.uid）同一列语义，将来接平台登录可平滑合并。
--
-- 用户名唯一性用 lower(username) 索引而不是列级 UNIQUE：
--   否则 "Alice" 和 "alice" 能同时注册，登录时谁是谁全看运气。
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_users (
  uid          TEXT        PRIMARY KEY,                             -- 服务端生成：u_ + 12 位随机
  username     TEXT        NOT NULL,                                -- 显示名 / 登录名，2~20 字
  username_lc  TEXT        NOT NULL,                                -- trim + lower 后的用户名（查重用）
  pass_hash    TEXT        NOT NULL,                                -- scrypt 结果（hex），永不出接口
  pass_salt    TEXT        NOT NULL,                                -- 随机 salt（hex），校验时重算用
  role         TEXT        NOT NULL DEFAULT 'member',               -- member / admin（第一个注册者自动 admin）
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,                                          -- 最后一次带令牌请求的时间（总览用）
  CONSTRAINT app_users_role_ck CHECK (role IN ('member', 'admin')),
  CONSTRAINT app_users_username_len_ck CHECK (char_length(btrim(username)) BETWEEN 2 AND 20)
);

-- 大小写不敏感的唯一用户名（"Alice" 与 "alice" 视为同一个）。
-- 为什么用一列而不是 lower(username) 索引 + 表达式查询：PostgREST 的过滤只认列名，
-- 表达式过滤会被回 400（Day 31 实测：注册接口 500）。所以写入时就把 trim+lower 存进 username_lc。
CREATE UNIQUE INDEX IF NOT EXISTS app_users_username_lc_uk
  ON app_users (username_lc);

COMMENT ON TABLE  app_users            IS '账号表（Day 31 多用户）：用户名 + 密码哈希 + 角色';
COMMENT ON COLUMN app_users.uid        IS '服务端生成的稳定标识，业务表里的 uid 就是它';
COMMENT ON COLUMN app_users.pass_hash  IS 'scrypt 派生值；绝不出现在任何接口响应里';


-- ============================================================================
-- 【Day 31】表 2：auth_tokens —— 登录令牌
-- ----------------------------------------------------------------------------
-- 为什么存 hash 而不是明文 token：
--   数据库快照/备份一旦外泄，明文 token 等于一把可以直接登录的钥匙；
--   存 sha256 之后，攻击者还得反过来破解（随机 32 字节，反不出来）。
--   校验时把请求头里的 token 算一遍 sha256 再查表，等价且安全。
--
-- 为什么不用 JWT（自签名）：JWT 无法撤销（只能等过期），退出登录要真正失效
--   就必须有黑名单，那就还是要一张表；不如一开始就用表，简单直白。
--
-- 过期：30 天。每次登录发新令牌，旧的不动（多设备可同时在线）；
--   退出登录只删**当前这一个**令牌，不影响手机上的另一个。
-- ============================================================================
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT        PRIMARY KEY,                               -- sha256(token)，hex，64 字符
  uid        TEXT        NOT NULL REFERENCES app_users(uid) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL                                   -- 过期行由接口层判掉（顺带清理）
);

CREATE INDEX IF NOT EXISTS auth_tokens_uid_idx ON auth_tokens (uid);

COMMENT ON TABLE  auth_tokens            IS '登录令牌（Day 31）：库里只存 sha256，明文只在登录响应里出现一次';
COMMENT ON COLUMN auth_tokens.token_hash IS 'sha256(明文 token)；前端持有明文，服务端只认这个哈希';
