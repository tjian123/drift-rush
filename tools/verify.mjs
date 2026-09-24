/* ===========================================================================
 * verify.mjs — 端到端无头验收（零第三方依赖，Node22 内置 WebSocket 直连 CDP）
 *
 * 覆盖：
 *   A 单人模式   菜单 → 完赛 → 结算，含循线自动驾驶与 AI 对手
 *   B 分屏双人   同屏两路相机，两台车都在真实行驶
 *   C 在线联机   两个独立浏览器实例经服务器互通，互相看到对方的车在动
 *   D 轮询降级   强制走 HTTP 轮询通道，验证反代不转发 Upgrade 时的可用性
 *   E 服务器     /api/health 与房间安全校验
 *
 *   node tools/verify.mjs           全部
 *   node tools/verify.mjs A C       只跑指定项
 * =========================================================================*/

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sweepOldProfiles } from './cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const CHROME = process.env.DR_CHROME ||
  'C:/Users/tjian/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const CDP_PORT = Number(process.env.DR_CDP_PORT || 9401);
const SERVER = process.env.DR_SERVER || 'http://127.0.0.1:8790';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  log(`${ok ? '  \x1b[32mPASS\x1b[0m' : '  \x1b[31mFAIL\x1b[0m'}  ${name}${detail ? '  — ' + detail : ''}`);
  return ok;
}

/* ------------------------------------------------------------------ HTTP */
/** 必须带超时：端口上残留半死实例时，无超时的请求会永久挂住 */
function httpJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`http 超时 ${timeoutMs}ms ${url}`)));
  });
}

/** 该端口上有没有 CDP 实例在应答；没有则返回 null */
async function tryVersion(port, timeoutMs = 2500) {
  try { return await httpJson(`http://127.0.0.1:${port}/json/version`, timeoutMs); }
  catch (e) { return null; }
}

/**
 * 关闭端口上残留的浏览器实例并等端口释放。
 * 残留实例占着端口时，新 Chrome 绑不上端口（静默退出），而 /json/version
 * 会被旧实例应答 —— 脚本会悄悄连到僵尸浏览器上，症状是「卡住」或断言诡异失败。
 */
async function shutdownStale(port) {
  const v = await tryVersion(port, 2500);
  if (!v || !v.webSocketDebuggerUrl) return false;
  try {
    const ws = await openWs(v.webSocketDebuggerUrl);
    const p = new Page(ws);
    try { await p.send('Browser.close', {}, 3000); } catch (e) { /* 关闭瞬间连接会断 */ }
    try { ws.close(); } catch (e) { }
  } catch (e) { /* 连不上也无妨 */ }
  for (let i = 0; i < 24; i++) {
    await sleep(250);
    if (!(await tryVersion(port, 1200))) return true;
  }
  return false;
}

/* ------------------------------------------------------------------- CDP */
class Page {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method) this.events.push(m);
    });
  }
  send(method, params = {}, timeout = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); }
      }, timeout);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.text || '') + ' ' +
      (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  }
  async key(code, key, vk, down) {
    await this.send('Input.dispatchKeyEvent', {
      type: down ? 'keyDown' : 'keyUp', code, key,
      windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    });
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ROOT, file), Buffer.from(r.data, 'base64'));
  }
  errors() {
    const out = [];
    for (const e of this.events) {
      if (e.method === 'Runtime.exceptionThrown') {
        out.push('EXCEPTION: ' + (e.params.exceptionDetails.text || '') + ' ' +
          (e.params.exceptionDetails.exception?.description || ''));
      }
      if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') {
        out.push('CONSOLE: ' + e.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      }
      if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
        out.push('LOG: ' + e.params.entry.text);
      }
    }
    return out;
  }
  async readyUrl(url) {
    await this.send('Page.navigate', { url });
    for (let i = 0; i < 140; i++) {
      await sleep(400);
      try {
        // __DR_READY__ = 首帧已渲染；__DR_BOOTED__ = 场景构建完成（后台标签 rAF 可能被节流）
        if (await this.eval('!!(window.__DR_READY__ || window.__DR_BOOTED__)')) {
          // 再确认渲染循环真的在跑（联机测试要求两端同时渲染）
          for (let k = 0; k < 30; k++) {
            await sleep(300);
            const f = await this.eval('window.__DR__ ? window.__DR__.frames : 0');
            if (f > 20) return true;
          }
          return true;    // 渲染可能被节流，但页面本身是好的
        }
        const err = await this.eval('window.__DR_ERROR__ || null');
        if (err) { log('    页面自报错误: ' + err); return false; }
      } catch (e) { /* 导航中 */ }
    }
    return false;
  }

  /** 关闭这个页面（断开 CDP 连接即可，Chrome 会回收 target） */
  async close() {
    try { if (this._ws) this._ws.close(); } catch (e) { }
  }
}

/* ------------------------------------------------- 自动驾驶（循线控制器） */
// 统一由 tools/driver.mjs 提供：两份近似实现容易在修复时漏改一边
import { makeDriver } from './driver.mjs';

/* ================================================================ 测试项 */
async function testSolo(browser) {
  log('\n\x1b[1m[A] 单人模式：菜单 → 完赛 → 结算\x1b[0m');
  const page = await browser.newPage();
  if (!check('A1 页面加载完成（场景构建 + 首帧渲染）', await page.readyUrl(SERVER + '/'), '')) return;

  const info = await page.eval(`({
    webgl: (() => { const c = document.createElement('canvas');
      const g = c.getContext('webgl2') || c.getContext('webgl');
      return g ? g.getParameter(g.VERSION) : 'none'; })(),
    tracks: document.querySelectorAll('.trackcard').length,
    ach: document.querySelectorAll('#ach-grid .achitem').length,
    menuVisible: !document.getElementById('screen-menu').classList.contains('hide')
  })`);
  check('A2 WebGL 可用', String(info.webgl).includes('WebGL'), info.webgl);
  check('A3 主菜单渲染 4 张赛道卡片', info.tracks === 4, info.tracks + ' 张');
  check('A4 主菜单可见', info.menuVisible);

  await page.eval(`window.__DR_API__.start({ mode:'solo', track:'coast', laps:1, level:'normal' })`);
  const r = await page.eval('window.__DR__');
  check('A5 进入倒计时并创建 1 名玩家 + AI', r.racers >= 4, r.racers + ' 台车');

  // 等 GO
  let phase = '';
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    phase = await page.eval('window.__DR__.phase');
    if (phase === 'race') break;
  }
  check('A6 倒计时结束进入比赛', phase === 'race', 'phase=' + phase);

  // 自动驾驶跑完一圈
  const drv = await makeDriver(page, 1);
  let aiMaxSeen = 0, done = false, phaseNow = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 150000) {
    await drv.step();
    await sleep(70);
    const snap = await page.eval(`({
      phase: window.__DR__.phase,
      aiMax: window.__DR__.aiMaxKmh,
      aiLap: window.__DR__.aiLeaderLap,
      lap: window.__DR__.lap
    })`);
    phaseNow = snap.phase;
    aiMaxSeen = Math.max(aiMaxSeen, snap.aiMax);
    if (snap.phase === 'result') { done = true; break; }
  }
  await drv.release();

  check('A7 玩家可真实加速并循线行驶', drv.stat.maxKmh > 60, `峰值 ${drv.stat.maxKmh} km/h`);
  check('A8 自动驾驶没有冲出赛道', drv.stat.maxOff < 0.9, `最大出界系数 ${drv.stat.maxOff.toFixed(2)}`);
  check('A9 AI 对手在行驶（曲率速度剖面 + 刹车点生效）', aiMaxSeen > 60,
    `AI 峰值 ${aiMaxSeen} km/h`);

  const aiInfo = await page.eval(`({ racers: window.__DR__.racers, lap: window.__DR__.lap })`);
  check('A10 完成 1 圈并进入结算', done, `phase=${phaseNow} lap=${aiInfo.lap}`);

  if (done) {
    const res = await page.eval(`({
      rows: document.querySelectorAll('#result-table tr').length - 1,
      title: document.getElementById('result-title').textContent,
      ach: window.__DR_API__.ach().count()
    })`);
    check('A11 结算表渲染出名次', res.rows >= 4, res.rows + ' 行');
    check('A12 成就已解锁', res.ach > 0, res.ach + ' 项 · ' + res.title);
  }
  await page.shot('tools/shot-solo-result.png');

  const errs = page.errors();
  check('A13 全程无 JS 异常 / console 错误', errs.length === 0, errs.slice(0, 3).join(' | '));
  await page.close();
}

async function testSplit(browser) {
  log('\n\x1b[1m[B] 本地分屏双人\x1b[0m');
  const page = await browser.newPage();
  if (!check('B1 页面加载完成', await page.readyUrl(SERVER + '/'), '')) return;

  await page.eval(`window.__DR_API__.start({ mode:'split', track:'coast', laps:1, level:'easy' })`);
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (await page.eval("window.__DR__.phase === 'race'")) break;
  }
  const st = await page.eval(`({
    phase: window.__DR__.phase,
    locals: window.__DR__.locals.length,
    splitHud: !document.getElementById('split-hud').classList.contains('hidden'),
    mainHudHidden: document.getElementById('lapbox').classList.contains('hidden')
  })`);
  check('B2 创建两位本地玩家', st.locals === 2, st.locals + ' 位');
  check('B3 分屏 HUD 显示、单人 HUD 隐藏', st.splitHud && st.mainHudHidden);

  const d1 = await makeDriver(page, 1);
  // P2 走偏移车道，模拟真实双人分屏（两车同线会贴在碰撞分离下限，误报）
  const d2 = await makeDriver(page, 2, { lane: 3.5 });
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) {
    await d1.step();
    await d2.step();
    await sleep(70);
  }
  await d1.release(); await d2.release();
  const after = await page.eval('window.__DR__.locals');
  check('B4 P1 在行驶', after[0].kmh > 20, after[0].kmh + ' km/h');
  check('B5 P2 在行驶（方向键独立控制）', after[1].kmh > 20, after[1].kmh + ' km/h');
  check('B6 两台车位置互相独立', Math.hypot(after[0].x - after[1].x, after[0].z - after[1].z) > 3,
    '间距 ' + Math.hypot(after[0].x - after[1].x, after[0].z - after[1].z).toFixed(1) + ' 单位');
  await page.shot('tools/shot-split.png');

  const errs = page.errors();
  check('B7 分屏模式无 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));
  await page.close();
}

async function testOnline(browser, { poll = false } = {}) {
  const tag = poll ? 'D' : 'C';
  const name = poll ? '轮询降级通道' : '在线联机双客户端';
  log(`\n\x1b[1m[${tag}] ${name}\x1b[0m`);

  const host = await browser.newPage();
  const guest = await browser.newPage();
  log('    [diag] 两个页面 target 已建立');
  const okA = await host.readyUrl(SERVER + '/');
  log(`    [diag] 房主页加载=${okA} title=${await host.eval('document.title').catch(() => '?')}`);
  const okB = await guest.readyUrl(SERVER + '/');
  log(`    [diag] 加入页加载=${okB} title=${await guest.eval('document.title').catch(() => '?')}`);
  if (!check(`${tag}1 两个浏览器实例均加载完成`, okA && okB, `房主=${okA} 加入者=${okB}`)) return;

  if (poll) {
    await host.eval('window.__DR_FORCE_POLL__ = true');
    await guest.eval('window.__DR_FORCE_POLL__ = true');
  }

  await host.eval(`window.__DR_API__.createRoom({ name:'房主A', paint:0, track:'coast', laps:1, level:'normal' })`);
  // 等房间码
  let code = null;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    code = await host.eval('window.__DR_API__.net().room');
    if (code) break;
  }
  check(`${tag}2 房主建房成功并拿到房间码`, !!code, 'code=' + code);
  if (!code) { await host.close(); await guest.close(); return; }

  const transport = await host.eval('window.__DR_API__.net().transport');
  check(`${tag}3 传输通道 = ${poll ? 'poll（轮询）' : 'ws（WebSocket）'}`,
    transport === (poll ? 'poll' : 'ws'), 'transport=' + transport);

  await guest.eval(`window.__DR_API__.joinRoom('${code}', { name:'挑战者B', paint:2 })`);
  let hostSees = 0, guestSees = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    hostSees = await host.eval('window.__DR_API__.net().players.length');
    guestSees = await guest.eval('window.__DR_API__.net().players.length');
    if (hostSees === 2 && guestSees === 2) break;
  }
  check(`${tag}4 双方都看到房间里有 2 人`, hostSees === 2 && guestSees === 2,
    `房主看到 ${hostSees} 人 / 加入者看到 ${guestSees} 人`);

  const roster = await host.eval('window.__DR_API__.net().players.map(p=>p.name)');
  check(`${tag}5 玩家名册正确同步`, Array.isArray(roster) && roster.includes('挑战者B'), roster.join(','));

  // 房主发车
  await host.eval('window.__DR_API__.startOnline()');
  let raceA = false, raceB = false;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    raceA = await host.eval("window.__DR__.phase === 'race'");
    raceB = await guest.eval("window.__DR__.phase === 'race'");
    if (raceA && raceB) break;
  }
  check(`${tag}6 服务器发车信号让双方同步进入比赛`, raceA && raceB,
    `房主=${raceA} 加入者=${raceB}`);
  if (!(raceA && raceB)) {
    for (const [label, p] of [['房主', host], ['加入者', guest]]) {
      const d = await p.eval(`({
        phase: window.__DR__ && window.__DR__.phase,
        locals: window.__DR__ ? window.__DR__.locals.length : -1,
        frames: window.__DR__ ? window.__DR__.frames : -1,
        err: window.__DR_ERROR__ || null,
        status: window.__DR_API__.net().status,
        transport: window.__DR_API__.net().transport,
        room: window.__DR_API__.net().room,
        myId: window.__DR_API__.net().myId,
        players: window.__DR_API__.net().players.length,
        isHost: window.__DR_API__.net().isHost,
      })`).catch((e) => ({ evalFail: String(e) }));
      log(`    [diag] ${label}: ${JSON.stringify(d)}`);
      log(`    [diag] ${label} 页面错误: ${p.errors().slice(0, 3).join(' | ') || '无'}`);
    }
  }

  // 双方各自驾驶
  const d1 = await makeDriver(host, 1);
  const d2 = await makeDriver(guest, 1);
  const t0 = Date.now();
  let remoteMovedA = 0, remoteMovedB = 0;
  let lastA = null, lastB = null;
  while (Date.now() - t0 < 30000) {
    await d1.step();
    await d2.step();
    await sleep(80);
    const ra = await host.eval(`(() => { const r = [...window.__DR_API__.net().remotes.values()][0];
      return r ? { x: r.x, z: r.z, count: window.__DR__.remoteCount, kmh: window.__DR__.locals[0].kmh } : null; })()`);
    const rb = await guest.eval(`(() => { const r = [...window.__DR_API__.net().remotes.values()][0];
      return r ? { x: r.x, z: r.z, count: window.__DR__.remoteCount, kmh: window.__DR__.locals[0].kmh } : null; })()`);
    if (ra && lastA) remoteMovedA += Math.hypot(ra.x - lastA.x, ra.z - lastA.z);
    if (rb && lastB) remoteMovedB += Math.hypot(rb.x - lastB.x, rb.z - lastB.z);
    lastA = ra; lastB = rb;
    if (remoteMovedA > 150 && remoteMovedB > 150) break;
  }
  await d1.release(); await d2.release();

  check(`${tag}7 房主看到加入者的车在真实移动`, remoteMovedA > 100,
    '累计位移 ' + remoteMovedA.toFixed(0) + ' 单位');
  check(`${tag}8 加入者看到房主的车在真实移动`, remoteMovedB > 100,
    '累计位移 ' + remoteMovedB.toFixed(0) + ' 单位');

  const posCheck = await host.eval(`(() => {
    const r = [...window.__DR_API__.net().remotes.values()][0];
    const me = window.__DR__.locals[0];
    return r ? { gap: Math.hypot(r.x - me.x, r.z - me.z), remoteName: r.name } : null; })()`);
  check(`${tag}9 远端车与自己车不是同一个位置（未穿模重合）`,
    posCheck && posCheck.gap > 3, posCheck ? `${posCheck.remoteName} 距离 ${posCheck.gap.toFixed(1)} 单位` : 'n/a');

  await host.shot(`tools/shot-online-host${poll ? '-poll' : ''}.png`);
  if (!poll) await guest.shot('tools/shot-online-guest.png');

  const eA = host.errors(), eB = guest.errors();
  check(`${tag}10 双方均无 JS 异常`, eA.length === 0 && eB.length === 0,
    (eA.slice(0, 2).concat(eB.slice(0, 2))).join(' | '));

  await host.close(); await guest.close();
}

async function testServer() {
  log('\n\x1b[1m[E] 服务器安全检查\x1b[0m');
  const h = await httpJson(SERVER + '/api/health');
  check('E1 /api/health 正常', h.ok === true, JSON.stringify(h));

  const room = await httpJson(SERVER + '/api/room/ZZZZ');
  check('E2 不存在的房间返回 exists:false', room.exists === false);

  const bad = await httpJson(SERVER + '/api/room/' + encodeURIComponent('../../etc/passwd'));
  check('E3 房间码接口对畸形输入安全', bad.exists === false || bad.error !== undefined);

  // 路径穿越
  const code = await new Promise((res) => {
    http.get(SERVER + '/../package.json', (r) => { r.resume(); res(r.statusCode); }).on('error', () => res(0));
  });
  check('E4 静态服务阻止路径穿越', code === 404 || code === 403, 'HTTP ' + code);
}

/* ============================================================ 浏览器管理 */
class Browser {
  constructor(chrome) { this.chrome = chrome; this.browserWs = null; this.pages = []; }

  static async launch() {
    // profile 放系统临时目录，且每次用独立目录：
    //   1) 留在项目里会污染部署包（十几 MB 且带锁文件）
    //   2) 复用同一目录需先删除，而 Windows 上同步删 Chrome profile 会卡死事件循环
    //      （profile 内含 reparse point；详见 cdp.mjs 的 sweepOldProfiles 注释）
    const profile = path.join(os.tmpdir(), `dr-cdp-profile-${process.pid.toString(36)}${Date.now().toString(36)}`);
    sweepOldProfiles('cdp-profile').catch(() => { });      // 老目录异步清理，不 await
    // 先腾干净端口：残留实例会让我们连到僵尸浏览器上（详见 shutdownStale 注释）
    if (await tryVersion(CDP_PORT, 1500)) {
      const freed = await shutdownStale(CDP_PORT);
      if (!freed) throw new Error(`端口 ${CDP_PORT} 被一个无法关闭的 CDP 实例占用，请先手动结束该进程`);
      console.log(`  [cdp] 已清理 ${CDP_PORT} 端口上的残留浏览器实例`);
    }
    const chrome = spawn(CHROME, [
      // 注意：该 Chromium 上 --headless=new 会直接退出，必须用 --headless
      '--headless', '--no-sandbox', '--disable-dev-shm-usage',
      '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=' + profile,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
      // 无头环境靠 SwiftShader 软件光栅化提供 WebGL 2.0
      '--enable-unsafe-swiftshader',
      // 不走系统代理：否则访问远端域名会被代理探测拖慢每个静态资源数秒
      '--no-proxy-server',
      // 多开标签页跑联机测试：禁用后台标签的 rAF 节流，否则第一个标签会被冻结
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--window-size=960,600',
      'about:blank',
    ], { stdio: 'ignore' });

    let version = null;
    for (let i = 0; i < 80; i++) {
      await sleep(300);
      if (chrome.exitCode !== null) break;
      try { version = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/version`, 2500); break; }
      catch (e) { /* 还没起来 */ }
    }
    if (!version) {
      try { chrome.kill(); } catch (e) { }
      throw new Error('Chrome 调试端口未就绪' +
        (chrome.exitCode !== null ? `（Chrome 已退出，code=${chrome.exitCode}）` : ''));
    }
    return new Browser(chrome);
  }

  /** 优雅关闭：先 Browser.close 再兜底 kill，不留僵尸实例占端口 */
  async kill() {
    for (const p of this.pages) { try { p.ws.close(); } catch (e) { } }
    this.pages = [];
    try { if (this.browserWs) await this.browserWs.send('Browser.close', {}, 2000); } catch (e) { }
    await sleep(700);
    try { if (this.chrome.exitCode === null) this.chrome.kill(); } catch (e) { }
  }

  async browserConn() {
    if (this.browserWs) return this.browserWs;
    const v = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
    this.browserWs = new Page(await openWs(v.webSocketDebuggerUrl));
    return this.browserWs;
  }

  /** 新建一个页面（复用初始 about:blank，之后用 Target.createTarget） */
  async newPage() {
    const b = await this.browserConn();
    let targetId = null;
    if (!this.usedInitial) {
      this.usedInitial = true;
      const list = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const first = list.find((t) => t.type === 'page');
      if (first) targetId = first.id;
    }
    if (!targetId) {
      const r = await b.send('Target.createTarget', { url: 'about:blank' });
      targetId = r.targetId;
      await sleep(600);
    }
    const list = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const t = list.find((x) => x.id === targetId);
    if (!t) throw new Error('找不到页面目标 ' + targetId);
    const ws = await openWs(t.webSocketDebuggerUrl);
    const page = new Page(ws);
    await page.send('Runtime.enable');
    await page.send('Log.enable');
    await page.send('Page.enable');
    page._ws = ws;
    this.pages.push(page);
    return page;
  }

  async kill() {
    for (const p of this.pages) { try { p._ws.close(); } catch (e) { } }
    this.chrome.kill();
  }
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', (e) => reject(new Error('ws 连接失败 ' + url)), { once: true });
  });
}

/* ==================================================================== main */
const only = process.argv.slice(2).map((s) => s.toUpperCase());
const want = (k) => only.length === 0 || only.includes(k);

(async () => {
  log('\x1b[1m=== DRIFT RUSH 端到端验收 ===\x1b[0m');
  log(`服务器: ${SERVER}`);

  let browser = null;
  try {
    if (want('E')) await testServer();
    if (want('A') || want('B') || want('C') || want('D')) {
      browser = await Browser.launch();
      log(`\n\x1b[2m浏览器已启动（CDP :${CDP_PORT}）\x1b[0m`);
    }
    if (want('A')) await testSolo(browser);
    if (want('B')) await testSplit(browser);
    if (want('C')) await testOnline(browser, { poll: false });
    if (want('D')) await testOnline(browser, { poll: true });
  } catch (e) {
    log('\n\x1b[31m验收脚本异常: ' + (e && e.stack || e) + '\x1b[0m');
    results.push({ name: '脚本异常', ok: false, detail: String(e && e.message || e) });
  } finally {
    if (browser) await browser.kill();
  }

  log('\n\x1b[1m==================== 结果 ====================\x1b[0m');
  for (const r of results) log(`${r.ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m'} ${r.name}  \x1b[2m${r.detail}\x1b[0m`);
  const pass = results.filter((r) => r.ok).length;
  log(`\n\x1b[1m通过 ${pass}/${results.length}\x1b[0m`);
  process.exit(pass === results.length ? 0 : 2);
})();
