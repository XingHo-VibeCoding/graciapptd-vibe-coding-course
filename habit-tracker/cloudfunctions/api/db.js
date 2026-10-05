/**
 * 自律计划 · 数据访问层（db.js）—— Day 19 从 index.js 拆出来
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
 *   ② 通用管道（将来加新表时复用）
 *        select / insert
 *   ③ 小工具（自测与排查用）
 *        mapPlanDay / mapCheckin / isDuplicateError / dbConfig / pickTotal
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

/** 取列清单（放这里而不是路由层：「这张表有哪些列」是数据库知识） */
const CHECKIN_COLS = 'id,date,text,time,quad,done,done_at,sort';
const PLANDAY_COLS = 'date,mood,created_at,updated_at';

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

// —— checkins ——

/**
 * 取某一天的全部打卡项（不分页），已按「当天排序位 → id」升序。
 * 返回：契约形状的数组（可能就是空数组）。
 */
const listCheckinsByDay = async (uid, date) => {
  const res = await select('checkins', {
    uid: 'eq.' + uid,
    date: 'eq.' + date,
    select: CHECKIN_COLS,
    order: 'sort.asc,id.asc',
  });
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

module.exports = {
  // ① 表级函数
  findPlanDay: findPlanDay,
  listCheckinsByDay: listCheckinsByDay,
  listCheckins: listCheckins,
  existsCheckinWithReqId: existsCheckinWithReqId,
  findCheckinByReqId: findCheckinByReqId,
  findCheckinByContent: findCheckinByContent,
  findLastSort: findLastSort,
  createCheckin: createCheckin,
  // ② 通用管道
  select: select,
  insert: insert,
  // ③ 小工具
  mapPlanDay: mapPlanDay,
  mapCheckin: mapCheckin,
  isDuplicateError: isDuplicateError,
  dbConfig: dbConfig,
  pickTotal: pickTotal,
};
