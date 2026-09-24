/* ===========================================================================
 * verify-signup.mjs — 真实账号闭环验收：注册 → 登录 → 跑一整圈 → 成绩上榜
 *
 * 这是唯一无法离线伪造的一环：邮箱验证码必须由真人从邮箱里取出来。
 * 为了让「取码」这一步不打断浏览器会话（verificationId 与会话相关），
 * 脚本会先真实点击「获取验证码」，把 challenge 留在页面内存里，然后
 * 轮询一个临时文件等验证码进来 —— 拿到就继续，超时就退出。
 *
 * 两条路径（DR_PHASE）：
 *   signup（默认）  邮箱验证码注册 —— 唯一无法离线伪造的一环：验证码必须由真人从邮箱取出。
 *                  脚本先真实点击「获取验证码」，把 challenge 留在页面内存里（verificationId
 *                  与会话相关，不能中断浏览器会话），再轮询临时文件等验证码进来。
 *   login           邮箱 + 密码登录 —— 账号已注册过时用它复跑 G8~G15（成绩上传/上榜），免验证码。
 *
 * 用法：
 *   DR_EMAIL=you@example.com node tools/verify-signup.mjs
 *   # 收到邮件后：把 6 位码写入 %TEMP%/dr-otp.txt
 *   DR_PHASE=login DR_EMAIL=you@example.com node tools/verify-signup.mjs   # 复跑（免验证码）
 *
 * 环境变量：
 *   DR_EMAIL        必填，用于注册/登录的邮箱
 *   DR_PASSWORD     账号密码（默认 DriftRush2026!a）
 *   DR_PHASE        signup（默认）| login
 *   DR_SERVER       目标站点（默认已发布的线上域名）
 *   DR_OTP_FILE     验证码投递文件（默认 <tmp>/dr-otp.txt）
 *   DR_OTP_WAIT_MIN 等待验证码的分钟数（默认 10）
 * =========================================================================*/

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Browser, sleep } from './cdp.mjs';
import { makeDriver } from './driver.mjs';

const BASE = (process.env.DR_SERVER || 'https://drift-rush-online.app.workbuddy.host').replace(/\/+$/, '');
const EMAIL = process.env.DR_EMAIL || '';
const PASSWORD = process.env.DR_PASSWORD || 'DriftRush2026!a';
const TOKEN_FILE = process.env.DR_OTP_FILE || path.join(os.tmpdir(), 'dr-otp.txt');
const WAIT_MS = Number(process.env.DR_OTP_WAIT_MIN || 10) * 60_000;
const STATE_FILE = path.join(os.tmpdir(), 'dr-signup-state.json');

let pass = 0, fail = 0;
const log = (s = '') => console.log(s);
function check(name, ok, detail = '') {
  if (ok) { pass++; log(`  \u2714 ${name}${detail ? '  \u2014 ' + detail : ''}`); }
  else { fail++; log(`  \u2718 ${name}${detail ? '  \u2014 ' + detail : ''}`); }
  return !!ok;
}

const FAIL_RE = /失败|不正确|已过期|不可用|异常|超时|请先|错误/;
/** 验收路径：signup=邮箱验证码注册（默认）；login=用已注册账号密码登录（免验证码，用于复跑） */
const LOGIN_MODE = process.env.DR_PHASE === 'login';

/* ------------------------------------------------------- 循线自动驾驶（P1） */
// 统一由 tools/driver.mjs 提供，避免与 verify.mjs 的实现各自漂移

/** 注册路径：邮箱验证码登录/注册。需要在账号页已打开的前提下调用，返回 cloudState()。 */
async function signupByOtp(page) {
    /* ---------------- G4：主流程是「填邮箱 → 继续」 ----------------
       新版账号页没有页签：一个入口，登录还是注册由服务端判定。 */
    check('G4 账号页处于主流程第一步（填邮箱）',
      await page.visible('step-email') && !(await page.visible('step-code'))
      && await page.visible('pane-code'), 'step-email 可见 / step-code 收起');

    const copy0 = await page.eval(`document.getElementById('acc-guest').textContent`);
    check('G4b 界面不出现「登录 / 注册」二选一文案', !/登\s*录\s*\/\s*注\s*册/.test(copy0),
      /登\s*录\s*\/\s*注\s*册/.test(copy0) ? '仍存在' : '未发现');

    /* ---------------- G5：真实发送验证码 ---------------- */
    log('\n\x1b[1m[G5] 发送邮箱验证码（真实云端请求）\x1b[0m');
    await page.fill('otp-email', EMAIL);
    await page.click('btn-send-code');

    let pending = null, hint = '';
    for (let i = 0; i < 90; i++) {
      await sleep(500);
      const r = await page.eval(`(() => {
        const u = window.__DR_API__.cloudUI();
        const h = document.getElementById('acc-hint');
        return { pending: u.pending ? { email: u.pending.email, verificationId: u.pending.verificationId, isExistingUser: u.pending.isExistingUser } : null,
                 hint: h ? h.textContent : '' };
      })()`);
      hint = r.hint || '';
      if (r.pending) { pending = r.pending; break; }
      if (FAIL_RE.test(hint)) break;
    }
    check('G5 验证码已发送成功（拿到云端 verificationId）', !!pending,
      pending ? `verificationId=${String(pending.verificationId).slice(0, 10)}… · isExistingUser=${pending.isExistingUser}`
              : '界面提示：' + hint);
    if (!pending) { await page.shot('tools/_signup-fail.png'); throw new Error('验证码未发出：' + hint); }

    /* 发码后界面必须明确走到第 2 步，且文案与「登录 or 注册」的实际情形一致 */
    const stage = await page.eval(`(() => {
      const btn = document.getElementById('btn-otp-login');
      return {
        step2: !document.getElementById('step-code').classList.contains('hide'),
        step1done: document.querySelector('.stp[data-step="1"]').classList.contains('done'),
        btn: (btn.textContent || '').replace(/\\s/g, ''),
        pwdShown: !document.getElementById('otp-pwd').classList.contains('hide'),
        to: (document.getElementById('otp-to').textContent || '').trim(),
        mode: document.getElementById('otp-mode').textContent || '',
      };
    })()`);
    check('G5b 发码后界面推进到第二步，并回显收件邮箱',
      stage.step2 && stage.step1done && stage.to === pending.email,
      `step2=${stage.step2} · 收件=「${stage.to}」`);
    check('G5c 按钮文案与真实情形一致（老用户=登录，新邮箱=注册并登录）',
      pending.isExistingUser ? stage.btn === '登录' : stage.btn === '注册并登录',
      `isExistingUser=${pending.isExistingUser} → 「${stage.btn}」`);
    check('G5d 密码字段只在需要时出现（新邮箱才要求设密码）',
      stage.pwdShown === !pending.isExistingUser,
      `pwdShown=${stage.pwdShown} · isExistingUser=${pending.isExistingUser}`);

    fs.writeFileSync(STATE_FILE, JSON.stringify({
      email: pending.email, base: BASE,
      verificationId: pending.verificationId, isExistingUser: pending.isExistingUser,
      at: new Date().toISOString(),
    }, null, 2));
    log(`  界面提示：${hint}`);
    log(`  challenge 已落盘：${STATE_FILE}`);

    /* ---------------- G6：等验证码（人工环节） ---------------- */
    log(`\n\x1b[1m[G6] 等待验证码投递到 ${TOKEN_FILE}\x1b[0m`);
    log(`  最长等待 ${WAIT_MS / 60000} 分钟，每 30 秒报一次进度…`);
    const t0 = Date.now();
    let token = '';
    let lastTick = 0;
    while (Date.now() - t0 < WAIT_MS) {
      await sleep(2000);
      try {
        const raw = fs.readFileSync(TOKEN_FILE, 'utf8').replace(/\D/g, '');
        if (raw.length >= 4) { token = raw.slice(0, 8); break; }
      } catch (e) { /* 还没写入 */ }
      const el = Math.round((Date.now() - t0) / 1000);
      if (el - lastTick >= 30) { lastTick = el; log(`  … 已等待 ${el}s`); }
    }
    check('G6 已取得邮箱验证码', !!token, token ? `${token.slice(0, 2)}****${token.slice(-1)}（${token.length} 位）` : '超时未收到');
    if (!token) throw new Error('未收到验证码，流程中止');

    /* ---------------- G7：提交验证码完成注册/登录 ---------------- */
    log('\n\x1b[1m[G7] 提交验证码，完成注册/登录\x1b[0m');
    await page.fill('otp-code', token);
    const pwdShown = await page.visible('otp-pwd');
    if (pwdShown) await page.fill('otp-pwd', pending.isExistingUser ? '' : PASSWORD);

    await page.click('btn-otp-login');
    let signed = null;
    for (let i = 0; i < 80; i++) {
      await sleep(500);
      const r = await page.eval(`(() => {
        const h = document.getElementById('acc-hint');
        return { st: window.__DR_API__.cloudState(), hint: h ? h.textContent : '' };
      })()`);
      if (r.st.signedIn) { signed = r.st; break; }
      if (FAIL_RE.test(r.hint)) { hint = r.hint; break; }
    }
    check('G7 注册/登录成功（拿到真实云端用户身份）', !!(signed && signed.signedIn),
      signed ? `userId=${signed.userId}` : '界面提示：' + hint);
    if (!signed) { await page.shot('tools/_signup-fail.png'); throw new Error('登录未成功：' + hint); }

  return signed;
}

/**
 * 登录路径：邮箱 + 密码。账号已注册过时用它复跑后续验收，无需重新取邮箱验证码。
 * 需要在账号页已打开的前提下调用，返回 cloudState()。
 */
async function loginByPassword(page) {
  log("\n\x1b[1m[G4] 从主流程切到「用密码登录」\x1b[0m");
  const tabPwd = await page.eval(`(() => {
    const b = document.getElementById('lnk-pwd');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(300);
  check("G4 已切换到密码登录面板", tabPwd && await page.visible("pane-pwd"));

  log("\n\x1b[1m[G5] 提交已注册账号的邮箱与密码（真实云端校验）\x1b[0m");
  await page.fill("acc-email", EMAIL);
  await page.fill("acc-pwd", PASSWORD);
  await page.click("btn-pwd-login");

  let signed = null, hint = "";
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    const r = await page.eval(`(() => {
      const h = document.getElementById('acc-hint-pwd');
      return { st: window.__DR_API__.cloudState(), hint: h ? h.textContent : '' };
    })()`);
    if (r.st.signedIn) { signed = r.st; break; }
    if (FAIL_RE.test(r.hint)) { hint = r.hint; break; }
  }
  check("G5 密码登录成功（拿到真实云端用户身份）", !!(signed && signed.signedIn),
    signed ? `userId=${signed.userId}` : "界面提示：" + hint);
  if (!signed) { await page.shot("tools/_signup-fail.png"); throw new Error("密码登录未成功：" + hint); }
  return signed;
}


/* ------------------------------------------------------------------- 主流程 */
async function main() {
  if (!EMAIL) { console.error('缺少 DR_EMAIL（用于注册/登录的邮箱）'); process.exit(2); }
  try { fs.unlinkSync(TOKEN_FILE); } catch (e) { /* 不存在即可 */ }

  log(`\n\x1b[1m真实账号闭环验收\x1b[0m`);
  log(`  站点：${BASE}`);
  log(`  邮箱：${EMAIL}`);
  if (LOGIN_MODE) log(`  路径：密码登录（免验证码，用于复跑成绩上传/上榜环节）\n`);
  else log(`  取码：把 6 位验证码写入 ${TOKEN_FILE}\n`);

  const browser = await Browser.launch();
  const page = await browser.newPage();
  let ok = false;

  try {
    /* ---------------- G1/G2：页面与云服务就绪 ---------------- */
    log('\x1b[1m[G1] 打开页面，等待云服务客户端就绪\x1b[0m');
    const loaded = await page.readyUrl(BASE + '/');
    check('G1 页面加载完成（场景与首帧就绪）', loaded, '');

    let cs = null;
    for (let i = 0; i < 70; i++) {
      await sleep(500);
      cs = await page.eval('window.__DR_API__ ? window.__DR_API__.cloudState() : null');
      if (cs && cs.status === 'ready') break;
    }
    check('G2 云服务客户端就绪（SDK 已连上云环境）', cs && cs.status === 'ready',
      cs ? `status=${cs.status}${cs.error ? ' · ' + (cs.error.message || JSON.stringify(cs.error)) : ''}` : '拿不到状态');

    /* ---------------- G3：打开账号页 ---------------- */
    log("\n\x1b[1m[G3] 打开账号页\x1b[0m");
    await page.click("btn-account");
    await sleep(400);
    check("G3 账号页已打开（主菜单入口真实可点）", await page.visible("screen-account"));

    // 两条路径：DR_PHASE=signup 走邮箱验证码注册；DR_PHASE=login 用已注册账号密码登录（免验证码）
    const signed = LOGIN_MODE ? await loginByPassword(page) : await signupByOtp(page);

    /* ---------------- G8：云档案建档/回读 ---------------- */
    log('\n\x1b[1m[G8] 云档案同步\x1b[0m');
    let prof = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const st = await page.eval('window.__DR_API__.cloudState()');
      if (st.profile) { prof = st.profile; break; }
    }
    check('G8 云档案已建立并回读（昵称/涂装跨设备可恢复）', !!prof,
      prof ? `display_name=${prof.display_name} · paint=${prof.paint} · races=${prof.races}` : '未建档');

    const uiAfter = await page.eval(`(() => {
      const rows = [...document.querySelectorAll('#acc-stats .accrow')].map((r) => r.textContent.trim());
      const who = document.getElementById('acc-who-email');
      return { rows, who: who ? who.textContent : '', userPaneVisible: !document.getElementById('acc-user').classList.contains('hide') };
    })()`);
    check('G9 账号页切到「已登录」视图并展示云端战绩', uiAfter.userPaneVisible && uiAfter.rows.length >= 4,
      `${uiAfter.who} · ${uiAfter.rows.length} 项战绩`);

    /* ---------------- G10：已登录状态下真实跑完一圈 ---------------- */
    log('\n\x1b[1m[G10] 已登录状态下跑完一整圈（成绩应自动上榜）\x1b[0m');
    await page.eval(`window.__DR_API__.start({ mode:'solo', track:'coast', laps:1, level:'normal', name: '云车手' })`);
    await sleep(500);

    const drv = await makeDriver(page, 1);
    const started = Date.now();
    let phaseNow = '', fin = null;
    while (Date.now() - started < 210000) {
      const st = await drv.step();
      await sleep(70);
      if (st) {
        phaseNow = st.phase;
        if (st.fin) fin = st;
        if (phaseNow === 'result') break;
      }
    }
    await drv.release();
    check('G10 完赛并进入结算屏', phaseNow === 'result',
      `phase=${phaseNow} · 自动驾驶峰值 ${drv.stat.maxKmh.toFixed(0)} km/h`);

    /* ---------------- G11：结算屏与上传提示 ---------------- */
    const resUI = await page.eval(`(() => {
      const t = document.getElementById('result-list') || document.getElementById('result-rows') || document.querySelector('#screen-result');
      return { visible: !document.getElementById('screen-result').classList.contains('hide'),
               text: (t ? t.textContent : '').replace(/\\s+/g, ' ').slice(0, 300) };
    })()`);
    check('G11 结算屏展示了本场成绩', resUI.visible, resUI.text.slice(0, 120));

    /* ---------------- G12：排行榜出现本人成绩 ---------------- */
    log('\n\x1b[1m[G12] 打开排行榜，确认成绩真的上榜\x1b[0m');
    await page.eval('window.__DR_API__.showBoard()');
    let mine = null, rows = [];
    for (let i = 0; i < 40; i++) {
      await sleep(600);
      const b = await page.eval(`(() => {
        const t = document.getElementById('board-table');
        const trs = [...t.querySelectorAll('tr')].slice(1);
        return trs.map((tr) => ({
          mine: tr.classList.contains('me'),
          cells: [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()),
        })).filter((r) => r.cells.length > 1);
      })()`);
      rows = b;
      mine = b.find((r) => r.mine);
      if (mine) break;
    }
    check('G12 排行榜出现本人成绩（标记为「你」）', !!mine,
      mine ? mine.cells.join(' | ') : `${rows.length} 行，未找到本人行`);
    if (rows.length) {
      const ordered = rows.slice(0, 5).map((r) => parseInt(String(r.cells[2]).replace(/\D/g, ''), 10));
      check('G13 排行榜按圈速升序渲染', ordered.every((v, i) => i === 0 || v >= ordered[i - 1]),
        `前 ${ordered.length} 名 ${ordered.join(' \u2264 ')}`);
    }

    /* ---------------- G14：数据层回读本人最佳 ---------------- */
    const best = await page.eval(`(async () => {
      try { const b = await window.__DR_API__.cloud().fetchMyBest('coast'); return { ok: true, b }; }
      catch (e) { return { ok: false, err: String((e && e.message) || e) }; }
    })()`);
    check('G14 云端「我的最佳圈速」可回读', best.ok && best.b,
      best.ok ? `lap_ms=${best.b && best.b.lap_ms} · top_kmh=${best.b && best.b.top_kmh} · mode=${best.b && best.b.mode}` : best.err);

    /* ---------------- G15：无 JS 异常 · 无失败请求 ---------------- */
    const errs = page.errors();
    check('G15 全程无 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));
    const bad = page.failedRequests();
    check('G16 全程无失败的云端请求（4xx/5xx）', bad.length === 0, bad.slice(0, 3).join(' | '));

    ok = fail === 0;
    log(`\n\x1b[1m结果：${pass} 通过 / ${fail} 失败\x1b[0m`);
    log(`账号：${EMAIL}  密码：${LOGIN_MODE ? '（沿用已注册密码，未改动）' : PASSWORD}`);
    log(`页面停在排行榜，可用浏览器窗口查看（CDP 端口 ${process.env.DR_CDP_PORT || 9402}）\n`);
  } catch (e) {
    log('\n\x1b[31m流程中断：' + (e && e.message ? e.message : e) + '\x1b[0m');
    log(`结果：${pass} 通过 / ${fail} 失败（未跑完）`);
  } finally {
    // 无头浏览器留着没用（用户看不到），一律优雅关闭，避免残留实例占着调试端口
    try { await browser.kill(); } catch (e) { }
  }
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
