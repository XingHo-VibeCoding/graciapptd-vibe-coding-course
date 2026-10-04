/**
 * 自律计划 · 云函数 api（Day 15 建立 v0.1.0 → Day 17 v0.2.0 → Day 18 v0.3.0）
 * ---------------------------------------------------------------------------
 * 这个函数是「前端的唯一后端入口」：所有接口都从这里进，内部再按路径分发给具体处理函数。
 * 为什么一个函数承载所有接口，而不是一个接口一个函数？
 *   → TECH_DESIGN.md 四、API 列表 就是这么定的：部署一次、日志一处、鉴权一处，后面加接口只加路由。
 *
 * 接口进度：
 *   Day 15  GET  /api/health        服务健康检查（不读库）
 *   Day 17  GET  /api/day           今天页首屏合并读取（plan_days + checkins）
 *   Day 17  GET  /api/checkins      打卡项列表读取（支持单日/区间/完成状态/条数限制）
 *   Day 18  POST /api/checkins      新建打卡项（全字段校验 + 重复提交防护）
 *   Day 19+ 其余写入接口与读取接口，按 api-contract.md 逐个加。
 *
 * 【零依赖】只用 Node 内置能力 + Node 18 自带的全局 fetch，不装任何 npm 包。
 *   数据库怎么读？——不装 `pg` 驱动，改走 CloudBase 的 PostgreSQL REST 接口
 *   （`https://<环境ID>.api.tcloudbasegateway.com/v1/rdb/rest/<表名>?<查询条件>`，
 *     PostgREST 风格：筛选写 `列=eq.值`，取列写 `select=`，排序写 `order=`）。
 *   这样云函数目录里连 node_modules 都不用，控制台粘贴即可部署。
 *   ⚠️ 要求运行环境 Node.js 18+（全局 fetch 是 18 才有的）。
 *
 * 【身份从哪来】按契约 1.4，前端永远不许明传 uid：
 *   匿名登录还未接入（课程把它排在后面的日子），所以 uid 依次取：
 *     1) context.userInfo.uid —— 平台注入的登录身份（配好匿名登录后自动生效）
 *     2) process.env.DEMO_UID —— 服务端配置的演示身份（今天靠它做真库验证，绝不来自请求参数）
 *   两个都没有 → 按契约回 401。
 *   ⚠️ 这是**临时**状态：等接上匿名登录那天，必须删掉第 2 条，只认平台注入的身份。
 */

// —— 服务身份：写进健康检查响应里，用来确认"公网地址返回的是我自己的服务" ——
const SERVICE = 'Self discipline plan';
const VERSION = '0.3.0';

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

/**
 * 从触发事件里取出请求体（POST 写入用），并解析成普通对象。
 * 三种来源都要兼容，因为调试时可能绕过 HTTP 访问服务：
 *   1) HTTP 访问服务：event.body 是**字符串**；若 event.isBase64Encoded，
 *      还要先按 base64 解回来（网关对非文本体会做 base64）。
 *   2) 控制台「测试」：event.body 可能已经是对象。
 *   3) 老式直接触发：字段直接摊在 event 顶层。
 *
 * 返回：对象 = 解析成功；**null = 不是合法 JSON**（调用处转成 400，不抛异常）。
 */
const pickBody = (event) => {
  const raw = event.body;
  const PLAIN = ['date', 'text', 'time', 'quad', 'clientReqId'];

  // 没有 body：可能是控制台把字段摊在了 event 顶层
  if (raw === undefined || raw === null || raw === '') {
    return Object.keys(event).some((k) => PLAIN.indexOf(k) > -1) ? event : {};
  }
  if (typeof raw === 'object') return raw; // 已经是对象

  let s = String(raw);
  if (event.isBase64Encoded) {
    try {
      s = Buffer.from(s, 'base64').toString('utf8');
    } catch (e) {
      return null;
    }
  }
  try {
    const obj = JSON.parse(s);
    return obj && typeof obj === 'object' ? obj : null;
  } catch (e) {
    return null;
  }
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

/**
 * 往一张表插一行（PostgREST 的 POST 语义）。和 pgSelect 是同一套零依赖思路。
 *   · 请求体 = 要插入的列（对象），键名用**数据库列名**（snake_case）
 *   · Prefer: return=representation —— 让数据库把"刚插进去的那一行"回传，
 *     这样响应里能直接给出新 id，不用再查一次
 *   · resolution=ignore-duplicates? **不用**。我们的重复提交要靠报错拦住（409），
 *     静默忽略会让"重复提交"变成"看起来成功但其实没写"，前端无法分辨。
 *
 * 返回：插入后的那一行（对象）；网关没回传表示时返回 null（调用处会读回兜底）。
 * 失败时抛的错误对象上带 `pgCode`（PostgreSQL 的 SQLSTATE，如 '23505' 唯一冲突），
 * 供调用处区分"重复提交"和其它故障。
 */
const pgInsert = async (table, row) => {
  const { envId, apiKey, base } = dbConfig();
  if (!envId || !apiKey) {
    throw new Error('数据库未配置：缺少环境变量 TCB_ENV 或 CLOUDBASE_API_KEY');
  }
  if (typeof fetch !== 'function') {
    throw new Error('运行环境不支持全局 fetch，请把云函数运行环境设为 Node.js 18 及以上');
  }

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

// —— 写入接口（Day 18）用到的字段规则 ——
// 这些规则和数据库里的 CHECK 约束是**一一对应**的：
//   服务端校验是"好用"（错得早、提示是中文），数据库约束是"最后防线"（绕过服务端也拦得住）。
//   两道都要有：只有服务端 → 并发/直连能绕过；只有数据库 → 用户看到的是英文报错。

/** 内容长度上限 60，与前端输入框 maxlength、以及 checkins_text_len 约束保持一致 */
const MAX_TEXT = 60;

/** 时间必须是 HH:mm 24 小时制（与 checkins_time_fmt 约束一致） */
const isTime = (s) => /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(s);

/** 四象限取值（与 checkins_quad_enum 约束一致） */
const QUADS = ['q1', 'q2', 'q3', 'q4'];

/** 幂等键格式：1~64 位的字母/数字/下划线/短横线（uuid 天然满足） */
const isReqId = (s) => /^[A-Za-z0-9_-]{1,64}$/.test(s);

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

/**
 * 写接口的服务端日志（Day 18 余力加练）。
 * 一行里放齐排查问题需要的全部要素：动作、谁、写了什么、结果、新 id、耗时。
 * 出问题时在 CloudBase 控制台「云函数 → api → 日志」搜 [api][write] 即可定位。
 * 注意：**只打元信息，不打用户内容正文**（待办内容属于用户隐私，日志不该留）。
 */
const logWrite = (action, info) => {
  const parts = Object.keys(info).map((k) => k + '=' + info[k]);
  console.log('[api][write] ' + action + ' | ' + parts.join(' '));
};

/** 重复提交的统一文案与错误码（两条路径共用，保证提示一致） */
const DUPLICATE = () => reply(409, '请勿重复提交：这条待办刚刚已经添加过了', null);

/**
 * POST /api/checkins —— 新建打卡项（契约 4.1）
 *
 * 请求体：{ date(必填), text(必填 1~60 字), time?(HH:mm), quad?(q1~q4), clientReqId?(幂等键) }
 * 幂等键也可放请求头 `Idempotency-Key`（两者都传时以 body 为准）。
 *
 * 处理顺序（顺序本身就是防护设计）：
 *   ① 身份 → ② 请求体 → ③ 全字段校验（错就早退，一个字都不写库）
 *   → ④ 幂等预检（带 key 才做）→ ⑤ 算排序位 → ⑥ 写入 → ⑦ 读回确认 → ⑧ 日志
 *
 * 重复提交防了两层，缺一不可：
 *   · 服务层预检：先查 (uid, clientReqId) 在不在 —— 好处是能给出友好的中文提示；
 *     但它**挡不住并发**（两个请求可能同时查、同时没查到，然后都去写）。
 *   · 数据库唯一索引：checkins_uid_reqid_uniq —— 并发下真正兜住的那一道，
 *     冲突时 PostgreSQL 报 SQLSTATE 23505，这里翻译成 409 + 同一句中文。
 */
const createCheckin = async (event, context) => {
  const startedAt = Date.now();

  // ① 身份
  const uid = resolveUid(context);
  if (!uid) return reply(401, '登录状态失效，请刷新页面', null);

  // ② 请求体
  const body = pickBody(event);
  if (body === null) return reply(400, '请求体不是合法的 JSON', null);

  // ③ 全字段校验 —— 任何一条不过就立刻返回，绝不写库
  const date = body.date === undefined || body.date === null ? '' : String(body.date);
  if (!date) return reply(400, '缺少必填字段 date（这条待办属于哪一天）', null);
  if (!isDate(date)) return reply(400, '日期格式不对，应为 YYYY-MM-DD', null);

  if (body.text === undefined || body.text === null) {
    return reply(400, '缺少必填字段 text（待办内容）', null);
  }
  if (typeof body.text !== 'string') {
    return reply(400, '内容不能为空，且不超过 60 字', null);
  }
  const text = body.text.trim(); // 存进去的是去首尾空白后的内容，和数据库 btrim 约束一致
  if (!text || text.length > MAX_TEXT) {
    return reply(400, '内容不能为空，且不超过 60 字', null);
  }

  let time = null;
  if (body.time !== undefined && body.time !== null && body.time !== '') {
    if (typeof body.time !== 'string' || !isTime(body.time)) {
      return reply(400, '时间格式不对，应为 HH:mm（24 小时制）', null);
    }
    time = body.time;
  }

  let quad = null;
  if (body.quad !== undefined && body.quad !== null && body.quad !== '') {
    if (typeof body.quad !== 'string' || QUADS.indexOf(body.quad) < 0) {
      return reply(400, '象限只能是 q1 / q2 / q3 / q4', null);
    }
    quad = body.quad;
  }

  // 幂等键：body.clientReqId 优先，其次请求头 Idempotency-Key
  const headerKey = event.headers && (event.headers['Idempotency-Key'] || event.headers['idempotency-key']);
  let reqId = body.clientReqId === undefined || body.clientReqId === null ? '' : String(body.clientReqId);
  if (!reqId && headerKey) reqId = String(headerKey);
  if (reqId && !isReqId(reqId)) {
    return reply(400, 'clientReqId 只能是 1~64 位的字母、数字、下划线或短横线', null);
  }

  // ④ 幂等预检：同一个 clientReqId 已经写过了 → 直接拒（给友好中文，不打数据库报错）
  if (reqId) {
    const dup = await pgSelect('checkins', {
      uid: 'eq.' + uid,
      client_req_id: 'eq.' + reqId,
      select: 'id',
      limit: 1,
    });
    if (dup.rows.length) {
      logWrite('重复提交被拒（预检）', {
        uid: uid, date: date, reqId: reqId, code: 409, ms: Date.now() - startedAt,
      });
      return DUPLICATE();
    }
  }

  // ⑤ 排序位：接在同一天已有条目的最后面（空的一天从 0 开始）
  const last = await pgSelect('checkins', {
    uid: 'eq.' + uid,
    date: 'eq.' + date,
    select: 'sort',
    order: 'sort.desc',
    limit: 1,
  });
  const sort = last.rows.length ? Number(last.rows[0].sort) + 1 : 0;

  // ⑥ 写入
  const row = { uid: uid, date: date, text: text, time: time, quad: quad, done: false, sort: sort };
  if (reqId) row.client_req_id = reqId;

  let inserted;
  try {
    inserted = await pgInsert('checkins', row);
  } catch (err) {
    // 竞态兜底：预检没查到、但写入时数据库唯一索引拦下了（并发/重试）
    if (err && err.pgCode === '23505') {
      logWrite('重复提交被拒（唯一索引兜底）', {
        uid: uid, date: date, reqId: reqId, pgCode: err.pgCode, code: 409, ms: Date.now() - startedAt,
      });
      return DUPLICATE();
    }
    throw err; // 其它故障交给 main 兜成 500，并留全栈日志
  }

  // ⑦ 读回确认：网关没回传表示时，自己再查一次，保证响应里的 id 一定真实存在
  let created = inserted;
  if (!created) {
    const back = reqId
      ? await pgSelect('checkins', { uid: 'eq.' + uid, client_req_id: 'eq.' + reqId, select: CHECKIN_COLS, limit: 1 })
      : await pgSelect('checkins', {
          uid: 'eq.' + uid, date: 'eq.' + date, text: 'eq.' + text,
          select: CHECKIN_COLS, order: 'id.desc', limit: 1,
        });
    created = back.rows.length ? back.rows[0] : null;
  }
  if (!created) throw new Error('写入未返回也无法读回新建的那一行，结果不可确认');

  // ⑧ 日志
  logWrite('写入成功', {
    uid: uid, date: date, textLen: text.length, reqId: reqId || '-',
    id: created.id, sort: sort, code: 0, ms: Date.now() - startedAt,
  });

  return reply(0, '已添加', mapCheckin(created));
};

// ===========================================================================
// 七、路由表
// ===========================================================================

/**
 * 路由表：键 = 「方法 + 路径」，值 = 处理函数。
 * 加接口就往这张表里加一行，例如（Day 19 预计）：
 *   'PATCH /api/checkins/:id': updateCheckin
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

  // Day 18：第一个写入接口。方法区分大小写（平台给的是大写）
  'POST /api/checkins': createCheckin,
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
exports.pgInsert = pgInsert;
exports.pickBody = pickBody;
exports.mapCheckin = mapCheckin;
exports.mapPlanDay = mapPlanDay;
exports.isDate = isDate;
exports.isTime = isTime;
exports.isReqId = isReqId;
exports.todayLocal = todayLocal;
