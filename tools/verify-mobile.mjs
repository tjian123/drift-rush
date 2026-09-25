/* ===========================================================================
 * tools/verify-mobile.mjs — 移动端操控 + 账号页流程验收（CDP 真实触摸事件）
 *
 * 覆盖：
 *   M  触屏操控  设备识别 → 拖动转向的模拟量 → 多点触控 → 踏板 → 设置项生效
 *   N  账号页    单一主流程（填邮箱→验证码）、文案不含「登录/注册」二选一、
 *                次级入口互不串味、错误输入有明确提示
 *
 * 关键手法：用 Input.dispatchTouchEvent 派发**真实触摸事件**，让 Chrome 自己
 * 合成 PointerEvent。直接改 JS 变量只能证明代码能跑，证明不了「手指按下去有效」。
 * 触摸模拟必须在 Page.navigate **之前**开，否则页面读到的 navigator.maxTouchPoints
 * 还是 0，触屏 UI 压根不会出现 —— 这样测出来的「通过」是假的。
 *
 * 用法：
 *   node tools/verify-mobile.mjs
 *   DR_SERVER=http://127.0.0.1:8790 node tools/verify-mobile.mjs
 * =========================================================================*/

import { Browser, sleep } from './cdp.mjs';

const SERVER = (process.env.DR_SERVER || 'http://127.0.0.1:8790').replace(/\/$/, '');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  \x1b[32mPASS\x1b[0m' : '  \x1b[31mFAIL\x1b[0m'}  ${name}${detail ? '  — ' + detail : ''}`);
  return !!ok;
}
const log = (...a) => console.log(...a);

/* 注意外层括号：`${GAME}.phase` 展开后是 `window.__DR__ || {}.phase`，
   由于运算符优先级，`{}` 并不会被括起来 —— 那样读到的会是整个对象。
   这是本次写脚本时踩过的坑，括号不能省。 */
const TOUCH_STATE = '(window.__DR_TOUCH__ || {})';
const GAME = '(window.__DR__ || {})';

/* ------------------------------------------------------------ 小工具 */
/** 取触控层状态 + 物理输入快照 */
async function snap(page) {
  return page.eval(`(() => {
    const t = ${TOUCH_STATE};
    const d = ${GAME};
    return {
      t, steer: d.steer || 0, gas: !!d.inputGas, brake: !!d.inputBrake,
      hand: !!d.inputHand, kmh: d.kmh || 0, heading: d.heading || 0,
      phase: d.phase || '', vF: d.vF || 0,
    };
  })()`);
}

/**
 * 「按住 → 拖到目标 → 采样 → 松手」。
 * 采样必须在松手**之前**（M9/M10 断言的就是按住时的状态），
 * 但松手这一步不能省 —— 忘了松手会留下一个永不释放的指针，
 * 后面的断言就会读到「上一根手指还在按」的脏状态（这个坑实际踩过一次）。
 */
async function dragHold(page, { from, to, id = 1, steps = 5, holdMs = 45, release = true }) {
  await page.touch('touchStart', [{ id, x: from.x, y: from.y }]);
  await sleep(holdMs);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await page.touch('touchMove', [{ id, x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }]);
    await sleep(holdMs);
  }
  await sleep(120);
  const held = await snap(page);
  if (release) {
    await page.touch('touchEnd', []);
    await sleep(160);
  }
  return held;
}

(async () => {
  log('\x1b[1m=== DRIFT RUSH 移动端 / 账号页验收 ===\x1b[0m');
  log('目标: ' + SERVER);

  let browser = null;
  try {
    browser = await Browser.launch({
      port: Number(process.env.DR_CDP_PORT || 9403),
      profileName: 'cdp-profile-mobile',
    });
    log('\x1b[2m浏览器已启动（CDP，触摸模拟已开启）\x1b[0m\n');
    const page = await browser.newPage();

    /* 触摸能力必须在导航前打开（见文件头注释） */
    await page.emulateMobile({ width: 880, height: 412, maxTouchPoints: 5 });

    const loaded = await page.readyUrl(SERVER + '/');
    check('M1 移动视口下页面正常加载', loaded, loaded ? '880×412 横屏' : '页面未就绪');
    if (!loaded) throw new Error('页面加载失败');

    /* ================================================ 设备与初始状态 */
    const dev = await page.eval(`(() => {
      const t = ${TOUCH_STATE};
      const on = (id) => {
        const el = document.getElementById(id);
        if (!el) return false;
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden';
      };
      return {
        isTouch: t.isTouch, pts: t.maxTouchPoints, supported: t.supported,
        touchHiddenInMenu: !on('touch'),
        shownCtrlRows: ['row-autogas','row-hand','row-sens','row-tilt']
          .filter((id) => !document.getElementById(id).classList.contains('hide')).length,
        keysHidden: document.getElementById('row-keys').classList.contains('hide'),
        note: (document.getElementById('ctrl-note') || {}).textContent || '',
      };
    })()`);
    check('M2 设备被识别为触屏（navigator.maxTouchPoints 生效）',
      dev.isTouch === true && dev.pts === 5 && dev.supported === true, JSON.stringify(dev));
    check('M3 菜单里给出触屏操作说明，并收起键盘键位',
      dev.shownCtrlRows === 4 && dev.keysHidden === true,
      `可调项=${dev.shownCtrlRows}/4 · 说明「${dev.note.trim()}」`);
    check('M4 菜单阶段不显示操控层（否则会吃掉菜单点击）',
      dev.touchHiddenInMenu === true, 'touch 隐藏');

    /* ================================================ 进入比赛 */
    await page.eval(`window.__DR_API__.start({ mode:'solo', track:'coast', laps:3, level:'easy' })`);
    await sleep(400);
    await page.eval(`window.__DR_API__.skipCountdown()`);
    await sleep(600);

    const inRace = await page.eval(`(() => {
      const t = ${TOUCH_STATE};
      const vis = (id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) };
      };
      return { enabled: t.enabled, phase: ${GAME}.phase, ring: vis('steer-ring'), gas: vis('tgas') };
    })()`);
    check('M5 比赛中操控层启用，方向盘与踏板已布局',
      inRace.enabled === true && inRace.phase === 'race'
      && inRace.ring && inRace.ring.w > 80 && inRace.gas && inRace.gas.w > 40,
      `phase=${inRace.phase} · 方向盘 ${inRace.ring && inRace.ring.w}px · 油门 ${inRace.gas && inRace.gas.w}px`);

    /* ================================================ 拖动转向 */
    /* 常驻记录仪：触控出问题时「事件序列 + 实例真实字段」比断言本身有用得多 */
    await page.eval(`(() => {
      window.__EV__ = [];
      const root = document.getElementById('touch');
      for (const t of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture']) {
        root.addEventListener(t, (e) => {
          window.__EV__.push(t + ':' + e.pointerId);
          if (window.__EV__.length > 60) window.__EV__.shift();
        }, true);
      }
      return true;
    })()`);

    const ring = await page.center('steer-ring');
    const R = await page.cssVar('touch', '--r');
    check('M6 方向盘半径随视口自适应（不小于 52px 的可用下限）',
      R >= 52, `--r = ${R}px`);

    // 从圈心向右拖 0.75R：应当得到明显但不打满的转向量
    const right = { x: ring.x + R * 0.75, y: ring.y };
    const s1 = await dragHold(page, { from: { x: ring.x, y: ring.y }, to: right, id: 1 });
    check('M7 圈内按住拖动产生模拟量转向（不是「按下即打死」）',
      s1.t.steering === true && s1.t.steer < -0.4 && s1.t.steer > -1.01,
      `__DR_TOUCH__.steer=${s1.t.steer}（拖了 0.75R，未打满）`);
    check('M8 拖动量真的到达物理层（__DR__.steer 同步）',
      Math.abs(s1.steer - s1.t.steer) < 0.05 && s1.steer < -0.4,
      `__DR__.steer=${s1.steer}`);
    check('M9 拖动期间方向盘进入激活态并有视觉反馈',
      s1.t.ring.active === true && /translate\(/.test(s1.t.knob),
      `active=${s1.t.ring.active} · knob=${s1.t.knob}`);

    // 满舵方向一致性：向右拖 → 车头右转（追尾相机下 heading 减小）
    const h0 = s1.heading;
    await sleep(500);
    const s2 = await snap(page);
    check('M10 右拖方向盘车真的向右转（heading 减小）',
      s2.heading < h0, `heading ${h0.toFixed(3)} → ${s2.heading.toFixed(3)}`);

    // 反向：拖到左侧应当得到正的转向量（左转）
    const left = { x: ring.x - R * 0.85, y: ring.y };
    const sL = await dragHold(page, { from: { x: ring.x, y: ring.y }, to: left, id: 1 });
    check('M11 反拖得到反向转向量（符号正确）',
      sL.t.steer > 0.4, `steer=${sL.t.steer}`);

    // 死区：极小位移不该让车头晃
    const sDead = await dragHold(page, { from: { x: ring.x, y: ring.y }, to: { x: ring.x + R * 0.08, y: ring.y }, id: 1 });
    check('M12 圈心有死区（轻微抖动不产生转向）',
      sDead.t.steer === 0, `拖 0.08R → steer=${sDead.t.steer}`);

    /* ================================================ 松手回正 */
    const after = await snap(page);
    const rel = await page.eval(`(() => {
      const t = window.__DR_API__.touch();
      return { pid: t._steerPid, ptrs: t.pointerCount, steer: Number(t.steer.toFixed(3)),
               ev: (window.__EV__ || []).slice(-6).join(' ') };
    })()`);
    check('M13 松手后转向量回正到 0（指针不漏、不卡在转向状态）',
      after.t.steering === false && after.steer === 0 && rel.pid === null && rel.ptrs === 0,
      `mirror(steering=${after.t.steering}, steer=${after.steer}) · ` +
      `real(pid=${rel.pid}, ptrs=${rel.ptrs}, steer=${rel.steer}) · 末尾事件[${rel.ev}]`);

    /* ================================================ 多点触控 */
    const gas = await page.center('tgas');
    // 一指按住方向盘拖到右侧并保持，另一指按住油门
    await page.touch('touchStart', [{ id: 1, x: ring.x, y: ring.y }]);
    await sleep(40);
    await page.touch('touchMove', [{ id: 1, x: ring.x + R * 0.8, y: ring.y }]);
    await sleep(40);
    await page.touch('touchStart', [{ id: 1, x: ring.x + R * 0.8, y: ring.y }, { id: 2, x: gas.x, y: gas.y }]);
    await sleep(220);
    const multi = await snap(page);
    check('M14 多点触控：转向与油门两根手指同时生效',
      multi.t.steer < -0.4 && multi.t.pedals.gas === true && multi.t.pointers === 2,
      `steer=${multi.t.steer} · gas=${multi.t.pedals.gas} · pointers=${multi.t.pointers}`);
    check('M15 多点触控时转向量没有被第二根手指打断',
      Math.abs(multi.steer - multi.t.steer) < 0.05 && multi.steer < -0.4,
      `__DR__.steer=${multi.steer}`);

    /* ================================================ 踏板：滑动切换 */
    const brake = await page.center('tbrake');
    await page.touch('touchMove', [
      { id: 1, x: ring.x + R * 0.8, y: ring.y },
      { id: 2, x: brake.x, y: brake.y },
    ]);
    await sleep(220);
    const slid = await snap(page);
    check('M16 手指从油门滑到刹车即切换（不必抬起再按）',
      slid.t.pedals.brake === true && slid.t.pedals.gas === false,
      JSON.stringify(slid.t.pedals));

    /* ================================================ 手刹 */
    const hand = await page.center('thand');
    await page.touch('touchMove', [
      { id: 1, x: ring.x + R * 0.8, y: ring.y },
      { id: 2, x: hand.x, y: hand.y },
    ]);
    await sleep(220);
    const hb = await snap(page);
    check('M17 手刹踏板生效并到达物理层',
      hb.t.pedals.handbrake === true && hb.hand === true,
      `pedals.handbrake=${hb.t.pedals.handbrake} · __DR__.inputHand=${hb.hand}`);

    // 收尾：两根手指都抬起
    await page.touch('touchEnd', []);
    await sleep(200);
    const cleared = await snap(page);
    check('M18 全部抬起后踏板与转向都归零（不会卡住油门）',
      !cleared.t.pedals.gas && !cleared.t.pedals.brake && !cleared.t.pedals.handbrake
      && cleared.t.pointers === 0 && cleared.t.steer === 0,
      `pointers=${cleared.t.pointers} · steer=${cleared.t.steer}`);

    /* ================================================ 自动油门 */
    const auto = await page.eval(`(() => {
      window.__DR_API__.touch().applySettings({ autoGas: true });
      return ${TOUCH_STATE}.autoGas;
    })()`);
    await sleep(300);
    const a1 = await snap(page);
    check('M19 自动油门：不碰屏幕也在加速（单手可玩）',
      auto === true && a1.gas === true, `autoGas=${auto} · __DR__.inputGas=${a1.gas}`);
    check('M20 自动油门下车辆确实在提速', a1.kmh > 10, `${a1.kmh} km/h`);

    // 自动油门时必须还能刹得住
    await page.touch('touchStart', [{ id: 3, x: brake.x, y: brake.y }]);
    await sleep(260);
    const a2 = await snap(page);
    await page.touch('touchEnd', []);
    await sleep(120);
    check('M21 自动油门遇刹车自动让位（否则永远刹不住）',
      a2.brake === true && a2.gas === false,
      `inputGas=${a2.gas} · inputBrake=${a2.brake}`);

    /* ================================================ 关闭自动油门 */
    await page.eval(`window.__DR_API__.touch().applySettings({ autoGas: false })`);
    await sleep(300);
    const off = await snap(page);
    check('M22 关掉自动油门后必须按住踏板才给油',
      off.gas === false, `autoGas=false · inputGas=${off.gas}`);

    /* ================================================ 转向灵敏度 */
    const sens = await page.eval(`(() => {
      const t = window.__DR_API__.touch();
      t.applySettings({ sens: 0.7 });
      const lo = t._steerValue(${R} * 0.5);
      t.applySettings({ sens: 1.5 });
      const hi = t._steerValue(${R} * 0.5);
      t.applySettings({ sens: 1 });
      return { lo, hi, now: ${TOUCH_STATE}.sens };
    })()`);
    check('M23 转向灵敏度设置真实改变输入曲线（高灵敏 = 同样位移转向更大）',
      Math.abs(sens.hi) > Math.abs(sens.lo) + 0.1 && sens.now === 1,
      `0.5R 位移：稳 ${sens.lo.toFixed(3)} → 灵敏 ${sens.hi.toFixed(3)}`);

    /* ================================================ 左手布局 */
    const handLeft = await page.eval(`(() => {
      const t = window.__DR_API__.touch();
      t.applySettings({ hand: 'left' });
      const zone = document.getElementById('steer-zone').getBoundingClientRect();
      const ped = document.getElementById('pedal-zone').getBoundingClientRect();
      const W = innerWidth;
      t.applySettings({ hand: 'right' });
      const zone2 = document.getElementById('steer-zone').getBoundingClientRect();
      return { leftZoneLeft: Math.round(zone.left), leftZoneRight: Math.round(zone.right),
               pedLeft: Math.round(ped.left), zone2Left: Math.round(zone2.left), W };
    })()`);
    check('M24 左手布局：方向盘换到右侧、踏板换到左侧',
      handLeft.leftZoneLeft > 0 && handLeft.pedLeft === 0 && handLeft.zone2Left === 0,
      `左手时转向区 x=${handLeft.leftZoneLeft}~${handLeft.leftZoneRight}、踏板 x=${handLeft.pedLeft}；` +
      `切回右手后转向区 x=${handLeft.zone2Left}`);

    /* ================================================ 竖屏提示 */
    await page.eval(`window.__DR_API__.quit()`);
    await sleep(400);
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 412, height: 880, deviceScaleFactor: 1, mobile: true,
      screenOrientation: { type: 'portraitPrimary', angle: 0 },
    });
    await sleep(700);
    const rot = await page.eval(`(() => {
      const el = document.getElementById('rotate-hint');
      return { shown: el.classList.contains('show'), phase: ${GAME}.phase,
               text: el.textContent.replace(/\\s+/g, ' ').trim() };
    })()`);
    check('M25 竖屏 + 手机尺寸时提示横屏（只在菜单里提示，比赛中不打扰）',
      rot.shown === true && /横屏/.test(rot.text) && rot.phase === 'menu',
      `phase=${rot.phase} · "${rot.text}"`);

    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 880, height: 412, deviceScaleFactor: 1, mobile: true,
      screenOrientation: { type: 'landscapePrimary', angle: 0 },
    });
    await sleep(500);
    const rot2 = await page.eval(`document.getElementById('rotate-hint').classList.contains('show')`);
    check('M26 转回横屏后提示自动消失', rot2 === false, `show=${rot2}`);

    await page.shot('tools/shot-mobile-race.png');

    /* ================================================ 账号页流程 */
    log('\n\x1b[1m[N] 账号页：登录与注册不该让用户自己选\x1b[0m');
    await page.eval(`window.__DR_API__.showAccount()`);
    await sleep(400);
    const acc = await page.eval(`(() => {
      // 只信计算样式，不信类名 —— .hide 曾被组件类的 display 覆盖过（真实踩坑）
      const vis = (id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden' &&
               el.getBoundingClientRect().height > 0;
      };
      const txt = (id) => ((document.getElementById(id) || {}).textContent || '').replace(/\\s/g, '');
      return {
        guest: vis('acc-guest'), user: vis('acc-user'),
        paneCode: vis('pane-code'), panePwd: vis('pane-pwd'), paneReset: vis('pane-reset'),
        stepEmail: vis('step-email'), stepCode: vis('step-code'),
        btn: txt('btn-send-code'),
        mixed: /登\\s*录\\s*\\/\\s*注\\s*册/.test(document.getElementById('acc-guest').textContent),
        steps: [...document.querySelectorAll('#code-steps .stp')].map((s) => s.textContent.replace(/\\s/g,'')),
      };
    })()`);
    check('N1 账号页只有一条主流程（填邮箱），密码/重置默认收起',
      acc.paneCode && !acc.panePwd && !acc.paneReset && acc.stepEmail && !acc.stepCode,
      JSON.stringify(acc));
    check('N2 第一步只有一个动作按钮，用户不需要先选「登录还是注册」',
      acc.btn === '继续', `按钮文案「${acc.btn}」`);
    check('N3 界面不出现「登录 / 注册」这类二选一文案', acc.mixed === false,
      acc.mixed ? '仍存在' : '未发现');
    check('N4 步骤指示器把两步流程写在界面上', acc.steps.length === 2,
      acc.steps.join(' → '));

    /* 非法输入必须有明确提示，而不是静默无反应 */
    await page.fill('otp-email', 'not-an-email');
    await page.click('btn-send-code');
    await sleep(300);
    const badEmail = await page.text('acc-hint');
    check('N5 邮箱格式错误时给出明确提示',
      /邮箱/.test(badEmail || ''), `"${(badEmail || '').trim()}"`);

    /* 视图互斥 + 提示不串味（同样以计算样式为准） */
    const viewSwitch = await page.eval(`(() => {
      const vis = (id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden' &&
               el.getBoundingClientRect().height > 0;
      };
      document.getElementById('lnk-pwd').click();
      const pwd = { pane: vis('pane-pwd'),
                    code: vis('pane-code'),
                    reset: vis('pane-reset'),
                    hint: (document.getElementById('acc-hint-pwd').textContent || ''),
                    mainHint: (document.getElementById('acc-hint').textContent || '') };
      document.getElementById('lnk-forgot').click();
      const reset = { pane: vis('pane-reset'), pwd: vis('pane-pwd'), code: vis('pane-code') };
      document.getElementById('lnk-back-code2').click();
      const back = { code: vis('pane-code'),
                     reset: vis('pane-reset'), pwd: vis('pane-pwd') };
      return { pwd, reset, back };
    })()`);
    check('N6 三个面板互斥显示（按真实渲染判定），来回切换都不会同时露出两个',
      viewSwitch.pwd.pane && !viewSwitch.pwd.code && !viewSwitch.pwd.reset
      && viewSwitch.reset.pane && !viewSwitch.reset.pwd && !viewSwitch.reset.code
      && viewSwitch.back.code && !viewSwitch.back.reset && !viewSwitch.back.pwd,
      JSON.stringify(viewSwitch));
    check('N7 各面板提示独立：主流程的提示不会串到密码面板',
      viewSwitch.pwd.mainHint === '' || viewSwitch.pwd.hint !== viewSwitch.pwd.mainHint,
      `密码面板提示 "${viewSwitch.pwd.hint.trim()}" · 主流程提示 "${viewSwitch.pwd.mainHint.trim()}"`);

    const pwdErr = await page.eval(`(() => {
      document.getElementById('lnk-pwd').click();
      document.getElementById('acc-email').value = 'nobody@example.com';
      document.getElementById('acc-pwd').value = '';
      document.getElementById('btn-pwd-login').click();
      return new Promise((r) => setTimeout(() => r({
        hint: (document.getElementById('acc-hint-pwd').textContent || '').trim(),
        mainHint: (document.getElementById('acc-hint').textContent || '').trim(),
      }), 300));
    })()`);
    check('N8 密码为空时在校验阶段就拦下（不会白跑一次请求）',
      /密码/.test(pwdErr.hint) && pwdErr.mainHint === '',
      `"${pwdErr.hint}"`);

    await page.eval(`document.getElementById('lnk-back-code').click()`);
    await sleep(200);
    await page.shot('tools/shot-mobile-account.png');

    /* ================================================ 无异常 */
    const errs = page.errors().filter((e) => !/Failed to load resource/.test(e));
    check('M27 全程无 JS 异常', errs.length === 0,
      errs.length ? errs.slice(0, 3).join(' | ') : '无');
    const fatal = await page.eval('window.__DR_ERROR__ || null');
    check('M28 页面未进入致命错误状态', fatal === null, fatal ? String(fatal).slice(0, 120) : '无');

    await page.close();
  } catch (e) {
    log('\n\x1b[31m验收脚本异常: ' + ((e && e.stack) || e) + '\x1b[0m');
    results.push({ name: '脚本异常', ok: false, detail: String((e && e.message) || e) });
  } finally {
    if (browser) await browser.kill();
  }

  log('\n\x1b[1m==================== 结果 ====================\x1b[0m');
  for (const r of results) {
    log(`${r.ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m'} ${r.name}  \x1b[2m${r.detail}\x1b[0m`);
  }
  const pass = results.filter((r) => r.ok).length;
  log(`\n\x1b[1m通过 ${pass}/${results.length}\x1b[0m`);
  process.exit(pass === results.length ? 0 : 2);
})();
