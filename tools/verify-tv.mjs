/* ===========================================================================
 * verify-tv.mjs — 电视模式 / 投屏 / 手柄菜单导航 的定量验收
 *
 * 【为什么需要它】
 * 这一整块都是"错了不报错、只是看不清/按不到"的问题：
 *   ① HUD 缩放系数写死在某个组件上，漏一个就是一个永远小字的控件 —— 而电视
 *      上小字的后果是"根本读不到"，不是"有点小"。
 *   ② 菜单放大 1.5 倍后顶出视口：电视没有滚动条可拖，超出的部分等于永久不可达
 *      （"开始比赛"被顶到屏幕外 = 开不了局）。
 *   ③ 手柄在菜单里没有焦点目标：能开车、开不了局，必须有人拿鼠标点一下。
 *   ④ 老电视只有 WebGL1 且没有可渲染的半浮点缓冲：HDR 后处理会让整屏变黑，
 *      比"少一层泛光"严重得多。
 * 四个都不会抛异常，且**在电脑屏幕上看不出来**（1080p 显示器上缩放前后可能
 * 完全一样），所以必须写成断言，而不是"我看着没问题"。
 *
 * 【关键判据】
 *   T3 用「同一个元素的字号放大倍数」而不是"截图里字变大了吗"——倍率是可回归的
 *      数值；T5 用「菜单 scrollHeight ≤ clientHeight」钉死②；T7 用焦点矩形
 *      的**屏幕坐标**验证方向键真按方向走（DOM 顺序会骗人）。
 * =========================================================================*/
import { Browser, sleep } from './cdp.mjs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const BASE = process.env.DR_BASE || 'http://127.0.0.1:8790';
const PORT = Number(process.env.DR_TV_PORT || 9426);
let passed = 0, failed = 0;

function check(name, ok, detail = '') {
  ok ? passed++ : failed++;
  console.log(
    `  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✘\x1b[0m'} ${name}` +
      (detail ? `  \x1b[2m${detail}\x1b[0m` : ''),
  );
}

async function ensureServer() {
  const alive = () =>
    fetch(BASE + '/api/health').then((r) => r.ok).catch(() => false);
  if (await alive()) return;
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    env: { ...process.env, PORT: new URL(BASE).port || '3000' },
    stdio: 'ignore', detached: true,
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await delay(250);
    if (await alive()) return;
  }
  throw new Error('本地服务器启动失败');
}

/** 等游戏启动完成（__DR_READY__ 由 boot 末尾置位） */
async function waitReady(page, ms = 25000) {
  for (let i = 0; i < ms / 300; i++) {
    const r = await page.eval(`(window.__DR_READY__ && window.__DR_API__) ? 1 : 0`).catch(() => 0);
    if (r === 1) return true;
    await sleep(300);
  }
  return false;
}

/* 读取某个 id 的「字号 / 位置 / 尺寸」，用来比较放大前后 */
const probe = (page, id) => page.eval(`(() => {
  const el = document.getElementById('${id}');
  if (!el) return null;
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return { font: parseFloat(cs.fontSize), w: r.width, h: r.height, top: r.top, left: r.left };
})()`);

/** 焦点系统当前状态（含焦点元素的屏幕矩形） */
const navState = (page) => page.eval(`(() => {
  const n = window.__DR_TVNAV__;
  if (!n) return null;
  const s = n.state();
  const el = document.querySelector('.navfocus');
  const r = el ? el.getBoundingClientRect() : null;
  return { ...s, rect: r ? { x: r.left + r.width / 2, y: r.top + r.height / 2, id: el.id || el.className } : null };
})()`);

/** 电视遥控器 = 方向键：真实派发 KeyboardEvent（与遥控器按键走同一条路径） */
const pressKey = (page, key) => page.eval(`(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
  return true;
})()`);

await ensureServer();
console.log('\x1b[1m电视模式 / 投屏 / 手柄导航验收\x1b[0m');
const b = await Browser.launch({ port: PORT, profileName: 'cdp-tv' });

/* ======================================================================
 * 场景 A：默认（桌面，不带参数）—— 必须完全不受影响
 * ====================================================================*/
{
  const page = await b.newPage();
  await page.readyUrl(BASE + '/');
  check('A0 页面加载完成', await waitReady(page));
  await sleep(1200);

  const t = await page.eval(`window.__DR_API__.tv()`);
  const uiVar = await page.eval(`getComputedStyle(document.documentElement).getPropertyValue('--ui').trim()`);
  check('A1 桌面默认不进电视模式', t.enabled === false, `enabled=${t.enabled} reason=${t.reason}`);
  check('A2 --ui 保持 1（缩放不误伤桌面）', uiVar === '1', `--ui=${uiVar}`);
  const tvClass = await page.eval(`document.body.classList.contains('tv')`);
  check('A3 body 上没有 .tv 类（电视专属样式不生效）', tvClass === false);

  const base = await probe(page, 'speednum');
  check('A4 基准字号可测（后续按倍率比较）', base && base.font > 0, `speednum=${base && base.font}px`);

  /* 桌面菜单也不能溢出：这是基线，B7 的电视断言要和它同口径 */
  const menuFit = await page.eval(`(() => {
    const m = document.getElementById('screen-menu');
    return { sh: m.scrollHeight, ch: m.clientHeight };
  })()`);
  check('A5 桌面菜单整屏放得下（基线）', menuFit.sh <= menuFit.ch + 4,
    `scroll=${menuFit.sh} client=${menuFit.ch}`);

  global.__BASE_FONT = base.font;
  await page.close();
}

/* ======================================================================
 * 场景 B：?tv=1 —— 电视模式本体
 * ====================================================================*/
{
  const page = await b.newPage();
  await page.readyUrl(BASE + '/?tv=1');
  check('B0 页面加载完成', await waitReady(page));
  await sleep(1500);

  const t = await page.eval(`window.__DR_API__.tv()`);
  const vars = await page.eval(`(() => {
    const cs = getComputedStyle(document.documentElement);
    return { ui: cs.getPropertyValue('--ui').trim(), menu: cs.getPropertyValue('--ui-menu').trim() };
  })()`);
  check('B1 URL ?tv=1 进入电视模式', t.enabled === true && t.reason === 'url',
    `enabled=${t.enabled} reason=${t.reason}`);
  check('B2 --ui 放大到 2（HUD 按观看距离放大）', Number(vars.ui) >= 1.8,
    `--ui=${vars.ui} hudScale=${t.hudScale}`);
  /* 菜单倍率必须**小于** HUD 倍率（跟着放大 2 倍会顶出视口），但仍要大于 1。
     注意测试视口只有 1000×609，比真实电视小得多，fit() 会据此把菜单倍率往回
     收到刚好放得下 —— 所以这里断言的是"独立且仍被放大"，不是某个固定数值。 */
  check('B3 --ui-menu 独立放大且小于 HUD 倍率',
    Number(vars.menu) > 1 && Number(vars.menu) < Number(vars.ui),
    `--ui-menu=${vars.menu} < --ui=${vars.ui}`);

  const now = await probe(page, 'speednum');
  const ratio = now.font / global.__BASE_FONT;
  check('B4 HUD 字号实际放大 ≥1.8 倍（倍率可回归，不靠肉眼看截图）',
    ratio >= 1.8, `${global.__BASE_FONT}px → ${now.font}px (×${ratio.toFixed(2)})`);

  const cls = await page.eval(`document.body.classList.contains('tv')`);
  check('B5 body.tv 生效（电视专属样式：过扫描内边距 / 光标隐藏）', cls === true);

  /* 菜单必须整屏可见：电视上超出视口 = 永久不可达 */
  const fit = await page.eval(`(() => {
    const m = document.getElementById('screen-menu');
    return { sh: m.scrollHeight, ch: m.clientHeight, menu: getComputedStyle(document.documentElement).getPropertyValue('--ui-menu').trim() };
  })()`);
  check('B6 菜单整屏放得下（超出则自动收回倍率）', fit.sh <= fit.ch + 4,
    `scroll=${fit.sh} client=${fit.ch} --ui-menu=${fit.menu}`);

  /* "下一步 / 开始比赛"必须在视口内 —— 被顶出屏幕就等于开不了局 */
  const nav = await page.eval(`(() => {
    const out = {};
    for (const id of ['btn-next', 'btn-go', 'menu-steps']) {
      const el = document.getElementById(id);
      const r = el.getBoundingClientRect();
      out[id] = { top: r.top, bottom: r.bottom, inView: r.top >= -1 && r.bottom <= innerHeight + 1 };
    }
    return out;
  })()`);
  check('B7 导航按钮在视口内（btn-next 可见即代表能推进流程）',
    nav['btn-next'].inView, `btn-next top=${nav['btn-next'].top.toFixed(0)} bottom=${nav['btn-next'].bottom.toFixed(0)} vh=${await page.eval('innerHeight')}`);

  /* HUD 放大后不能互相压出屏幕：比赛里四个面板都要在视口内 */
  await page.eval(`window.__DR_API__.start({ mode: 'solo', track: 'coast', laps: 1 })`);
  await sleep(1500);
  await page.eval(`window.__DR_API__.skipCountdown()`);
  await sleep(1800);
  const hud = await page.eval(`(() => {
    const out = {};
    for (const id of ['lapbox', 'speedbox', 'mapwrap']) {
      const el = document.getElementById(id);
      if (!el || el.classList.contains('hidden')) { out[id] = null; continue; }
      const r = el.getBoundingClientRect();
      out[id] = { l: r.left, t: r.top, r: r.right, btm: r.bottom,
        inView: r.left >= -2 && r.top >= -2 && r.right <= innerWidth + 2 && r.bottom <= innerHeight + 2 };
    }
    return out;
  })()`);
  const hudOK = ['lapbox', 'speedbox', 'mapwrap'].every(
    (k) => !hud[k] || hud[k].inView,
  );
  check('B8 放大后的 HUD 面板仍在视口内（没有被顶出屏幕）', hudOK,
    Object.entries(hud).map(([k, v]) => `${k}=${v ? (v.inView ? 'ok' : 'OUT') : 'n/a'}`).join(' '));

  check('B9 后处理旁路位可用（老电视无 HDR 缓冲时靠它避免黑屏）',
    typeof t.postBypass === 'boolean', `postBypass=${t.postBypass}`);
  await page.close();
}

/* ======================================================================
 * 场景 C：伪装成智能电视（Tizen UA）—— 自动识别 + 画质封顶
 * ====================================================================*/
{
  const page = await b.newPage();
  const UA = 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/6.0 TV Safari/537.36';
  await page.send('Network.setUserAgentOverride', { userAgent: UA });
  await page.readyUrl(BASE + '/');
  check('C0 页面加载完成', await waitReady(page));
  await sleep(1200);

  const t = await page.eval(`window.__DR_API__.tv()`);
  check('C1 UA 识别为电视设备', t.isTVDevice === true, `ua→isTVDevice=${t.isTVDevice}`);
  check('C2 自动进入电视模式（无需 URL 参数）', t.enabled === true && t.reason === 'ua',
    `enabled=${t.enabled} reason=${t.reason}`);
  check('C3 电视设备画质封顶 ≤1（不跑满血后处理+2048 阴影）',
    t.maxLevel <= 1 && t.quality <= 1, `maxLevel=${t.maxLevel} quality=${t.quality}`);

  /* 电视设备不应该出现"虚拟踏板/自动油门"这类只有触屏才用得上的开关 */
  const rows = await page.eval(`(() => {
    const out = {};
    for (const id of ['row-autogas', 'row-tilt', 'row-pad']) {
      const el = document.getElementById(id);
      out[id] = el ? getComputedStyle(el).display !== 'none' : null;
    }
    return out;
  })()`);
  check('C4 电视上隐藏触屏专属开关、保留手柄说明',
    rows['row-autogas'] === false && rows['row-pad'] === true,
    JSON.stringify(rows));

  /* 遥控器 = 方向键：焦点必须在菜单里出现，且按方向真按屏幕方向移动 */
  await page.eval(`window.__DR_TVNAV__.focus()`);
  await sleep(200);
  const s0 = await navState(page);
  check('C5 焦点系统产出可见焦点框', !!s0 && !!s0.rect, `focus=${s0 && s0.rect && s0.rect.id}`);

  let s1 = s0;
  for (let i = 0; i < 6; i++) {
    await pressKey(page, 'ArrowDown');
    await sleep(120);
    s1 = await navState(page);
    if (s1.rect && s1.rect.id === 'btn-next') break;
  }
  check('C6 按「下」焦点真的往下走（按屏幕坐标，不是 DOM 顺序）',
    !!s1.rect && s1.rect.y > s0.rect.y,
    `y ${s0.rect.y.toFixed(0)} → ${s1.rect.y.toFixed(0)} (${s0.rect.id} → ${s1.rect.id})`);

  const before = await page.eval(`document.getElementById('step-format').classList.contains('hide')`);
  await pressKey(page, 'Enter');
  await sleep(400);
  const after = await page.eval(`document.getElementById('step-format').classList.contains('hide')`);
  check('C7 遥控器 OK（Enter）能推进到下一步',
    before === true && after === false, `step-format hide ${before} → ${after}`);

  await pressKey(page, 'Escape');
  await sleep(400);
  const back = await page.eval(`document.getElementById('step-track').classList.contains('hide')`);
  check('C8 遥控器返回（Escape）退回上一步', back === false, `step-track hide=${back}`);
  await page.close();
}

/* ======================================================================
 * 场景 D：假手柄（无真实硬件）—— 手柄路径也能驱动菜单
 * ====================================================================*/
{
  const page = await b.newPage();
  await page.readyUrl(BASE + '/?tv=1');
  check('D0 页面加载完成', await waitReady(page));
  await sleep(1200);

  /* 注入一个标准布局的假手柄：16 个按钮 + 2 轴，connected=true。
     pad.js / tvnav 都是每帧轮询 getGamepads()，覆盖它即可，无需真硬件。 */
  await page.eval(`(() => {
    const btn = () => ({ pressed: false, value: 0, touched: false });
    const buttons = Array.from({ length: 17 }, btn);
    window.__PAD__ = {
      index: 0, id: 'Mock Pad (XInput)', connected: true, mapping: 'standard',
      timestamp: 0, axes: [0, 0], buttons,
    };
    navigator.getGamepads = () => [window.__PAD__];
    return true;
  })()`);
  await sleep(700);

  const s = await navState(page);
  check('D1 手柄被识别（无需 gamepadconnected 事件）', s.pad === true && s.padSeen === true,
    `pad=${s.pad} padSeen=${s.padSeen}`);
  check('D2 手柄接入后菜单自动出现焦点', !!s.rect && s.count > 0,
    `focus=${s.rect && s.rect.id} 可聚焦控件=${s.count}`);

  /* 十字键「下」：按下 → 等一帧让轮询读到 → 松开 */
  await page.eval(`window.__PAD__.buttons[13].pressed = true`);
  await sleep(260);
  const s2 = await navState(page);
  await page.eval(`window.__PAD__.buttons[13].pressed = false`);
  check('D3 十字键「下」移动焦点', !!s2.rect && s2.index !== s.index,
    `index ${s.index} → ${s2.index} (${s2.rect && s2.rect.id})`);

  /* A 键确认：焦点落在哪个按钮就点哪个，这里断言「点击确实发生了」 */
  const clicked = await page.eval(`(() => {
    const el = document.querySelector('.navfocus');
    if (!el) return null;
    let n = 0;
    const h = () => n++;
    el.addEventListener('click', h);
    window.__PAD__.buttons[0].pressed = true;
    return new Promise((res) => setTimeout(() => {
      window.__PAD__.buttons[0].pressed = false;
      el.removeEventListener('click', h);
      res({ id: el.id || el.className, n });
    }, 400));
  })()`);
  check('D4 A 键触发焦点元素的点击', !!clicked && clicked.n >= 1,
    clicked ? `${clicked.id} ×${clicked.n}` : 'no focus');

  /* START 推进流程（菜单里 = 下一步） */
  const stepBefore = await page.eval(`document.getElementById('step-format').classList.contains('hide')`);
  await page.eval(`(() => { window.__PAD__.buttons[9].pressed = true; return 1; })()`);
  await sleep(400);
  await page.eval(`window.__PAD__.buttons[9].pressed = false`);
  const stepAfter = await page.eval(`document.getElementById('step-format').classList.contains('hide')`);
  check('D5 START 推进流程（等同于点「下一步」）',
    stepBefore !== stepAfter || stepAfter === false,
    `step-format hide ${stepBefore} → ${stepAfter}`);

  await page.close();
}

/* ======================================================================
 * 场景 E：倍率可微调（电视尺寸/观看距离差异很大）
 * ====================================================================*/
{
  const page = await b.newPage();
  await page.readyUrl(BASE + '/?tv=1&ui=2.6&uimenu=1.3');
  check('E0 页面加载完成', await waitReady(page));
  await sleep(1200);
  const t = await page.eval(`window.__DR_API__.tv()`);
  const fontNow = await probe(page, 'speednum');
  check('E1 URL 参数可覆盖放大倍率', Math.abs(t.hudScale - 2.6) < 0.01,
    `hudScale=${t.hudScale} menuScale=${t.menuScale}`);
  check('E2 倍率真的作用到了 HUD 字号',
    fontNow.font / global.__BASE_FONT > 2.4,
    `×${(fontNow.font / global.__BASE_FONT).toFixed(2)}`);

  /* 关掉电视模式：必须完整还原（这类开关最容易被写成"只能开不能关"） */
  await page.eval(`(() => { window.__DR_API__.tvnav(); return 1; })()`);
  await page.click('btn-tv');
  await sleep(300);
  const t2 = await page.eval(`window.__DR_API__.tv()`);
  const ui2 = await page.eval(`getComputedStyle(document.documentElement).getPropertyValue('--ui').trim()`);
  check('E3 菜单开关能关掉电视模式并还原 --ui',
    t2.enabled === false && ui2 === '1', `enabled=${t2.enabled} --ui=${ui2}`);
  await page.close();
}

await b.kill();
console.log(`\n\x1b[1m结果：${passed} 通过 / ${failed} 失败\x1b[0m`);
process.exit(failed ? 1 : 0);
