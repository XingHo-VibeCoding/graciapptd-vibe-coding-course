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
 *   Day 29  PUT    /api/day/:date/mood  写某天的心情（upsert）；POST /api/day/moods 批量迁移
 *   Day 29  GET    /api/habits          打卡定义 + 指定日期各自的次数
 *           PUT    /api/habits/:id      新建或修改一条打卡（upsert，前端本机 id 当主键用）
 *           DELETE /api/habits/:id      删除一条打卡及其全部记录
 *           PUT    /api/habits/:id/logs/:date  设置某天打了几次
 *           POST   /api/habits/import   本机已有打卡一次性搬上云
 *   Day 30+ 其余写入接口与读取接口，按 api-contract.md 逐个加。
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
const VERSION = '0.6.0';

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
  const PLAIN = ['date', 'text', 'time', 'quad', 'clientReqId', 'mood', 'items',
                  'name', 'perDay', 'start', 'end', 'count', 'habits', 'logs'];

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
// 四·补充、心情写入（Day 29 十三轮）
// ===========================================================================
/**
 * 心情的五个取值 —— 与数据库 plan_days_mood_enum 一一对应。
 * 服务端先校验一遍是为了"错得早、提示是中文"；真正兜底的是数据库那条 CHECK。
 */
const MOODS = ['sad', 'blue', 'calm', 'cozy', 'joy'];

/** 一次迁移最多收多少条心情 —— 前端本机历史再多也不会超过这个量级 */
const MAX_MOOD_IMPORT = 200;

/**
 * `PUT /api/day/:date/mood` —— 记下某一天的心情。
 *
 * 为什么是 upsert 而不是"只允许新增"：心情本来就允许改（A9 以最后一次为准），
 * `plan_days` 的主键是 (uid, date)，同一天反复选只会覆盖同一条，不会长出第二行。
 *
 * 未来日期回 409：日期格式没错，是"业务上还没到"，与给未来待办打勾同一口径。
 */
const putMood = async (event, context, dateRaw) => {
  const startedAt = Date.now();

  const uid = resolveUid(context);
  if (!uid) return reply(401, '登录状态失效，请刷新页面', null);

  const date = String(dateRaw === undefined || dateRaw === null ? '' : dateRaw);
  if (!isDate(date)) return reply(400, '日期格式不对，应为 YYYY-MM-DD', null);
  if (date > todayLocal()) return reply(409, '还没到那一天，到了再记心情吧', null);

  const body = pickBody(event);
  if (body === null) return reply(400, '请求体不是合法的 JSON', null);
  const mood = typeof body.mood === 'string' ? body.mood : '';
  if (MOODS.indexOf(mood) < 0) {
    return reply(400, '心情只能是 sad / blue / calm / cozy / joy', null);
  }

  try {
    const planDay = await db.savePlanDayMood(uid, date, mood);
    logWrite('写心情成功', { uid: uid, date: date, code: 0, ms: Date.now() - startedAt });
    return reply(0, '已记下', planDay || { date: date, mood: mood, updatedAt: Date.now() });
  } catch (err) {
    console.error('[api] 写心情失败：' + err.message);
    return reply(500, '心情没存上，稍后再试一次', null);
  }
};

/**
 * `POST /api/day/moods` —— 把本机历史心情一次性搬上云（前端只调一次，成功后打标记）。
 *
 * 两条容易踩的点：
 *   ① **同一批里同一天不能出现两次**：PostgREST 的批量 upsert 在同一个语句里
 *      撞到同一个冲突键会直接报 `ON CONFLICT DO UPDATE command cannot affect row a second time`。
 *      所以先用 Map 按日期去重（后面的覆盖前面的），再写库。
 *   ② **整批原子**：任意一条非法就整体 400，一条都不写。因为接口幂等，前端改完重发安全。
 */
const importMoods = async (event, context) => {
  const startedAt = Date.now();

  const uid = resolveUid(context);
  if (!uid) return reply(401, '登录状态失效，请刷新页面', null);

  const body = pickBody(event);
  if (body === null) return reply(400, '请求体不是合法的 JSON', null);

  const items = body.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_MOOD_IMPORT) {
    return reply(400, 'items 必须是 1~200 条的数组', null);
  }

  const today = todayLocal();
  const uniq = new Map();                    // date -> mood（后面的覆盖前面的）
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const date = String(it.date === undefined || it.date === null ? '' : it.date);
    if (!isDate(date)) {
      return reply(400, '第 ' + (i + 1) + ' 条的日期格式不对，应为 YYYY-MM-DD', null);
    }
    if (date > today) {
      return reply(400, '第 ' + (i + 1) + ' 条是未来日期，心情只能记已经到来的日子', null);
    }
    const mood = typeof it.mood === 'string' ? it.mood : '';
    if (MOODS.indexOf(mood) < 0) {
      return reply(400, '第 ' + (i + 1) + ' 条的心情只能是 sad / blue / calm / cozy / joy', null);
    }
    uniq.set(date, mood);
  }

  const payload = [];
  uniq.forEach((mood, date) => payload.push({ date: date, mood: mood }));

  try {
    const imported = await db.savePlanDayMoods(uid, payload);
    logWrite('导入本机心情', { uid: uid, count: imported, code: 0, ms: Date.now() - startedAt });
    return reply(0, '已导入', { imported: imported });
  } catch (err) {
    console.error('[api] 导入心情失败：' + err.message);
    return reply(500, '心情没搬完，稍后再试一次', null);
  }
};

// ===========================================================================
// 五、打卡上云（Day 29 十四轮）：定义 + 每日次数
// ===========================================================================
// 打卡在数据上拆成两张表（见 db/schema-4.sql）：
//   habits      一条定义 = "要打卡什么、每天几次、什么范围内有效"
//   habit_logs  一天一行 = "这条打卡这一天打了几次"
// 接口把两张表包在一起，前端看到的仍然是"一条打卡 + 今天的次数"，
// 与它本机存的结构完全一样 —— 这样前端不用为"上云"改写任何数据形状。

/** 打卡名称上限 20，与前端 maxlength、habits_name_len 约束一致 */
const MAX_HABIT_NAME = 20;
/** 每天次数上限 9，与前端步进器、habits_per_day_range 约束一致 */
const MAX_PER_DAY = 9;
/** 迁移时每批最多多少条（与契约 POST /api/habits/import 的上限一致） */
const MAX_HABIT_IMPORT = 100;
const MAX_HABIT_LOG_IMPORT = 500;

/**
 * client_id 格式：前端用 'h' + 时间戳，这里放宽到字母/数字/下划线/短横线 1~40 位。
 * 为什么不限制成纯数字：老数据的 id、将来可能换的生成方式都得能用。
 */
const isClientId = (s) => /^[A-Za-z0-9_-]{1,40}$/.test(s);

/** 每天次数必须是 1~9 的整数（字符串 '3' 也放行，前端从 data 属性读出来时可能是字符串） */
const parsePerDay = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= MAX_PER_DAY ? n : null;
};

/**
 * 校验一条打卡定义（新建 / 编辑 / 迁移三处共用）。
 * 返回 { habit } 或 { error } —— 错误文案直接面向用户，带上出错字段的名字。
 */
const parseHabit = (raw, indexLabel) => {
  const at = indexLabel ? indexLabel + '的' : '';
  const src = raw && typeof raw === 'object' ? raw : {};

  const id = String(src.id === undefined || src.id === null ? '' : src.id);
  if (!isClientId(id)) return { error: at + '打卡 id 不合法（1~40 位字母/数字/下划线/短横线）' };

  const name = String(src.name === undefined || src.name === null ? '' : src.name).trim();
  if (!name) return { error: at + '打卡名称不能为空' };
  if (name.length > MAX_HABIT_NAME) return { error: at + '打卡名称最多 ' + MAX_HABIT_NAME + ' 个字' };

  const perDay = parsePerDay(src.perDay);
  if (perDay === null) return { error: at + '每天次数必须是 1~' + MAX_PER_DAY + ' 的整数' };

  const time = (src.time === undefined || src.time === null || src.time === '') ? null : String(src.time);
  if (time !== null && !isTime(time)) return { error: at + '时间格式不对，应为 HH:mm' };

  const quad = (src.quad === undefined || src.quad === null || src.quad === '') ? null : String(src.quad);
  if (quad !== null && QUADS.indexOf(quad) < 0) return { error: at + '象限只能是 q1 / q2 / q3 / q4' };

  const start = String(src.start === undefined || src.start === null ? '' : src.start);
  if (!isDate(start)) return { error: at + '开始日期格式不对，应为 YYYY-MM-DD' };

  const endRaw = (src.end === undefined || src.end === null || src.end === '') ? '' : String(src.end);
  if (endRaw && !isDate(endRaw)) return { error: at + '结束日期格式不对，应为 YYYY-MM-DD' };
  if (endRaw && endRaw < start) return { error: at + '结束日期不能早于开始日期' };

  return { habit: { id: id, name: name, perDay: perDay, time: time, quad: quad,
                    start: start, end: endRaw || null } };
};

/**
 * GET /api/habits?date=YYYY-MM-DD —— 全部打卡定义 + 指定日期各自的次数（契约 4.9）
 *
 * 为什么把次数和定义放一个接口：首页那张清单要的是"这条打卡今天打了几次"，
 * 分两个接口不仅多一次往返，还会出现"定义回来了、次数没回来"的中间态。
 * date 不传就用服务端今天（和 GET /api/day 的口径一致）。
 */
const listHabits = async (event, context) => {
  const uid = resolveUid(context);
  if (!uid) return reply(401, '登录状态失效，请刷新页面', null);

  const q = pickQuery(event);
  const date = q.date || todayLocal();
  if (!isDate(date)) return reply(400, '日期格式不对，应为 YYYY-MM-DD', null);

  const habits = await db.listHabits(uid);
  const logs = await db.listHabitLogsByDate(uid, date);

  // 次数挂在每条定义上（count 默认 0），前端拿到就能直接渲染扇形进度
  const items = habits.map((h) => Object.assign({}, h, { count: logs[h.id] || 0 }));

  return reply(0, 'ok', { date: date, total: items.length, items: items });
};

/**
 * PUT /api/habits/:clientId —— 新建或修改一条打卡定义（契约 4.10）
 *
 * 为什么"新建"也用 PUT 而不是 POST：本机 id 是前端生成的稳定标识（h+时间戳），
 * 新建和编辑对服务端而言都是"把 id=X 的那行写成这样"，撞上就覆盖。
 * 好处是断网重试天然幂等 —— 同一个请求发两遍不会变成两条打卡。
 */
const putHabit = async (event, context, idRaw) => {
  const startedAt = Date.now();

  const uid = resolveUid(context);
  if (!uid) return reply(401, '登录状态失效，请刷新页面', null);

  const clientId = String(idRaw === undefined || idRaw === null ? '' : idRaw);
  if (!isClientId(clientId)) return reply(400, '打卡 id 不合法', null);

  const body = pickBody(event);
  if (body === null) return reply(400, '请求体不是合法的 JSON', null);

  // 路径里的 id 是权威的：body 里就算带了 id 也不采信（防止"路径改 A、内容改 B"）
  const parsed = parseHabit(Object.assign({}, body, { id: clientId }), '');
  if (parsed.error) return reply(400, parsed.error, null);

  try {
    const habit = await db.saveHabit(uid, parsed.habit);
    logWrite('保存打卡成功', { uid: uid, perDay: parsed.habit.perDay,
                             code: 0, ms: Date.now() - startedAt });
    return reply(0, '已保存', habit);
  } catch (err) {
    console.error('[api] 保存打卡失败：' + err.message);
    return reply(500, '打卡没存上，稍后再试一次', null);
  }
};

/**
 * DELETE /api/habits/:clientId —— 删除一条打卡**及其全部记录**（契约 4.11）
 *
 * 不做软删除：用户点删除就是"这个习惯我不要了"，留下的孤儿日志没有意义
 * （理由写在 db.js 的 remove 注释里）。重复删除返回成功（幂等），前端重试不发愁。
 */
const deleteHabit = async (event, context, idRaw) => {
  const startedAt = Date.now();

  const uid = resolveUid(context);
  if (!uid) return reply(401, '登录状态失效，请刷新页面', null);

  const clientId = String(idRaw === undefined || idRaw === null ? '' : idRaw);
  if (!isClientId(clientId)) return reply(400, '打卡 id 不合法', null);

  try {
    const deleted = await db.deleteHabit(uid, clientId);
    logWrite('删除打卡', { uid: uid, rows: deleted, code: 0, ms: Date.now() - startedAt });
    // deleted = 0 也回成功：这条本来就不在云上（可能从没同步过，或是重复删除）——
    // 用户的目的"让它在列表里消失"已经由本机删除达成了，没必要让他看见一个红叉。
    return reply(0, '已删除', { id: clientId, removed: deleted });
  } catch (err) {
    console.error('[api] 删除打卡失败：' + err.message);
    return reply(500, '删除没成功，稍后再试一次', null);
  }
};

/**
 * PUT /api/habits/:clientId/logs/:date —— 设置某天打了多少次（契约 4.12）
 *
 * 为什么是 PUT 而不是 POST(+1)：次数是"那一天的事实值"，不是"又来了一次"。
 * 前端本地改完立刻把新值整条送上去，重发、乱序、并发都不会把次数叠错。
 * count = 0 表示撤回干净 → 直接删掉那行。
 */
const putHabitLog = async (event, context, idRaw, dateRaw) => {
  const startedAt = Date.now();

  const uid = resolveUid(context);
  if (!uid) return reply(401, '登录状态失效，请刷新页面', null);

  const clientId = String(idRaw === undefined || idRaw === null ? '' : idRaw);
  if (!isClientId(clientId)) return reply(400, '打卡 id 不合法', null);

  const date = String(dateRaw === undefined || dateRaw === null ? '' : dateRaw);
  if (!isDate(date)) return reply(400, '日期格式不对，应为 YYYY-MM-DD', null);

  const body = pickBody(event);
  if (body === null) return reply(400, '请求体不是合法的 JSON', null);

  const count = Number(body.count);
  if (!Number.isInteger(count) || count < 0 || count > MAX_PER_DAY) {
    return reply(400, '次数必须是 0~' + MAX_PER_DAY + ' 的整数', null);
  }

  try {
    const saved = await db.saveHabitLog(uid, clientId, date, count);
    logWrite('打卡计数', { uid: uid, date: date, count: saved, code: 0,
                          ms: Date.now() - startedAt });
    return reply(0, '已记录', { id: clientId, date: date, count: saved });
  } catch (err) {
    console.error('[api] 写打卡次数失败：' + err.message);
    return reply(500, '这次打卡没记到云端，稍后再试一次', null);
  }
};

/**
 * POST /api/habits/import —— 把本机已有的打卡一次性搬上云（契约 4.13）
 *
 * 前端只在第一次连上云端时调一次（成功后打 meta.habitsSynced 标记）。
 * 请求体：{ habits: [...], logs: [{ id, date, count }] }，两者都可省略，但不能都为空。
 * 校验是"整批要么全过、要么全拒"：一批几十条，错一条就说不清到底搬了什么，
 * 不如让前端先修好再来（前端的迁移函数会先把明显不合规的筛掉）。
 */
const importHabits = async (event, context) => {
  const startedAt = Date.now();

  const uid = resolveUid(context);
  if (!uid) return reply(401, '登录状态失效，请刷新页面', null);

  const body = pickBody(event);
  if (body === null) return reply(400, '请求体不是合法的 JSON', null);

  const rawHabits = body.habits === undefined ? [] : body.habits;
  const rawLogs = body.logs === undefined ? [] : body.logs;
  if (!Array.isArray(rawHabits) || !Array.isArray(rawLogs)) {
    return reply(400, 'habits 与 logs 都必须是数组', null);
  }
  if (!rawHabits.length && !rawLogs.length) {
    return reply(400, '没有可以搬的打卡', null);
  }
  if (rawHabits.length > MAX_HABIT_IMPORT) {
    return reply(400, '一次最多搬 ' + MAX_HABIT_IMPORT + ' 条打卡', null);
  }
  if (rawLogs.length > MAX_HABIT_LOG_IMPORT) {
    return reply(400, '一次最多搬 ' + MAX_HABIT_LOG_IMPORT + ' 条打卡记录', null);
  }

  const habits = [];
  const seenHabit = new Set();
  for (let i = 0; i < rawHabits.length; i++) {
    const parsed = parseHabit(rawHabits[i], '第 ' + (i + 1) + ' 条');
    if (parsed.error) return reply(400, parsed.error, null);
    if (seenHabit.has(parsed.habit.id)) return reply(400, '第 ' + (i + 1) + ' 条打卡 id 重复', null);
    seenHabit.add(parsed.habit.id);
    habits.push(parsed.habit);
  }

  // 打卡次数：同 (id, date) 只留最后一条 —— PostgREST 的 upsert 不允许
  // 一条语句里两次影响同一行（会报 "ON CONFLICT DO UPDATE command cannot affect row a second time"）
  const logMap = new Map();
  for (let i = 0; i < rawLogs.length; i++) {
    const it = rawLogs[i] || {};
    const id = String(it.id === undefined || it.id === null ? '' : it.id);
    if (!isClientId(id)) return reply(400, '第 ' + (i + 1) + ' 条记录的打卡 id 不合法', null);
    const date = String(it.date === undefined || it.date === null ? '' : it.date);
    if (!isDate(date)) return reply(400, '第 ' + (i + 1) + ' 条记录的日期格式不对，应为 YYYY-MM-DD', null);
    const count = Number(it.count);
    if (!Number.isInteger(count) || count < 1 || count > MAX_PER_DAY) {
      return reply(400, '第 ' + (i + 1) + ' 条记录的次数必须是 1~' + MAX_PER_DAY + ' 的整数', null);
    }
    logMap.set(id + '@' + date, { id: id, date: date, count: count });
  }
  const logs = [];
  logMap.forEach((v) => logs.push(v));

  try {
    const habitRows = habits.length ? await db.saveHabitsBulk(uid, habits) : 0;
    const logRows = logs.length ? await db.saveHabitLogsBulk(uid, logs) : 0;
    logWrite('导入本机打卡', { uid: uid, habits: habitRows, logs: logRows,
                              code: 0, ms: Date.now() - startedAt });
    return reply(0, '已导入', { habits: habitRows, logs: logRows });
  } catch (err) {
    console.error('[api] 导入打卡失败：' + err.message);
    return reply(500, '打卡没搬完，稍后再试一次', null);
  }
};

// ===========================================================================
// 六、路由表
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

  // Day 29 十三轮：本机历史心情一次性迁移（固定路径，先于带参路由命中）
  'POST /api/day/moods': importMoods,

  // Day 29 十四轮：打卡（定义 + 每日次数）
  'GET /api/habits': listHabits,
  // 「导入」写在固定路由表里，才不会先被 PUT/DELETE /api/habits/:clientId 抢走
  'POST /api/habits/import': importHabits,
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
  // Day 29 十三轮：路径里带的是**日期**（YYYY-MM-DD），不是自增 id —— 正则同样用 ([^/]+)，
  // 让 2026-13-99 这种也能命中路由，好回一句"日期格式不对"，而不是笼统的 404。
  { method: 'PUT', re: /^\/api\/day\/([^/]+)\/mood$/, handler: putMood },

  // Day 29 十四轮：打卡。注意顺序 —— 带 /logs/ 的那条（两个参数）必须排在
  // 单参数的那条**前面**，否则 /api/habits/h123/logs/2026-10-27 会先被单参数正则
  // 匹配失败……实际上单参数正则用的是 ([^/]+)$（末尾不许有斜杠），本来就匹配不上，
  // 但把更具体的路由放前面是更稳的习惯，将来谁改了正则也不会踩。
  { method: 'PUT', re: /^\/api\/habits\/([^/]+)\/logs\/([^/]+)$/, handler: putHabitLog },
  { method: 'PUT', re: /^\/api\/habits\/([^/]+)$/, handler: putHabit },
  { method: 'DELETE', re: /^\/api\/habits\/([^/]+)$/, handler: deleteHabit },
];
// 注：不再有 allRoutes() —— Day 27 把 404 收口成最小响应后，路由清单的
// 唯一权威是 api-contract.md，云函数不再向请求方输出它。

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
    let idRaw2 = null;

    // ② 带参数路径：正则命中，把参数从路径里抽出来
    //    Day 29 十四轮起可能有**两个**参数（/api/habits/:id/logs/:date），
    //    所以把整个匹配结果都取出来，第二个捕获组按需传给处理函数。
    if (!handler) {
      const hit = idRoutes.find((r) => r.method === method && r.re.test(path));
      if (hit) {
        handler = hit.handler;
        const m = path.match(hit.re);
        idRaw = m[1];
        idRaw2 = m.length > 2 ? m[2] : null;
      }
    }

    if (!handler) {
      // 404 只回一句中文 —— Day 27 收口：
      //   ① 不再回 availableRoutes + 版本号：原实现等于把"接口地图"白送给任何
      //      探测者（实测 /api/nope 能拿到全部 6 条路由 + 0.5.0），信息泄露；
      //   ② 也不再原样回显请求路径：路径是用户输入，回显虽经前端 textContent
      //      渲染不会执行，但对其它消费方不设防，没必要留。
      // 调试去哪找：路由清单看 api-contract.md；服务端日志有下面这行未命中记录。
      const safePath = String(path).replace(/[\r\n\t]/g, ' ').slice(0, 120);
      console.log('[api] 未命中路由：' + method + ' ' + safePath);
      return reply(404, '接口不存在', null);
    }
    // 顺手打一行日志：出错时在 CloudBase 控制台"日志"里能看到每次请求的方法和路径
    console.log('[api] ' + method + ' ' + path + ' 命中路由，uid=' +
                (resolveUid(context) || '匿名未注入'));
    return await handler(event, context, idRaw, idRaw2);
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
exports.pickBody = pickBody;
exports.isDate = isDate;
exports.isTime = isTime;
exports.isReqId = isReqId;
exports.parseId = parseId;
exports.isClientId = isClientId;
exports.parsePerDay = parsePerDay;
exports.parseHabit = parseHabit;
exports.todayLocal = todayLocal;
