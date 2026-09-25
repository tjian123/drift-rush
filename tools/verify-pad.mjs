/* ===========================================================================
 * verify-pad.mjs — 游戏手柄适配 E2E 验收
 * 前置：无头 Chrome（Browser.launch 自带），服务器 DR_SERVER（默认 127.0.0.1:3000）
 * 运行：node tools/verify-pad.mjs
 * 说明：真实手柄无法在无头环境模拟，这里用 mock navigator.getGamepads()
 *       注入一个标准 Xbox 布局的假手柄，验证「激活 → 物理层转向/油门/刹车/
 *       手刹 → 道具键 → 拔线」全链路。转向/油门/刹车/手刹的映射符号已由
 *       pad.js 单元测试锁定（右推=右转=D 键，steer<0）。
 * =========================================================================*/
import { Browser, sleep, httpJson, CDP_PORT } from './cdp.mjs';

const SERVER = process.env.DR_SERVER || 'http://127.0.0.1:3000';
let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✘ ${name}${extra ? ' —— ' + extra : ''}`); }
};

async function ensureServer() {
  for (let i = 0; i < 2; i++) {
    try { await httpJson(SERVER + '/api/health'); return; } catch (e) { /* retry */ }
  }
  console.error(`服务器未启动：${SERVER}（先 node server/index.js）`);
  process.exit(1);
}

/** 注入一个 GameSir 假手柄到 navigator.getGamepads */
const MOCK_INIT = `(() => {
  window.__MOCK_PAD__ = {
    connected: true, index: 0,
    id: 'GameSir T4 Pro (STANDARD GAMEPAD Vendor: 360c Product: 1006)',
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0, touched: false })),
  };
  try {
    Object.defineProperty(navigator, 'getGamepads', {
      value: () => [window.__MOCK_PAD__], configurable: true,
    });
  } catch (e) {
    navigator.getGamepads = () => [window.__MOCK_PAD__];
  }
  return true;
})()`;

const setAxes = (page, a0) =>
  page.eval(`(() => { window.__MOCK_PAD__.axes[0] = ${a0}; return true; })()`);
const setBtn = (page, i, pressed, value) =>
  page.eval(`(() => { window.__MOCK_PAD__.buttons[${i}] = { pressed: ${pressed}, value: ${value}, touched: ${pressed} }; return true; })()`);
const clearInputs = (page) =>
  page.eval(`(() => { window.__MOCK_PAD__.axes = [0,0,0,0]; window.__MOCK_PAD__.buttons = Array.from({ length: 16 }, () => ({ pressed: false, value: 0, touched: false })); return true; })()`);
const dr = (page) => page.eval('window.__DR__');

async function waitForRace(page) {
  for (let i = 0; i < 30; i++) {
    if (await page.eval('window.__DR__ && window.__DR__.phase === "race"')) return true;
    await sleep(300);
  }
  return false;
}

/** 预置偏好 + 重载 + 菜单直达开局（solo 模式：next → next → go） */
async function setupRace(page, format) {
  await page.readyUrl(SERVER + '/');   // 先建立 origin（about:blank 上读不到 localStorage）
  await sleep(600);
  await page.eval(`(() => {
    localStorage.clear();
    localStorage.setItem('dr-mode', 'solo');
    localStorage.setItem('dr-track', 'coast');
    localStorage.setItem('dr-laps', '1');
    localStorage.setItem('dr-format', ${JSON.stringify(format)});
    return true;
  })()`);
  await page.readyUrl(SERVER + '/');   // 带 localStorage 预置重新加载
  await sleep(900);
  // 双保险：显式点亮目标赛制（localStorage 预置后菜单 seg 可能未同步）
  await page.eval(`(() => {
    const b = document.querySelector('#format-seg [data-format="${format}"]');
    if (b && !b.classList.contains('on')) b.click();
    return true;
  })()`);
  await page.eval(MOCK_INIT);
  await sleep(350);
}

async function main() {
  await ensureServer();
  const browser = await Browser.launch({ port: CDP_PORT, profileName: 'cdp-verify-pad' });
  try {
    /* ---------- P1 无手柄：inactive，页面无 JS 异常 ---------- */
    {
      const page = await browser.newPage();
      await page.emulateMobile({ width: 1280, height: 800, mobile: false, touch: false });
      await page.readyUrl(SERVER + '/');
      await sleep(1200);
      const pad = await page.eval('window.__DR__ && window.__DR__.pad');
      check('P1 无手柄时 pad.active=false', !!pad && pad.active === false);
      const exc = page.errors().filter((e) => e.startsWith('EXCEPTION'));
      check('P1 页面无 JS 异常', exc.length === 0, exc.slice(0, 3).join(' | '));
    }

    /* ---------- P2 注入手柄：激活 + 名称识别 + 菜单说明行 ---------- */
    {
      const page = await browser.newPage();
      await page.emulateMobile({ width: 1280, height: 800, mobile: false, touch: false });
      await page.readyUrl(SERVER + '/');
      await sleep(800);
      await page.eval(MOCK_INIT);
      await sleep(450);
      const pad = await page.eval('window.__DR__ && window.__DR__.pad');
      check('P2 注入后 pad.active=true', !!pad && pad.active === true);
      check('P2 名称识别为盖世小鸡', !!pad && /盖世小鸡/.test(pad.name || ''), pad && pad.name);
      // 手柄说明行在「车手/操作设置」步（第 3 步），先切过去再查
      await page.click('btn-next'); await sleep(220);
      await page.click('btn-next'); await sleep(220);
      const rowVisible = await page.visible('row-pad');
      check('P2 第 3 步显示手柄键位说明行', rowVisible === true);
    }

    /* ---------- P3/P4 驾驶：转向 / 油门 / 刹车 / 手刹 / 键盘让位 ---------- */
    {
      const page = await browser.newPage();
      await page.emulateMobile({ width: 1280, height: 800, mobile: false, touch: false });
      await setupRace(page, 'classic');
      await page.click('btn-next'); await sleep(220);
      await page.click('btn-next'); await sleep(220);
      await page.click('btn-go');
      const raced = await waitForRace(page);
      check('P3 进入比赛', raced);

      await setAxes(page, 1);          // 摇杆右推
      await setBtn(page, 7, true, 1);  // RT 油门
      await sleep(1000);
      let d = await dr(page);
      check('P3 右推 → steer<0（右转）', d.steer < -0.3, 'steer=' + d.steer);
      check('P3 RT → inputGas=true', d.inputGas === true);
      check('P3 车辆前进 kmh>0', d.kmh > 0, 'kmh=' + d.kmh);

      await setBtn(page, 6, true, 1);  // LT 刹车（同时 RT 仍在）
      await sleep(350);
      d = await dr(page);
      check('P4 LT → 刹车优先（brake=true, gas=false）', d.inputBrake === true && d.inputGas === false);

      await clearInputs(page);
      await setBtn(page, 0, true, 1);  // A 手刹
      await sleep(350);
      d = await dr(page);
      check('P4 A → inputHand=true', d.inputHand === true);

      await clearInputs(page);
      await setAxes(page, 1);
      await setBtn(page, 7, true, 1);
      await sleep(200);
      await page.key('KeyW', 'w', 87, true); // 键盘 W 抢回控制权
      await sleep(250);
      d = await dr(page);
      check('P4 键盘按住时手柄让位（steer 归零）', Math.abs(d.steer) < 1e-6, 'steer=' + d.steer);
      await page.key('KeyW', 'w', 87, false);
    }

    /* ---------- P5 道具模式：手柄 X 使用道具 ---------- */
    {
      const page = await browser.newPage();
      await page.emulateMobile({ width: 1280, height: 800, mobile: false, touch: false });
      await setupRace(page, 'item');
      await page.click('btn-next'); await sleep(220);
      await page.click('btn-next'); await sleep(220);
      await page.click('btn-go');
      const raced = await waitForRace(page);
      check('P5 道具赛进入比赛', raced);

      await page.eval(`(() => { window.__DR_IX__.testHooks.giveLocal('boost'); return true; })()`);
      await sleep(250); // 等 frame 刷新 __DR__ 快照
      let it = await page.eval('window.__DR__.items');
      check('P5 注入 boost 道具', !!it && it.myItem === 'boost', JSON.stringify(it));

      await setBtn(page, 2, true, 1);  // X 按下
      await sleep(250);
      await setBtn(page, 2, false, 0); // X 释放
      await sleep(450);
      it = await page.eval('window.__DR__.items');
      check('P5 手柄 X → boost 生效（boostT>0）', !!it && it.boostT > 0, JSON.stringify(it));
    }

    /* ---------- P6 拔线：inactive + 触发复位 ---------- */
    {
      const page = await browser.newPage();
      await page.emulateMobile({ width: 1280, height: 800, mobile: false, touch: false });
      await page.readyUrl(SERVER + '/');
      await sleep(800);
      await page.eval(MOCK_INIT);
      await sleep(450);
      await page.eval(`(() => { window.__MOCK_PAD__.connected = false; return true; })()`);
      await sleep(450);
      const pad = await page.eval('window.__DR__ && window.__DR__.pad');
      check('P6 拔线后 pad.active=false', !!pad && pad.active === false);
    }
  } finally {
    await browser.kill();
  }

  console.log(`\n${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
