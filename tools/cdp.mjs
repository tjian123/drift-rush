/* ===========================================================================
 * tools/cdp.mjs — 零依赖 CDP 浏览器自动化（Node22 内置 WebSocket 直连）
 *
 * 从 verify.mjs 抽出的可复用部分，供云服务验收等脚本共用。
 * 用法：
 *   import { Browser, sleep, httpJson } from './cdp.mjs'
 * =========================================================================*/

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

export const CHROME = process.env.DR_CHROME ||
  'C:/Users/tjian/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
export const CDP_PORT = Number(process.env.DR_CDP_PORT || 9402);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 读一个 JSON 端点。**必须带超时**：调试端口上如果残留着半死的实例，
 * 无超时的 http.get 会永久挂住 —— 这个坑实测踩过一次（脚本静默卡 2 分钟）。
 */
export function httpJson(url, timeoutMs = 8000) {
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
export async function tryVersion(port, timeoutMs = 2500) {
  try { return await httpJson(`http://127.0.0.1:${port}/json/version`, timeoutMs); }
  catch (e) { return null; }
}

/**
 * 关闭端口上残留的浏览器实例，并等端口真正释放。
 *
 * 为什么必须有这一步：上一次跑崩或被中断的 Chrome 会继续占着调试端口和
 * profile 目录，此时新实例**绑不上端口**（静默退出），而 `/json/version`
 * 会被旧实例应答 —— 于是脚本悄然连到僵尸浏览器上，拿到的是上一轮的页面，
 * 表现为「脚本卡住」或「断言莫名其妙失败」，极难排查。
 */
export async function shutdownStale(port) {
  const v = await tryVersion(port, 2500);
  if (!v || !v.webSocketDebuggerUrl) return false;
  try {
    const ws = await openWs(v.webSocketDebuggerUrl);
    const p = new Page(ws);
    try { await p.send('Browser.close', {}, 3000); } catch (e) { /* 关闭瞬间连接会断，属正常 */ }
    try { ws.close(); } catch (e) { }
  } catch (e) { /* 连不上也无妨，交给下面的端口释放探测 */ }
  for (let i = 0; i < 24; i++) {
    await sleep(250);
    if (!(await tryVersion(port, 1200))) return true;
  }
  return false;
}

/**
 * 顺手清理历史遗留的 profile 目录。
 *
 * 两个硬约束：
 *   1) 用 `fs.promises.rm`（线程池，不阻塞事件循环），绝不用 `fs.rmSync` ——
 *      Chrome profile 内含 reparse point，`rmSync` 递归删除在 Windows 上会
 *      **永久卡死并同步阻塞事件循环**（实测踩过：连看门狗定时器都触发不了）。
 *   2) 每个目录加超时兜底，且只清 1 小时前的旧目录 —— 正在用的目录绝不碰。
 * 清不掉就放弃（留在系统临时目录里无副作用），绝不能影响启动路径。
 */
export async function sweepOldProfiles(profileName, { maxAgeMs = 3600_000, maxDirs = 3 } = {}) {
  if (process.env.DR_NO_SWEEP) return 0;
  const tmp = os.tmpdir();
  let names = [];
  try { names = fs.readdirSync(tmp); } catch (e) { return 0; }
  const prefix = `dr-${profileName}`;
  let cleaned = 0;
  for (const n of names) {
    if (cleaned >= maxDirs) break;
    if (!n.startsWith(prefix) || n === prefix) continue;   // 不带后缀的老目录名不碰
    const dir = path.join(tmp, n);
    try {
      const st = fs.statSync(dir);
      if (!st.isDirectory() || Date.now() - st.mtimeMs < maxAgeMs) continue;
    } catch (e) { continue; }
    await Promise.race([
      fs.promises.rm(dir, { recursive: true, force: true }).catch(() => { }),
      sleep(8000),
    ]);
    cleaned++;
  }
  return cleaned;
}

/* 注意：这里刻意不提供任何 `fs.rmSync` 形式的目录删除工具函数。
 * Chrome profile 目录内含 reparse point，同步递归删除在 Windows 上会无限
 * 递归并卡死事件循环 —— 需要用删除时一律走上面 sweepOldProfiles 的异步路径。*/

export function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error('ws 连接失败 ' + url)), { once: true });
  });
}

/* ------------------------------------------------------------------- Page */
export class Page {
  constructor(ws) {
    this.ws = ws;
    this._ws = ws;
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
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error('eval: ' + (r.exceptionDetails.text || '') + ' ' +
        (r.exceptionDetails.exception?.description || ''));
    }
    return r.result.value;
  }

  async key(code, key, vk, down) {
    await this.send('Input.dispatchKeyEvent', {
      type: down ? 'keyDown' : 'keyUp', code, key,
      windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    });
  }

  /** 真实点击（按元素 id 触发 click 事件，等价于鼠标点击该元素） */
  async click(id) {
    const ok = await this.eval(`(() => {
      const el = document.getElementById(${JSON.stringify(id)});
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (!ok) throw new Error('找不到元素 #' + id);
    await sleep(60);
  }

  /** 真实输入（走 input 事件，与用户键入等效） */
  async fill(id, value) {
    const ok = await this.eval(`(() => {
      const el = document.getElementById(${JSON.stringify(id)});
      if (!el) return false;
      el.value = ${JSON.stringify(String(value))};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    if (!ok) throw new Error('找不到元素 #' + id);
    await sleep(40);
  }

  async text(id) {
    return this.eval(`(() => {
      const el = document.getElementById(${JSON.stringify(id)});
      return el ? el.textContent : null;
    })()`);
  }

  /**
   * 元素是否**真的可见**。
   * 不能只看 classList.contains('hide')：样式里如果组件类的 display 覆盖了
   * .hide（这个坑真实存在过），类名在但元素仍占位 —— 断言就会全部失真。
   * 这里以计算样式 + 实际占位为准。
   */
  async visible(id) {
    return this.eval(`(() => {
      const el = document.getElementById(${JSON.stringify(id)});
      if (!el) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })()`);
  }

  /** 与 visible() 同源，但返回面板显隐的明细（便于断言「互斥显示」） */
  async panelState(ids) {
    return this.eval(`(() => {
      const out = {};
      for (const id of ${JSON.stringify(ids)}) {
        const el = document.getElementById(id);
        if (!el) { out[id] = null; continue; }
        const cs = getComputedStyle(el);
        out[id] = cs.display !== 'none' && cs.visibility !== 'hidden' &&
                  el.getBoundingClientRect().height > 0;
      }
      return out;
    })()`);
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

  /**
   * 失败的网络请求（需先 Network.enable）。
   * 控制台里「Failed to load resource: 400」这类信息看不到具体是哪个接口，
   * 这里把 URL / 方法 / 请求体 / 响应体拼出来，验收失败时能直接定位。
   */
  failedRequests() {
    const reqs = new Map();
    for (const e of this.events) {
      if (e.method === 'Network.requestWillBeSent') reqs.set(e.params.requestId, e.params.request);
    }
    const out = [];
    for (const e of this.events) {
      if (e.method !== 'Network.responseReceived') continue;
      const { status, url } = e.params.response;
      if (status < 400) continue;
      const req = reqs.get(e.params.requestId) || {};
      out.push(`${status} ${req.method || '?'} ${url}`
        + (req.postData ? ` · body=${String(req.postData).slice(0, 200)}` : ''));
    }
    return out;
  }

  async readyUrl(url) {
    await this.send('Page.navigate', { url });
    for (let i = 0; i < 140; i++) {
      await sleep(400);
      try {
        if (await this.eval('!!(window.__DR_READY__ || window.__DR_BOOTED__)')) {
          for (let k = 0; k < 30; k++) {
            await sleep(300);
            const f = await this.eval('window.__DR__ ? window.__DR__.frames : 0');
            if (f > 20) return true;
          }
          return true;
        }
        const err = await this.eval('window.__DR_ERROR__ || null');
        if (err) return false;
      } catch (e) { /* 导航中 */ }
    }
    return false;
  }

  async close() {
    try { this.ws.close(); } catch (e) { }
  }

  /* =============================================================== 移动端 */
  /**
   * 打开触摸模拟。必须在 Page.navigate **之前**调用：
   * 页面里的 `'ontouchstart' in window / navigator.maxTouchPoints` 是在脚本
   * 首次执行时读取的，导航完再开就晚了 —— 触屏 UI 根本不会出现。
   */
  async emulateMobile({ width = 880, height = 412, maxTouchPoints = 5, mobile = true } = {}) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile,
      screenOrientation: { type: width >= height ? 'landscapePrimary' : 'portraitPrimary', angle: 0 },
    });
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints });
    await this.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
  }

  /**
   * 派发真实触摸事件。
   * 用 Input.dispatchTouchEvent 而不是直接改 JS 变量：走完整的浏览器输入管线，
   * Chrome 会由触摸事件合成 PointerEvent —— 这是唯一能证明「真的能用手玩」的做法。
   * @param type touchStart | touchMove | touchEnd
   * @param points 当前仍按住的触点 [{id,x,y}]（touchEnd 传剩余触点，可传空数组）
   */
  async touch(type, points = []) {
    await this.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map((p) => ({
        x: Math.round(p.x), y: Math.round(p.y),
        id: p.id ?? 1, radiusX: 12, radiusY: 12, force: 1,
      })),
    });
  }

  /** 元素中心的屏幕坐标（触摸派发需要真实像素坐标，不是 CSS 选择器） */
  async center(id) {
    return this.eval(`(() => {
      const el = document.getElementById(${JSON.stringify(id)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    })()`);
  }

  /** 元素半径基准（方向盘的 --r），用于计算「拖到多远才算打满」 */
  async cssVar(id, name) {
    return this.eval(`(() => {
      const el = document.getElementById(${JSON.stringify(id)});
      if (!el) return null;
      const v = getComputedStyle(el).getPropertyValue(${JSON.stringify(name)});
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : null;
    })()`);
  }

  /** 一次性把每个触点的按下/移动/抬起序列跑完（含真实的时间间隔） */
  async drag({ from, to, steps = 6, id = 1, holdMs = 40, beforeUp }) {
    await this.touch('touchStart', [{ id, x: from.x, y: from.y }]);
    await sleep(holdMs);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await this.touch('touchMove', [{
        id, x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t,
      }]);
      await sleep(holdMs);
    }
    if (beforeUp) await beforeUp();
    await this.touch('touchEnd', []);
    return true;
  }
}

/* ---------------------------------------------------------------- Browser */
export class Browser {
  constructor(chrome, port) { this.chrome = chrome; this.port = port; this.pages = []; }

  static async launch({ port = CDP_PORT, profileName = 'cdp-profile-cloud' } = {}) {
    // profile 放系统临时目录，且**每次启动都用独立目录**：
    //   1) 留在项目里会污染部署包（十几 MB 且带锁文件）
    //   2) 复用同一目录就必须先删旧的，而 Windows 上同步删除 Chrome profile
    //      会卡死（见 sweepOldProfiles 注释）—— 用新目录从根上绕开这个问题
    const profile = path.join(
      os.tmpdir(), `dr-${profileName}-${process.pid.toString(36)}${Date.now().toString(36)}`);
    // 老目录异步清理，不 await：清理失败也绝不能拖慢/阻断启动
    sweepOldProfiles(profileName).catch(() => { });

    // 端口腾干净 —— 残留实例会让我们悄悄连到僵尸浏览器上（详见 shutdownStale 注释）
    if (await tryVersion(port, 1500)) {
      const freed = await shutdownStale(port);
      if (!freed) throw new Error(`端口 ${port} 被一个无法关闭的 CDP 实例占用，请先手动结束该进程`);
      console.log(`  [cdp] 已清理 ${port} 端口上的残留浏览器实例`);
    }

    const chrome = spawn(CHROME, [
      // 该 Chromium 上 --headless=new 会直接退出，必须用 --headless
      '--headless', '--no-sandbox', '--disable-dev-shm-usage',
      '--remote-debugging-port=' + port,
      '--user-data-dir=' + profile,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
      '--enable-unsafe-swiftshader',       // 无头 WebGL
      // 不走系统代理：否则访问远端域名时会走代理探测/重试，静态资源每个都要卡数秒
      // （localhost 恰好被代理绕过，所以这个坑只在测线上地址时暴露）
      '--no-proxy-server',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--window-size=1000,760',
      'about:blank',
    ], { stdio: 'ignore' });

    let version = null;
    for (let i = 0; i < 80; i++) {
      await sleep(300);
      if (chrome.exitCode !== null) break;            // 进程已退出，再等也没意义
      try { version = await httpJson(`http://127.0.0.1:${port}/json/version`, 2500); break; }
      catch (e) { /* 未就绪 */ }
    }
    if (!version) {
      try { chrome.kill(); } catch (e) { }
      throw new Error('Chrome 调试端口未就绪' +
        (chrome.exitCode !== null ? `（Chrome 已退出，code=${chrome.exitCode}）` : ''));
    }
    const b = new Browser(chrome, port);
    b.browserWs = new Page(await openWs(version.webSocketDebuggerUrl));
    return b;
  }

  async newPage() {
    const list = await httpJson(`http://127.0.0.1:${this.port}/json/list`);
    let target = list.find((t) => t.type === 'page' && t.url === 'about:blank');
    if (!target) {
      // 兜底一：显式开一个干净 target
      try {
        const r = await this.browserWs.send('Target.createTarget', { url: 'about:blank' });
        await sleep(600);
        const l2 = await httpJson(`http://127.0.0.1:${this.port}/json/list`);
        target = l2.find((x) => x.id === r.targetId);
      } catch (e) { /* 继续兜底二 */ }
      // 兜底二：复用任意已存在的页面（比直接失败更有用；页面会被导航覆盖）
      if (!target) target = list.find((t) => t.type === 'page');
    }
    if (!target) throw new Error('找不到可用的页面目标');
    const ws = await openWs(target.webSocketDebuggerUrl);
    const page = new Page(ws);
    await page.send('Runtime.enable');
    await page.send('Log.enable');
    await page.send('Page.enable');
    await page.send('Network.enable');    // 供 failedRequests() 定位 4xx/5xx 接口
    this.pages.push(page);
    return page;
  }

  /** 优雅关闭：先 Browser.close，再兜底 kill —— 不留僵尸实例占端口 */
  async kill() {
    for (const p of this.pages) { try { p.ws.close(); } catch (e) { } }
    this.pages = [];
    try { await this.browserWs.send('Browser.close', {}, 2000); } catch (e) { }
    await sleep(700);
    try { if (this.chrome.exitCode === null) this.chrome.kill(); } catch (e) { }
  }
}
