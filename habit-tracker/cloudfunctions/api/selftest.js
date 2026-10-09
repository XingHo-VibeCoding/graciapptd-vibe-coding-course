/**
 * 自律计划 · 云函数 api 本地自测（Day 17 建立，Day 18 补写入路径，Day 19 补分层）
 * ---------------------------------------------------------------------------
 * 作用：**不联网、不连数据库**，把云函数的五种东西验证一遍——
 *   1) 路由：路径/方法能不能命中，未命中会不会回 404 且列出可用路由
 *   2) 参数校验与身份：非法日期、互斥参数、limit 越界、缺必填字段、未取到身份 → 各自的错误码
 *   3) 数据库交互：拼出来的 SQL 查询串 / 写入体对不对 + 数据库回的行有没有被正确映射成契约形状
 *   4) 写入防护：重复提交（预检 + 唯一索引兜底两条路径）会不会都被拦住并回 409
 *   5) 分层（Day 19）：数据库代码是不是真的搬去了 db.js，且数据访问层能脱离路由独立工作
 *
 * 怎么做到的：把全局 fetch 换成一个假的（stub），既能记录"你请求了哪个 URL / 什么方法 / 写了什么"，
 *   又能返回我们指定的假数据。所以它是**纯本地、可重复、秒级**的。
 *
 * 怎么跑（在 habit-tracker/cloudfunctions/api 目录下）：
 *   node selftest.js
 * 退出码 0 = 全过。
 */

const api = require('./index.js');
const db = require('./db.js');   // Day 19 拆出来的数据访问层：这一层要能脱离路由单独测
const fs = require('fs');
const path = require('path');

process.env.TCB_ENV = 'test-env-id';
process.env.CLOUDBASE_API_KEY = 'test-api-key';
process.env.DEMO_UID = 'seed-demo-user';

// 云函数里每次请求都会 console.log 一行、出错会 console.error 一段栈；
// 自测会有意触发大量错误路径，日志会淹掉结果，所以测试期间静音（最后恢复）。
const realLog = console.log;
const realError = console.error;
console.log = () => {};
console.error = () => {};

// ---------------------------------------------------------------------------
// 极简测试框架
// ---------------------------------------------------------------------------
let pass = 0;
const fails = [];
const ok = (name, cond, extra) => {
  if (cond) {
    pass++;
  } else {
    fails.push(name + (extra ? '  → ' + extra : ''));
  }
};
const eq = (name, actual, expect) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expect),
     '实际 ' + JSON.stringify(actual) + '，期望 ' + JSON.stringify(expect));

// ---------------------------------------------------------------------------
// 假数据库：记录请求 URL，按 URL 里的表名返回假数据
// ---------------------------------------------------------------------------
let captured = [];   // 每次请求的 URL 与表名
let responder = null; // (url) => { rows, total }
let realFetch = global.fetch;

const installFakeFetch = () => {
  captured = [];
  global.fetch = async (url, init) => {
    const u = String(url);
    const table = u.split('?')[0].split('/').pop();
    captured.push({
      url: u,
      table: table,
      headers: (init && init.headers) || {},
      method: String((init && init.method) || 'GET').toUpperCase(),
      body: init && init.body,           // 写入时用于断言"到底往库里写了什么"
    });
    // 把 init 也交给 responder：写接口需要按「方法」返回不同结果
    const { rows, total, status, body } = responder(u, table, init || {});
    if (status && status !== 200) {
      return {
        ok: false, status: status,
        headers: { get: () => null },
        text: async () => JSON.stringify(body || { message: 'db error' }),
      };
    }
    const realTotal = total === undefined ? rows.length : total;
    return {
      ok: true, status: 200,
      headers: { get: (k) => (String(k).toLowerCase() === 'content-range' ? '0-' + (rows.length - 1) + '/' + realTotal : null) },
      text: async () => JSON.stringify(rows),
    };
  };
};

/** 取出某次请求写入的 JSON 体（无体 / 不是 JSON 时返回 null） */
const bodyOf = (index) => {
  const raw = captured[index].body;
  if (raw === undefined || raw === null || raw === '') return null;
  try {
    return JSON.parse(String(raw));
  } catch (e) {
    return null;
  }
};

/** 取出某次请求 URL 的查询参数（重复键会全部保留，方便断言区间查询） */
const paramsOf = (index) => {
  const qs = captured[index].url.split('?')[1] || '';
  const map = {};
  qs.split('&').filter(Boolean).forEach((kv) => {
    const [k, v] = kv.split('=');
    const key = decodeURIComponent(k);
    const val = decodeURIComponent(v || '');
    map[key] = map[key] === undefined ? val : [].concat(map[key], val);
  });
  return map;
};

const call = (event) => api.main(event, event.__context || {});

// ---------------------------------------------------------------------------
// 准备假数据
// ---------------------------------------------------------------------------
const PLAN_ROW = { date: '2026-10-01', mood: 'calm', created_at: '2026-10-01T01:00:00+00:00', updated_at: '2026-10-01T01:00:00+00:00' };
const CHECKIN_ROWS = [
  { id: 101, date: '2026-10-01', text: '晨跑 30 分钟', time: '07:30', quad: 'q2', done: true, done_at: '2026-10-01T00:02:00+00:00', sort: 0 },
  { id: 102, date: '2026-10-01', text: '写周报', time: null, quad: null, done: false, done_at: null, sort: 1 },
];
/** 假数据库"刚插入的那一行" */
const NEW_ROW = {
  id: 901, date: '2026-10-01', text: '写周报', time: '14:00', quad: 'q2',
  done: false, done_at: null, sort: 5,
};

/**
 * 写接口（POST /api/checkins）用的假数据库。
 * 同一个表会被三种请求打到，靠「方法 + URL」区分：
 *   · POST（写入）        → 返回"刚插入的那一行"
 *   · GET 带 client_req_id → 幂等预检（默认"没写过"）
 *   · GET 其它（查排序位）  → 返回当天最大 sort
 * opt：
 *   row / insertEmpty       —— 写入返回什么（默认 NEW_ROW；insertEmpty=true 模拟网关不回传）
 *   insertStatus/insertBody —— 模拟写入失败（如 409 + 23505 唯一冲突）
 *   dupRows                 —— 预检查到"已经写过"的行
 *   maxSortRows             —— 当天最大排序位
 */
const writeResponder = (opt) => {
  const o = opt || {};
  return (u, table, init) => {
    const isPost = String((init && init.method) || 'GET').toUpperCase() === 'POST';
    if (isPost) {
      if (o.insertStatus) return { status: o.insertStatus, body: o.insertBody };
      if (o.insertEmpty) return { rows: [] };
      return { rows: [o.row || NEW_ROW] };
    }
    if (u.indexOf('client_req_id') > -1) return { rows: o.dupRows || [] };
    return { rows: o.maxSortRows === undefined ? [{ sort: 4 }] : o.maxSortRows };
  };
};

(async () => {
  // =========================================================================
  // 一、路由与健康检查
  // =========================================================================
  installFakeFetch();
  responder = () => ({ rows: [] });

  let r = await call({ httpMethod: 'GET', path: '/api/health' });
  eq('health：扁平返回，不走信封', r, { ok: true, service: 'Self discipline plan' });

  r = await call({ httpMethod: 'GET', path: '/api/health/' });
  eq('health：末尾斜杠也能命中', r.ok, true);

  r = await call({ httpMethod: 'GET', path: '/health' });   // 平台剥掉 /api 前缀
  eq('health：平台剥掉 /api 前缀也能命中', r.ok, true);

  r = await call({ httpMethod: 'GET', path: '/api/nope' });
  eq('未命中路由：回 404 信封', r.code, 404);
  ok('未命中路由：message 带出路径', r.message.indexOf('/api/nope') > -1);
  ok('404 里列出可用路由', Array.isArray(r.data.availableRoutes) && r.data.availableRoutes.indexOf('GET /api/day') > -1,
     JSON.stringify(r.data));

  r = await call({ httpMethod: 'POST', path: '/api/health' });
  eq('方法不对：回 404（健康检查只认 GET）', r.code, 404);

  // =========================================================================
  // 二、身份（契约 1.4：前端不许明传 uid）
  // =========================================================================
  installFakeFetch();
  responder = () => ({ rows: [] });
  delete process.env.DEMO_UID;
  r = await call({ httpMethod: 'GET', path: '/api/day', queryStringParameters: { date: '2026-10-01' } });
  eq('拿不到身份：回 401', r.code, 401);
  eq('拿不到身份：不得查数据库', captured.length, 0);
  process.env.DEMO_UID = 'seed-demo-user';

  installFakeFetch();
  responder = () => ({ rows: [] });
  r = await call({
    httpMethod: 'GET', path: '/api/day', queryStringParameters: { date: '2026-10-01' },
    __context: { userInfo: { uid: 'real-user-uid' } },
  });
  eq('有登录身份时优先用登录 uid', paramsOf(0).uid, 'eq.real-user-uid');

  r = await call({ httpMethod: 'GET', path: '/api/day', queryStringParameters: { date: '2026-10-01', uid: 'hacker' } });
  ok('请求参数里的 uid 被忽略（防越权）',
     captured.every((c) => c.url.indexOf('hacker') === -1), JSON.stringify(captured.map((c) => c.url)));

  // =========================================================================
  // 三、GET /api/day —— 首屏合并读取
  // =========================================================================
  installFakeFetch();
  responder = (url, table) => (table === 'plan_days' ? { rows: [PLAN_ROW] } : { rows: CHECKIN_ROWS });

  r = await call({ httpMethod: 'GET', path: '/api/day', queryStringParameters: { date: '2026-10-01' } });
  eq('day：走信封', r.code, 0);
  eq('day：请求了两张表', captured.map((c) => c.table), ['plan_days', 'checkins']);
  eq('day：data.date 原样回传', r.data.date, '2026-10-01');
  eq('day：planDay 字段映射（snake→camel、时间戳转毫秒）', r.data.planDay, {
    date: '2026-10-01', mood: 'calm',
    createdAt: Date.parse(PLAN_ROW.created_at), updatedAt: Date.parse(PLAN_ROW.updated_at),
  });
  eq('day：checkins 条数', r.data.checkins.length, 2);
  eq('day：打卡项字段映射', r.data.checkins[0], {
    id: 101, date: '2026-10-01', text: '晨跑 30 分钟', time: '07:30', quad: 'q2',
    done: true, doneAt: Date.parse('2026-10-01T00:02:00+00:00'), sort: 0,
  });
  eq('day：未完成项的 doneAt 为 null', r.data.checkins[1].doneAt, null);
  eq('day：未分类项 quad 为 null', r.data.checkins[1].quad, null);
  ok('day：checkins 按 sort 排（order 参数下发）', paramsOf(1).order === 'sort.asc,id.asc', JSON.stringify(paramsOf(1)));
  ok('day：带上 select 只取需要的列', paramsOf(1).select === 'id,date,text,time,quad,done,done_at,sort');
  ok('day：带 uid 条件（防越权）', paramsOf(1).uid === 'eq.seed-demo-user');

  installFakeFetch();
  responder = (url, table) => (table === 'plan_days' ? { rows: [] } : { rows: [] });
  r = await call({ httpMethod: 'GET', path: '/api/day', queryStringParameters: { date: '2026-10-01' } });
  eq('day：这天没记录时 planDay 为 null（不是错误）', r.data.planDay, null);
  eq('day：没记录时 checkins 是空数组', r.data.checkins, []);

  installFakeFetch();
  responder = (url, table) => (table === 'plan_days' ? { rows: [PLAN_ROW] } : { rows: [] });
  r = await call({ httpMethod: 'GET', path: '/api/day' });   // 不传 date
  ok('day：不传 date 时默认服务端今天（东八区）',
     paramsOf(0).date === 'eq.' + api.todayLocal() && /^\d{4}-\d{2}-\d{2}$/.test(r.data.date),
     r.data.date);

  // =========================================================================
  // 四、参数校验
  // =========================================================================
  installFakeFetch();
  responder = () => ({ rows: [] });

  r = await call({ httpMethod: 'GET', path: '/api/day', queryStringParameters: { date: '2026/10/01' } });
  eq('day：非法日期格式 → 400', r.code, 400);
  eq('day：非法日期的提示文案', r.message, '日期格式不对，应为 YYYY-MM-DD');

  r = await call({ httpMethod: 'GET', path: '/api/day', queryStringParameters: { date: '2026-02-30' } });
  eq('day：不存在的日期（2 月 30 日）→ 400', r.code, 400);

  eq('校验不过时一次数据库都不查', captured.length, 0);

  r = await call({ httpMethod: 'GET', path: '/api/day', queryStringParameters: { date: '2024-02-29' } });
  eq('day：闰年 2 月 29 日是合法日期', r.code, 0);

  // =========================================================================
  // 五、GET /api/checkins —— 列表读取（含余力加练的 limit）
  // =========================================================================
  installFakeFetch();
  responder = () => ({ rows: CHECKIN_ROWS, total: 8 });

  r = await call({ httpMethod: 'GET', path: '/api/checkins', queryStringParameters: { date: '2026-10-01' } });
  eq('checkins：走信封', r.code, 0);
  eq('checkins：默认 limit = 20', paramsOf(0).limit, '20');
  eq('checkins：total 来自 Content-Range（不是本页条数）', r.data.total, 8);
  eq('checkins：limit 跟随返回', r.data.limit, 20);
  eq('checkins：items 条数 = 本页行数', r.data.items.length, 2);
  eq('checkins：单日查询下发的条件', paramsOf(0).date, 'eq.2026-10-01');

  installFakeFetch();
  responder = () => ({ rows: CHECKIN_ROWS, total: 2 });
  r = await call({ httpMethod: 'GET', path: '/api/checkins', queryStringParameters: { limit: '2' } });
  eq('checkins：自定义 limit 生效', paramsOf(0).limit, '2');
  eq('checkins：返回里回显 limit', r.data.limit, 2);

  installFakeFetch();
  responder = () => ({ rows: [], total: 0 });
  await call({ httpMethod: 'GET', path: '/api/checkins', queryStringParameters: { from: '2026-09-25', to: '2026-10-01' } });
  eq('checkins：区间查询下发"同列两个条件"（gte + lte）', paramsOf(0).date, ['gte.2026-09-25', 'lte.2026-10-01']);

  installFakeFetch();
  responder = () => ({ rows: [], total: 0 });
  await call({ httpMethod: 'GET', path: '/api/checkins', queryStringParameters: { done: 'false' } });
  eq('checkins：done=false 下发 is.false', paramsOf(0).done, 'is.false');

  installFakeFetch();
  responder = () => ({ rows: [], total: 0 });
  await call({ httpMethod: 'GET', path: '/api/checkins', queryStringParameters: { from: '2026-09-25' } });
  eq('checkins：只传 from 时下发单个 gte', paramsOf(0).date, 'gte.2026-09-25');

  installFakeFetch();
  responder = () => ({ rows: [], total: 0 });
  await call({ httpMethod: 'GET', path: '/api/checkins', queryStringParameters: { to: '2026-10-01' } });
  eq('checkins：只传 to 时下发单个 lte', paramsOf(0).date, 'lte.2026-10-01');

  installFakeFetch();
  responder = () => ({ rows: [], total: 0 });
  await call({ httpMethod: 'GET', path: '/api/checkins', queryStringParameters: { from: '2026-09-30' } });
  ok('checkins：默认按 日期→sort→id 升序', paramsOf(0).order === 'date.asc,sort.asc,id.asc');
  ok('checkins：查询必带 uid', paramsOf(0).uid === 'eq.seed-demo-user');

  // —— limit 边界 ——
  for (const bad of ['0', '-1', '101', 'abc', '2.5']) {
    installFakeFetch();
    responder = () => ({ rows: [], total: 0 });
    r = await call({ httpMethod: 'GET', path: '/api/checkins', queryStringParameters: { limit: bad } });
    eq('checkins：limit=' + bad + ' → 400', r.code, 400);
    eq('checkins：limit=' + bad + ' 时不查库', captured.length, 0);
  }
  installFakeFetch();
  responder = () => ({ rows: [], total: 0 });
  r = await call({ httpMethod: 'GET', path: '/api/checkins', queryStringParameters: { limit: '100' } });
  eq('checkins：limit=100（上限）合法', r.code, 0);

  // —— 互斥与顺序 ——
  installFakeFetch();
  responder = () => ({ rows: [], total: 0 });
  r = await call({ httpMethod: 'GET', path: '/api/checkins', queryStringParameters: { date: '2026-10-01', from: '2026-09-01' } });
  eq('checkins：date 与 from 同传 → 400', r.code, 400);

  installFakeFetch();
  responder = () => ({ rows: [], total: 0 });
  r = await call({ httpMethod: 'GET', path: '/api/checkins', queryStringParameters: { from: '2026-10-02', to: '2026-10-01' } });
  eq('checkins：from 晚于 to → 400', r.code, 400);

  installFakeFetch();
  responder = () => ({ rows: [], total: 0 });
  r = await call({ httpMethod: 'GET', path: '/api/checkins', queryStringParameters: { done: 'yes' } });
  eq('checkins：done 非 true/false → 400', r.code, 400);

  // =========================================================================
  // 六、POST /api/checkins —— 新建打卡项（Day 18）
  // =========================================================================

  // —— 正常写入 ——
  installFakeFetch();
  responder = writeResponder({});
  r = await call({
    httpMethod: 'POST', path: '/api/checkins',
    body: JSON.stringify({ date: '2026-10-01', text: '写周报', time: '14:00', quad: 'q2' }),
  });
  eq('POST：走信封且成功', r.code, 0);
  eq('POST：成功文案', r.message, '已添加');
  eq('POST：返回新建的那一行（契约形状）', r.data, {
    id: 901, date: '2026-10-01', text: '写周报', time: '14:00', quad: 'q2',
    done: false, doneAt: null, sort: 5,
  });
  eq('POST：先查排序位再写入（两次库操作）', captured.map((c) => c.method), ['GET', 'POST']);
  eq('POST：查当天最大排序位（select=sort，order=sort.desc）',
     [paramsOf(0).select, paramsOf(0).order, paramsOf(0).date, paramsOf(0).uid],
     ['sort', 'sort.desc', 'eq.2026-10-01', 'eq.seed-demo-user']);
  eq('POST：写库的列（snake_case、uid 由服务端补、未启用幂等时不带 client_req_id）',
     bodyOf(1), { uid: 'seed-demo-user', date: '2026-10-01', text: '写周报', time: '14:00', quad: 'q2', done: false, sort: 5 });
  eq('POST：请求头声明要回传插入的行', captured[1].headers.Prefer, 'return=representation');

  // —— 排序位计算 ——
  installFakeFetch();
  responder = writeResponder({ maxSortRows: [] });
  await call({ httpMethod: 'POST', path: '/api/checkins', body: JSON.stringify({ date: '2026-10-01', text: '第一条' }) });
  eq('POST：当天没有任何待办时 sort 从 0 开始', bodyOf(1).sort, 0);

  installFakeFetch();
  responder = writeResponder({ maxSortRows: [{ sort: 11 }] });
  await call({ httpMethod: 'POST', path: '/api/checkins', body: JSON.stringify({ date: '2026-10-01', text: '接在最后' }) });
  eq('POST：sort = 当天最大 sort + 1（接在最后）', bodyOf(1).sort, 12);

  // —— text 规范化 ——
  installFakeFetch();
  responder = writeResponder({});
  await call({ httpMethod: 'POST', path: '/api/checkins', body: JSON.stringify({ date: '2026-10-01', text: '   写周报   ' }) });
  eq('POST：存进去的是去掉首尾空白后的内容', bodyOf(1).text, '写周报');

  installFakeFetch();
  responder = writeResponder({});
  r = await call({ httpMethod: 'POST', path: '/api/checkins', body: JSON.stringify({ date: '2026-10-01', text: '啊'.repeat(60) }) });
  eq('POST：正好 60 字合法（边界）', r.code, 0);

  // —— 缺必填 / 非法值：一律 400 + 中文，且一个字都不写库 ——
  const badCases = [
    ['缺 text', { date: '2026-10-01' }, '缺少必填字段 text（待办内容）'],
    ['text 是空串', { date: '2026-10-01', text: '' }, '内容不能为空，且不超过 60 字'],
    ['text 全是空格', { date: '2026-10-01', text: '    ' }, '内容不能为空，且不超过 60 字'],
    ['text 超 60 字', { date: '2026-10-01', text: '啊'.repeat(61) }, '内容不能为空，且不超过 60 字'],
    ['text 不是字符串', { date: '2026-10-01', text: 123 }, '内容不能为空，且不超过 60 字'],
    ['缺 date', { text: '写周报' }, '缺少必填字段 date（这条待办属于哪一天）'],
    ['date 格式不对', { date: '2026/10/01', text: '写周报' }, '日期格式不对，应为 YYYY-MM-DD'],
    ['date 不存在（2 月 30 日）', { date: '2026-02-30', text: '写周报' }, '日期格式不对，应为 YYYY-MM-DD'],
    ['time 格式不对', { date: '2026-10-01', text: '写周报', time: '25:00' }, '时间格式不对，应为 HH:mm（24 小时制）'],
    ['time 缺前导零', { date: '2026-10-01', text: '写周报', time: '9:30' }, '时间格式不对，应为 HH:mm（24 小时制）'],
    ['quad 非法', { date: '2026-10-01', text: '写周报', quad: 'q5' }, '象限只能是 q1 / q2 / q3 / q4'],
    ['clientReqId 含非法字符', { date: '2026-10-01', text: '写周报', clientReqId: 'has space' },
      'clientReqId 只能是 1~64 位的字母、数字、下划线或短横线'],
  ];
  for (const [name, body, msg] of badCases) {
    installFakeFetch();
    responder = writeResponder({});
    r = await call({ httpMethod: 'POST', path: '/api/checkins', body: JSON.stringify(body) });
    eq('POST：' + name + ' → 400', r.code, 400);
    eq('POST：' + name + ' 的中文提示', r.message, msg);
    eq('POST：' + name + ' 时一次库都不查', captured.length, 0);
  }

  // —— 可选字段留空 = 存 NULL ——
  installFakeFetch();
  responder = writeResponder({});
  await call({ httpMethod: 'POST', path: '/api/checkins', body: JSON.stringify({ date: '2026-10-01', text: '泡脚放松' }) });
  eq('POST：不传 time/quad 时存 NULL（不是空串）', [bodyOf(1).time, bodyOf(1).quad], [null, null]);

  installFakeFetch();
  responder = writeResponder({});
  await call({ httpMethod: 'POST', path: '/api/checkins', body: JSON.stringify({ date: '2026-10-01', text: '泡脚放松', time: '', quad: '' }) });
  eq('POST：time/quad 传空串也当没传（存 NULL）', [bodyOf(1).time, bodyOf(1).quad], [null, null]);

  // —— 请求体的三种来源 ——
  installFakeFetch();
  responder = writeResponder({});
  r = await call({ httpMethod: 'POST', path: '/api/checkins', body: '{这不是 JSON' });
  eq('POST：请求体不是合法 JSON → 400', r.code, 400);
  eq('POST：非法 JSON 的中文提示', r.message, '请求体不是合法的 JSON');
  eq('POST：非法 JSON 时不写库', captured.length, 0);

  installFakeFetch();
  responder = writeResponder({});
  r = await call({
    httpMethod: 'POST', path: '/api/checkins',
    isBase64Encoded: true,
    body: Buffer.from(JSON.stringify({ date: '2026-10-01', text: 'base64 来的' }), 'utf8').toString('base64'),
  });
  eq('POST：网关 base64 编码的请求体能正确解码', r.code, 0);
  eq('POST：base64 解码后的内容正确', bodyOf(1).text, 'base64 来的');

  installFakeFetch();
  responder = writeResponder({});
  await call({ httpMethod: 'POST', path: '/api/checkins', date: '2026-10-01', text: '控制台直接触发' });
  eq('POST：控制台把字段摊在 event 顶层也能写入', bodyOf(1).text, '控制台直接触发');

  // —— 身份（写入同样不许明传 uid）——
  installFakeFetch();
  responder = writeResponder({});
  delete process.env.DEMO_UID;
  r = await call({ httpMethod: 'POST', path: '/api/checkins', body: JSON.stringify({ date: '2026-10-01', text: '写周报' }) });
  eq('POST：拿不到身份 → 401', r.code, 401);
  eq('POST：拿不到身份时不写库', captured.length, 0);
  process.env.DEMO_UID = 'seed-demo-user';

  installFakeFetch();
  responder = writeResponder({});
  await call({
    httpMethod: 'POST', path: '/api/checkins',
    body: JSON.stringify({ date: '2026-10-01', text: '写周报', uid: 'hacker' }),
    __context: { userInfo: { uid: 'real-user-uid' } },
  });
  eq('POST：写库的 uid 取登录身份，请求体里伪造的 uid 被忽略', bodyOf(1).uid, 'real-user-uid');

  // =========================================================================
  // 七、重复提交防护（Day 18 的核心）
  // =========================================================================

  // —— 第一层：服务层预检 ——
  installFakeFetch();
  responder = writeResponder({});
  r = await call({
    httpMethod: 'POST', path: '/api/checkins',
    body: JSON.stringify({ date: '2026-10-01', text: '写周报', clientReqId: 'req-abc-001' }),
  });
  eq('幂等：第一次带 clientReqId 正常写入', r.code, 0);
  eq('幂等：带 key 时先预检再排序再写入', captured.map((c) => c.method), ['GET', 'GET', 'POST']);
  eq('幂等：预检按 (uid, client_req_id) 查', [paramsOf(0).uid, paramsOf(0).client_req_id], ['eq.seed-demo-user', 'eq.req-abc-001']);
  eq('幂等：写库时带上 client_req_id', bodyOf(2).client_req_id, 'req-abc-001');

  installFakeFetch();
  responder = writeResponder({ dupRows: [{ id: 901 }] });
  r = await call({
    httpMethod: 'POST', path: '/api/checkins',
    body: JSON.stringify({ date: '2026-10-01', text: '写周报', clientReqId: 'req-abc-001' }),
  });
  eq('幂等：同一个 clientReqId 再提交 → 409', r.code, 409);
  eq('幂等：重复提交的中文提示', r.message, '请勿重复提交：这条待办刚刚已经添加过了');
  eq('幂等：重复提交时 data 为 null（契约 1.2）', r.data, null);
  eq('幂等：预检拦住后不再写库', captured.length, 1);

  installFakeFetch();
  responder = writeResponder({ dupRows: [{ id: 901 }] });
  r = await call({
    httpMethod: 'POST', path: '/api/checkins',
    headers: { 'Idempotency-Key': 'header-key-9' },
    body: JSON.stringify({ date: '2026-10-01', text: '写周报' }),
  });
  eq('幂等：请求头 Idempotency-Key 同样生效 → 409', r.code, 409);

  installFakeFetch();
  responder = writeResponder({});
  r = await call({
    httpMethod: 'POST', path: '/api/checkins',
    body: JSON.stringify({ date: '2026-10-01', text: '写周报', clientReqId: 'different-key' }),
  });
  eq('幂等：内容相同但 clientReqId 不同 = 两次不同的添加动作，允许写入', r.code, 0);

  // —— 第二层：数据库唯一索引兜底（并发下预检会漏，这一层才是真闸）——
  installFakeFetch();
  responder = writeResponder({
    insertStatus: 409,
    insertBody: { code: '23505', message: 'duplicate key value violates unique constraint "checkins_uid_reqid_uniq"' },
  });
  r = await call({
    httpMethod: 'POST', path: '/api/checkins',
    body: JSON.stringify({ date: '2026-10-01', text: '写周报', clientReqId: 'race-key' }),
  });
  eq('幂等：唯一索引冲突（23505）被翻译成 409，而不是 500', r.code, 409);
  eq('幂等：唯一索引兜底的提示与服务层一致', r.message, '请勿重复提交：这条待办刚刚已经添加过了');

  // —— 网关切走"回传插入行"时的读回兜底 ——
  installFakeFetch();
  responder = (u, table, init) => {
    if (String((init && init.method) || 'GET').toUpperCase() === 'POST') return { rows: [] };
    if (u.indexOf('order=id.desc') > -1) return { rows: [NEW_ROW] };   // 读回的查询
    return { rows: [{ sort: 4 }] };
  };
  r = await call({ httpMethod: 'POST', path: '/api/checkins', body: JSON.stringify({ date: '2026-10-01', text: '写周报' }) });
  eq('读回兜底：网关不回传插入行时，自己再查一次仍返回成功', r.code, 0);
  eq('读回兜底：返回的仍是真实的那一行', r.data.id, 901);

  installFakeFetch();
  responder = (u, table, init) => {
    if (String((init && init.method) || 'GET').toUpperCase() === 'POST') return { rows: [] };
    if (u.indexOf('order=id.desc') > -1) return { rows: [] };
    return { rows: [{ sort: 4 }] };
  };
  r = await call({ httpMethod: 'POST', path: '/api/checkins', body: JSON.stringify({ date: '2026-10-01', text: '写周报' }) });
  eq('读回兜底：写入后读不回来 → 500（宁可报错，也不假装成功）', r.code, 500);

  // —— 写入时的其它数据库故障 ——
  installFakeFetch();
  responder = writeResponder({ insertStatus: 500, insertBody: { message: 'connection refused' } });
  r = await call({ httpMethod: 'POST', path: '/api/checkins', body: JSON.stringify({ date: '2026-10-01', text: '写周报' }) });
  eq('POST：数据库故障 → 500 统一文案', r.code, 500);
  eq('POST：数据库故障不泄露内部信息', r.message, '服务端出了点问题，稍后再试');

  // —— 路由：PATCH/DELETE 属第 4 周，今天应当还是 404 ——
  installFakeFetch();
  responder = () => ({ rows: [] });
  r = await call({ httpMethod: 'PATCH', path: '/api/checkins' });
  eq('PATCH 尚未实现（第 4 周）→ 404', r.code, 404);
  ok('404 的可用路由里已含 POST /api/checkins',
     r.data.availableRoutes.indexOf('POST /api/checkins') > -1, JSON.stringify(r.data.availableRoutes));

  // =========================================================================
  // 八、异常兜底
  // =========================================================================
  installFakeFetch();
  responder = () => ({ status: 500, body: { message: 'relation "checkins" does not exist' } });
  r = await call({ httpMethod: 'GET', path: '/api/day', queryStringParameters: { date: '2026-10-01' } });
  eq('数据库报错：兜成 500 信封，不崩', r.code, 500);
  eq('数据库报错：对外文案是统一提示', r.message, '服务端出了点问题，稍后再试');
  eq('数据库报错：data 为 null', r.data, null);

  installFakeFetch();
  global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '<html>502</html>' });
  r = await call({ httpMethod: 'GET', path: '/api/day', queryStringParameters: { date: '2026-10-01' } });
  eq('数据库返回非 JSON：兜成 500', r.code, 500);

  installFakeFetch();
  const savedKey = process.env.CLOUDBASE_API_KEY;
  delete process.env.CLOUDBASE_API_KEY;
  r = await call({ httpMethod: 'GET', path: '/api/day', queryStringParameters: { date: '2026-10-01' } });
  eq('缺少数据库配置：兜成 500（不泄露内部信息）', r.code, 500);
  process.env.CLOUDBASE_API_KEY = savedKey;

  // =========================================================================
  // 九、分层结构（Day 19：数据库操作拆到 db.js）
  // =========================================================================

  // —— 9.1 静态检查：数据库代码是不是真的搬走了 ——
  // 为什么要读源码文本：这类"搬没搬走"的事，靠跑行为测不出来 ——
  // 搬走之前行为也全对，所以只有看代码本身才知道分层有没有真做到。
  const readSrc = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
  const idxSrc = readSrc('index.js');
  const dbSrc = readSrc('db.js');

  ok('路由层不再自己调 fetch（数据库访问已全部搬走）', idxSrc.indexOf('fetch(') === -1);
  ok('路由层不再出现数据库 REST 基址', idxSrc.indexOf('tcloudbasegateway') === -1);
  ok('路由层不再出现数据库列名 client_req_id', idxSrc.indexOf('client_req_id') === -1);
  ok('路由层不再出现数据库列名 done_at', idxSrc.indexOf('done_at') === -1);
  ok('数据访问层里才有 fetch', dbSrc.indexOf('fetch(') > -1);
  ok('路由层通过 require 引用数据访问层', idxSrc.indexOf("require('./db.js')") > -1);

  // —— 9.2 数据访问层的对外接口面（加函数要同步改这里，等于一张清单）——
  eq('数据访问层对外暴露的函数名单',
     Object.keys(db).sort().join(','),
     ['createCheckin', 'dbConfig', 'existsCheckinWithReqId', 'findCheckinByContent',
      'findCheckinByReqId', 'findCheckinRowById', 'findLastSort', 'findPlanDay', 'insert',
      'isDuplicateError', 'listCheckins', 'listCheckinsByDay', 'mapCheckin', 'mapPlanDay',
      'pickTotal', 'select', 'softDeleteCheckin', 'update', 'updateCheckin']
       .sort().join(','));

  // —— 9.3 数据访问层能脱离路由独立工作（这才是"拆干净了"的证明）——
  installFakeFetch();
  responder = () => ({ rows: [PLAN_ROW], total: 1 });
  const dayRow = await db.findPlanDay('seed-demo-user', '2026-10-01');
  eq('数据层可直接调用：findPlanDay 返回契约形状（不经路由）', dayRow, {
    date: '2026-10-01', mood: 'calm',
    createdAt: Date.parse(PLAN_ROW.created_at), updatedAt: Date.parse(PLAN_ROW.updated_at),
  });
  eq('数据层自动补 uid 条件与列清单',
     [paramsOf(0).uid, paramsOf(0).select], ['eq.seed-demo-user', 'date,mood,created_at,updated_at']);

  installFakeFetch();
  responder = () => ({ rows: [], total: 0 });
  eq('这天没记录时 findPlanDay 返回 null（不是错误）',
     await db.findPlanDay('seed-demo-user', '2026-10-02'), null);

  installFakeFetch();
  responder = () => ({ rows: [{ sort: 11 }], total: 1 });
  eq('findLastSort 返回当天最大排序位', await db.findLastSort('seed-demo-user', '2026-10-01'), 11);

  installFakeFetch();
  responder = () => ({ rows: [], total: 0 });
  eq('这天没有条目时 findLastSort 返回 null（上层好从 0 起算）',
     await db.findLastSort('seed-demo-user', '2026-10-01'), null);

  installFakeFetch();
  responder = () => ({ rows: CHECKIN_ROWS, total: 2 });
  const listByDay = await db.listCheckinsByDay('seed-demo-user', '2026-10-01');
  eq('listCheckinsByDay 返回契约形状的数组（done 布尔、doneAt 毫秒）',
     [listByDay[0].done, listByDay[0].doneAt, listByDay[1].doneAt],
     [true, Date.parse(CHECKIN_ROWS[0].done_at), null]);
  eq('listCheckinsByDay 只发一次查询', captured.length, 1);

  installFakeFetch();
  responder = () => ({ rows: [CHECKIN_ROWS[1]], total: 42 });
  const listed = await db.listCheckins('seed-demo-user', { date: '2026-10-01', limit: 1 });
  eq('listCheckins 返回 { total, items }（total 用数据库报的总数）',
     [listed.total, listed.items.length], [42, 1]);

  installFakeFetch();
  responder = () => ({ rows: [], total: 0 });
  await db.listCheckins('seed-demo-user', { from: '2026-09-25', to: '2026-10-01', limit: 20 });
  eq('listCheckins 的区间查询下发为同列两个条件',
     paramsOf(0).date, ['gte.2026-09-25', 'lte.2026-10-01']);

  installFakeFetch();
  responder = () => ({ rows: [], total: 0 });
  await db.listCheckins('seed-demo-user', { date: '2026-10-01', done: 'false', limit: 20 });
  eq('listCheckins 的完成状态下发为 is.false', paramsOf(0).done, 'is.false');

  installFakeFetch();
  responder = () => ({ rows: [NEW_ROW], total: 1 });
  const made = await db.createCheckin({
    uid: 'seed-demo-user', date: '2026-10-01', text: '写周报', time: '14:00', quad: 'q2',
    sort: 5, reqId: 'req-x',
  });
  eq('createCheckin 把业务字段翻成数据库列名（含幂等键列、done 恒 false）', bodyOf(0), {
    uid: 'seed-demo-user', date: '2026-10-01', text: '写周报', time: '14:00', quad: 'q2',
    done: false, sort: 5, client_req_id: 'req-x',
  });
  eq('createCheckin 返回契约形状的那一行', made, {
    id: 901, date: '2026-10-01', text: '写周报', time: '14:00', quad: 'q2',
    done: false, doneAt: null, sort: 5,
  });

  installFakeFetch();
  responder = () => ({ rows: [NEW_ROW], total: 1 });
  await db.createCheckin({ uid: 'u', date: '2026-10-01', text: 't', time: null, quad: null, sort: 0, reqId: '' });
  ok('没传幂等键时不写 client_req_id 列（保持 NULL）', bodyOf(0).client_req_id === undefined);

  installFakeFetch();
  responder = () => ({ status: 409, body: { code: '23505', message: 'duplicate key value' } });
  let dupErr = null;
  try {
    await db.createCheckin({ uid: 'u', date: '2026-10-01', text: 't', time: null, quad: null, sort: 0, reqId: 'r' });
  } catch (e) {
    dupErr = e;
  }
  ok('createCheckin 遇到唯一冲突会把 SQLSTATE 带回来（供上层翻成 409）',
     db.isDuplicateError(dupErr) === true && dupErr.pgCode === '23505');
  ok('isDuplicateError 不把别的数据库错误当重复',
     db.isDuplicateError({ pgCode: '42601' }) === false && db.isDuplicateError(null) === false);

  // =========================================================================
  // 十、改与删（Day 22：PATCH / DELETE + 软删除）
  // =========================================================================
  // 这一节的假数据库要同时应付三种请求，所以按「方法」分开返回：
  //   GET    → 路由层用来"查这一行是谁的、删过没"（findCheckinRowById）
  //   PATCH  → 路由层用来改（updateCheckin）或软删除（softDeleteCheckin）
  //   DELETE → **本项目不该出现**：出现就说明软删除被写成了真删，测试会当场失败
  const OWN_ROW = { id: 101, uid: 'seed-demo-user', date: '2026-10-01', is_deleted: false };
  const PATCHED_ROW = {
    id: 101, date: '2026-10-01', text: '晨跑 30 分钟', time: '07:30', quad: 'q2',
    done: true, done_at: '2026-10-09T02:00:00+00:00', sort: 0,
  };

  /** 明天（按东八区算，和 todayLocal 同一套口径）：A5 测试用 */
  const plusDays = (ds, n) => {
    const [y, m, d] = ds.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  };
  const TODAY = api.todayLocal();
  const TOMORROW = plusDays(TODAY, 1);

  // —— 10.1 路径参数解析（:id 是这一节新增的"路由能力"）——
  eq('parseId：正常数字转成 number', api.parseId('13'), 13);
  eq('parseId：0 不合法（id 从 1 开始）', api.parseId('0'), null);
  eq('parseId：非数字不合法', api.parseId('abc'), null);
  eq('parseId：小数不合法', api.parseId('1.5'), null);
  eq('parseId：空值不合法', api.parseId(undefined), null);

  // —— 10.2 带参数路由：能命中，方法/路径不对要 404，id 不合法要 400 ——
  installFakeFetch();
  responder = () => ({ rows: [OWN_ROW] });
  r = await call({ httpMethod: 'PATCH', path: '/api/checkins/101', body: { done: true } });
  ok('PATCH /api/checkins/:id 命中路由（不是 404）', r.code !== 404, JSON.stringify(r));

  installFakeFetch();
  responder = () => ({ rows: [OWN_ROW] });
  r = await call({ httpMethod: 'DELETE', path: '/api/checkins/101' });
  ok('DELETE /api/checkins/:id 命中路由（不是 404）', r.code !== 404, JSON.stringify(r));

  r = await call({ httpMethod: 'PUT', path: '/api/checkins/101' });
  eq('没实现的方法：仍回 404（不悄悄当成别的接口）', r.code, 404);
  ok('404 的可用路由里带出带参数的接口',
     r.data.availableRoutes.indexOf('PATCH /api/checkins/:id') > -1 &&
     r.data.availableRoutes.indexOf('DELETE /api/checkins/:id') > -1,
     JSON.stringify(r.data.availableRoutes));

  installFakeFetch();
  responder = () => ({ rows: [] });
  r = await call({ httpMethod: 'PATCH', path: '/api/checkins/abc', body: { done: true } });
  eq('id 不是数字：回 400（不是 404）', r.code, 400);
  eq('id 不是数字：提示"待办 id 不合法"', r.message, '待办 id 不合法');
  eq('id 不合法时一个字都不查库', captured.length, 0);

  // —— 10.3 PATCH 的字段校验：错就早退，绝不写库 ——
  const patchChecks = [
    [{},                                 '一个字段都没给', '请至少指定一个要修改的字段（done / text / time / quad）'],
    [{ done: 'yes' },                    'done 不是布尔',  'done 只能是 true 或 false'],
    [{ text: '   ' },                    'text 全是空白',  '内容不能为空，且不超过 60 字'],
    [{ text: 123 },                      'text 不是字符串','内容不能为空，且不超过 60 字'],
    [{ time: '9:00' },                   'time 不是 HH:mm','时间格式不对，应为 HH:mm（24 小时制）'],
    [{ quad: 'q9' },                     'quad 不在枚举',  '象限只能是 q1 / q2 / q3 / q4'],
  ];
  let idx = 0;
  for (const [body, why, msg] of patchChecks) {
    installFakeFetch();
    responder = () => ({ rows: [OWN_ROW] });
    r = await call({ httpMethod: 'PATCH', path: '/api/checkins/101', body: body });
    eq('PATCH 校验 · ' + why + ' → 400', [r.code, r.message], [400, msg]);
    eq('PATCH 校验 · ' + why + ' → 不写库', captured.length, 0);
    idx++;
  }
  ok('PATCH 字段校验覆盖了 ' + idx + ' 种非法输入', idx === patchChecks.length);

  installFakeFetch();
  responder = () => ({ rows: [OWN_ROW] });
  r = await call({ httpMethod: 'PATCH', path: '/api/checkins/101', body: 'not-json{' });
  eq('PATCH 请求体不是合法 JSON → 400', [r.code, r.message], [400, '请求体不是合法的 JSON']);

  installFakeFetch();
  responder = () => ({ rows: [OWN_ROW] });
  delete process.env.DEMO_UID;
  r = await call({ httpMethod: 'PATCH', path: '/api/checkins/101', body: { done: true } });
  eq('PATCH 拿不到身份 → 401', r.code, 401);
  process.env.DEMO_UID = 'seed-demo-user';

  // —— 10.4 PATCH 正常路径：只改传了的字段，done 与 done_at 一起改 ——
  installFakeFetch();
  responder = (u, table, init) =>
    (String(init.method).toUpperCase() === 'PATCH' ? { rows: [PATCHED_ROW] } : { rows: [OWN_ROW] });
  r = await call({ httpMethod: 'PATCH', path: '/api/checkins/101', body: { done: true } });
  eq('PATCH 成功：走信封 + 文案"已更新"', [r.code, r.message], [0, '已更新']);
  eq('PATCH 成功后回传改完的完整对象（字段与 POST 同形状）', r.data, {
    id: 101, date: '2026-10-01', text: '晨跑 30 分钟', time: '07:30', quad: 'q2',
    done: true, doneAt: Date.parse(PATCHED_ROW.done_at), sort: 0,
  });
  eq('PATCH 前先按 id 查了这一行（查的是 id 列）', paramsOf(0).id, 'eq.101');
  eq('查这一行时**不带 uid 条件**（否则越权尝试永远只能得到 404）',
     paramsOf(0).uid, undefined);
  eq('PATCH 请求打在 /api/checkins 上（不是别的路径）', captured[1].url.indexOf('/checkins') > -1, true);
  eq('PATCH 的筛选条件带 uid（只改自己的数据）',
     [paramsOf(1).id, paramsOf(1).uid], ['eq.101', 'eq.seed-demo-user']);
  ok('PATCH 的写入体只带 done 与 done_at（没传的字段一个字都不碰）',
     JSON.stringify(Object.keys(bodyOf(1)).sort()) === JSON.stringify(['done', 'done_at']),
     JSON.stringify(bodyOf(1)));
  eq('打勾时写 done=true', bodyOf(1).done, true);
  ok('打勾时同时写 done_at（数据库 CHECK 约束要求两者一致）',
     typeof bodyOf(1).done_at === 'string' && bodyOf(1).done_at.length > 10, JSON.stringify(bodyOf(1)));

  installFakeFetch();
  responder = (u, table, init) =>
    (String(init.method).toUpperCase() === 'PATCH' ? { rows: [PATCHED_ROW] } : { rows: [OWN_ROW] });
  await call({ httpMethod: 'PATCH', path: '/api/checkins/101', body: { done: false } });
  eq('取消打勾时把 done_at 写成 null（不能只改 done）', [bodyOf(1).done, bodyOf(1).done_at], [false, null]);

  installFakeFetch();
  responder = (u, table, init) =>
    (String(init.method).toUpperCase() === 'PATCH' ? { rows: [PATCHED_ROW] } : { rows: [OWN_ROW] });
  await call({ httpMethod: 'PATCH', path: '/api/checkins/101', body: { time: null, quad: 'q3', text: ' 改过的内容 ' } });
  eq('传 null 是"清空"、传字符串是"改值"、内容去了首尾空白',
     [bodyOf(1).time, bodyOf(1).quad, bodyOf(1).text], [null, 'q3', '改过的内容']);

  // —— 10.5 404 / 403 / 已删除：三种"不能动"要分得清 ——
  installFakeFetch();
  responder = () => ({ rows: [] });
  r = await call({ httpMethod: 'PATCH', path: '/api/checkins/999', body: { done: true } });
  eq('PATCH 不存在的 id → 404', [r.code, r.message], [404, '这条待办不存在或已删除']);
  eq('PATCH 不存在时没有任何写入请求', captured.length, 1);

  installFakeFetch();
  responder = () => ({ rows: [{ id: 101, uid: 'someone-else', date: '2026-10-01', is_deleted: false }] });
  r = await call({ httpMethod: 'PATCH', path: '/api/checkins/101', body: { done: true } });
  eq('PATCH 别人的数据 → 403（而不是含糊的 404）', [r.code, r.message], [403, '无权修改这条待办']);
  eq('PATCH 别人的数据：一个字节都没往库里写', captured.length, 1);

  installFakeFetch();
  responder = () => ({ rows: [{ id: 101, uid: 'seed-demo-user', date: '2026-10-01', is_deleted: true }] });
  r = await call({ httpMethod: 'PATCH', path: '/api/checkins/101', body: { done: true } });
  eq('PATCH 已软删除的那条 → 404（对外不区分"没这条"和"删过了"）', r.code, 404);

  // —— 10.6 A5：给未来日期的待办打勾，服务端必须拦（409）——
  installFakeFetch();
  responder = () => ({ rows: [{ id: 101, uid: 'seed-demo-user', date: TOMORROW, is_deleted: false }] });
  r = await call({ httpMethod: 'PATCH', path: '/api/checkins/101', body: { done: true } });
  eq('给明天打勾 → 409 + 中文原因', [r.code, r.message], [409, '这一天还没到，先别急着打勾']);
  eq('被 A5 拦下时没有任何写入请求', captured.length, 1);

  installFakeFetch();
  responder = (u, table, init) =>
    (String(init.method).toUpperCase() === 'PATCH' ? { rows: [PATCHED_ROW] } : { rows: [{ id: 101, uid: 'seed-demo-user', date: TOMORROW, is_deleted: false }] });
  r = await call({ httpMethod: 'PATCH', path: '/api/checkins/101', body: { done: false } });
  eq('明天的待办"取消打勾"不拦（A5 只拦提前打勾）', r.code, 0);

  installFakeFetch();
  responder = (u, table, init) =>
    (String(init.method).toUpperCase() === 'PATCH' ? { rows: [PATCHED_ROW] } : { rows: [{ id: 101, uid: 'seed-demo-user', date: TODAY, is_deleted: false }] });
  r = await call({ httpMethod: 'PATCH', path: '/api/checkins/101', body: { done: true } });
  eq('给今天打勾：正常放行', r.code, 0);

  // —— 10.7 DELETE：是"打标记"，不是"真删" ——
  installFakeFetch();
  responder = (u, table, init) =>
    (String(init.method).toUpperCase() === 'PATCH' ? { rows: [{ id: 101 }] } : { rows: [OWN_ROW] });
  r = await call({ httpMethod: 'DELETE', path: '/api/checkins/101' });
  eq('DELETE 成功：回 id（不回整行——它已经"不存在"了）',
     [r.code, r.message, JSON.stringify(r.data)], [0, '已删除', '{"id":101}']);
  eq('DELETE 只发了两条请求：先查行、再改行', captured.length, 2);
  eq('软删除用的是 PATCH 方法（**不是** HTTP DELETE）', captured[1].method, 'PATCH');
  eq('软删除的筛选条件带 uid + 只挑没删过的行',
     [paramsOf(1).uid, paramsOf(1).is_deleted], ['eq.seed-demo-user', 'is.false']);
  eq('软删除写的是 is_deleted = true（物理行留在库里）', bodyOf(1), { is_deleted: true });
  ok('整个过程没有发出任何 HTTP DELETE（真删就从这里漏出去了）',
     captured.every((c) => c.method !== 'DELETE'), JSON.stringify(captured.map((c) => c.method)));

  installFakeFetch();
  responder = () => ({ rows: [{ id: 101, uid: 'someone-else', date: '2026-10-01', is_deleted: false }] });
  r = await call({ httpMethod: 'DELETE', path: '/api/checkins/101' });
  eq('删别人的数据 → 403（删除比新增更危险，这道防线尤其不能省）',
     [r.code, r.message], [403, '无权删除这条待办']);
  eq('删别人的数据：一个字节都没写', captured.length, 1);

  installFakeFetch();
  responder = () => ({ rows: [{ id: 101, uid: 'seed-demo-user', date: '2026-10-01', is_deleted: true }] });
  r = await call({ httpMethod: 'DELETE', path: '/api/checkins/101' });
  eq('重复删除同一条 → 404（前端应把它当"已经没了"，不是错误）', r.code, 404);

  installFakeFetch();
  responder = () => ({ rows: [] });
  r = await call({ httpMethod: 'DELETE', path: '/api/checkins/404' });
  eq('删不存在的 id → 404', r.code, 404);

  // —— 10.8 读取接口必须跳过已删除（软删除的连带影响，最容易漏的一处）——
  installFakeFetch();
  responder = () => ({ rows: [], total: 0 });
  await db.listCheckinsByDay('seed-demo-user', '2026-10-01');
  eq('listCheckinsByDay 带上了 is_deleted = false 条件', paramsOf(0).is_deleted, 'is.false');

  installFakeFetch();
  responder = () => ({ rows: [], total: 0 });
  await db.listCheckins('seed-demo-user', { date: '2026-10-01', limit: 20 });
  eq('listCheckins 带上了 is_deleted = false 条件', paramsOf(0).is_deleted, 'is.false');

  installFakeFetch();
  responder = () => ({ rows: [{ sort: 3 }], total: 1 });
  await db.findLastSort('seed-demo-user', '2026-10-01');
  eq('findLastSort **刻意不带** is_deleted 条件（避免新条目复用已删条目的排序位）',
     paramsOf(0).is_deleted, undefined);

  installFakeFetch();
  responder = () => ({ rows: [], total: 0 });
  await db.existsCheckinWithReqId('seed-demo-user', 'req-1');
  eq('幂等预检**刻意不带** is_deleted（要和数据库唯一索引覆盖的范围一致）',
     paramsOf(0).is_deleted, undefined);

  // —— 10.9 通用管道 update：拒绝"无条件改全表" ——
  installFakeFetch();
  let noWhereErr = null;
  try {
    await db.update('checkins', {}, { is_deleted: true });
  } catch (e) {
    noWhereErr = e;
  }
  ok('update 拒绝无条件修改（没有筛选条件就抛错，防止误改全表）',
     !!noWhereErr && noWhereErr.message.indexOf('筛选条件') > -1,
     noWhereErr && noWhereErr.message);

  installFakeFetch();
  responder = () => ({ status: 400, body: { code: '23514', message: 'check constraint violated' } });
  let checkErr = null;
  try {
    await db.updateCheckin('seed-demo-user', 101, { done: true });
  } catch (e) {
    checkErr = e;
  }
  ok('update 遇到 CHECK 约束冲突会把 SQLSTATE 带回来（不是静默成功）',
     !!checkErr && checkErr.pgCode === '23514', checkErr && checkErr.pgCode);

  global.fetch = realFetch;
  console.log = realLog;
  console.error = realError;

  // -------------------------------------------------------------------------
  const total = pass + fails.length;
  console.log('\n云函数本地自测：' + pass + '/' + total + ' 通过');
  if (fails.length) {
    console.log('\n未通过：');
    fails.forEach((f) => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log('全部通过 ✓');
})();
