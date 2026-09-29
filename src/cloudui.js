/* ===========================================================================
 * cloudui.js — 账号（登录 / 注册 / 重置）与排行榜界面
 *
 * 只负责 DOM 与事件，云调用全部落在 cloud.js。
 *
 * 关于「登录与注册」的界面原则（上一版在这里是错的）：
 *   旧版把「验证码登录 / 注册」做成一个页签、按钮写着「登 录 / 注 册」，
 *   等于让玩家自己判断「我该登录还是该注册」—— 而这件事玩家无法知道，
 *   却是服务端一句话就能确定的。所以新版：
 *     · 只有一个主入口：填邮箱 → 输验证码
 *     · 登录还是注册，由发码接口返回的 isExistingUser 决定，
 *       按钮文案、密码字段、说明文字全部据此切换，界面里不再出现「/」
 *     · 密码登录与重置密码降为次级文字链，不占主导航
 *
 * 另两条交互硬约束：
 *   · 「发验证码」与「提交验证码」是两个独立动作；提交阶段绝不再发新码
 *   · 发送/提交在途时禁用按钮，防止重复请求；任何失败都在界面上说明原因
 * =========================================================================*/

import { TRACKS, TRACK_ORDER } from './config.js';
import { fmtTime } from './util.js';
import { t, pick } from './i18n.js';

const $ = (id) => document.getElementById(id);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const VIEWS = ['code', 'pwd', 'reset'];
const HINT_OF = { code: 'acc-hint', pwd: 'acc-hint-pwd', reset: 'acc-hint-reset' };

export class CloudUI {
  constructor(cb = {}) {
    this.cb = cb;
    this.cloud = cb.cloud;
    this.pending = null;          // 验证码挑战：{ email, verificationId, isExistingUser }
    this.resetChallenge = null;   // 重置密码挑战
    this.view = 'code';
    this.step = 'email';          // code 视图内部：email | code
    this.sendTimer = null;
    this.boardTrack = TRACK_ORDER[0];
    this.trackObjects = null;
    this._wire();
  }

  /* ============================================================ 界面切换 */
  showAccount() {
    this.render();
    this._show('account');
  }
  showBoard(trackObjects) {
    if (trackObjects) this.trackObjects = trackObjects;
    this._buildBoardTabs();
    this._show('board');
    this.loadBoard();
  }
  _show(which) {
    $('screen-account').classList.toggle('hide', which !== 'account');
    $('screen-board').classList.toggle('hide', which !== 'board');
    if (this.cb.onScreen) this.cb.onScreen(which);
  }
  hide() {
    $('screen-account').classList.add('hide');
    $('screen-board').classList.add('hide');
  }

  /* ======================================================== 视图 / 步骤 */
  /** 切到某个视图（code | pwd | reset）。切换时清空提示，避免串味。 */
  setView(view, step) {
    this.view = VIEWS.includes(view) ? view : 'code';
    if (this.view === 'code' && step) this.step = step;
    if (this.view === 'code') this._renderStep();
    for (const v of VIEWS) $('pane-' + v).classList.toggle('hide', v !== this.view);
    this.hint('');
    // 自动聚焦到该视图里第一个可输入字段，少点一次屏幕
    const first = {
      code: this.step === 'email' ? 'otp-email' : 'otp-code',
      pwd: 'acc-email',
      reset: 'reset-email',
    }[this.view];
    if (first) setTimeout(() => { const el = $(first); if (el) el.focus({ preventScroll: true }); }, 60);
  }

  /** 步骤指示器：1 填邮箱 → 2 输验证码，让流程在界面上可见 */
  _renderStep() {
    const at = this.step;
    for (const el of $('code-steps').querySelectorAll('.stp')) {
      const n = el.dataset.step;
      el.classList.toggle('on', n === (at === 'email' ? '1' : '2'));
      el.classList.toggle('done', n === '1' && at === 'code');
    }
    $('step-email').classList.toggle('hide', at !== 'email');
    $('step-code').classList.toggle('hide', at !== 'code');
  }

  /* ============================================================ 状态渲染 */
  render() {
    const c = this.cloud;
    const statusText = {
      idle: t('cloud.statusIdle'),
      loading: t('cloud.statusLoading'),
      ready: t('cloud.statusReady'),
      error: t('cloud.statusError', (c.error && c.error.message) || t('cloud.errUnknown')),
      unavailable: t('cloud.statusUnavailable'),
    }[c.status] || c.status;
    const dot = c.status === 'ready' ? 'ok' : c.status === 'loading' ? 'wait' : 'bad';
    $('cloud-status').innerHTML = `<span class="cd ${dot}"></span>${statusText}`;

    const guest = !c.signedIn;
    $('acc-guest').classList.toggle('hide', !guest);
    $('acc-user').classList.toggle('hide', guest);
    const tag = $('acc-tagline');
    if (tag) {
      tag.textContent = guest ? t('acc.tagGuest') : t('acc.tagUser');
    }
    if (guest) return;

    $('acc-who-email').textContent = (c.user && c.user.email) || t('acc.whoFallback');
    const p = c.profile || {};
    const rows = [
      [t('acc.statRaces'), p.races != null ? p.races : '--'],
      [t('acc.statWins'), p.wins != null ? p.wins : '--'],
      [t('acc.statKm'), p.total_km != null ? p.total_km.toFixed(1) + ' km' : '--'],
      [t('acc.statBest'), p.best_lap_ms ? fmtTime(p.best_lap_ms) : '--:--.--'],
      [t('acc.statName'), p.display_name || '--'],
    ];
    $('acc-stats').innerHTML = rows
      .map(([k, v]) => `<div class="accrow"><span class="k">${k}</span><span class="v">${v}</span></div>`)
      .join('');
  }

  /** 提示写到「当前视图」的提示条里，切视图不会残留 */
  hint(msg, kind = 'info') {
    const el = $(HINT_OF[this.view] || 'acc-hint');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'acchint' + (msg ? ' on ' + kind : '');
  }

  /* ============================================================ 事件接线 */
  _wire() {
    $('btn-account').addEventListener('click', () => this.showAccount());
    $('btn-board').addEventListener('click', () => this.showBoard());
    $('btn-acc-back').addEventListener('click', () => this._back());
    $('btn-board-back').addEventListener('click', () => this._back());

    /* --- 主流程：邮箱 → 验证码 --- */
    $('btn-send-code').addEventListener('click', () => this.doSendCode());
    $('btn-otp-login').addEventListener('click', () => this.doCodeLogin());
    $('otp-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.doSendCode(); });
    $('otp-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.doCodeLogin(); });
    $('otp-code').addEventListener('input', () => {
      // 粘贴整串验证码时自动提交，省一次点击
      const v = ($('otp-code').value || '').trim();
      if (v.length === 6 && /^\d{6}$/.test(v)) this.hint(t('acc.otpFilled'), 'info');
    });
    $('lnk-resend').addEventListener('click', () => this.doSendCode({ resend: true }));
    $('lnk-change-email').addEventListener('click', () => this.backToEmail());
    $('lnk-back-email').addEventListener('click', () => this.backToEmail());

    /* --- 次级入口 --- */
    $('lnk-pwd').addEventListener('click', () => this.setView('pwd'));
    $('lnk-back-code').addEventListener('click', () => this.setView('code'));
    $('lnk-back-code2').addEventListener('click', () => this.setView('code'));
    $('btn-pwd-login').addEventListener('click', () => this.doPasswordLogin());
    $('acc-pwd').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.doPasswordLogin(); });
    $('lnk-forgot').addEventListener('click', () => this.setView('reset'));
    $('btn-send-reset').addEventListener('click', () => this.doGetResetCode());
    $('btn-do-reset').addEventListener('click', () => this.doCompleteReset());

    /* --- 已登录 --- */
    $('btn-signout').addEventListener('click', () => this.doSignOut());
    $('btn-sync').addEventListener('click', () => this.doSync());
  }

  _back() {
    this.hide();
    if (this.cb.onBack) this.cb.onBack();
  }

  /** 回到第一步：保留已填邮箱，清掉验证码挑战 */
  backToEmail() {
    this.pending = null;
    this.setView('code', 'email');
    $('otp-code').value = '';
    $('otp-pwd').value = '';
    $('otp-pwd').classList.add('hide');
    $('otp-to').textContent = '—';
  }

  _toast(msg, ok) {
    if (this.cb.toast) this.cb.toast(msg, ok);
  }

  _resetSendBtn() {
    clearInterval(this.sendTimer);
    const btn = $('btn-send-code');
    btn.textContent = t('acc.continue');
    btn.disabled = false;
  }

  /* ==================================================== 主流程：发验证码 */
  /**
   * 「继续」与「重新发送」共用。这是唯一会发码的地方。
   * 返回 isExistingUser 后立刻把界面切成「登录」或「注册」——玩家不需要自己选。
   */
  async doSendCode({ resend = false } = {}) {
    const email = ($('otp-email').value || '').trim();
    if (!EMAIL_RE.test(email)) { this.hint(t('acc.badEmail'), 'bad'); return; }
    if (this.cloud.status !== 'ready') { this.hint(t('acc.cloudDown'), 'bad'); return; }

    const btn = resend ? $('lnk-resend') : $('btn-send-code');
    const raw = btn.textContent;
    btn.disabled = true;
    if (resend) btn.textContent = t('acc.sending');
    this.setView('code', resend ? 'code' : 'email');   // resend 时留在第 2 步
    this.hint(t('acc.sendingCode'));

    try {
      const data = await this.cloud.sendEmailCode(email);
      this.pending = {
        email,
        verificationId: data.verificationId,
        isExistingUser: !!data.isExistingUser,
      };
      this.setView('code', 'code');
      this._renderCodeStage();
      // 只有从第 1 步过来时才做重发倒计时，避免「重新发送」按钮本身被锁 60 秒
      if (!resend) this._startCountdown();
      else btn.textContent = raw;
      this.hint(
        this.pending.isExistingUser ? t('acc.sentLogin') : t('acc.sentRegister'),
        'ok');
    } catch (e) {
      this.pending = null;
      this.hint(e.message || t('acc.sendCodeFail'), 'bad');
      btn.disabled = false;
      if (resend) btn.textContent = raw;
    }
  }

  /**
   * 第 2 步的文案完全由 isExistingUser 决定：
   *   已有账号 → 标题「登录」、不要密码字段
   *   新邮箱   → 标题「注册」、必须设置密码
   * 界面上不出现任何「登录 / 注册」这类「二选一」的表述。
   */
  _renderCodeStage() {
    const p = this.pending || {};
    $('otp-to').textContent = p.email || '—';
    const btn = $('btn-otp-login');
    const pwd = $('otp-pwd');
    const mode = $('otp-mode');
    if (p.isExistingUser) {
      btn.textContent = t('acc.login');
      pwd.classList.add('hide');
      pwd.placeholder = t('acc.newPwdPh');
      mode.innerHTML = t('acc.modeExisting');
    } else {
      btn.textContent = t('acc.registerBtn');
      pwd.classList.remove('hide');
      pwd.placeholder = t('acc.pwdPhNew');
      mode.innerHTML = t('acc.modeNew');
    }
  }

  /* ------------------------------------------- 主流程：提交验证码 */
  /** 只消费已保存的挑战，绝不在这里重新发码 */
  async doCodeLogin() {
    const email = ($('otp-email').value || '').trim();
    const token = ($('otp-code').value || '').trim();
    const password = $('otp-pwd').value || '';
    if (!this.pending) { this.hint(t('acc.needCode'), 'bad'); return; }
    if (this.pending.email !== email) {
      this.hint(t('acc.emailChanged'), 'bad');
      this.backToEmail();
      return;
    }
    if (!/^\d{4,8}$/.test(token)) { this.hint(t('acc.needToken'), 'bad'); return; }
    if (!this.pending.isExistingUser && password.length < 6) {
      this.hint(t('acc.needPwd6'), 'bad');
      return;
    }

    const btn = $('btn-otp-login');
    const raw = btn.textContent;
    btn.disabled = true;
    btn.textContent = this.pending.isExistingUser ? t('acc.loggingIn') : t('acc.registering');
    this.hint('');
    try {
      await this.cloud.verifyEmailCode({ email, token, pending: this.pending, password });
      const wasNew = !this.pending.isExistingUser;
      this.pending = null;
      $('otp-code').value = ''; $('otp-pwd').value = '';
      await this.afterSignIn(wasNew ? t('acc.created') : t('acc.loginOk'));
    } catch (e) {
      this.hint(e.message || t('acc.verifyFail'), 'bad');
    } finally {
      btn.disabled = false;
      btn.textContent = raw;
    }
  }

  /* ---------------------------------------------------------- 密码登录 */
  async doPasswordLogin() {
    const email = ($('acc-email').value || '').trim();
    const password = $('acc-pwd').value || '';
    if (!EMAIL_RE.test(email)) { this.hint(t('acc.badEmailShort'), 'bad'); return; }
    if (!password) { this.hint(t('acc.needPwd'), 'bad'); return; }
    const btn = $('btn-pwd-login');
    btn.disabled = true; btn.textContent = t('acc.loggingIn');
    this.hint('');
    try {
      await this.cloud.signInWithPassword(email, password);
      $('acc-pwd').value = '';
      await this.afterSignIn(t('acc.loginOk'));
    } catch (e) {
      this.hint(e.message || t('acc.loginFail'), 'bad');
    } finally {
      btn.disabled = false; btn.textContent = t('acc.login');
    }
  }

  /* ---------------------------------------------------------- 重置密码 */
  async doGetResetCode() {
    const email = ($('reset-email').value || '').trim();
    if (!EMAIL_RE.test(email)) { this.hint(t('acc.badEmailShort'), 'bad'); return; }
    const btn = $('btn-send-reset');
    btn.disabled = true;
    this.hint(t('acc.sendingReset'));
    try {
      this.resetChallenge = await this.cloud.requestPasswordReset(email);
      this.hint(t('acc.resetSent'), 'ok');
    } catch (e) {
      this.resetChallenge = null;
      this.hint(e.message || t('acc.sendFail'), 'bad');
      btn.disabled = false;
    }
  }

  async doCompleteReset() {
    const nonce = ($('reset-code').value || '').trim();
    const password = $('reset-newpwd').value || '';
    if (!this.resetChallenge) { this.hint(t('acc.needResetCode'), 'bad'); return; }
    if (!nonce) { this.hint(t('acc.enterResetCode'), 'bad'); return; }
    if (password.length < 6) { this.hint(t('acc.pwd6'), 'bad'); return; }
    const btn = $('btn-do-reset');
    btn.disabled = true; btn.textContent = t('acc.submitting');
    try {
      await this.cloud.completePasswordReset(this.resetChallenge, nonce, password);
      this.resetChallenge = null;
      $('reset-code').value = ''; $('reset-newpwd').value = '';
      await this.afterSignIn(t('acc.resetDone'));
    } catch (e) {
      this.hint(e.message || t('acc.resetFail'), 'bad');
    } finally {
      btn.disabled = false; btn.textContent = t('acc.setPwd');
    }
  }

  _startCountdown() {
    const btn = $('btn-send-code');
    let n = 60;
    btn.disabled = true;
    clearInterval(this.sendTimer);
    btn.textContent = t('acc.resendIn', n);
    this.sendTimer = setInterval(() => {
      n--;
      if (n <= 0) {
        clearInterval(this.sendTimer);
        btn.disabled = false;
        btn.textContent = t('acc.continue');
      } else {
        btn.textContent = t('acc.resendIn', n);
      }
    }, 1000);
  }

  /* ------------------------------------------------- 登录成功后的编排 */
  async afterSignIn(okMsg) {
    this.hint(t('acc.afterSync', okMsg), 'ok');
    this.render();
    try {
      if (this.cb.onSignedIn) await this.cb.onSignedIn();
    } catch (e) {
      this.hint(t('acc.syncFailAfter', e.message), 'bad');
      return;
    }
    this.render();
    this.hint(t('acc.synced', okMsg), 'ok');
  }

  async doSignOut() {
    const btn = $('btn-signout');
    btn.disabled = true;
    try {
      await this.cloud.signOut();
      this.pending = null;
      $('otp-code').value = ''; $('otp-pwd').value = ''; $('otp-to').textContent = '—';
      this._resetSendBtn();
      this.setView('code', 'email');
      this.render();
      if (this.cb.onSignedOut) this.cb.onSignedOut();
    } catch (e) {
      this._toast(t('acc.signoutFail', e.message || e), false);
    } finally {
      btn.disabled = false;
    }
  }

  async doSync() {
    const btn = $('btn-sync');
    btn.disabled = true; btn.textContent = t('acc.syncing');
    try {
      if (this.cb.onSignedIn) await this.cb.onSignedIn();
      this.render();
      this._toast(t('acc.syncedToast'), true);
    } catch (e) {
      this._toast(t('acc.syncFail', e.message || e), false);
    } finally {
      btn.disabled = false; btn.textContent = t('acc.sync');
    }
  }

  /* ============================================================ 排行榜 */
  _buildBoardTabs() {
    const seg = $('board-tracks');
    seg.innerHTML = '';
    for (const id of TRACK_ORDER) {
      const b = document.createElement('button');
      b.dataset.track = id;
      b.textContent = pick(TRACKS[id].name);
      b.className = id === this.boardTrack ? 'on' : '';
      b.addEventListener('click', () => {
        this.boardTrack = id;
        seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.track === id));
        this.loadBoard();
      });
      seg.appendChild(b);
    }
  }

  async loadBoard() {
    const table = $('board-table');
    const hint = $('board-hint');
    const head = `<tr><th>${t('result.colRank')}</th><th>${t('board.driver')}</th><th>${t(
      'board.lap'
    )}</th><th>${t('board.top')}</th><th>${t('board.drift')}</th><th>${t(
      'board.mode'
    )}</th></tr>`;
    table.innerHTML =
      head +
      `<tr><td colspan="6" style="text-align:center;opacity:.6">${t('board.loading')}</td></tr>`;
    hint.textContent = '';
    try {
      const all = await this.cloud.fetchLeaderboard(this.boardTrack, 20);
      if (!all.length) {
        table.innerHTML =
          head +
          `<tr><td colspan="6" style="text-align:center;opacity:.6">${t('board.empty')}</td></tr>`;
        return;
      }
      // 每位玩家只显示最快的一圈：查询已按圈速升序，取每人首次出现即可
      // （否则同一玩家跑多次会让榜单挤满同一名字，看起来像重复数据）
      const seen = new Set();
      const rows = all.filter((r) => {
        const key = r.owner_id || r.player_name || '';
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const modeName = {
        solo: t('board.modeSolo'),
        split: t('board.modeSplit'),
        online: t('board.modeOnline'),
      };
      table.innerHTML = head +
        rows.map((r, i) => {
          const mine = this.cloud.signedIn && r.owner_id === this.cloud.user.id;
          const pos = i === 0 ? '<span class="p1">1</span>' : i + 1;
          return `<tr${mine ? ' class="me"' : ''}>
            <td class="pos">${pos}</td>
            <td>${escapeHtml(r.player_name || t('board.driver'))}${mine ? ` <small>${t('board.youTag')}</small>` : ''}</td>
            <td>${fmtTime(r.lap_ms)}</td>
            <td>${Math.round(r.top_kmh || 0)} km/h</td>
            <td>${(r.drift_score || 0).toLocaleString()}</td>
            <td>${modeName[r.mode] || r.mode}</td>
          </tr>`;
        }).join('');
      hint.textContent = this.cloud.signedIn ? t('board.hintOn') : t('board.hintOff');
    } catch (e) {
      table.innerHTML =
        head +
        `<tr><td colspan="6" style="text-align:center;opacity:.6">${t('board.fail')}</td></tr>`;
      hint.textContent = t('board.loadFail', e.message || e);
    }
  }
}

/** 玩家名来自输入框，渲染前统一转义，避免写入 HTML */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
