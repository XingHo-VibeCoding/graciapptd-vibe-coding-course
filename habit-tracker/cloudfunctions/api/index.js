/**
 * 自律计划 · 云函数 api（Day 15 建立 v0.1.0 → Day 17 v0.2.0 → Day 18 v0.3.0 → Day 19 v0.4.0 → Day 22 v0.5.0）
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
 *   Day 19  结构重构：数据库操作拆到 db.js（数据访问层），接口行为与契约零变化
 *   Day 22  PATCH  /api/checkins/:id  修改打卡项（打勾 / 改内容 / 改时间 / 改象限）
 *   Day 22  DELETE /api/checkins/:id  删除打卡项（**软删除**：只打标记，行仍在库里）
 *           → 到这一天，checkins 上的"增删改查"四类操作在公网全部闭环
 *   Day 23+ 其余写入接口与读取接口，按 api-contract.md 逐个加。
 *
 * 【Day 19 分层】本文件**不再直接读写数据库** —— 那是 db.js（数据访问层）的活。
 *   现在这个文件只管三件事：
 *     ① HTTP 解析：把触发事件解析成「方法 / 路径 / query / body」
 *     ② 校验与业务规则：必填字段、格式、幂等键、排序位、写后读回
 *     ③ 拼响应：调 db.js 取/写数据，再套上契约要求的统一信封
 *   要数据就写 `await db.listCheckinsByDay(uid, date)`；
 *   不再自己拼数据库查询串，也不再在业务代码里出现任何数据库列名。
 *   分层图见 TECH_DESIGN.md「二.1 分层结构」。
 *
 * 【零依赖】整个云函数只用 Node 内置能力 + Node 18 自带的全局 fetch，不装任何 npm 包（含 `pg` 驱动）。
 *   ⚠️ 因此运行环境必须 Node.js 18 及以上。
 *
 * 【身份从哪来】按契约 1.4，前端永远不许明传 uid：
 *   匿名登录还未接入（课程把它排在后面的日子），所以 uid 依次取：
 *     1) context.userInfo.uid —— 平台注入的登录身份（配好匿名登录后自动生效）
 *     2) process.env.DEMO_UID —— 服务端配置的演示身份（绝不来自请求参数）
 *   两个都没有 → 按契约回 401。
 *   ⚠️ 这是**临时**状态：等接上匿名登录那天，必须删掉第 2 条，只认平台注入的身份。
 */

// —— 数据访问层（Day 19 从本文件拆出去的那一层）：所有数据库读写的唯一入口 ——
const db = require('./db.js');

// —— 服务身份：写进健康检查响应里，用来确认"公网地址返回的是我自己的服务" ——
const SERVICE = 'Self discipline plan';
const VERSION = '0.5.0';

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
// 二、参数校验（前端的错要早点挡住，别让它变成一条奇怪的查询）
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

/**
 * 路径参数 `:id` 必须是正整数（Day 22）。返回数字；不合法返回 **null**。
 * 为什么要单独校验：`/api/checkins/abc` 这种请求不该被当成"找不到这条"（404），
 * 而是"你给我的 id 本身就不对"（400）—— 两种情况的错在谁身上完全不同。
 */
const parseId = (raw) => {
  const s = String(raw === undefined || raw === null ? '' : raw);
  if (!/^\d{1,15}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

// ===========================================================================
// 三、业务规则用的小工具
// ===========================================================================

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

// ===========================================================================
// 四、接口实现（只做 HTTP 与业务规则的活，数据一律找 db.js 要）
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

  // 问数据访问层要"这一天"的两样东西（怎么查是它的事，这里只说"要什么"）
  const planDay = await db.findPlanDay(uid, date);
  const checkins = await db.listCheckinsByDay(uid, date);

  return reply(0, 'ok', {
    date: date,
    planDay: planDay,
    checkins: checkins,
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
 * 排序：日期升序 → 同一天内按排序位升序 → id 兜底（顺序稳定，翻页不会漏不会重）。
 */
const listCheckins = async (event, context) => {
  const uid = resolveUid(context);
  if (!uid) return reply(401, '登录状态失效，请刷新页面', null);

  const q = pickQuery(event);

  // —— 参数校验：错就早说，别让它变成一条奇怪的查询 ——
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

  // —— 交给数据访问层去查（单日/区间/完成状态/条数，都是它的活）——
  const res = await db.listCheckins(uid, {
    date: q.date,
    from: q.from,
    to: q.to,
    done: q.done,
    limit: limit,
  });

  return reply(0, 'ok', {
    total: res.total,
    limit: limit,
    items: res.items,
  });
};

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
 *   · 服务层预检：先问数据访问层"这个幂等键用过了吗" —— 好处是能给出友好的中文提示；
 *     但它**挡不住并发**（两个请求可能同时查、同时没查到，然后都去写）。
 *   · 数据库唯一索引：checkins_uid_reqid_uniq —— 并发下真正兜住的那一道；
 *     冲突时数据访问层会把 PostgreSQL 的 SQLSTATE 23505 带回来，这里翻译成 409 + 同一句中文。
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

  // ④ 幂等预检：这个幂等键用过了 → 直接拒（给友好中文，不打数据库报错）
  if (reqId) {
    const used = await db.existsCheckinWithReqId(uid, reqId);
    if (used) {
      logWrite('重复提交被拒（预检）', {
        uid: uid, date: date, reqId: reqId, code: 409, ms: Date.now() - startedAt,
      });
      return DUPLICATE();
    }
  }

  // ⑤ 排序位：接在同一天已有条目的最后面（空的一天从 0 开始）
  const lastSort = await db.findLastSort(uid, date);
  const sort = lastSort === null ? 0 : lastSort + 1;

  // ⑥ 写入（数据库列名由数据访问层拼；唯一键冲突会带着 pgCode 抛回来）
  let created;
  try {
    created = await db.createCheckin({
      uid: uid, date: date, text: text, time: time, quad: quad, sort: sort, reqId: reqId,
    });
  } catch (err) {
    // 竞态兜底：预检没查到、但写入时数据库唯一索引拦下了（并发/重试）
    if (db.isDuplicateError(err)) {
      logWrite('重复提交被拒（唯一索引兜底）', {
        uid: uid, date: date, reqId: reqId, pgCode: err.pgCode, code: 409, ms: Date.now() - startedAt,
      });
      return DUPLICATE();
    }
    throw err; // 其它故障交给 main 兜成 500，并留全栈日志
  }

  // ⑦ 读回确认：网关没回传表示时，自己再查一次，保证响应里的 id 一定真实存在
  if (!created) {
    created = reqId
      ? await db.findCheckinByReqId(uid, reqId)
      : await db.findCheckinByContent(uid, date, text);
  }
  if (!created) throw new Error('写入未返回也无法读回新建的那一行，结果不可确认');

  // ⑧ 日志（只记元信息，不记用户内容正文）
  logWrite('写入成功', {
    uid: uid, date: date, textLen: text.length, reqId: reqId || '-',
    id: created.id, sort: sort, code: 0, ms: Date.now() - startedAt,
  });

  return reply(0, '已添加', created);
};

// ---------------------------------------------------------------------------
// Day 22：改与删（PATCH / DELETE）
// ---------------------------------------------------------------------------

/**
 * 修改 / 删除共同的前置步骤：按 id 把这一行查出来，替调用方判定三种"不能动"。
 *
 * 判定顺序（**顺序本身就是防线**，见 api-contract.md §三）：
 *   ① 查不到这一行            → 404「不存在或已删除」
 *   ② 查到了但 uid 不是本人    → 403「无权修改/删除这条待办」
 *   ③ 是自己的、但已被软删除过 → 404（对外不区分"没这条"和"删过了"）
 *
 * 为什么第 ① 步要"不带 uid 查"：见 db.js `findCheckinRowById` 的注释 ——
 *   一上来就 `WHERE id AND uid` 的话，越权尝试永远只会得到 404，
 *   既看不见、也测不出"有人正在试图动别人的数据"。
 *
 * @param action '修改' | '删除'，只用来拼 403 的中文提示
 * @returns { row } 或 { err }（`err` 非空就直接 return 它，那是给前端的完整响应）
 */
const locateOwnCheckin = async (uid, id, action) => {
  const row = await db.findCheckinRowById(id);
  if (!row) return { err: reply(404, '这条待办不存在或已删除', null) };
  if (String(row.uid) !== uid) {
    return { err: reply(403, '无权' + action + '这条待办', null) };
  }
  if (row.is_deleted === true) {
    return { err: reply(404, '这条待办不存在或已删除', null) };
  }
  return { row: row };
};

/**
 * PATCH /api/checkins/:id —— 修改打卡项（契约 4.1 / §三）
 *
 * 只传要改的字段（部分更新），至少给一个：done / text / time / quad。
 * 处理顺序：① 身份 → ② id 与请求体校验（错就早退，一个字都不写库）
 *          → ③ 查出这一行并判 404/403/已删除 → ④ A5 业务规则 → ⑤ 写入 → ⑥ 日志
 *
 * ④ 是 PRD A5 的硬规则：**给未来日期的待办打勾**要 409。
 *   为什么必须服务端拦：前端把圆圈禁用只是"体验层"，直接发一个请求就绕过去了；
 *   而这条规则是产品承诺（"明天的待办今天不能打勾"），承诺必须在服务端兑现。
 *   注意只在「由假变真」时拦：取消打勾任何时候都允许。
 */
const updateCheckin = async (event, context, idRaw) => {
  const startedAt = Date.now();

  // ① 身份
  const uid = resolveUid(context);
  if (!uid) return reply(401, '登录状态失效，请刷新页面', null);

  // ② id 与请求体
  const id = parseId(idRaw);
  if (id === null) return reply(400, '待办 id 不合法', null);

  const body = pickBody(event);
  if (body === null) return reply(400, '请求体不是合法的 JSON', null);

  // 哪些字段"传了"？—— 用 hasOwnProperty 而不是 truthy 判断：
  //   { time: null } 是"清空时间"（有效指令），truthy 判断会把它当成"没传"。
  const PATCHABLE = ['done', 'text', 'time', 'quad'];
  const touched = PATCHABLE.filter((k) => Object.prototype.hasOwnProperty.call(body, k));
  if (!touched.length) {
    return reply(400, '请至少指定一个要修改的字段（done / text / time / quad）', null);
  }

  const patch = {};
  if (touched.indexOf('done') > -1) {
    if (typeof body.done !== 'boolean') return reply(400, 'done 只能是 true 或 false', null);
    patch.done = body.done;
  }
  if (touched.indexOf('text') > -1) {
    if (typeof body.text !== 'string') return reply(400, '内容不能为空，且不超过 60 字', null);
    const text = body.text.trim();
    if (!text || text.length > MAX_TEXT) return reply(400, '内容不能为空，且不超过 60 字', null);
    patch.text = text;
  }
  if (touched.indexOf('time') > -1) {
    const v = body.time;
    if (v === null || v === '') {
      patch.time = null;                                        // 清空 = 未安排
    } else if (typeof v !== 'string' || !isTime(v)) {
      return reply(400, '时间格式不对，应为 HH:mm（24 小时制）', null);
    } else {
      patch.time = v;
    }
  }
  if (touched.indexOf('quad') > -1) {
    const v = body.quad;
    if (v === null || v === '') {
      patch.quad = null;                                        // 清空 = 未分类
    } else if (typeof v !== 'string' || QUADS.indexOf(v) < 0) {
      return reply(400, '象限只能是 q1 / q2 / q3 / q4', null);
    } else {
      patch.quad = v;
    }
  }

  // ③ 查出这一行：404 / 403 / 已删除
  const located = await locateOwnCheckin(uid, id, '修改');
  if (located.err) return located.err;

  // ④ A5：给未来日期的待办打勾 → 409（服务端硬拦）
  if (patch.done === true && String(located.row.date) > todayLocal()) {
    logWrite('给未来待办打勾被拒', {
      uid: uid, id: id, date: String(located.row.date), code: 409, ms: Date.now() - startedAt,
    });
    return reply(409, '这一天还没到，先别急着打勾', null);
  }

  // ⑤ 写入（条件里带 uid：只改自己的数据）
  const updated = await db.updateCheckin(uid, id, patch);
  if (!updated) throw new Error('修改未返回也无法读回改后的行，结果不可确认');

  // ⑥ 日志（只记"改了哪些字段"，不记内容正文）
  logWrite('修改成功', {
    uid: uid, id: id, fields: touched.join('+'), code: 0, ms: Date.now() - startedAt,
  });

  return reply(0, '已更新', updated);
};

/**
 * DELETE /api/checkins/:id —— 删除打卡项（契约 4.1 / §三）
 *
 * ⚠️ 这是**软删除**：不是 `DELETE FROM checkins`，而是把该行 `is_deleted` 置 true。
 *    为什么、以及它对读取接口的影响 —— 见 api-contract.md §1.7 与 db/schema-3.sql 开头。
 *
 * 为什么删除也要先查一遍、判 uid：新增错了只是多一条（可逆），
 * 删错了是**别人的数据没了**（不可逆）。所以删除的每一道防线都不能省：
 * 前端 confirm → 服务端按 uid 限定范围 → 存储层只打标记。
 *
 * 删除**没有 409**：任何日期都允许删（A5 拦的是"提前打勾"，不是"提前清理"）。
 */
const deleteCheckin = async (event, context, idRaw) => {
  const startedAt = Date.now();

  const uid = resolveUid(context);
  if (!uid) return reply(401, '登录状态失效，请刷新页面', null);

  const id = parseId(idRaw);
  if (id === null) return reply(400, '待办 id 不合法', null);

  const located = await locateOwnCheckin(uid, id, '删除');
  if (located.err) return located.err;

  const done = await db.softDeleteCheckin(uid, id);
  if (!done) throw new Error('标记删除时一行都没匹配到，结果不可确认');

  logWrite('软删除成功', {
    uid: uid, id: id, date: String(located.row.date), code: 0, ms: Date.now() - startedAt,
  });

  return reply(0, '已删除', { id: id });
};

// ===========================================================================
// 五、路由表
// ===========================================================================
/**
 * 路由表：键 = 「方法 + 路径」，值 = 处理函数。
 * 处理函数签名统一是 async (event, context) => 响应对象。
 * **固定路径**写在这张表里（精确匹配，一眼看得出有哪些接口）；
 * 带路径参数的路由（`:id`）在下面另一张表 `idRoutes` 里，用正则匹配。
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
 * 带路径参数的路由（Day 22 新增）—— 精确匹配的 routes 表装不下 `:id`。
 *
 * 为什么要单开一张表而不是塞进 routes：
 *   routes 的键是死字符串，`/api/checkins/13` 里那个 13 每次都不一样，键是拼不出来的。
 *   所以这里用**正则**把 id 抽出来，再作为第三个参数交给处理函数 `(event, context, idRaw)`。
 *
 * 正则用 `([^/]+)` 而不是 `(\d+)`：这样 `/api/checkins/abc` 也能命中路由，
 * 由处理函数回一个精准的 `400 待办 id 不合法`，而不是笼统的"接口不存在 404"——
 * 两种错在谁身上完全不同（前者是请求参数错，后者是路径根本没这个接口）。
 */
const idRoutes = [
  { method: 'PATCH', re: /^\/api\/checkins\/([^/]+)$/, handler: updateCheckin },
  { method: 'DELETE', re: /^\/api\/checkins\/([^/]+)$/, handler: deleteCheckin },
];

/** 全部可用路由（固定 + 带参数的），只用于 404 提示与调试时列出 */
const allRoutes = () => Object.keys(routes).concat([
  'PATCH /api/checkins/:id',
  'DELETE /api/checkins/:id',
]);

/**
 * 云函数入口：平台每次请求都会调用这个 main。
 * 流程：取方法/路径 → 先查固定路由 → 再试带参数的路由 → 都没命中回 404
 *      → 任何异常都兜成 500，绝不让函数崩溃。
 * （服务端必须始终返回"结构化 JSON"，前端才好处理——这是 api-contract.md 的约定。）
 */
exports.main = async (event = {}, context = {}) => {
  const method = pickMethod(event);
  const path = pickPath(event);

  try {
    // ① 固定路径：精确命中
    let handler = routes[method + ' ' + path];
    let idRaw = null;

    // ② 带参数路径：正则命中，把 id 从路径里抽出来
    if (!handler) {
      const hit = idRoutes.find((r) => r.method === method && r.re.test(path));
      if (hit) {
        handler = hit.handler;
        idRaw = path.match(hit.re)[1];
      }
    }

    if (!handler) {
      // 404 的 message 里带上可用路由，调试时一眼看出是路径写错了还是接口还没做
      return reply(404, '接口不存在：' + method + ' ' + path, {
        availableRoutes: allRoutes(),
        version: VERSION,
      });
    }
    // 顺手打一行日志：出错时在 CloudBase 控制台"日志"里能看到每次请求的方法和路径
    console.log('[api] ' + method + ' ' + path + ' 命中路由，uid=' +
                (resolveUid(context) || '匿名未注入'));
    return await handler(event, context, idRaw);
  } catch (err) {
    // 兜底：不把原始错误抛给前端（可能含内部信息），只在服务端日志里留全貌
    console.error('[api] 未捕获异常：', err && err.stack ? err.stack : err);
    return reply(500, '服务端出了点问题，稍后再试', null);
  }
};

// —— 供本地自测引用（云函数运行时不依赖这里；不影响 exports.main）——
// 注意：数据库相关的东西（表级查询 / 行映射 / 分页总数）已随重构搬到 db.js，
// 自测要直接用就 `require('./db.js')`，本文件不再转发它们。
exports.SERVICE = SERVICE;
exports.VERSION = VERSION;
exports.routes = routes;
exports.idRoutes = idRoutes;
exports.allRoutes = allRoutes;
exports.pickBody = pickBody;
exports.isDate = isDate;
exports.isTime = isTime;
exports.isReqId = isReqId;
exports.parseId = parseId;
exports.todayLocal = todayLocal;
