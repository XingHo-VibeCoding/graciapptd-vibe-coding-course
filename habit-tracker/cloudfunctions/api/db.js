/**
 * 自律计划 · 数据访问层（db.js）—— Day 19 从 index.js 拆出来；Day 22 增补 update 管道与软删除
 * ---------------------------------------------------------------------------
 * 【这一层是什么】整个云函数里**唯一知道"数据库长什么样、怎么读写"的文件**：
 *   · 连接配置（函数环境变量 → REST 基址）
 *   · PostgREST 查询串的拼装（`uid=eq.xxx&order=sort.asc`）
 *   · 真正的 fetch 调用
 *   · PostgreSQL 错误码识别（23505 = 唯一键冲突）
 *   · 行映射：数据库列名（snake_case）→ 契约字段名（camelCase）
 *
 * 【为什么要拆】Day 19 的结构化重构。拆之前这些代码全在 index.js 里，和"取参数 / 校验 /
 *   拼响应"混在一个文件；拆之后上面那层（index.js）只做 HTTP 与业务规则，
 *   要数据就调本文件暴露的**业务语义函数**，例如：
 *       const items = await db.listCheckinsByDay(uid, '2026-10-01');
 *   而不再自己拼 `{ uid: 'eq.xxx', order: 'sort.asc' }` 这种数据库方言。
 *   好处：以后换数据库（改用 `pg` 驱动 / 换服务商 / 加缓存）只改这一个文件，路由层一行不用动。
 *   分层图见 TECH_DESIGN.md「二.1 分层结构」。
 *
 * 【零依赖】只用 Node 内置能力 + Node 18 自带的全局 fetch，不装任何 npm 包（含 `pg` 驱动）。
 *   数据库怎么读写？——走 CloudBase PostgreSQL 的 REST 接口
 *   （`https://<环境ID>.api.tcloudbasegateway.com/v1/rdb/rest/<表名>?<查询条件>`，PostgREST 风格：
 *     筛选 `列=eq.值`、取列 `select=`、排序 `order=`、条数 `limit=`）。
 *   这样云函数目录里连 node_modules 都不用。
 *   ⚠️ 要求运行环境 Node.js 18+（全局 fetch 是 18 才有的）。
 *
 * 【对外三层接口】
 *   ① 表级函数（index.js 只用这些；名字是业务语义，不是数据库方言）
 *        findPlanDay / listCheckinsByDay / listCheckins
 *        existsCheckinWithReqId / findCheckinByReqId / findCheckinByContent
 *        findLastSort / createCheckin
 *        ★ Day 22：findCheckinRowById / updateCheckin / softDeleteCheckin
 *   ② 通用管道（将来加新表时复用）
 *        select / insert / ★ Day 22：update
 *   ③ 小工具（自测与排查用）
 *        mapPlanDay / mapCheckin / isDuplicateError / dbConfig / pickTotal
 *
 * 【Day 22 的两个要点】
 *   · `update()` = PostgREST 的 PATCH：只改传进来的那几列，没传的列一动不动。
 *   · **软删除**：`softDeleteCheckin()` 不是一个"DELETE 语句"，而是 `update({ is_deleted: true })`。
 *     删除在本项目里是"打标记"，不是"抹掉行"——为什么这么设计见 api-contract.md §1.7 与 db/schema-3.sql。
 *     连带后果：所有**面向用户的读取**都要带上 `is_deleted = false`，否则删掉的东西还会冒出来。
 */

'use strict';

// ===========================================================================
// 一、连接配置（全部来自函数环境变量，不写进代码、不进仓库）
// ===========================================================================

/**
 * 取数据库连接配置。两个值都来自**函数环境变量**：
 *   TCB_ENV            —— 环境 ID（云函数运行时由 CloudBase 自动注入；也兼容 CLOUDBASE_ENV_ID / ENV_ID）
 *   CLOUDBASE_API_KEY  —— 环境 API Key（在控制台「环境 → API Key」或 `tcb env apikey` 创建）
 */
const dbConfig = () => {
  const envId = process.env.TCB_ENV || process.env.CLOUDBASE_ENV_ID || process.env.ENV_ID || '';
  const apiKey = process.env.CLOUDBASE_API_KEY || '';
  return {
    envId: envId,
    apiKey: apiKey,
    base: envId ? 'https://' + envId + '.api.tcloudbasegateway.com/v1/rdb/rest' : '',
  };
};

/**
 * 发请求前的两道检查；不满足就直接抛错（文案是给服务端日志看的，不会返给用户）。
 *   1) 配置齐不齐 —— 缺环境变量时错误要一眼看懂，而不是发一个必然 404 的请求
 *   2) 运行环境支不支持 —— 全局 fetch 是 Node 18 才有的
 */
const connection = () => {
  const cfg = dbConfig();
  if (!cfg.envId || !cfg.apiKey) {
    throw new Error('数据库未配置：缺少环境变量 TCB_ENV 或 CLOUDBASE_API_KEY');
  }
  if (typeof fetch !== 'function') {
    throw new Error('运行环境不支持全局 fetch，请把云函数运行环境设为 Node.js 18 及以上');
  }
  return cfg;
};

// ===========================================================================
// 二、通用管道：JS 对象 → PostgREST 查询串 → fetch（本文件是唯一碰 fetch 的地方）
// ===========================================================================

/** 从 Content-Range（形如 `0-7/8`）里解析总数；解析不出来就用本页行数兜底。 */
const pickTotal = (contentRange, fallback) => {
  if (!contentRange) return fallback;
  const after = String(contentRange).split('/')[1];
  const n = Number(after);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * 把查询对象拼成查询串，例如
 *   { uid: 'eq.seed-demo-user', date: 'eq.2026-10-01', select: 'id,text', order: 'sort.asc' }
 * → `uid=eq.seed-demo-user&date=eq.2026-10-01&select=id,text&order=sort.asc`
 *
 * ⚠️ 同一个列上要挂两个条件（区间查询 `date >= A 且 date <= B`）时，
 *    PostgREST 要的是**重复同名参数**，而 JS 对象的键不能重复 ——
 *    所以这里允许值是数组：`{ date: ['gte.A', 'lte.B'] }` → `date=gte.A&date=lte.B`（两个条件是 AND）。
 */
const buildSearch = (query) => {
  const search = new URLSearchParams();
  Object.keys(query).forEach((k) => {
    const v = query[k];
    if (v === undefined || v === null || v === '') return;
    (Array.isArray(v) ? v : [v]).forEach((one) => search.append(k, String(one)));
  });
  return search;
};

/**
 * 查一张表。
 * 返回 { rows, total }：
 *   rows  —— 数据行（已解析成 JS 对象）
 *   total —— 满足条件的总行数（靠 `Prefer: count=exact` + 响应头 Content-Range 拿到；
 *            拿不到就退回本页行数，前端仍然能工作，只是"还有没有下一页"不准）
 */
const select = async (table, query) => {
  const { apiKey, base } = connection();

  const search = buildSearch(query);
  const url = base + '/' + table + (search.toString() ? '?' + search.toString() : '');
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: 'Bearer ' + apiKey, // 服务端身份（service_role），不泄露给前端
      Accept: 'application/json',
      Prefer: 'count=exact',
    },
  });

  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (e) {
    throw new Error('数据库返回的不是合法 JSON（HTTP ' + res.status + '）：' + text.slice(0, 200));
  }

  if (!res.ok) {
    const detail = body && (body.message || body.error || body.details);
    throw new Error('数据库查询失败（HTTP ' + res.status + '）：' + (detail || text.slice(0, 200)));
  }

  const rows = Array.isArray(body) ? body : [];
  return { rows: rows, total: pickTotal(res.headers.get('content-range'), rows.length) };
};

/**
 * 往一张表插一行（PostgREST 的 POST 语义）。和 select 是同一套零依赖思路。
 *   · 请求体 = 要插入的列（对象），键名用**数据库列名**（snake_case）
 *   · Prefer: return=representation —— 让数据库把"刚插进去的那一行"回传，
 *     这样响应里能直接给出新 id，不用再查一次
 *   · resolution=ignore-duplicates? **不用**。我们的重复提交要靠报错拦住（409），
 *     静默忽略会让"重复提交"变成"看起来成功但其实没写"，前端无法分辨。
 *
 * 返回：插入后的那一行；网关没回传表示时返回 null（调用处会读回兜底）。
 * 失败时抛的错误对象上带 `pgCode`（PostgreSQL 的 SQLSTATE，如 '23505' 唯一冲突），
 * 供调用处区分"重复提交"与其它故障。
 */
const insert = async (table, row) => {
  const { apiKey, base } = connection();

  const res = await fetch(base + '/' + table, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });

  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (e) {
    body = null; // 插入失败的响应也可能不是 JSON，下面统一按状态码处理
  }

  if (!res.ok) {
    const detail = body && (body.message || body.details || body.error);
    const err = new Error('数据库写入失败（HTTP ' + res.status + '）：' + (detail || String(text).slice(0, 200)));
    err.pgCode = body && body.code ? String(body.code) : ''; // PostgREST 把 SQLSTATE 放在 code 里
    throw err;
  }

  return Array.isArray(body) && body.length ? body[0] : null;
};

/**
 * 改一张表里符合条件的行（PostgREST 的 PATCH 语义）—— Day 22 新增。
 *   · `query`：筛选条件（**一定要带 uid**，删除/修改的防越权全靠它）
 *   · `patch`：要改的列（键名用**数据库列名** snake_case）；**没出现在这里的列不会被碰**
 *   · Prefer: return=representation —— 让数据库把改完的整行回传，
 *     这样响应里能直接给出"改之后的值"，不用再查一次（也是"改完读回确认"这一步的替代）
 *
 * ⚠️ 为什么不做"先查再改"的两步式：两步之间别的请求可能插进来（并发），
 *    而 PATCH 的筛选条件本身就是原子生效的 —— 把条件写进语句里，比先查后改更安全。
 *
 * 返回：改完后的那些行（数组）；一行都没匹配到时返回 **空数组**（不是错误，
 *       调用处要自己判断"是不是要改的那条不存在/不是自己的"）。
 * 失败时抛的错误对象上带 `pgCode`（PostgreSQL SQLSTATE，如 '23514' 违反 CHECK 约束）。
 */
const update = async (table, query, patch) => {
  const { apiKey, base } = connection();

  const search = buildSearch(query);
  if (!search.toString()) {
    throw new Error('修改数据必须带筛选条件（拒绝无条件 UPDATE）');
  }

  const res = await fetch(base + '/' + table + '?' + search.toString(), {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(patch),
  });

  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (e) {
    body = null; // 失败响应也可能不是 JSON，下面统一按状态码处理
  }

  if (!res.ok) {
    const detail = body && (body.message || body.details || body.error);
    const err = new Error('数据库修改失败（HTTP ' + res.status + '）：' + (detail || String(text).slice(0, 200)));
    err.pgCode = body && body.code ? String(body.code) : '';
    throw err;
  }

  return Array.isArray(body) ? body : [];
};

/**
 * 真删一张表里符合条件的行（PostgREST 的 DELETE 语义）—— Day 29 新增。
 *
 * 为什么这次是"真删"而不是像 checkins 那样软删除：
 *   checkins 的软删除是课程要求的余力加练（删错了还能找回）；
 *   打卡删除的语义是"这个习惯我不要了，连同它的所有打卡记录一起消失"，
 *   留一堆孤儿日志既没用、又会在下次建同名习惯时被误当成历史记录。
 *   而且**只有 uid 对得上才删得掉**（筛选条件必带 uid），越权这一道照样在。
 *
 * ⚠️ 这里同样拒绝无条件 DELETE —— 少写一个条件就是"把全表删掉"。
 * 返回：被删掉的行（数组，可能为空 = 本来就没有这条）。
 */
const remove = async (table, query) => {
  const { apiKey, base } = connection();

  const search = buildSearch(query);
  if (!search.toString()) {
    throw new Error('删除数据必须带筛选条件（拒绝无条件 DELETE）');
  }

  const res = await fetch(base + '/' + table + '?' + search.toString(), {
    method: 'DELETE',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      Accept: 'application/json',
      Prefer: 'return=representation',
    },
  });

  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (e) {
    body = null;
  }

  if (!res.ok) {
    const detail = body && (body.message || body.details || body.error);
    const err = new Error('数据库删除失败（HTTP ' + res.status + '）：' + (detail || String(text).slice(0, 200)));
    err.pgCode = body && body.code ? String(body.code) : '';
    throw err;
  }

  return Array.isArray(body) ? body : [];
};

// ===========================================================================
// 三、行 → 契约形状的映射（数据库 snake_case → 契约 camelCase）
// ===========================================================================
// 放在数据访问层的原因：**列名本身就是数据库知识**。
// 映射放在这里，index.js 里就再也看不到 done_at / client_req_id 这种列名。

/** 时间戳列：数据库回 ISO 字符串，契约要毫秒数 */
const toMs = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Date.parse(v);
  return Number.isNaN(n) ? null : n;
};

/**
 * 写一张表：有就改、没有就插（PostgREST 的 upsert 语义）—— Day 29 新增。
 *
 * 为什么不能拿 update 凑：`update` 是 PATCH，行不存在时它只返回空数组，
 * "先查再改、查不到再插"两步之间又有并发窗口；`plan_days` 的主键是 (uid, date)，
 * 数据库天然知道"冲突了该合并"，把这件事交给它做才是原子的。
 *
 * `onConflict` 必须是**真实存在的唯一约束列**（如 `'uid,date'`），否则 PostgreSQL 会报错；
 * 传空则退化成普通插入（撞主键就抛 23505）。
 *
 * 单条与批量共用：`rows` 是对象就是一条，是数组就一次写多条（同一次请求、同一个事务）。
 */
const upsert = async (table, rows, onConflict) => {
  const { apiKey, base } = connection();

  const payload = Array.isArray(rows) ? rows : [rows];
  if (!payload.length) return [];

  const qs = onConflict ? '?on_conflict=' + encodeURIComponent(onConflict) : '';
  const res = await fetch(base + '/' + table + qs, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      // resolution=merge-duplicates = 撞唯一键时用请求里的值覆盖，而不是报错
      Prefer: 'return=representation,resolution=merge-duplicates',
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (e) {
    body = null;
  }

  if (!res.ok) {
    const detail = body && (body.message || body.details || body.error);
    const err = new Error('数据库写入失败（HTTP ' + res.status + '）：' + (detail || String(text).slice(0, 200)));
    err.pgCode = body && body.code ? String(body.code) : '';
    throw err;
  }

  return Array.isArray(body) ? body : [];
};

/** plan_days 一行 → 契约里的 planDay 对象 */
const mapPlanDay = (r) => ({
  date: r.date,
  mood: r.mood === undefined ? null : r.mood,
  createdAt: toMs(r.created_at),
  updatedAt: toMs(r.updated_at),
});

/** checkins 一行 → 契约里的打卡项对象 */
const mapCheckin = (r) => ({
  id: r.id === null || r.id === undefined ? null : Number(r.id),
  date: r.date,
  text: r.text,
  time: r.time === undefined ? null : r.time,
  quad: r.quad === undefined ? null : r.quad,
  done: r.done === true,
  doneAt: toMs(r.done_at),
  sort: r.sort === null || r.sort === undefined ? 0 : Number(r.sort),
});

/**
 * habits 一行 → 契约里的打卡定义对象（Day 29）。
 * 契约里 id 就是 **client_id**（前端本机那个 id），服务端自增 id 不出现在响应里 ——
 * 这样前端拿到的形状和它本机存的完全一致，一行映射都不用写。
 */
const mapHabit = (r) => ({
  id: r.client_id,
  name: r.name,
  perDay: r.per_day === null || r.per_day === undefined ? 1 : Number(r.per_day),
  time: r.time === undefined ? null : r.time,
  quad: r.quad === undefined ? null : r.quad,
  start: r.start_date,
  end: r.end_date === undefined ? null : r.end_date,
  createdAt: toMs(r.created_at),
  updatedAt: toMs(r.updated_at),
});

/** 取列清单（放这里而不是路由层：「这张表有哪些列」是数据库知识） */
const CHECKIN_COLS = 'id,date,text,time,quad,done,done_at,sort';
const PLANDAY_COLS = 'date,mood,created_at,updated_at';
/** habits 的列（Day 29）：注意取的是 client_id 而不是自增 id —— 接口只用 client_id */
const HABIT_COLS = 'client_id,name,per_day,time,quad,start_date,end_date,created_at,updated_at';
/**
 * Day 22：查"这一行是谁的、删过没"时要用的列。
 * 比 CHECKIN_COLS 多了 `uid` 与 `is_deleted` —— 这两列**只给服务端判断用**，
 * 绝不能出现在契约响应里（`mapCheckin` 的产出里就没有它们，前端永远看不到 uid）。
 */
const CHECKIN_OWNER_COLS = 'id,uid,date,is_deleted';

/**
 * 软删除的过滤条件（Day 22）：面向用户的读取一律带上它。
 * 写成常量而不是到处手打，是为了"漏加一处"这种事一眼可查 —— 全文件搜索 `NOT_DELETED` 即可。
 */
const NOT_DELETED = { is_deleted: 'is.false' };

/** 是不是"唯一键冲突"（PostgreSQL SQLSTATE 23505）—— 并发下的重复提交靠它识别 */
const isDuplicateError = (err) => Boolean(err && err.pgCode === '23505');

// ===========================================================================
// 四、表级访问（index.js 只用这一层；函数名是业务语义）
// ===========================================================================

// —— plan_days ——

/**
 * 取某一天的那一条记录。
 * 返回契约形状的 planDay 对象；这天还没建过记录时返回 **null**（不是错误，前端照常渲染空列表）。
 */
const findPlanDay = async (uid, date) => {
  const res = await select('plan_days', {
    uid: 'eq.' + uid,
    date: 'eq.' + date,
    select: PLANDAY_COLS,
    limit: 1,
  });
  return res.rows.length ? mapPlanDay(res.rows[0]) : null;
};

/**
 * 写入某天的心情（Day 29 十三轮）：upsert，已有就以新值覆盖（A9 以最后一次为准）。
 * 返回契约形状的 planDay；写失败抛错，由路由层兜成 500。
 */
const savePlanDayMood = async (uid, date, mood) => {
  const rows = await upsert('plan_days', {
    uid: uid,
    date: date,
    mood: mood,
    updated_at: new Date().toISOString(),   // 覆盖更新也要刷新时间，否则 GET /api/day 的 updatedAt 会一直停在第一次
  }, 'uid,date');
  return rows.length ? mapPlanDay(rows[0]) : null;
};

/**
 * 批量写入本机历史心情（Day 29 十三轮，一次性迁移用）。
 * 一次请求写多行 = 数据库在一个事务里处理，不会出现"搬了一半"。
 * 返回真正写进去的行数。
 */
const savePlanDayMoods = async (uid, items) => {
  const now = new Date().toISOString();
  const rows = await upsert('plan_days', items.map((it) => ({
    uid: uid,
    date: it.date,
    mood: it.mood,
    updated_at: now,
  })), 'uid,date');
  return rows.length;
};

// —— checkins ——

/**
 * 取某一天的全部打卡项（不分页），已按「当天排序位 → id」升序。
 * 返回：契约形状的数组（可能就是空数组）。
 */
const listCheckinsByDay = async (uid, date) => {
  const res = await select('checkins', Object.assign({
    uid: 'eq.' + uid,
    date: 'eq.' + date,
    select: CHECKIN_COLS,
    order: 'sort.asc,id.asc',
  }, NOT_DELETED));                       // Day 22：已删除的不返回（否则删掉的东西又冒出来）
  return res.rows.map(mapCheckin);
};

/**
 * 列表查询：支持单日 / 区间 / 只看已完成或未完成 / 条数上限。
 * filter: { date?, from?, to?, done?: 'true'|'false', limit? }
 * 返回：{ total, items }（total = 满足条件的总条数，items = 本次返回的那些）
 *
 * 排序固定为「日期升序 → 当天排序位 → id」，保证翻页不漏不重。
 */
const listCheckins = async (uid, filter) => {
  const f = filter || {};
  const query = {
    uid: 'eq.' + uid,
    select: CHECKIN_COLS,
    order: 'date.asc,sort.asc,id.asc',
    limit: f.limit,
    is_deleted: 'is.false',        // Day 22：已删除的不返回；total 也不含已删行
  };
  if (f.date) {
    query.date = 'eq.' + f.date;
  } else if (f.from && f.to) {
    query.date = ['gte.' + f.from, 'lte.' + f.to]; // 同列两个条件 = 区间
  } else if (f.from) {
    query.date = 'gte.' + f.from;
  } else if (f.to) {
    query.date = 'lte.' + f.to;
  }
  if (f.done !== undefined) query.done = 'is.' + f.done;

  const res = await select('checkins', query);
  return { total: res.total, items: res.rows.map(mapCheckin) };
};

/**
 * 这个幂等键（clientReqId）在这位用户名下是不是已经用过了？
 * 只取 id 一列、只要一行 —— 预检只关心"有没有"，不需要把整行读回来。
 *
 * Day 22 注意：这里**故意不过滤已删除的行**（下面的 findCheckinByReqId 同理）。
 *   因为数据库唯一索引 `checkins_uid_reqid_uniq` **也覆盖已删行** ——
 *   预检的"看到的东西"必须和数据库约束的"拦的范围"一致，否则预检放过、
 *   数据库再拦，用户拿到的道理是一样的 409，但日志会多一层"怎么回事"的困惑。
 *   语义上也对：把一条删掉再加同样的动作，本来就是两个动作、两个 uuid，
 *   若客户端真复用了同一个 uuid，那确实是"同一个动作重发"。
 */
const existsCheckinWithReqId = async (uid, reqId) => {
  const res = await select('checkins', {
    uid: 'eq.' + uid,
    client_req_id: 'eq.' + reqId,
    select: 'id',
    limit: 1,
  });
  return res.rows.length > 0;
};

/** 按幂等键取那一行（写入后读回确认用）；没有则 null */
const findCheckinByReqId = async (uid, reqId) => {
  const res = await select('checkins', {
    uid: 'eq.' + uid,
    client_req_id: 'eq.' + reqId,
    select: CHECKIN_COLS,
    limit: 1,
  });
  return res.rows.length ? mapCheckin(res.rows[0]) : null;
};

/** 没带幂等键时的读回兜底：按「同一天 + 同内容」找最新那一条；没有则 null */
const findCheckinByContent = async (uid, date, text) => {
  const res = await select('checkins', {
    uid: 'eq.' + uid,
    date: 'eq.' + date,
    text: 'eq.' + text,
    select: CHECKIN_COLS,
    order: 'id.desc',
    limit: 1,
  });
  return res.rows.length ? mapCheckin(res.rows[0]) : null;
};

/**
 * 某天现有的最大排序位；这天一条都没有时返回 **null**。
 * （为什么返回 null 而不是 0：路由层要能区分"这天是空的"，新条目的 sort 才算得对。）
 *
 * Day 22 注意：这里**故意不过滤已删除的行**（与其它读取相反）。
 *   理由：已删行的 `sort` 还占着那个位置，若跳过它，新建的条目会拿到同一个 sort，
 *   同一天内两条 sort 相同就只能靠 id 兜底排序 —— 顺序会变得"看着随机"。
 *   宁可让 sort 单调增长，也不要排序撞车。（契约 §1.7 记了这条）
 */
const findLastSort = async (uid, date) => {
  const res = await select('checkins', {
    uid: 'eq.' + uid,
    date: 'eq.' + date,
    select: 'sort',
    order: 'sort.desc',
    limit: 1,
  });
  return res.rows.length ? Number(res.rows[0].sort) : null;
};

/**
 * 新建一条打卡项，返回契约形状的那一行（网关没回传表示时返回 null，由调用处读回兜底）。
 * 入参用**业务字段名**，数据库列名（uid / client_req_id）由本层负责拼出来。
 *
 * 会抛错，调用处要 catch：
 *   · 唯一键冲突时 err.pgCode === '23505'（重复提交，用 isDuplicateError 判断）
 *   · 其它故障是普通 Error
 */
const createCheckin = async (fields) => {
  const row = {
    uid: fields.uid,
    date: fields.date,
    text: fields.text,
    time: fields.time,
    quad: fields.quad,
    done: false,          // 新建的一律是"没完成"，打勾是以后的 PATCH 接口的活
    sort: fields.sort,
  };
  if (fields.reqId) row.client_req_id = fields.reqId; // 没传幂等键就不写这一列（保持 NULL）

  const inserted = await insert('checkins', row);
  return inserted ? mapCheckin(inserted) : null;
};

// —— Day 22：改与删（PATCH / DELETE 接口的数据访问） ——

/**
 * 按 id 查"这一行是谁的、删过没"——**刻意不按 uid 过滤，也刻意不过滤已删除**。
 *
 * 为什么不能一上来就 `WHERE id=? AND uid=?`：
 *   那样"别人的数据"永远只会得到"查不到"，路由层就没法把
 *   **404（没这条）** 和 **403（有这条但不是你的）** 分开 —— 越权尝试就永远不会被发现、也测不出来。
 *   所以这里要"先看见整行"，由路由层判断归属（契约 §三 的判定顺序第 3–5 步）。
 *
 * 返回：{ id, uid, date, is_deleted } 或 **null**（没有这一行）。
 * 《注意》返回的 uid 只给服务端比对用，绝不进响应（契约 §1.4）。
 */
const findCheckinRowById = async (id) => {
  const res = await select('checkins', {
    id: 'eq.' + id,
    select: CHECKIN_OWNER_COLS,
    limit: 1,
  });
  return res.rows.length ? res.rows[0] : null;
};

/**
 * 改一条打卡项，返回改完之后的契约对象（改完没匹配到行时返回 null）。
 *
 * @param uid   当前身份（作为筛选条件的一部分 = 只改自己的数据）
 * @param id    打卡项 id
 * @param patch 业务字段：{ done?, text?, time?, quad? }（路由层已校验过值与格式）
 *
 * 两个容易写错的地方：
 *   · `done` 与 `done_at` **必须一起改**：数据库约束 `checkins_done_consistent` 要求
 *     "打勾必有完成时刻、没打勾必无完成时刻"，只改一个必然被 CHECK 约束拒绝（SQLSTATE 23514）。
 *   · `time` / `quad` 传 `null` 是"清空"，语义与"没传这个字段"完全不同 ——
 *     所以路由层用 `hasOwnProperty` 判断"有没有传"，本函数只负责把 null 原样写下去。
 */
const updateCheckin = async (uid, id, patch) => {
  const row = {};
  if (patch.done !== undefined) {
    row.done = patch.done;
    row.done_at = patch.done ? new Date().toISOString() : null;
  }
  if (patch.text !== undefined) row.text = patch.text;
  if (patch.time !== undefined) row.time = patch.time;
  if (patch.quad !== undefined) row.quad = patch.quad;

  const rows = await update('checkins', { id: 'eq.' + id, uid: 'eq.' + uid }, row);
  return rows.length ? mapCheckin(rows[0]) : null;
};

/**
 * 软删除一条打卡项（Day 22）：把 `is_deleted` 置 true，**行还在库里**。
 * 为什么不是 `DELETE` 语句 —— 见 api-contract.md §1.7 与 db/schema-3.sql 的开头。
 *
 * 返回 true = 改到了（该行存在、是自己的、这次标记成功）；false = 一行都没匹配到。
 * 注意：重复删同一条，第二次会返回 **false**（筛选条件里带 `is_deleted = false`，
 * 已经删过的行不再匹配）—— 路由层不会走到这里，因为它在那之前就按 404 返回了。
 */
const softDeleteCheckin = async (uid, id) => {
  const rows = await update('checkins', {
    id: 'eq.' + id,
    uid: 'eq.' + uid,
    is_deleted: 'is.false',          // 只标记"还没删过"的那一行（重复删不产生第二次写入）
  }, { is_deleted: true });
  return rows.length > 0;
};

// —— habits / habit_logs（Day 29：打卡上云）——

/**
 * 取一个人的全部打卡定义（不分页），按创建时间升序。
 * 打卡数量天然有限（几十条量级），不做分页 —— 分页反而会让"今天的清单"拼不齐。
 */
const listHabits = async (uid) => {
  const res = await select('habits', {
    uid: 'eq.' + uid,
    select: HABIT_COLS,
    order: 'created_at.asc,client_id.asc',    // 时间相同再按 id 兜底，顺序稳定
    limit: 500,
  });
  return res.rows.map(mapHabit);
};

/**
 * 取某一天的全部打卡次数，返回 `{ [clientId]: count }`（前端本机就是这个形状）。
 * 只返回 count >= 1 的行（接口在次数减到 0 时会直接删行，这里再兜一层）。
 */
const listHabitLogsByDate = async (uid, date) => {
  const res = await select('habit_logs', {
    uid: 'eq.' + uid,
    date: 'eq.' + date,
    select: 'client_id,count',
    limit: 500,
  });
  const out = {};
  res.rows.forEach((r) => {
    const n = Number(r.count) || 0;
    if (n > 0) out[r.client_id] = n;
  });
  return out;
};

/**
 * 新建 / 修改一条打卡定义（Day 29）：upsert，撞 (uid, client_id) 就覆盖。
 * 前端"新建"和"编辑"走同一个接口 —— 本机 id 是稳定的，两种情况都只是"把这行写成这样"。
 * 返回契约形状的打卡定义；写失败抛错，由路由层兜成 500。
 */
const saveHabit = async (uid, h) => {
  const rows = await upsert('habits', {
    uid: uid,
    client_id: h.id,
    name: h.name,
    per_day: h.perDay,
    time: h.time,
    quad: h.quad,
    start_date: h.start,
    end_date: h.end,
    updated_at: new Date().toISOString(),
  }, 'uid,client_id');
  return rows.length ? mapHabit(rows[0]) : null;
};

/**
 * 删除一条打卡定义**及其全部打卡记录**（Day 29）。
 * 顺序：先删日志、再删定义 —— 反过来的话中途失败会留下查不到主人的孤儿日志。
 * 返回被删掉的打卡定义条数（0 = 本来就没有这条，或不是这个人的）。
 */
const deleteHabit = async (uid, clientId) => {
  await remove('habit_logs', { uid: 'eq.' + uid, client_id: 'eq.' + clientId });
  const rows = await remove('habits', { uid: 'eq.' + uid, client_id: 'eq.' + clientId });
  return rows.length;
};

/**
 * 写某一条打卡在某一天打了多少次（Day 29）。
 *   count >= 1 → upsert（同一天重复点 = 覆盖次数，不是新增一行）
 *   count <= 0 → 直接删行（"撤回"不留 count=0 的垃圾行）
 * 返回写入后的次数（删行时是 0）。
 */
const saveHabitLog = async (uid, clientId, date, count) => {
  if (count <= 0) {
    await remove('habit_logs', {
      uid: 'eq.' + uid, client_id: 'eq.' + clientId, date: 'eq.' + date,
    });
    return 0;
  }
  const rows = await upsert('habit_logs', {
    uid: uid,
    client_id: clientId,
    date: date,
    count: count,
    updated_at: new Date().toISOString(),
  }, 'uid,client_id,date');
  return rows.length ? Number(rows[0].count) : count;
};

/**
 * 批量写入本机已有的打卡定义（Day 29 一次性迁移用）。
 * 一次请求写多行 = 数据库在一个事务里处理；重发安全（走 upsert 合并）。
 * 返回真正写进去的行数。
 */
const saveHabitsBulk = async (uid, items) => {
  const now = new Date().toISOString();
  const rows = await upsert('habits', items.map((h) => ({
    uid: uid,
    client_id: h.id,
    name: h.name,
    per_day: h.perDay,
    time: h.time,
    quad: h.quad,
    start_date: h.start,
    end_date: h.end,
    updated_at: now,
  })), 'uid,client_id');
  return rows.length;
};

/**
 * 批量写入本机已有的打卡次数（Day 29 一次性迁移用）。
 * 同批里同 (client_id, date) 必须**先去重**再进来 ——
 * PostgREST 的 upsert 不允许一条语句里两次影响同一行（会报 21000）。
 */
const saveHabitLogsBulk = async (uid, items) => {
  const now = new Date().toISOString();
  const rows = await upsert('habit_logs', items.map((it) => ({
    uid: uid,
    client_id: it.id,
    date: it.date,
    count: it.count,
    updated_at: now,
  })), 'uid,client_id,date');
  return rows.length;
};

// ===========================================================================
// 四、身份与总览（Day 31 多用户）
// ===========================================================================
// 为什么身份也放在这一层：账号、令牌都是**表**，读写它们和读写待办没有本质区别。
// index.js 只该出现「用户名对不对、令牌过期没」这种业务判断，不该出现 table 名。
//
// 安全红线（三处都要守住）：
//   ① 响应里**永不出现** pass_hash / pass_salt —— mapUser 只挑三个字段；
//   ② 令牌只存 sha256，明文仅在登录/注册响应里出现一次；
//   ③ 「谁是管理员」由库里的 role 决定，不由请求参数决定。

/** 账号对外形状：只出不敏感的三样（uid 也不给前端，用户名足够认人） */
const mapUser = (r) => ({
  uid: r.uid,
  username: r.username,
  role: r.role,
});

/** 库里共几个账号 —— 用来判定"第一个注册者当管理员" */
const countUsers = async () => {
  const res = await select('app_users', { select: 'uid', limit: 1 });
  // total 是 Content-Range 里的真实总数（不是本页行数）；拿不到就退回本页行数
  return Number.isFinite(res.total) ? res.total : res.rows.length;
};

/**
 * 按用户名查（大小写不敏感）；查不到返回 null。
 * 为什么查 `username_lc` 而不是 `lower(username)`：PostgREST 的过滤只认**列名**，
 * 表达式过滤会被数据库回 400（实测踩过：注册接口 500，日志里是"failed to parse filter"）。
 * 所以注册时把 trim+lower 的结果写进 `username_lc`，唯一索引也建在这一列上。
 */
const findUserByName = async (username) => {
  const res = await select('app_users', {
    username_lc: 'eq.' + String(username).trim().toLowerCase(),
    select: 'uid,username,pass_hash,pass_salt,role',
    limit: 1,
  });
  return res.rows.length ? res.rows[0] : null;
};

/** 按 uid 查（令牌换身份后用）；查不到返回 null */
const findUserByUid = async (uid) => {
  const res = await select('app_users', {
    uid: 'eq.' + uid,
    select: 'uid,username,pass_hash,pass_salt,role',
    limit: 1,
  });
  return res.rows.length ? res.rows[0] : null;
};

/** 建账号（uid / hash / salt 都由上层算好） */
const createUser = async (row) => {
  const out = await insert('app_users', {
    uid: row.uid,
    username: row.username,
    username_lc: String(row.username).trim().toLowerCase(),
    pass_hash: row.passHash,
    pass_salt: row.passSalt,
    role: row.role,
  });
  return out && out.length ? out[0] : null;
};

/** 全部账号（总览用，按注册时间正序） */
const listUsers = async () => {
  const res = await select('app_users', {
    select: 'uid,username,role,last_seen_at,created_at',
    order: 'created_at.asc',
    limit: 200,
  });
  return res.rows;
};

/** 全部令牌（登录时顺手清过期行，避免表无限增长） */
const listAllTokens = async () => {
  const res = await select('auth_tokens', { select: 'token_hash,uid,expires_at', limit: 500 });
  return res.rows;
};

/** 发令牌：库里只落 sha256，明文由上层返回给前端且不再保存 */
const saveToken = async (row) => {
  const out = await upsert('auth_tokens', {
    token_hash: row.tokenHash,
    uid: row.uid,
    expires_at: row.expiresAt,
  }, 'token_hash');
  return out && out.length ? out[0] : null;
};

/** 用 sha256 找令牌；过期与否交给上层判断（这一层只认数据） */
const findToken = async (tokenHash) => {
  const res = await select('auth_tokens', {
    token_hash: 'eq.' + tokenHash,
    select: 'token_hash,uid,expires_at',
    limit: 1,
  });
  return res.rows.length ? res.rows[0] : null;
};

/** 删一个令牌（退出登录只影响当前设备） */
const deleteToken = async (tokenHash) => {
  const rows = await remove('auth_tokens', { token_hash: 'eq.' + tokenHash });
  return rows.length;
};

/** 记一下"这个人刚来过"（总览的 lastSeenAt） */
const touchUser = async (uid) => {
  await update('app_users', { uid: 'eq.' + uid }, { last_seen_at: new Date().toISOString() });
};

/**
 * 总览的三张原始表（不在这一层做聚合）。
 * 为什么按"整天 / 全部"拉而不按 uid 过滤：这一层拿不到账号列表里的 uid 集合，
 * 拼 `in.(a,b)` 反而更绕；当天行数最多是「人数 × 每人十几条」，一次拉全更简单。
 */
const overviewRows = async (date) => {
  const [checkins, habits, logs] = await Promise.all([
    select('checkins', { date: 'eq.' + date, select: 'uid,done,is_deleted', limit: 2000 }),
    select('habits', { select: 'uid', limit: 2000 }),
    select('habit_logs', { date: 'eq.' + date, select: 'uid,count', limit: 2000 }),
  ]);
  return { checkins: checkins.rows, habits: habits.rows, logs: logs.rows };
};

// ===========================================================================
// 五、导出
// ===========================================================================

module.exports = {
  // ① 表级函数
  findPlanDay: findPlanDay,
  // ① 表级函数 · Day 29 增补（心情上云）
  savePlanDayMood: savePlanDayMood,
  savePlanDayMoods: savePlanDayMoods,
  listCheckinsByDay: listCheckinsByDay,
  listCheckins: listCheckins,
  existsCheckinWithReqId: existsCheckinWithReqId,
  findCheckinByReqId: findCheckinByReqId,
  findCheckinByContent: findCheckinByContent,
  findLastSort: findLastSort,
  createCheckin: createCheckin,
  // ① 表级函数 · Day 22 增补（改与删）
  findCheckinRowById: findCheckinRowById,
  updateCheckin: updateCheckin,
  softDeleteCheckin: softDeleteCheckin,
  // ① 表级函数 · Day 29 增补（打卡上云：定义 + 每日次数）
  listHabits: listHabits,
  listHabitLogsByDate: listHabitLogsByDate,
  saveHabit: saveHabit,
  deleteHabit: deleteHabit,
  saveHabitLog: saveHabitLog,
  saveHabitsBulk: saveHabitsBulk,
  saveHabitLogsBulk: saveHabitLogsBulk,
  // ① 表级函数 · Day 31 增补（多用户：账号 + 令牌 + 总览聚合）
  countUsers: countUsers,
  createUser: createUser,
  findUserByName: findUserByName,
  findUserByUid: findUserByUid,
  listUsers: listUsers,
  listAllTokens: listAllTokens,
  saveToken: saveToken,
  findToken: findToken,
  deleteToken: deleteToken,
  touchUser: touchUser,
  overviewRows: overviewRows,
  // ② 通用管道
  select: select,
  insert: insert,
  update: update,
  upsert: upsert,
  remove: remove,
  // ③ 小工具
  mapPlanDay: mapPlanDay,
  mapCheckin: mapCheckin,
  mapHabit: mapHabit,
  isDuplicateError: isDuplicateError,
  dbConfig: dbConfig,
  pickTotal: pickTotal,
};
