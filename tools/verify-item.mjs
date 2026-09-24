/* ===========================================================================
 * verify-item.mjs — 道具赛 E2E 验收
 * 前置：无头 Chrome（Browser.launch 自带），服务器 DR_SERVER（默认 127.0.0.1:3000）
 * 运行：node tools/verify-item.mjs
 * 注意：必须串行跑（与其他套件并行会撞 CDP 资源）。
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

/** 从菜单直接开局：赛制/模式/难度/圈数按 localStorage 预置 */
async function startRace(page, { format = 'item', mode = 'solo', laps = 2 }) {
  await page.eval(`(() => {
    localStorage.clear();
    localStorage.setItem('dr-format', ${JSON.stringify(format)});
    localStorage.setItem('dr-mode', ${JSON.stringify(mode)});
    localStorage.setItem('dr-laps', ${JSON.stringify(laps)});
    localStorage.setItem('dr-track', 'coast');
    return true;
  })()`);
  await page.readyUrl(SERVER + '/');   // 带 localStorage 预置重新加载
  await sleep(900);
  // 第 2 步把赛制点亮到目标值（localStorage 预置后菜单状态应已同步，双保险）
  await page.eval(`(() => {
    const b = document.querySelector('#format-seg [data-format="${format}"]');
    if (b && !b.classList.contains('on')) b.click();
    return true;
  })()`);
  await page.click('btn-next'); await sleep(220);
  await page.click('btn-next'); await sleep(220);
  await page.click('btn-go');
  await sleep(2600);            // 等倒计时进入比赛
}

/** 等待倒计时结束进入比赛（倒计时约 3.6s，btn-go 后必须轮询） */
async function waitForRace(page) {
  for (let i = 0; i < 30; i++) {
    if (await page.eval('window.__DR__ && window.__DR__.phase === "race"')) return true;
    await sleep(300);
  }
  return false;
}

/** 按住/松开油门 */
async function gas(page, down) {
  await page.key('KeyW', 'w', 87, down);
}

async function main() {
  await ensureServer();
  const browser = await Browser.launch({ port: CDP_PORT, profileName: 'cdp-verify-item' });
  try {
    /* ---------- I1 菜单：赛制分段存在且可切换 ---------- */
    {
      const page = await browser.newPage();
      await page.emulateMobile({ width: 1280, height: 800, mobile: false, touch: false });
      await page.readyUrl(SERVER + '/');
      await sleep(800);
      const seg = await page.eval(`(() => {
        const seg = document.getElementById('format-seg');
        if (!seg) return { ok: false };
        const item = seg.querySelector('[data-format="item"]');
        item.click();
        return { ok: true, on: item.classList.contains('on'),
          saved: localStorage.getItem('dr-format') };
      })()`);
      check('I1 赛制分段可切换并持久化', seg.ok && seg.on && JSON.parse(seg.saved) === 'item');
      await page.close();
    }

    /* ---------- I2 联机模式下道具赛被拦截 ---------- */
    {
      const page = await browser.newPage();
      await page.emulateMobile({ width: 1280, height: 800, mobile: false, touch: false });
      await page.readyUrl(SERVER + '/');
      await sleep(800);
      const r = await page.eval(`(() => {
        localStorage.setItem('dr-format', 'classic');   // 先落回竞速，看点道具会不会被改写
        const modeBtn = document.querySelector('#mode-seg [data-mode="online"]');
        const before = modeBtn.classList.contains('on');
        if (!before) modeBtn.click();
        const item = document.querySelector('#format-seg [data-format="item"]');
        item.click();
        return JSON.stringify({
          before,
          modeOn: document.querySelector('#mode-seg .on').dataset.mode,
          fmtOn: document.querySelector('#format-seg .on').dataset.format,
          fmt: localStorage.getItem('dr-format'),
          toast: (document.getElementById('toast') || {}).textContent || '',
        });
      })()`);
      const d = JSON.parse(r);
      check('I2 联机时道具赛被拦截（保持竞速）',
        JSON.parse(d.fmt) !== 'item' && d.fmtOn === 'classic', r);
      await page.close();
    }

    /* ---------- I3 道具赛开局：系统与道具箱就位 ---------- */
    {
      const page = await browser.newPage();
      await page.emulateMobile({ width: 1280, height: 800, mobile: false, touch: false });
      await page.readyUrl(SERVER + '/');
      await startRace(page, { format: 'item' });
      check('I3-pre 进入比赛相位', await waitForRace(page));
      const d = await page.eval('window.__DR__');
      const slotHidden = await page.eval(
        `document.getElementById('item-slot').classList.contains('hidden')`);
      check('I3 道具赛开局：format=item、道具箱 24 个、槽位可见',
        d.format === 'item' && d.items && d.items.boxes === 24 && d.items.active === 24
        && !slotHidden,
        JSON.stringify(d.items));
      await page.close();
    }

    /* ---------- I4 竞速赛开局：无道具系统 ---------- */
    {
      const page = await browser.newPage();
      await page.emulateMobile({ width: 1280, height: 800, mobile: false, touch: false });
      await page.readyUrl(SERVER + '/');
      await startRace(page, { format: 'classic' });
      const d = await page.eval('window.__DR__');
      const slotHidden = await page.eval(
        `document.getElementById('item-slot').classList.contains('hidden')`);
      check('I4 竞速赛：无道具系统、槽位隐藏',
        d.format === 'classic' && d.items === null && slotHidden);
      await page.close();
    }

    /* ---------- I5 吃道具箱 → 抽取 → 获得道具 ---------- */
    {
      const page = await browser.newPage();
      await page.emulateMobile({ width: 1280, height: 800, mobile: false, touch: false });
      await page.readyUrl(SERVER + '/');
      await startRace(page, { format: 'item' });
      await sleep(1200);
      check('I5-pre 进入比赛相位', await waitForRace(page));
      const tele = await page.eval('__DR_IX__.testHooks.teleportLocalToBox(1)');
      await sleep(2200);           // 覆盖 0.9s 滚动期
      const d = await page.eval('window.__DR__');
      check('I5 传送到道具箱 → 获得道具',
        !!tele && d.items && (d.items.myItem !== null || d.items.rolling),
        JSON.stringify({ tele, it: d.items && d.items.myItem, roll: d.items && d.items.rolling }));
      await page.close();
    }

    /* ---------- I6 氮气：boostT 生效且速度提升 ---------- */
    {
      const page = await browser.newPage();
      await page.emulateMobile({ width: 1280, height: 800, mobile: false, touch: false });
      await page.readyUrl(SERVER + '/');
      await startRace(page, { format: 'item' });
      check('I6-pre 进入比赛相位', await waitForRace(page));
      // 静止起步纯氮气：不踩油门，只靠 boost 推力，起点是直道不会撞墙
      const kmh0 = await page.eval('__DR__.kmh');
      await page.eval('__DR_IX__.testHooks.giveLocal("boost")');
      await page.eval('__DR_IX__.testHooks.useLocal(1)');
      await sleep(400);
      const t = await page.eval('__DR__.items.boostT');
      await sleep(1200);
      const kmh1 = await page.eval('__DR__.kmh');
      check('I6 氮气：boostT>0 且静止起步明显加速',
        t > 0 && kmh1 > 40 && kmh1 > kmh0 + 25,
        JSON.stringify({ kmh0, t, kmh1 }));
      await page.close();
    }

    /* ---------- I7 护盾：开启后挡下打滑 ---------- */
    {
      const page = await browser.newPage();
      await page.emulateMobile({ width: 1280, height: 800, mobile: false, touch: false });
      await page.readyUrl(SERVER + '/');
      await startRace(page, { format: 'item' });
      await waitForRace(page);
      await page.eval('__DR_IX__.testHooks.giveLocal("shield")');
      await page.eval('__DR_IX__.testHooks.useLocal(1)');
      await sleep(300);
      const on = await page.eval('__DR__.items.shieldT');
      const res = await page.eval('__DR_IX__.testHooks.spinLocal()');
      await sleep(250);
      const after = await page.eval('__DR__.items.spinT');
      check('I7 护盾：shieldT>0 且打滑被挡下（spinT 保持 0）',
        on > 0 && res === 'shielded' && after === 0,
        JSON.stringify({ on, res, after }));
      await page.close();
    }

    /* ---------- I8 油污：前方可行驶触发打滑 ---------- */
    {
      const page = await browser.newPage();
      await page.emulateMobile({ width: 1280, height: 800, mobile: false, touch: false });
      await page.readyUrl(SERVER + '/');
      await startRace(page, { format: 'item' });
      await waitForRace(page);
      await page.eval('__DR_IX__.testHooks.oilAhead()');
      let spun = false;
      await gas(page, true);
      for (let i = 0; i < 40; i++) {           // 最多 8 秒
        await sleep(200);
        const s = await page.eval('__DR__.items.spinT');
        if (s > 0) { spun = true; break; }
      }
      await gas(page, false);
      check('I8 压上前方油污 → 打滑', spun);
      await page.close();
    }

    /* ---------- I9 导弹：后方发射追尾命中 ---------- */
    {
      const page = await browser.newPage();
      await page.emulateMobile({ width: 1280, height: 800, mobile: false, touch: false });
      await page.readyUrl(SERVER + '/');
      await startRace(page, { format: 'item' });
      await waitForRace(page);
      const fired = await page.eval('__DR_IX__.testHooks.fireMissileAtMe()');
      let hit = false;
      for (let i = 0; i < 45; i++) {           // 最多 9 秒
        await sleep(200);
        const s = await page.eval('__DR__.items.spinT');
        if (s > 0) { hit = true; break; }
      }
      check('I9 导弹追踪命中 → 打滑', !!fired && hit, 'fired=' + fired);
      await page.close();
    }

    /* ---------- I10 赛制记忆 + 一局内道具箱再生 ---------- */
    {
      const page = await browser.newPage();
      await page.emulateMobile({ width: 1280, height: 800, mobile: false, touch: false });
      await page.readyUrl(SERVER + '/');
      await startRace(page, { format: 'item' });
      await waitForRace(page);
      const r1 = await page.eval(`(() => {
        __DR_IX__.testHooks.teleportLocalToBox(0);
        return true;
      })()`);
      await sleep(1400);
      // 此时 box0 应已被吃掉 → inactive；重生需 5s，先确认消失
      const gone = await page.eval(`__DR_IX__.boxes[0].active === false`);
      check('I10a 吃掉的道具箱进入再生等待', !!r1 && gone);
      // 车还停在箱子位置，再生后会被立刻再吃掉——先把车挪到远处
      await page.eval(`__DR_IX__.testHooks.teleportLocalToBox(6)`);
      await sleep(4600);                       // 5s 再生 + 余量
      const back = await page.eval(`__DR_IX__.boxes[0].active === true`);
      check('I10b 道具箱约 5 秒后再生', back);
      const saved = await page.eval('localStorage.getItem("dr-format")');
      check('I10c 赛制选择持久化（dr-format=item）', JSON.parse(saved) === 'item');
      await page.close();
    }
  } finally {
    await browser.kill();
  }

  console.log(`\n${pass + fail} 项中 ${pass} 项通过${fail ? `，${fail} 项失败` : ''}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
