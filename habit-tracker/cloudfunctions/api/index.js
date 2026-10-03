/**
 * 自律计划 · 云函数 api（Day 15 建立 v0.1.0 → Day 17 v0.2.0）
 * ---------------------------------------------------------------------------
 * 这个函数是「前端的唯一后端入口」：所有接口都从这里进，内部再按路径分发给具体处理函数。
 * 为什么一个函数承载所有接口，而不是一个接口一个函数？
 *   → TECH_DESIGN.md 四、API 列表 就是这么定的：部署一次、日志一处、鉴权一处，后面加接口只加路由。
 *
 * 接口进度：
 *   Day 15  GET /api/health        服务健康检查（不读库）
 *   Day 17  GET /api/day           今天页首屏合并读取（plan_days + checkins）
 *   Day 17  GET /api/checkins      打卡项列表读取（支持单日/区间/完成状态/条数限制）
 *   Day 18+ 写入接口与其余读取接口，按 api-contract.md 逐个加。
 *
 * 【零依赖】只用 Node 内置能力 + Node 18 自带的全局 fetch，不装任何 npm 包。
 *   数据库怎么读？——不装 `pg` 驱动，改走 CloudBase 的 PostgreSQL REST 接口
 *   （`https://<环境ID>.api.tcloudbasegateway.com/v1/rdb/rest/<表名>?<查询条件>`，
 *     PostgREST 风格：筛选写 `列=eq.值`，取列写 `select=`，排序写 `order=`）。
 *   这样云函数目录里连 node_modules 都不用，控制台粘贴即可部署。
 *   ⚠️ 要求运行环境 Node.js 18+（全局 fetch 是 18 才有的）。
 *
 * 【身份从哪来】按契约 1.4，前端永远不许明传 uid：
 *   Day 17 还没有接匿名登录，所以 uid 依次取：
 *     1) context.userInfo.uid —— 平台注入的登录身份（配好匿名登录后自动生效，Day 18+）
 *     2) process.env.DEMO_UID —— 服务端配置的演示身份（今天靠它做真库验证，绝不来自请求参数）
 *   两个都没有 → 按契约回 401。
 */

// —— 服务身份：写进健康检查响应里，用来确认"公网地址返回的是我自己的服务" ——
const SERVICE = 'Self discipline plan';
const VERSION = '0.2.0';

/**
 * 业务接口的统一响应形状（见 api-contract.md 1.2）：
 *   无论成功失败，HTTP 状态码一律 200，业务结果看 code。
 *   这样前端只需要一套判断逻辑：code === 0 成功，否则读 message 直接展示。
 *
 * ⚠️ 注意：健康检查 /api/health 是**唯一例外**，不走这个信封（它没有业务语义），
 *    直接返回扁平对象 { ok, service }，见下方 routes。
 *
 * @param {number} code    0 = 成功；非 0 = 失败（错误码表见 api-contract.md 1.3）
 * @param {string} message 中文文案，可直接展示给用户
 * @param {*}      data    成功时的业务数据；失败或没有数据时传 null
 */
const reply = (code, message, data) => ({
  code: code,
  message: message,
  data: data === undefined ? null : data,
});

/**
 * 从触发事件里取出 HTTP 方法。
 * HTTP 访问服务触发时 event.httpMethod 有值；直接从控制台"测试"按钮调用时可能没有，默认当 GET。
 */
const pickMethod = (event) => String(event.httpMethod || event.method || 'GET').toUpperCase();

/**
 * 从触发事件里取出请求路径。
 * 不同触发方式给到的字段名不一样（path / pathname / rawPath），所以三个都试一遍。
 * 再做两步清洗：
 *   1) 去掉查询串（?a=1）和末尾多余的斜杠，让 /api/health 和 /api/health/ 都能命中；
 *   2) 如果平台把 /api 前缀剥掉了（只给到 /health），自动补回来。
 */
const pickPath = (event) => {
  let path = String(event.path || event.pathname || event.rawPath || '/');
  path = path.split('?')[0];
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (path === '' || path === '/') return '/api/health'; // 根路径直接回健康检查，方便在控制台点一下就能测
  if (!path.startsWith('/api')) path = '/api' + (path.startsWith('/') ? path : '/' + path);
  return path;
};

/**
 * 从触发事件里取出查询参数（query string），统一成普通对象。
 * HTTP 访问服务会给 event.queryStringParameters；控制台测试可能给 event.query。
 */
const pickQuery = (event) => {
  const q = event.queryStringParameters || event.query || {};
  const out = {};
  Object.keys(q).forEach((k) => {
    const v = q[k];
    if (v === undefined || v === null || v === '') return; // 空串当作没传，避免 date= 被当成非法日期
    out[k] = String(Array.isArray(v) ? v[0] : v);
  });
  return out;
};

// ===========================================================================
// 一、身份：同一个人 + 同一天，是全部查询的前提
// ===========================================================================

/**
 * 取当前身份 uid。见文件头「身份从哪来」。
 * 注意：**永远不从请求参数里取 uid**（契约 1.4 的第一道闸）。
 */
const resolveUid = (context) => {
  const fromAuth = (context && context.userInfo && context.userInfo.uid) || '';
  if (fromAuth) return String(fromAuth);
  return String(process.env.DEMO_UID || '');
};

// ===========================================================================
// 二、数据库：CloudBase PostgreSQL 的 REST 接口（零依赖，用全局 fetch）
// ===========================================================================

/**
 * 取数据库连接配置。全部来自**函数环境变量**，不写进代码、不进仓库：
 *   TCB_ENV            —— 环境 ID（云函数运行时由 CloudBase 自动注入；也兼容手动配 CLOUDBASE_ENV_ID / ENV_ID）
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
 * 查一张表。零依赖的关键就在这 20 行：
 *   query 里的键值对直接拼成 PostgREST 查询串，例如
 *     { uid: 'eq.seed-demo-user', date: 'eq.2026-10-01', select: 'id,text', order: 'sort.asc' }
 *   会请求 `.../rest/checkins?uid=eq.seed-demo-user&date=eq.2026-10-01&select=id,text&order=sort.asc`
 *
 *   ⚠️ 同一个列上要挂两个条件（区间查询 `date >= A 且 date <= B`）时，
 *      PostgREST 要的是**重复同名参数**，而 JS 对象的键不能重复——
 *      所以这里允许值是数组：`{ date: ['gte.A', 'lte.B'] }` → `date=gte.A&date=lte.B`（两个条件是 AND）。
 *
 * 返回 { rows, total }：
 *   rows  —— 数据行（已解析成 JS 对象）
 *   total —— 满足条件的总行数（靠 `Prefer: count=exact` + 响应头 Content-Range 拿到；
 *            拿不到就退回本页行数，前端仍然能工作，只是"还有没有下一页"不准）
 */
const pgSelect = async (table, query) => {
  const { envId, apiKey, base } = dbConfig();
  if (!envId || !apiKey) {
    throw new Error('数据库未配置：缺少环境变量 TCB_ENV 或 CLOUDBASE_API_KEY');
  }
  if (typeof fetch !== 'function') {
    throw new Error('运行环境不支持全局 fetch，请把云函数运行环境设为 Node.js 18 及以上');
  }

  const search = new URLSearchParams();
  Object.keys(query).forEach((k) => {
    const v = query[k];
    if (v === undefined || v === null || v === '') return;
    // 数组 = 同一列多个条件，重复拼接（见上方说明）
    (Array.isArray(v) ? v : [v]).forEach((one) => search.append(k, String(one)));
  });

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

/** 从 Content-Range（形如 `0-7/8`）里解析总数；解析不出来就用本页行数兜底。 */
const pickTotal = (contentRange, fallback) => {
  if (!contentRange) return fallback;
  const after = String(contentRange).split('/')[1];
  const n = Number(after);
  return Number.isFinite(n) ? n : fallback;
};

// ===========================================================================
// 三、行 → 接口形状的映射（数据库 snake_case → 契约 camelCase）
// ===========================================================================

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

const CHECKIN_COLS = 'id,date,text,time,quad,done,done_at,sort';
const PLANDAY_COLS = 'date,mood,created_at,updated_at';

// ===========================================================================
// 四、参数校验（前端的错要早点挡住，别让它变成一条奇怪的 SQL）
// ===========================================================================

/** 日期必须是 YYYY-MM-DD 且真的存在（挡住 2026-02-30 这种） */
const isDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/** 服务端"今天"：按东八区算，避免服务器在别的时区把日期算差一天 */
const todayLocal = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

// ===========================================================================
// 五、接口实现
// ===========================================================================

/**
 * GET /api/day?date=YYYY-MM-DD —— 今天页首屏合并读取（契约 4.1）
 *
 * 一次请求把"这一天"要的东西全取回：plan_days 那一条 + 当天的打卡项列表。
 * planDay 为 null 表示这天还没建过记录，**不是错误**，前端照常渲染空列表。
 */
const getDay = async (event, context) => {
  const uid = resolveUid(context);
  if (!uid) return reply(401, '登录状态失效，请刷新页面', null);

  const q = pickQuery(event);
  const date = q.date || todayLocal();
  if (!isDate(date)) return reply(400, '日期格式不对，应为 YYYY-MM-DD', null);

  const day = await pgSelect('plan_days', {
    uid: 'eq.' + uid,
    date: 'eq.' + date,
    select: PLANDAY_COLS,
    limit: 1,
  });
  const list = await pgSelect('checkins', {
    uid: 'eq.' + uid,
    date: 'eq.' + date,
    select: CHECKIN_COLS,
    order: 'sort.asc,id.asc',
  });

  return reply(0, 'ok', {
    date: date,
    planDay: day.rows.length ? mapPlanDay(day.rows[0]) : null,
    checkins: list.rows.map(mapCheckin),
  });
};

/**
 * GET /api/checkins —— 打卡项列表读取（契约 4.1）
 *
 * 参数（都可选）：
 *   date          单日查询
 *   from / to     区间查询（与 date 二选一）
 *   done          true / false，只看已完成 / 未完成
 *   limit         返回条数上限，默认 20、最大 100（Day 17 余力加练）
 *
 * 排序：日期升序 → 同一天内按 sort 升序 → id 兜底（顺序稳定，翻页不会漏不会重）。
 */
const listCheckins = async (event, context) => {
  const uid = resolveUid(context);
  if (!uid) return reply(401, '登录状态失效，请刷新页面', null);

  const q = pickQuery(event);

  // —— 参数校验：错就早说，别让它变成一条奇怪的 SQL ——
  if (q.date && (q.from || q.to)) {
    return reply(400, 'date 与 from/to 不能同时传，请二选一', null);
  }
  const badDate = ['date', 'from', 'to'].find((k) => q[k] && !isDate(q[k]));
  if (badDate) return reply(400, '日期格式不对，应为 YYYY-MM-DD', null);
  if (q.from && q.to && q.from > q.to) {
    return reply(400, 'from 不能晚于 to', null);
  }
  if (q.done !== undefined && q.done !== 'true' && q.done !== 'false') {
    return reply(400, 'done 只能是 true 或 false', null);
  }

  let limit = 20;
  if (q.limit !== undefined) {
    limit = Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return reply(400, 'limit 必须是 1~100 的整数', null);
    }
  }

  // —— 组装查询 ——
  const query = {
    uid: 'eq.' + uid,
    select: CHECKIN_COLS,
    order: 'date.asc,sort.asc,id.asc',
    limit: limit,
  };
  if (q.date) {
    query.date = 'eq.' + q.date;
  } else if (q.from && q.to) {
    query.date = ['gte.' + q.from, 'lte.' + q.to]; // 同列两个条件 = 区间
  } else if (q.from) {
    query.date = 'gte.' + q.from;
  } else if (q.to) {
    query.date = 'lte.' + q.to;
  }
  if (q.done !== undefined) query.done = 'is.' + q.done;

  const res = await pgSelect('checkins', query);
  return reply(0, 'ok', {
    total: res.total,
    limit: limit,
    items: res.rows.map(mapCheckin),
  });
};

// ===========================================================================
// 六、路由表
// ===========================================================================

/**
 * 路由表：键 = 「方法 + 路径」，值 = 处理函数。
 * 以后加接口就往这张表里加一行，例如：
 *   'POST /api/checkins': createCheckin    （Day 18）
 * 处理函数签名统一是 async (event, context) => 响应对象。
 */
const routes = {
  /**
   * 健康检查：不读数据库、不依赖任何外部服务，只证明"函数活着、能返回合法 JSON"。
   * 返回形状由任务要求写死：{ ok: true, service: 'Self discipline plan' }
   *   ok      —— 恒为 true；函数挂了根本不会返回（会超时或 5xx）
   *   service —— 服务名，用来确认"公网地址打开的是我自己的服务"，而不是缓存页或别人家的接口
   * 这是契约里唯一的"扁平返回"接口，业务接口一律走 reply() 信封。
   */
  'GET /api/health': async () => ({
    ok: true,
    service: SERVICE,
  }),

  'GET /api/day': getDay,
  'GET /api/checkins': listCheckins,
};

/**
 * 云函数入口：平台每次请求都会调用这个 main。
 * 流程：取方法/路径 → 查路由 → 命中就执行，没命中回 404 → 任何异常都兜成 500，绝不让函数崩溃。
 * （服务端必须始终返回"结构化 JSON"，前端才好处理——这是 api-contract.md 的约定。）
 */
exports.main = async (event = {}, context = {}) => {
  const method = pickMethod(event);
  const path = pickPath(event);

  try {
    const handler = routes[method + ' ' + path];
    if (!handler) {
      // 404 的 message 里带上可用路由，调试时一眼看出是路径写错了还是接口还没做
      return reply(404, '接口不存在：' + method + ' ' + path, {
        availableRoutes: Object.keys(routes),
        version: VERSION,
      });
    }
    // 顺手打一行日志：出错时在 CloudBase 控制台"日志"里能看到每次请求的方法和路径
    console.log('[api] ' + method + ' ' + path + ' 命中路由，uid=' +
                (resolveUid(context) || '匿名未注入'));
    return await handler(event, context);
  } catch (err) {
    // 兜底：不把原始错误抛给前端（可能含内部信息），只在服务端日志里留全貌
    console.error('[api] 未捕获异常：', err && err.stack ? err.stack : err);
    return reply(500, '服务端出了点问题，稍后再试', null);
  }
};

// —— 供本地自测引用（云函数运行时不依赖这里；不影响 exports.main）——
exports.SERVICE = SERVICE;
exports.VERSION = VERSION;
exports.routes = routes;
exports.pgSelect = pgSelect;
exports.mapCheckin = mapCheckin;
exports.mapPlanDay = mapPlanDay;
exports.isDate = isDate;
exports.todayLocal = todayLocal;
