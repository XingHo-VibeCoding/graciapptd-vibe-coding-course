/**
 * 自律计划 · 云函数 api 本地自测（Day 17 建立）
 * ---------------------------------------------------------------------------
 * 作用：**不联网、不连数据库**，把云函数的三种东西验证一遍——
 *   1) 路由：路径/方法能不能命中，未命中会不会回 404 且列出可用路由
 *   2) 参数校验与身份：非法日期、互斥参数、limit 越界、未取到身份 → 各自的错误码
 *   3) 数据库交互：拼出来的 SQL 查询串对不对 + 数据库回的行有没有被正确映射成契约形状
 *
 * 怎么做到的：把全局 fetch 换成一个假的（stub），既能记录"你请求了哪个 URL"，
 *   又能返回我们指定的假数据。所以它是**纯本地、可重复、秒级**的。
 *
 * 怎么跑（在 habit-tracker/cloudfunctions/api 目录下）：
 *   node selftest.js
 * 退出码 0 = 全过。
 */

const api = require('./index.js');

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
    captured.push({ url: u, table: table, headers: (init && init.headers) || {} });
    const { rows, total, status, body } = responder(u, table);
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
  // 六、异常兜底
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
