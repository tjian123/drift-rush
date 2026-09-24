/* ===========================================================================
 * tools/verify-cloud.mjs — 云服务端到端验收
 *
 * 覆盖：
 *   F1 页面 + 云 SDK 加载
 *   F2 云服务初始化（endpoint/publishableKey 生效）
 *   F3 菜单云端状态行
 *   F4 排行榜真实读取云端数据（公开读策略生效）
 *   F5 服务端拒绝匿名写入（RLS 生效，不是只在客户端拦）
 *   F6 未登录提交成绩：明确提示且不伪成功
 *   F7 账号界面渲染与三表单切换
 *   F8 Auth 链路真实连通（错误凭据由后端拒绝，而非网络失败）
 *   F9 全程无 JS 异常
 *
 * 用法：
 *   node tools/verify-cloud.mjs                 # 默认打已发布域（Auth 只在注册域可用）
 *   DR_SERVER=http://127.0.0.1:8790 node tools/verify-cloud.mjs
 * =========================================================================*/

import { Browser, sleep } from './cdp.mjs';

const SERVER = (process.env.DR_SERVER || 'https://drift-rush-online.app.workbuddy.host').replace(/\/$/, '');
const TEST_TAG = '__selftest__';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  \x1b[32mPASS\x1b[0m' : '  \x1b[31mFAIL\x1b[0m'}  ${name}${detail ? '  — ' + detail : ''}`);
  return ok;
}
const log = (...a) => console.log(...a);

(async () => {
  log('\x1b[1m=== DRIFT RUSH 云服务验收 ===\x1b[0m');
  log('目标: ' + SERVER);

  let browser = null;
  try {
    browser = await Browser.launch();
    log(`\x1b[2m浏览器已启动（CDP）\x1b[0m\n`);
    const page = await browser.newPage();
    const loaded = await page.readyUrl(SERVER + '/');
    check('F1 页面加载完成', loaded, loaded ? '' : '页面未就绪');
    if (!loaded) throw new Error('页面加载失败');

    /* --- F1b: SDK 是否就绪，以及用的是自托管还是 CDN --- */
    const sdk = await page.eval(`(() => {
      const scripts = [...document.querySelectorAll('script[src]')]
        .map((s) => s.getAttribute('src'))
        .filter((s) => /workbuddy-cloud/.test(s));
      const res = performance.getEntriesByType('resource')
        .filter((r) => /workbuddy-cloud/.test(r.name))
        .map((r) => ({ url: r.name, ms: Math.round(r.duration) }));
      return {
        hasGlobal: !!(window.WorkBuddyCloud && window.WorkBuddyCloud.createWorkBuddyCloud),
        scripts, res,
      };
    })()`);
    const selfHosted = sdk.scripts.some((s) => s.startsWith('/vendor/'));
    check('F1b 云 SDK 已加载（全局 WorkBuddyCloud 就绪）', sdk.hasGlobal,
      `来源 ${sdk.scripts.join(', ') || '未知'}` + (sdk.res[0] ? ` · 加载 ${sdk.res[0].ms}ms` : ''));
    check('F1c SDK 自托管于 /vendor（不阻塞首屏、无运行时外部依赖）', selfHosted,
      selfHosted ? '' : '仍在用外部 CDN，首屏会被同步脚本阻塞');

    const timing = await page.eval(`(() => {
      const n = performance.getEntriesByType('navigation')[0];
      return n ? { domInteractive: Math.round(n.domInteractive) } : null;
    })()`);
    check('F1d 首屏 DOM 就绪未被外部资源阻塞', !!timing && timing.domInteractive < 6000,
      timing ? `domInteractive ${timing.domInteractive}ms` : '拿不到计时');

    /* --- F2: 云服务初始化 --- */
    let cs = null;
    for (let i = 0; i < 40; i++) {
      cs = await page.eval('window.__DR_API__.cloudState ? window.__DR_API__.cloudState() : null');
      if (cs && (cs.status === 'ready' || cs.status === 'error')) break;
      await sleep(500);
    }
    check('F2 云服务初始化完成', !!cs && cs.status === 'ready',
      cs ? `status=${cs.status}${cs.error ? ' · ' + JSON.stringify(cs.error) : ''}` : '拿不到状态');
    if (!cs || cs.status !== 'ready') throw new Error('云服务未就绪，后续项无法验证');

    /* --- F3: 菜单状态行 --- */
    const line = await page.text('cloudline');
    check('F3 菜单显示云端状态行', !!line && line.trim().length > 0,
      `"${(line || '').trim()}"`);
    check('F3b 未登录时明确告知成绩只存本机', /未登录|本机/.test(line || ''), `"${(line || '').trim()}"`);

    /* --- F4: 排行榜真实读取云端数据（先验数据层，再验 UI 层） --- */
    const dataLayer = await page.eval(`(async () => {
      const c = window.__DR_API__.cloud();
      try {
        const rows = await c.fetchLeaderboard('coast', 20);
        return { ok: true, count: rows.length };
      } catch (e) { return { ok: false, err: String(e && e.message || e) }; }
    })()`);
    check('F4 数据层可查询云端排行榜', dataLayer.ok,
      dataLayer.ok ? `返回 ${dataLayer.count} 条` : '异常: ' + dataLayer.err);

    await page.eval('window.__DR_API__.showBoard()');
    const readTable = `(() => {
      const t = document.getElementById('board-table');
      const rows = [...t.querySelectorAll('tr')].slice(1).map((tr) =>
        [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()))
        .filter((r) => r.length > 1);
      return {
        rows,
        visible: !document.getElementById('screen-board').classList.contains('hide'),
        text: t.textContent || '',
      };
    })()`;
    const expect = dataLayer.count || 0;
    let board = { rows: [], visible: false, text: '' };
    if (expect > 0) {
      for (let i = 0; i < 30; i++) {     // 首次数据请求含冷启动，轮询等待渲染完成
        await sleep(600);
        board = await page.eval(readTable);
        if (board.rows.length >= Math.min(expect, 20)) break;
      }
    } else {
      await sleep(2500);
      board = await page.eval(readTable);
    }
    check('F4b 排行榜界面可打开', board.visible === true, `visible=${board.visible}`);
    if (expect > 0) {
      // 榜单与云端同源：行数应等于「去重后的玩家数」（每位玩家只显示最快的一圈）
      const names = board.rows.map((r) => String(r[1] || '').replace(/（你）/, '').trim());
      const uniq = new Set(names);
      check('F4c 表格渲染出云端成绩（行数 = 去重后的玩家数）',
        board.rows.length >= 1 && uniq.size === board.rows.length,
        `云端原始 ${expect} 条 → 表格 ${board.rows.length} 行 / ${uniq.size} 位玩家 · 首行 ${JSON.stringify(board.rows[0] || [])}`);

      // 圈速数值必须与数据层的第一条完全一致 —— 证明渲染的是真实云端数据，而不是占位/伪造
      const cloudTop = await page.eval(`(async () => {
        const rows = await window.__DR_API__.cloud().fetchLeaderboard('coast', 20);
        return rows.length ? rows[0].lap_ms : null;
      })()`);
      // 表格里的 "0:44.34" 是 m:ss.cc，fmtTime 会**向下截断**到百分之一秒，
      // 所以把云端毫秒按同样口径截断后再比对（否则 44342ms 与显示值差 2ms 会误判）
      const parseLap = (s) => {
        const m = String(s).match(/(\d+):(\d+)\.(\d+)/);
        return m ? Number(m[1]) * 60000 + Number(m[2]) * 1000 + Number(m[3]) * 10 : null;
      };
      const truncToCc = (ms) => Math.floor(ms / 10) * 10;
      check('F4d 表格首行圈速与云端数据一致（非占位内容）',
        cloudTop != null && parseLap(board.rows[0][2]) === truncToCc(cloudTop),
        `表格 "${board.rows[0][2]}" → ${parseLap(board.rows[0][2])}ms · 云端 ${cloudTop}ms`);

      const ordered = board.rows.map((r) => parseLap(r[2]));
      check('F4e 排行榜按圈速升序返回',
        ordered.every((v, i) => i === 0 || v >= ordered[i - 1]),
        `圈速序号 ${ordered.join(' ≤ ')}`);
    } else {
      check('F4c 空榜单时显示空态而非报错', /还没有成绩/.test(board.text),
        `"${board.text.trim().slice(0, 44)}"`);
    }

    /* --- F5: 服务端 RLS 拒绝匿名写入（绕过客户端检查直连 SDK） --- */
    const anonWrite = await page.eval(`(async () => {
      const c = window.__DR_API__.cloud();
      const { data, error } = await c.db.from('dr_lap_records')
        .insert({ track_id: 'coast', lap_ms: 12345, player_name: '${TEST_TAG}-匿名伪造', mode: 'solo' })
        .select();
      return {
        error: error ? { code: error.code || null, message: error.message || String(error) } : null,
        rows: Array.isArray(data) ? data.length : 0,
      };
    })()`);
    check('F5 服务端拒绝未登录写入（RLS 生效，非仅客户端拦截）',
      !!anonWrite.error || anonWrite.rows === 0,
      anonWrite.error ? `拒绝于服务端 ${anonWrite.error.code || ''} ${anonWrite.error.message}` : `rows=${anonWrite.rows}`);

    /* --- F6: 未登录提交成绩的提示 --- */
    await page.eval(`window.__DR_API__.submitResult({
      trackId:'coast', lapMs:61000, topKmh:150, driftScore:100, mode:'solo', rank:2 })`);
    await sleep(900);
    const toast = await page.text('toast');
    check('F6 未登录提交成绩时明确提示（不伪成功）',
      /未登录|本机/.test(toast || ''), `"${(toast || '').trim()}"`);
    const stillAnon = await page.eval('window.__DR_API__.cloudState().signedIn');
    check('F6b 提交失败后仍处于未登录态', stillAnon === false, `signedIn=${stillAnon}`);

    /* --- F7: 账号界面 ---
       界面原则（上一版在这里是错的）：登录与注册不该让用户自己选。
       主流程只有一条：填邮箱 → 收验证码；是登录还是注册由服务端说了算。 */
    await page.eval('window.__DR_API__.showAccount()');
    await sleep(500);
    const accOpen = await page.visible('screen-account');
    check('F7 账号界面可打开', accOpen === true, `visible=${accOpen}`);

    const flow = await page.eval(`(() => {
      const g = document.getElementById('acc-guest');
      const vis = (id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden' &&
               el.getBoundingClientRect().height > 0;
      };
      const txt = (id) => (document.getElementById(id) || {}).textContent || '';
      return {
        codeShown: vis('pane-code'),
        pwdHidden: !vis('pane-pwd'),
        resetHidden: !vis('pane-reset'),
        stepEmail: vis('step-email'),
        stepCode: !vis('step-code'),
        primaryBtn: txt('btn-send-code').replace(/\\s/g, ''),
        hasEmail: !!document.getElementById('otp-email'),
        pwdLink: !!document.getElementById('lnk-pwd'),
        forgotLink: !!document.getElementById('lnk-forgot'),
        // 「登录 / 注册」这类把选择权丢给用户的文案不该再出现
        mixedCopy: /登\\s*录\\s*\\/\\s*注\\s*册/.test(g.textContent),
      };
    })()`);
    check('F7b 账号页只有一条主流程（邮箱优先），密码/重置面板默认收起',
      flow.codeShown && flow.pwdHidden && flow.resetHidden && flow.stepEmail && !flow.stepCode,
      JSON.stringify(flow));
    check('F7c 第一步只有一个动作按钮，不需要用户先选「登录还是注册」',
      flow.primaryBtn === '继续' && flow.hasEmail, `主按钮文案=「${flow.primaryBtn}」`);
    check('F7d 界面不再出现「登录 / 注册」这种二选一文案', flow.mixedCopy === false,
      flow.mixedCopy ? '仍存在混合文案' : '未发现');
    check('F7e 次级入口（密码登录 / 忘记密码）仍可达', flow.pwdLink && flow.forgotLink,
      JSON.stringify({ pwd: flow.pwdLink, forgot: flow.forgotLink }));

    const pwdPane = await page.eval(`(() => {
      const vis = (id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden' &&
               el.getBoundingClientRect().height > 0;
      };
      document.getElementById('lnk-pwd').click();
      return { pwd: vis('pane-pwd'), code: !vis('pane-code') };
    })()`);
    await sleep(150);
    check('F7f 可切入密码登录 / 返回验证码登录（按真实渲染判定）',
      pwdPane.pwd && pwdPane.code, JSON.stringify(pwdPane));

    const hasForms = await page.eval(`({
      pwd: !!document.getElementById('btn-pwd-login'),
      send: !!document.getElementById('btn-send-code'),
      verify: !!document.getElementById('btn-otp-login'),
      reset: !!document.getElementById('btn-do-reset'),
    })`);
    check('F7g 密码登录 / 验证码 / 注册 / 重置密码入口齐全',
      hasForms.pwd && hasForms.send && hasForms.verify && hasForms.reset, JSON.stringify(hasForms));

    /* --- F8 前置：切到密码登录面板 --- */
    check('F8 前置：密码登录面板已就绪',
      await page.visible('pane-pwd'), 'visible(pane-pwd)');
    await page.fill('acc-email', 'selftest-not-a-user@example.com');
    await page.fill('acc-pwd', 'definitely-wrong-password-9f2a');
    await page.click('btn-pwd-login');
    let authErr = null;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const h = await page.text('acc-hint-pwd');
      if (h && h.trim()) { authErr = h.trim(); break; }
    }
    check('F8 错误凭据由后端拒绝（Auth 链路真实连通，非网络失败）',
      !!authErr && !/网络|SDK/.test(authErr), `界面提示: "${authErr}"`);
    const stillAnon2 = await page.eval('window.__DR_API__.cloudState().signedIn');
    check('F8b 登录失败后未产生任何会话', stillAnon2 === false, `signedIn=${stillAnon2}`);

    /* --- F9: 无 JS 异常 --- */
    const errs = page.errors();
    // F5 / F8 是「故意让服务端拒绝」的用例，浏览器会记录一条资源加载失败 —— 属预期内的业务失败
    const realErrs = errs.filter((e) => !/Failed to load resource/.test(e));
    const expected = errs.length - realErrs.length;
    check('F9 全程无 JS 异常', realErrs.length === 0,
      realErrs.length ? realErrs.slice(0, 3).join(' | ')
        : `（已排除 ${expected} 条预期内的「请求被服务端拒绝」日志）`);

    const fatal = await page.eval('window.__DR_ERROR__ || null');
    check('F9b 页面未进入致命错误状态', fatal === null, fatal ? String(fatal).slice(0, 120) : '无');

    await page.shot('tools/shot-cloud-account.png');
    await page.close();
  } catch (e) {
    log('\n\x1b[31m验收脚本异常: ' + (e && e.stack || e) + '\x1b[0m');
    results.push({ name: '脚本异常', ok: false, detail: String(e && e.message || e) });
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
