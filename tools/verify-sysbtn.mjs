/* ===========================================================================
 * verify-sysbtn.mjs — 原生壳「返回 / 退出」浮层验收
 *
 * 【为什么必须写成断言】
 * 这两个按钮的失效方式是「不报错、只是没反应」——按钮渲染出来了、字样也对，
 * 但被整个屏幕层盖在下面，鼠标事件根本落不到它身上。这类问题在截图里完全
 * 看不出来（按钮确实可见），只有**问浏览器「这个坐标上真正接收点击的是谁」**
 * 才能判定。所以核心判据不是"按钮存在"，而是：
 *
 *   ① 命中判据：按钮中心点上 document.elementFromPoint() 必须返回按钮本身。
 *      返回 .screen 就等于被盖住了 —— 看得见、点不到，正是这次的 bug。
 *   ② 真实鼠标：用 Input.dispatchMouseEvent 按坐标点，而不是 el.click()。
 *      el.click() 直接派发事件，会**绕过遮挡**，用它会让 bug 测不出来。
 *
 * 【必须复刻原生壳的两个注入】
 *   Windows 壳在页面脚本之前注入 __DR_TV_OVERRIDE=false（否则 file:// 会误判成电视）
 *   和 __drNativeExit（退出桥）。不注入就不是真实形态，测了等于没测。
 * =========================================================================*/
import { Browser, sleep } from './cdp.mjs';
import { resolve } from 'node:path';

const PORT = Number(process.env.DR_SYS_PORT || 9463);
const OFFLINE = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  '..', 'drift-rush-tv-apps', 'offline', 'index.html');
const FILE_URL = 'file:///' + OFFLINE.replace(/\\/g, '/');

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
  ok ? passed++ : failed++;
  console.log(
    `  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✘\x1b[0m'} ${name}` +
      (detail ? `  \x1b[2m${detail}\x1b[0m` : ''),
  );
}

async function waitReady(page, ms = 25000) {
  for (let i = 0; i < ms / 300; i++) {
    const r = await page.eval(`window.__DR_READY__ ? 1 : 0`).catch(() => 0);
    if (r === 1) return true;
    await sleep(300);
  }
  return false;
}

/** 真实鼠标点击（按坐标），能反映遮挡；el.click() 会绕过遮挡，不能用来验证 */
async function mouseClick(page, x, y) {
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(220);
}

/** 按钮的中心坐标 + 该点上真正接收事件的元素是谁 */
const probe = (page, id) => page.eval(`(() => {
  const el = document.getElementById('${id}');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const top = document.elementFromPoint(cx, cy);
  const cs = getComputedStyle(el);
  return {
    x: cx, y: cy, w: r.width, h: r.height,
    display: cs.display, visible: cs.display !== 'none' && r.width > 0 && r.height > 0,
    hitId: top ? (top.id || top.tagName) : null,
    hitIsSelf: !!top && (top === el || el.contains(top)),
    text: (el.textContent || '').trim(),
  };
})()`);

/* 与游戏内 visibleScreen() 同口径：账号/排行榜/帮助是叠加层，菜单并不隐藏，
   所以要取 z-index 最高、同层取 DOM 靠后的那个，而不是第一个。 */
const visibleScreen = (page) => page.eval(`(() => {
  const list = [].slice.call(document.querySelectorAll('.screen:not(.hide)'));
  if (!list.length) return null;
  let best = list[0], bestZ = parseInt(getComputedStyle(best).zIndex, 10) || 0;
  for (let i = 1; i < list.length; i++) {
    const z = parseInt(getComputedStyle(list[i]).zIndex, 10) || 0;
    if (z >= bestZ) { best = list[i]; bestZ = z; }
  }
  return best.id;
})()`);

console.log('\x1b[1m原生壳 返回/退出 浮层验收\x1b[0m');
console.log(`\x1b[2m${FILE_URL}\x1b[0m`);
const b = await Browser.launch({ port: PORT, profileName: 'cdp-sysbtn' });
const page = await b.newPage();

/* 复刻 Windows 壳的注入：页面脚本之前生效 */
await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: 'window.__DR_TV_OVERRIDE = false;' +
    'window.__EXIT_CALLS__ = 0;' +
    'window.__drNativeExit = function(){ window.__EXIT_CALLS__++; };',
});

await page.readyUrl(FILE_URL);
check('A0 离线包加载完成', await waitReady(page));
await sleep(1200);

/* 首次启动教学浮层（#screen-help）会盖住按钮，不关掉后面的命中测试全是假的。
   真实玩家第一次也会看到它，但那是界面内的既有交互，不属于本次验收范围。 */
await page.click('btn-help-close').catch(() => {});
await sleep(600);

/* ======================================================================
 * A：浮层可见 + 真的能被点到
 * ====================================================================*/
{
  const shown = await page.eval(`document.getElementById('dr-sys').classList.contains('show')`);
  check('A1 桌面形态显示浮层（非 TV / 非触屏）', shown === true);

  const tv = await page.eval(`document.body.classList.contains('tv')`);
  check('A1b 未误判为电视模式（__DR_TV_OVERRIDE 生效）', tv === false);

  const back = await probe(page, 'dr-back');
  const exit = await probe(page, 'dr-exit');
  check('A2 退出按钮已渲染出尺寸', !!exit && exit.w > 0 && exit.h > 0,
    exit ? `exit ${exit.w.toFixed(0)}x${exit.h.toFixed(0)}` : 'null');

  /* 核心：命中测试。返回 'screen-menu' 之类就说明被屏幕层盖住了 */
  check('A3 退出按钮**点得到**（该坐标命中的是按钮本身，不是屏幕层）',
    !!exit && exit.hitIsSelf, `命中=${exit && exit.hitId} 是否自身=${exit && exit.hitIsSelf}`);

  /* 退出按钮必须可见：有原生退出桥时才显示 */
  check('A4 有原生退出桥时显示「退出」按钮', !!exit && exit.visible,
    `display=${exit && exit.display}`);

  /* 主菜单是根界面，没有上一步可退 —— 此时隐藏返回，避免点了没反应 */
  const scr = await visibleScreen(page);
  check('A5 主菜单下隐藏「返回」（根界面无处可退）',
    scr === 'screen-menu' && !!back && back.display === 'none',
    `screen=${scr} back.display=${back && back.display}`);
}

/* ======================================================================
 * B：真实鼠标点击 —— 退出桥真的被调用
 * ====================================================================*/
{
  const exit = await probe(page, 'dr-exit');
  await page.eval(`window.__EXIT_CALLS__ = 0`);
  await mouseClick(page, exit.x, exit.y);
  const n = await page.eval(`window.__EXIT_CALLS__`);
  check('B1 鼠标点「退出」真的触发原生退出桥', n >= 1, `__EXIT_CALLS__=${n}`);
}

/* ======================================================================
 * C：子界面里点「返回」——真的退回主菜单
 * ====================================================================*/
{
  await page.click('btn-account'); // 打开账号子界面
  await sleep(700);
  const inSub = await visibleScreen(page);
  check('C1 已进入子界面（账号）', inSub === 'screen-account', `screen=${inSub}`);

  await sleep(400); // 等 sync 轮询把 back 按钮放出来
  const back = await probe(page, 'dr-back');
  check('C2 子界面下「返回」按钮重新出现且点得到',
    !!back && back.visible && back.hitIsSelf,
    `display=${back && back.display} 命中=${back && back.hitId}`);

  await mouseClick(page, back.x, back.y);
  await sleep(900);
  const now = await visibleScreen(page);
  check('C3 点「返回」真的退回主菜单', now === 'screen-menu', `screen=${now}`);
}

/* ======================================================================
 * D：比赛中 —— 浮层让开右下角速度表，且仍然点得到
 * ====================================================================*/
{
  await page.eval(`window.__DR_API__.start({ mode: 'solo', track: 'coast', laps: 1 })`);
  await sleep(1500);
  await page.eval(`window.__DR_API__.skipCountdown()`);
  await sleep(2200);

  const racing = await page.eval(`document.getElementById('dr-sys').classList.contains('racing')`);
  check('D1 比赛中浮层切到 .racing（让开右下角速度表）', racing === true);

  const back = await probe(page, 'dr-back');
  check('D2 比赛中「返回」按钮点得到', !!back && back.visible && back.hitIsSelf,
    `命中=${back && back.hitId}`);

  /* 不能压住小地图：小地图右下角区域不应被浮层覆盖 */
  const overlap = await page.eval(`(() => {
    const m = document.getElementById('mapwrap');
    const s = document.getElementById('dr-sys');
    if (!m || !s) return null;
    const a = m.getBoundingClientRect(), c = s.getBoundingClientRect();
    const ox = Math.max(0, Math.min(a.right, c.right) - Math.max(a.left, c.left));
    const oy = Math.max(0, Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top));
    return { ox: Math.round(ox), oy: Math.round(oy) };
  })()`);
  check('D3 浮层不压住右上角小地图', !overlap || overlap.ox * overlap.oy === 0,
    overlap ? `重叠 ${overlap.ox}x${overlap.oy}px` : 'n/a');

  await mouseClick(page, back.x, back.y);
  await sleep(900);
  const paused = await visibleScreen(page);
  check('D4 比赛中点「返回」真的暂停（弹出暂停界面）',
    paused === 'screen-pause', `screen=${paused}`);

  /* 暂停界面里再点一次：应退回主菜单 */
  await sleep(400);
  const back2 = await probe(page, 'dr-back');
  if (back2 && back2.visible) {
    await mouseClick(page, back2.x, back2.y);
    await sleep(900);
    check('D5 暂停界面里再点「返回」退回主菜单',
      (await visibleScreen(page)) === 'screen-menu', `screen=${await visibleScreen(page)}`);
  } else {
    check('D5 暂停界面里再点「返回」退回主菜单', false, '返回按钮不可见');
  }
}

/* ======================================================================
 * E：多语言 —— 按钮跟着 EN/中 切换
 * ====================================================================*/
{
  await sleep(400);
  const en = await probe(page, 'dr-exit');
  check('E1 默认语言下按钮是英文', en && en.text === 'Exit', `"${en && en.text}"`);

  await page.click('btn-lang');
  await sleep(700);
  const zh = await probe(page, 'dr-exit');
  const zhBack = await probe(page, 'dr-back');
  check('E2 切到中文后按钮变中文', zh && zh.text === '退出', `"${zh && zh.text}"`);
  check('E3 返回按钮也跟着切（不是硬编码中文）',
    !zhBack || zhBack.text === '返回' || zhBack.display === 'none',
    `"${zhBack && zhBack.text}" display=${zhBack && zhBack.display}`);

  await page.click('btn-lang');
  await sleep(700);
  const backEn = await probe(page, 'dr-exit');
  check('E4 切回英文还原', backEn && backEn.text === 'Exit', `"${backEn && backEn.text}"`);
}

/* ======================================================================
 * F：无原生退出桥时（浏览器打开离线包）—— 不给退出按钮
 * ====================================================================*/
{
  const p2 = await b.newPage();
  await p2.send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.__DR_TV_OVERRIDE = false;',
  });
  await p2.readyUrl(FILE_URL);
  check('F0 第二个实例加载完成', await waitReady(p2));
  await sleep(1200);
  await p2.click('btn-help-close').catch(() => {});
  await sleep(600);
  const exit = await probe(p2, 'dr-exit');
  check('F1 没有原生退出桥时隐藏「退出」（避免点了只退回菜单、像坏了）',
    !!exit && exit.display === 'none', `display=${exit && exit.display}`);
  await p2.close();
}

await b.kill();
console.log(`\n\x1b[1m结果：${passed} 通过 / ${failed} 失败\x1b[0m`);
process.exit(failed ? 1 : 0);
