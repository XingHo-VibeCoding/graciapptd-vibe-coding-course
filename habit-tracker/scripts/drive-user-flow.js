#!/usr/bin/env node
/**
 * 自律计划 · 以「真实用户视角」驱动浏览器走完核心流程（Day 27 建立）
 * ----------------------------------------------------------------------------
 * 为什么要写这个脚本（两个用途，一套代码）：
 *   ① Day 27 的第三方试用：真人在别的设备上怎么操作，这里就怎么操作 ——
 *      真浏览器、真鼠标点击（不是 .click()）、真键盘输入、真刷新页面。
 *      代码里调用 .click() 会绕过"遮挡 / z-index / 元素在屏幕外"这类问题，
 *      而这些恰恰是真人最容易卡住的地方，所以这里一律走 CDP 的真实输入事件。
 *   ② 余力加练：手机宽度（--width=390）跑一遍完整打卡流程，逐步截图留证。
 *
 * 它和 test-home.js 的分工：
 *   test-home.js     = jsdom，400+ 条行为断言，快、细、但**没有布局与真网络**
 *   drive-user-flow  = 真 Edge + 真公网，只跑一遍"用户主链路"，慢但**所见即真人所见**
 *
 * 关于首访的「风险提醒」中间页（Day 27 实测发现）：
 *   全新浏览器会话访问 CloudBase 默认域名（*.tcloudbaseapp.com）时，浏览器直接
 *   导航（Sec-Fetch-Mode: navigate）会先看到腾讯云的「风险提醒」页，必须点
 *   「确定访问」才进得去。官方文档明确：移除它的**唯一合规途径是绑自定义域名**
 *   （需 ICP 备案），默认域名"仅建议用于开发测试"。所以本脚本把它当成**正常
 *   首步**处理并截图留证，而不是当成失败 —— 这也正是第三方试用最容易卡住的
 *   第一屏，必须让试用者提前知道。
 *
 * 用法
 *   node scripts/drive-user-flow.js                          # 手机宽度 390，跑线上
 *   node scripts/drive-user-flow.js --width=430 --out=./ev   # 指定宽度与截图目录
 *   node scripts/drive-user-flow.js --base=http://localhost:8765  # 指向本地预览
 *   EDGE_BIN=... PORT=9223 node scripts/drive-user-flow.js
 *
 * 退出码
 *   0 = 五步全过；1 = 有失败项（输出里标 ✗ 的步骤）
 *
 * 依赖：Node ≥ 22（需要全局 WebSocket / fetch）、本机装了 Edge（或 Chrome）。
 * 不留任何痕迹：跑完自造的那条待办会被删除；浏览器由脚本自己关掉。
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

// ── 参数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};
const WIDTH = Number(arg('width', 390));
const HEIGHT = Number(arg('height', 844));
const BASE = arg('base', 'https://habit-tracker-d9gh0mjel767ff0d2-1499348397.tcloudbaseapp.com');
const OUT = path.resolve(arg('out', path.join(process.cwd(), 'user-flow-shots')));
const PORT = Number(arg('port', 9222));
const KEEP = arg('keep', '0') === '1';          // 1 = 跑完不删自造数据（排查用）
const NEW_TODO = arg('todo', '试用：走一遍核心流程 ' + new Date().toISOString().slice(0, 16));

const EDGE_CANDIDATES = [
  process.env.EDGE_BIN,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);

// ── 输出小工具（与项目其它脚本同一套记号：✓ / ✗ / ⚠ / 说明） ────────────────
const lines = [];
let pass = 0, fail = 0;
const say = (s) => { console.log(s); lines.push(s); };
const ok = (s) => { pass++; say('  ✓ ' + s); };
const no = (s) => { fail++; say('  ✗ ' + s); };
const warn = (s) => say('  ⚠ ' + s);
const note = (s) => say('      ↳ ' + s);

// ── CDP 最小客户端 ──────────────────────────────────────────────────────────
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { ws, ready, send };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const edge = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!edge) { console.error('找不到浏览器可执行文件，请用 EDGE_BIN=... 指定'); process.exit(2); }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'uf-profile-'));
  say('自律计划 · 用户流程驱动（真实浏览器）');
  say(' 站点   ：' + BASE);
  say(' 视口   ：' + WIDTH + ' × ' + HEIGHT + (WIDTH <= 430 ? '（手机宽度）' : ''));
  say(' 截图   ：' + OUT);
  say(' 浏览器 ：' + edge.split(/[\\/]/).pop());
  say('');

  const child = spawn(edge, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-features=Translate', '--hide-scrollbars',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--window-size=' + WIDTH + ',' + HEIGHT,
    'about:blank',
  ], { stdio: 'ignore' });

  // 等调试端口起来（不 sleep 死等，轮询更稳）
  let version = null;
  for (let i = 0; i < 60 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); }
    catch { await sleep(250); }
  }
  if (!version) { console.error('浏览器调试端口没起来'); child.kill(); process.exit(2); }

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const target = list.find((t) => t.type === 'page');
  const { ws, ready, send } = connect(target.webSocketDebuggerUrl);
  await ready;

  await send('Page.enable');
  await send('Runtime.enable');
  // 手机视口：用 Emulation 而不是 --window-size，这样设备像素比、触摸都按手机来
  await send('Emulation.setDeviceMetricsOverride',
    { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: WIDTH <= 430 });
  // confirm() 在无头浏览器里默认返回 false（等于自动取消），删不掉东西。
  // 这里改成"记录 + 同意"，这样既能让流程走下去，又能**断言二次确认真的弹过**。
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.__confirmCalls = [];' +
      'window.confirm = function (m) { window.__confirmCalls.push(String(m)); return true; };',
  });

  // ── 浏览器侧小工具 ────────────────────────────────────────────────────────
  const evalJS = async (expr) => {
    const r = await send('Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return undefined;
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (r.result && r.result.data) {
      const f = path.join(OUT, name + '.png');
      fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
      return f;
    }
    return null;
  };
  const waitFor = async (expr, ms = 12000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await evalJS('!!(' + expr + ')')) return true;
      await sleep(150);
    }
    return false;
  };
  // 等数据加载完成：#state-loading 的 hidden 变 true。
  // 为什么不能只 sleep：云函数有冷启动，首请求可能要好几秒 —— 等不足就会像
  // 第一次实跑那样，页面停在「加载中…」，后面所有步骤全部误判失败。
  const waitLoaded = () =>
    waitFor('document.getElementById("state-loading") && document.getElementById("state-loading").hidden', 25000);
  // 等"云端数据真正应用"。为什么不用 today-count / today-empty 当信号：
  // 应用是「先渲染本机（新会话=空）→ 云端回来后再渲染一次」——
  // 前者的空状态就会让等待假通过（实测两次都栽在这，页面明明有 6 条却读到 0）。
  // cloud-hint 以「云端数据」开头 = fetchCloudDay 成功返回并已应用（renderCloudHint 的语义）。
  const waitRendered = () => waitFor(
    '(document.getElementById("cloud-hint")||{}).textContent' +
    ' && document.getElementById("cloud-hint").textContent.indexOf("云端数据") === 0', 30000);
  // 每日心情弹窗会盖住整页 —— 真人也会遇到，正常路径是点「先不选」关掉它，
  // 不然后面所有真实坐标点击都会点到弹窗上。
  const dismissMood = async () => {
    if (await evalJS('!document.getElementById("mood-modal").hidden')) {
      await click('#mood-close');
      await waitFor('document.getElementById("mood-modal").hidden');
      note('每日心情弹窗出现 —— 已按「先不选」关闭（真人在自己设备上也会看到它）');
    }
  };
  // 真实鼠标点击：先取元素中心坐标，再派发 mousePressed/mouseReleased。
  // 元素被遮挡 / 不在视口内时这套会失败，而 .click() 不会 —— 这正是要抓的。
  const click = async (sel) => {
    const box = await evalJS(`(function(){var e=document.querySelector(${JSON.stringify(sel)});
      if(!e) return null; e.scrollIntoView({block:'center'});
      var r=e.getBoundingClientRect();
      return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2), w:r.width, h:r.height};})()`);
    if (!box || !box.w) return false;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent',
        { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
    return true;
  };
  const typeText = async (sel, text) => {
    await evalJS(`document.querySelector(${JSON.stringify(sel)}).focus()`);
    await send('Input.insertText', { text });
  };

  // ── 第 0 步：首访（CloudBase 中间页） ─────────────────────────────────────
  say('【第 0 步】打开链接 —— 全新会话首访会看到什么');
  await send('Page.navigate', { url: BASE });
  await sleep(3500);

  const hasApp = await evalJS('!!document.getElementById("timeline")');
  const isMid = await evalJS('/确定访问/.test(document.body ? document.body.innerText : "")');
  if (isMid && !hasApp) {
    warn('首访命中腾讯云「' + (await evalJS('document.title')) + '」中间页 —— 应用尚未渲染');
    await shot('00-firstvisit-midpage');
    note('截图 00-firstvisit-midpage.png（第三方在**自己设备**上看到的第一屏就是它）');
    note('平台限制：官方文档写明移除它只能绑自定义域名（需 ICP 备案），体验版做不到');
    const clicked = await click('#submitBtn') || await click('button');
    if (!clicked) { no('点不到「确定访问」按钮，后续步骤无法继续'); }
    else {
      const arrived = await waitFor('document.getElementById("timeline")');
      if (arrived) ok('点击「确定访问」后进入应用（中间页是一次性的，同会话不再出现）');
      else no('点了「确定访问」仍未进入应用');
    }
  } else if (hasApp) {
    ok('直接进入应用（本会话此前已点过「确定访问」，中间页不再出现）');
  } else {
    warn('页面既没有应用标志节点、也没有中间页 —— 内容异常，请人工看一眼截图');
    await shot('00-unexpected');
  }
  if (!await waitLoaded()) warn('等了 25 秒仍在「加载中…」（云函数冷启动慢？）—— 继续往下验');
  else ok('数据加载完成');
  if (!await waitRendered()) warn('数据加载完成但列表一直没渲染出来');
  await dismissMood();

  // ── 第 1 步：读取（首页展示今天的计划与打卡） ─────────────────────────────
  say('');
  say('【第 1 步】读取 —— 首页有没有今天的数据');
  const title = await evalJS('document.title');
  if (title === '自律计划') ok('页面标题 = 自律计划'); else no('页面标题异常：' + title);
  await waitFor('document.getElementById("today-count")');
  const countText = await evalJS('(document.getElementById("today-count")||{}).textContent');
  const cardCount = await evalJS('document.querySelectorAll("#timeline .todo, #unassigned-list .todo").length');
  const emptyShown = await evalJS('!document.getElementById("today-empty").hidden');
  note('计数文案：「' + (countText || '(空)') + '」· 卡片 ' + cardCount + ' 张');
  if (emptyShown && cardCount === 0) {
    warn('首页处于空状态（今天没有任何安排）—— 真人走到这里就不知道下一步该干什么');
  } else if (cardCount > 0) {
    ok('首页读到今日数据：' + cardCount + ' 张卡片');
  } else {
    no('既非空状态也读不到卡片，页面状态异常');
  }
  const hint = await evalJS('(document.getElementById("cloud-hint")||{}).textContent || ""');
  if (/本机数据/.test(hint)) no('正在显示本机数据（云端没通）—— 这不是真实链路');
  else ok('走的是云端链路（没出现「当前显示本机数据」提示）');
  await shot('01-read-home');

  // ── 第 2 步：写入打卡 ────────────────────────────────────────────────────
  say('');
  say('【第 2 步】写入 —— 点右下角 ＋ 添加一条待办');
  if (!await waitFor('!document.getElementById("fab").hidden', 8000)) {
    no('＋ 按钮（#fab）一直不可见（data 未就绪 / 不在今天视图）—— 真人走到这里会卡住');
  } else if (!await click('#fab')) no('＋ 可见但点不到 —— 可能被遮挡');
  else if (!await waitFor('!document.getElementById("tm-modal").hidden')) no('＋ 点了但弹窗没出来');
  else {
    ok('弹窗打开');
    await typeText('#tm-text', NEW_TODO);
    await shot('02a-write-modal');
    await click('#tm-ok');
    const appeared = await waitFor(
      `[...document.querySelectorAll('.todo .text')].some(e=>e.textContent.includes(${JSON.stringify(NEW_TODO)}))`);
    if (appeared) ok('新待办出现在列表上：「' + NEW_TODO + '」');
    else no('保存后列表里找不到新待办');
  }
  await shot('02b-write-done');

  // ── 第 3 步：刷新确认（真的落库了吗） ────────────────────────────────────
  say('');
  say('【第 3 步】刷新 —— 重新加载页面，看它还在不在');
  await send('Page.reload', { ignoreCache: true });
  await waitFor('document.getElementById("timeline")');
  if (!await waitRendered()) warn('刷新后 25 秒列表仍未渲染 —— 继续验');
  await dismissMood();
  const persist = await evalJS(
    `[...document.querySelectorAll('.todo .text')].some(e=>e.textContent.includes(${JSON.stringify(NEW_TODO)}))`);
  if (persist) ok('刷新后仍在 —— 数据真的写进了云端库'); else no('刷新后消失了 —— 只写在本机');
  await shot('03-refresh-persist');

  // ── 第 4 步：修改（打勾完成） ────────────────────────────────────────────
  say('');
  say('【第 4 步】修改 —— 点这条待办的圆圈标记完成');
  const idx = await evalJS(
    `[...document.querySelectorAll('.todo')].findIndex(r=>r.textContent.includes(${JSON.stringify(NEW_TODO)}))`);
  const clicked = await evalJS(`(function(){
      var rows=[...document.querySelectorAll('.todo')];
      var row=rows[${idx}]; if(!row) return false;
      var b=row.querySelector('.check'); if(!b) return false;
      b.scrollIntoView({block:'center'});
      var r=b.getBoundingClientRect();
      window.__probe={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
      return true;})()`);
  if (!clicked) no('找不到这条待办的完成按钮');
  else {
    const p = await evalJS('window.__probe');
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent',
        { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
    }
    // 为什么等 25 秒：打勾要走一次云函数 PATCH，撞上冷启动可能要十几秒
    //（实测过一次：库里 done 已变 true，但脚本 12 秒就放弃了 —— 不是功能坏，是等太短）。
    const done = await waitFor(`[...document.querySelectorAll('.todo')]
        .some(r=>r.textContent.includes(${JSON.stringify(NEW_TODO)}) && r.classList.contains('done'))`, 25000);
    if (done) ok('已标记完成（卡片进入 done 态）'); else no('点了完成按钮但状态没变');
  }
  await shot('04-edit-toggle');

  // ── 第 5 步：删除（含二次确认） ──────────────────────────────────────────
  say('');
  say('【第 5 步】删除 —— ··· 菜单 → 删除 → 二次确认');
  const i2 = await evalJS(
    `[...document.querySelectorAll('.todo')].findIndex(r=>r.textContent.includes(${JSON.stringify(NEW_TODO)}))`);
  if (i2 < 0) no('找不到这条待办，无法继续删除');
  else {
    await evalJS(`[...document.querySelectorAll('.todo')][${i2}].querySelector('.del').click()`);
    await sleep(400);
    const menuShown = await evalJS('!!document.querySelector(".todo .menu .danger")');
    if (!menuShown) no('··· 菜单没出现「删除」项');
    else {
      await shot('05a-delete-menu');
      await evalJS('document.querySelector(".todo .menu .danger").click()');
      const gone = await waitFor(`![...document.querySelectorAll('.todo .text')]
          .some(e=>e.textContent.includes(${JSON.stringify(NEW_TODO)}))`);
      if (gone) ok('待办已从列表消失');
      else no('点了删除但待办还在');
      const confirms = await evalJS('(window.__confirmCalls||[]).length');
      const confirmMsg = await evalJS('(window.__confirmCalls||[]).join(" | ")');
      if (confirms >= 1) ok('删除前弹过二次确认：' + confirmMsg);
      else no('删除没有弹二次确认（防误触失效）');
    }
  }
  await shot('05b-delete-done');

  if (!KEEP) {
    // 兜底清理：万一中间某步失败留下了那条数据，这里再删一次
    const still = await evalJS(
      `[...document.querySelectorAll('.todo .text')].some(e=>e.textContent.includes(${JSON.stringify(NEW_TODO)}))`);
    if (still) { warn('还有残留，尝试再删一次'); await sleep(300); }
  }

  // ── 收尾 ────────────────────────────────────────────────────────────────
  say('');
  say('————————————————————————————————————————————');
  say(' 结论：' + pass + ' 通过 / ' + fail + ' 失败');
  say(' 截图：' + OUT);
  say('————————————————————————————————————————————');
  fs.writeFileSync(path.join(OUT, 'drive-user-flow.log'), lines.join('\n') + '\n');

  await send('Browser.close').catch(() => {});
  ws.close();
  await sleep(500);
  try { child.kill(); } catch { /* 已经退出 */ }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('脚本自身出错：', e); process.exit(2); });
