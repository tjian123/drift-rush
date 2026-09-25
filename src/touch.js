/* ===========================================================================
 * touch.js — 移动端触屏操控
 *
 * 设计参考主流移动端竞速游戏（狂野飙车 / 极品飞车 / Real Racing）的共识做法：
 *
 *   1) 左半屏是「转向区」，不是两个左右箭头按钮。
 *      在圈内按住并拖动 = 方向盘的模拟量输入：拖动距离映射成 -1..1 的
 *      转向量，而不是「按下 = 打死方向」。这样高速微调走线才可能做到。
 *      按在圈外也会把圈吸附到手指位置（浮动方向盘），不用去够固定位置。
 *
 *   2) 右半屏是踏板簇：油门 / 刹车 / 手刹，排布成拇指自然落点，
 *      手指从油门滑到刹车也算数（滑动切换），不必反复抬起。
 *
 *   3) 「自动油门」：只控制方向的玩家不必一直按着油门 —— 这是手游玩家的
 *      默认预期，也是单手可玩的前提。
 *
 *   4) 多点触控：转向与油门必须是两根手指同时生效的独立通道，
 *      所以全程用 Pointer Events + 按 pointerId 记账，绝不假设单指。
 *
 * 与物理的连接方式：**不直接改 input**，而是每帧由游戏循环调用 apply(racer)，
 * 统一写入。这样「冻结输入」的相位逻辑（倒计时禁止抢跑）与触屏输入不会互相打架。
 * =========================================================================*/

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* 踏板判定：用矩形命中测试而不是给每个按钮挂事件。
 * 好处：一根手指从油门滑到刹车时，状态切换是连续的，而且天然支持多指。 */
const PEDAL_KEYS = ['gas', 'brake', 'handbrake'];

export class TouchControls {
  /**
   * @param opts.target       () => racer|null  获取当前受控车（通常是 game.locals[0]）
   * @param opts.onFirstInput 首次触摸回调（用于解锁 WebAudio）
   * @param opts.onPause      点暂停按钮
   * @param opts.settings     { autoGas, hand, sens, tilt }
   * @param opts.onSettings   设置变化回调（用于持久化）
   */
  constructor(opts = {}) {
    this.target = opts.target || (() => null);
    this.onFirstInput = opts.onFirstInput || (() => { });
    this.onPause = opts.onPause || (() => { });
    this.onSettings = opts.onSettings || (() => { });

    this.settings = Object.assign(
      { autoGas: true, hand: 'right', sens: 1, tilt: false },
      opts.settings || {});

    this.enabled = false;
    this.supported = ('onpointerdown' in window);
    this.isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    this.rotateGate = false;           // 是否允许弹「请横屏」（只在菜单里允许）
    this.steer = 0;                    // -1..1 当前转向量
    this.pedals = { gas: false, brake: false, handbrake: false };
    this.pointerCount = 0;

    this._steerPid = null;             // 正在转向的 pointerId
    this._steerFrom = 0;               // 拖动起点（px，相对圈心）
    this._steerHome = null;            // {x,y} 浮动方向盘中心（null = 用 CSS 默认位）
    this._pedalMap = new Map();        // pointerId -> pedalKey
    this._releaseAt = 0;               // 松手回正动画起点
    this._releaseFrom = 0;
    this._touchesOnce = false;
    this._tilt = { active: false, base: 0, gamma: 0, ok: false };

    this._el = {
      root: document.getElementById('touch'),
      zone: document.getElementById('steer-zone'),
      ring: document.getElementById('steer-ring'),
      knob: document.getElementById('steer-knob'),
      hint: document.getElementById('steer-hint'),
      pedals: {
        gas: document.getElementById('tgas'),
        brake: document.getElementById('tbrake'),
        handbrake: document.getElementById('thand'),
      },
      pause: document.getElementById('tpause'),
      rotate: document.getElementById('rotate-hint'),
    };

    this._bind();
    this._sizeRing();
    this.applySettings(this.settings, false);
  }

  /* ================================================================ 启停 */
  setEnabled(on) {
    on = !!on;
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) this._sizeRing();
    this._el.root.classList.toggle('show', on);
    // HUD 重排（速度表/成就卡给踏板让位、隐藏键盘提示条）挂在 body 类上，
    // 因为这些 HUD 在 DOM 里位于 #touch 之前，兄弟选择器够不着
    document.body.classList.toggle('touch-on', on);
    document.body.classList.toggle('hand-left', this.settings.hand === 'left');
    if (!on) this.releaseAll();
    this._updateRotateHint();
    this._sync();          // 开关状态也要反映到调试快照里，否则外部读到的永远是旧值
  }

  releaseAll() {
    this._steerPid = null;
    this._pedalMap.clear();
    this.pedals.gas = this.pedals.brake = this.pedals.handbrake = false;
    this._setSteer(0, false);
    for (const k of PEDAL_KEYS) this._el.pedals[k].classList.remove('on');
    this.pointerCount = 0;
    this._sync();
  }

  /* ============================================================ 设置项 */
  applySettings(s, persist = true) {
    Object.assign(this.settings, s || {});
    const st = this.settings;
    this._el.root.classList.toggle('auto-gas', !!st.autoGas);
    this._el.root.classList.toggle('hand-left', st.hand === 'left');
    document.body.classList.toggle('hand-left', st.hand === 'left');
    if (st.tilt) this._enableTilt(); else this._disableTilt();
    if (persist) this.onSettings(Object.assign({}, st));
    this._sync();
  }

  /* ============================================== 陀螺仪转向（可选项） */
  async _enableTilt() {
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) { this._tilt.ok = false; this._sync(); return; }
    try {
      // iOS 13+ 必须在用户手势里申请权限；这里由设置开关的点击触发
      if (typeof DOE.requestPermission === 'function') {
        const r = await DOE.requestPermission();
        if (r !== 'granted') { this._tilt.ok = false; this.settings.tilt = false; this._sync(); return; }
      }
      if (!this._tiltHandler) {
        this._tiltHandler = (e) => {
          if (e.gamma == null) return;
          this._tilt.ok = true;
          if (!this._tilt.active) { this._tilt.base = e.gamma; this._tilt.active = true; }
          this._tilt.gamma = e.gamma;
        };
        addEventListener('deviceorientation', this._tiltHandler);
      }
      // 3 秒内没收到数据就认为设备不支持，自动关掉，避免玩家以为坏了
      setTimeout(() => { if (!this._tilt.ok && this.settings.tilt) this.settings.tilt = false; }, 3000);
    } catch (e) { this._tilt.ok = false; this.settings.tilt = false; }
    this._sync();
  }
  _disableTilt() {
    if (this._tiltHandler) removeEventListener('deviceorientation', this._tiltHandler);
    this._tiltHandler = null;
    this._tilt.active = false;
    this._tilt.ok = false;
  }
  calibrateTilt() { this._tilt.active = false; this._tilt.base = this._tilt.gamma || 0; }

  /* ============================================================== 事件 */
  _bind() {
    const root = this._el.root;
    if (!root) return;

    // 统一在 #touch 上收事件（子元素气泡上来），按 pointerId 分派到各自通道。
    // 触摸指针天然带 implicit pointer capture，手指滑出元素后事件仍回到原元素，
    // 所以「从油门滑到刹车」不会丢事件。
    root.addEventListener('pointerdown', (e) => this._onDown(e), { passive: false });
    root.addEventListener('pointermove', (e) => this._onMove(e), { passive: false });
    root.addEventListener('pointerup', (e) => this._onUp(e), { passive: false });
    root.addEventListener('pointercancel', (e) => this._onUp(e), { passive: false });
    root.addEventListener('lostpointercapture', (e) => this._onUp(e));

    // 兜底：切后台 / 失焦 / 转屏时，手指的 up 事件可能永远不来
    addEventListener('blur', () => this.releaseAll());
    addEventListener('orientationchange', () => { this.releaseAll(); this._resetRingHome(); this._sizeRing(); });
    addEventListener('resize', () => { this._resetRingHome(); this._sizeRing(); this._updateRotateHint(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseAll(); });

    if (this._el.pause) {
      this._el.pause.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this.onPause(); });
    }
  }

  _inZone(e, el) {
    const r = el.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  }
  _pedalAt(e) {
    for (const k of PEDAL_KEYS) {
      if (this._inZone(e, this._el.pedals[k])) return k;
    }
    return null;
  }

  /* ------------------------------------------------------------ 按下 */
  _onDown(e) {
    if (!this.enabled) return;
    if (e.target === this._el.pause) return;      // 暂停按钮自己处理
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    this._firstTouch();

    // 踏板优先：踏板区域压在转向区之上，先判踏板
    const key = this._pedalAt(e);
    if (key) {
      this._pedalMap.set(e.pointerId, key);
      this.pointerCount++;
      this.pedals[key] = true;
      this._el.pedals[key].classList.add('on');
      this._buzz(key === 'gas' ? 6 : 10);
      this._sync();
      return;
    }

    if (this._inZone(e, this._el.zone)) {
      if (this._steerPid !== null) return;        // 一根手指管转向就够了
      this._steerPid = e.pointerId;
      this.pointerCount++;
      this._placeRing(e.clientX, e.clientY);
      this._steerFrom = { x: e.clientX, y: e.clientY };
      this._releaseAt = 0;
      this._ringClass(true);
      this._moveRing(e);
      this._sync();
    }
  }

  /* ------------------------------------------------------------ 移动 */
  _onMove(e) {
    if (!this.enabled) return;

    if (this._steerPid === e.pointerId) {
      e.preventDefault();
      this._moveRing(e);
      const dx = e.clientX - this._steerFrom.x;
      this._setSteer(this._steerValue(dx), true);
      this._sync();
      return;
    }

    const key = this._pedalMap.get(e.pointerId);
    if (!key) return;
    e.preventDefault();
    // 滑动切换：手指挪到别的踏板就跟着切，挪出所有踏板则保持原状态
    // （保持而不是清空，是因为手指短暂滑出边缘时不该断油门）
    const next = this._pedalAt(e);
    if (next && next !== key) {
      this._el.pedals[key].classList.remove('on');
      this.pedals[key] = false;
      this._pedalMap.set(e.pointerId, next);
      this.pedals[next] = true;
      this._el.pedals[next].classList.add('on');
      this._buzz(8);
      this._sync();
    }
  }

  /* ------------------------------------------------------------ 抬起 */
  _onUp(e) {
    if (!this.enabled && this._steerPid === null && this._pedalMap.size === 0) return;

    if (this._steerPid === e.pointerId) {
      this._steerPid = null;
      this.pointerCount = Math.max(0, this.pointerCount - 1);
      this._steerFrom = null;
      this._ringClass(false);
      this._backHome();                            // 圈回默认位，丝滑归中
      this._releaseFrom = this.steer;
      this._releaseAt = performance.now();
      this._sync();
      return;
    }

    const key = this._pedalMap.get(e.pointerId);
    if (key) {
      this._pedalMap.delete(e.pointerId);
      this.pointerCount = Math.max(0, this.pointerCount - 1);
      // 同一踏板可能被两根手指按着，只有最后一根松开才真的抬起
      const still = [...this._pedalMap.values()].includes(key);
      if (!still) {
        this.pedals[key] = false;
        this._el.pedals[key].classList.remove('on');
      }
      this._sync();
    }
  }

  /* ====================================================== 转向量换算 */
  _ringR() {
    const v = getComputedStyle(this._el.ring).getPropertyValue('--r');
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : 64;
  }

  /**
   * 拖动位移 → 转向量。
   *   · 死区：手指轻微抖动不该让车头晃（占半径 16%）
   *   · 有效行程：半径的 82% 即打满，不必把手指顶到圈外
   *   · 灵敏度：指数曲线，sens > 1 时小位移就能给出更大的转向量
   *
   * 符号约定（与 car.js 的 input.steer 严格一致）：
   *   · 正值 = 左转，负值 = 右转（car.js 里 digital = left - right，
   *     追尾相机下 heading 增大对应车头左转）
   *   · 所以「手指向右拖 dx>0」必须返回负值 = 右转，故整体取负号。
   */
  _steerValue(dx) {
    const R = this._ringR();
    const dz = R * 0.16;
    const usable = R * 0.82;
    const a = Math.abs(dx);
    if (a <= dz || usable <= dz) return 0;
    const t = clamp((a - dz) / (usable - dz), 0, 1);
    const shaped = Math.pow(t, 1 / clamp(this.settings.sens, 0.4, 3));
    return -Math.sign(dx) * shaped;
  }

  _setSteer(v, fromDrag) {
    this.steer = clamp(v, -1, 1);
    if (fromDrag) this._releaseAt = 0;
  }

  /* ==================================================== 方向盘视觉 */
  /** 半径随视口自适应：小屏够用、平板不至于夸张。--r 由 :root 继承给圈与提示 */
  _sizeRing() {
    const z = this._el.zone;
    if (!z || !this._el.root) return;
    const r = z.getBoundingClientRect();
    const R = Math.round(clamp(Math.min(r.width, r.height) * 0.30, 52, 104));
    this._el.root.style.setProperty('--r', R + 'px');
  }

  _placeRing(px, py) {
    const zr = this._el.zone.getBoundingClientRect();
    const R = this._ringR();
    const ring = this._el.ring.getBoundingClientRect();
    const cx = ring.left + ring.width / 2;
    const cy = ring.top + ring.height / 2;
    const d = Math.hypot(px - cx, py - cy);

    // 按在圈内（或圈附近）就沿用原位；按在别处则把圈吸附过去 ——
    // 既保留固定方向盘的肌肉记忆，又不用玩家去够固定位置
    if (this._steerHome === null && d <= R * 1.3) return;

    const pad = R + 8;
    const x = clamp(px, zr.left + pad, zr.right - pad);
    const y = clamp(py, zr.top + pad, zr.bottom - pad);
    this._steerHome = { x, y };
    const st = this._el.ring.style;
    st.left = x + 'px';
    st.top = y + 'px';
    st.bottom = 'auto';                 // top 与 bottom 同时存在会互相拉扯，必须择一
    this._el.ring.classList.add('floating');
  }

  _moveRing(e) {
    const R = this._ringR();
    let dx = e.clientX - this._steerFrom.x;
    let dy = e.clientY - this._steerFrom.y;
    const d = Math.hypot(dx, dy);
    if (d > R * 0.92) {                       // 旋钮不脱圈
      const k = (R * 0.92) / d;
      dx *= k; dy *= k;
    }
    this._el.knob.style.transform = `translate(${dx.toFixed(1)}px,${dy.toFixed(1)}px)`;
    this._el.ring.classList.toggle('locking', Math.abs(dx) > R * 0.7);
  }

  _ringClass(dragging) {
    this._el.ring.classList.toggle('active', dragging);
    this._el.hint.classList.toggle('hide', dragging);
    if (!dragging) this._el.ring.classList.remove('locking');
  }

  _backHome() {
    const knob = this._el.knob;
    knob.style.transition = 'transform .18s cubic-bezier(.22,1.3,.4,1)';
    knob.style.transform = 'translate(0px,0px)';
    clearTimeout(this._homeTimer);
    this._homeTimer = setTimeout(() => { knob.style.transition = ''; }, 220);
    /* 方向盘停留在按压处而不弹回默认位：
       一轮比赛里拇指落点基本固定，盘子跟着乱跑反而更难瞄。 */
  }

  /** 把浮动方向盘还原到 CSS 默认位置（换局 / 转屏 / 复位时调用） */
  _resetRingHome() {
    this._steerHome = null;
    if (!this._el.ring) return;
    const st = this._el.ring.style;
    st.left = ''; st.top = ''; st.bottom = '';
    this._el.ring.classList.remove('floating');
  }

  resetHome() { this._resetRingHome(); }

  setRotateGate(on) {
    on = !!on;
    if (on === this.rotateGate) return;
    this.rotateGate = on;
    this._updateRotateHint();
  }

  _updateRotateHint() {
    const el = this._el.rotate;
    if (!el) return;
    const portrait = matchMedia('(orientation: portrait)').matches;
    const small = Math.min(innerWidth, innerHeight) < 560;
    // 只在菜单里提示横屏：比赛途中盖一层全屏遮罩只会让人想摔手机
    el.classList.toggle('show', this.rotateGate && this.isTouch && portrait && small);
  }

  _buzz(ms) {
    // 未获得用户激活时调 vibrate 会被浏览器拦掉并往控制台写一条 error。
    // 触觉反馈本来就依赖真实手势，主动跳过比让浏览器报错干净。
    if (!navigator.vibrate) return;
    if (navigator.userActivation && navigator.userActivation.hasBeenActive === false) return;
    try { navigator.vibrate(ms); } catch (e) { /* 忽略 */ }
  }

  _firstTouch() {
    if (this._touchesOnce) return;
    this._touchesOnce = true;
    this.onFirstInput();
  }

  /* ================================================= 每帧写入车辆输入 */
  /**
   * 由物理循环每步调用一次。这里是触屏状态与车辆输入之间**唯一**的写入口，
   * 所以不会出现「某个分支忘了清空输入」这类问题。
   *
   * @param racer 受控车
   * @param kb    键盘的实时按键表（可为 null）。带触摸屏的笔记本上键盘与触屏
   *              可能同时存在：只要键盘有键被按住，就整轮让位给键盘 ——
   *              否则每帧都会被触屏状态覆盖，键盘玩家会发现自己完全开不动车。
   */
  apply(racer, kb) {
    if (!racer || !this.enabled) return;

    /* 松手后的回正：0.14 秒内把转向量线性收回到 0。
       直接归零会让车头猛地回弹，快速度下体感很跳。 */
    if (this._releaseAt) {
      const t = (performance.now() - this._releaseAt) / 140;
      if (t >= 1) { this.steer = 0; this._releaseAt = 0; }
      else this.steer = this._releaseFrom * (1 - t);
    }

    /* 陀螺仪：以开启时刻的姿态为零点，左右倾斜 20° 打满。
       同样取负号，与拖动保持一致的符号约定（右倾 = 负 = 右转）。 */
    let steer = this.steer;
    if (this.settings.tilt && this._tilt.active && this._steerPid === null) {
      const g = this._tilt.gamma - this._tilt.base;
      const dz = 2.0;
      const a = Math.abs(g);
      steer = a <= dz ? 0 : clamp(-Math.sign(g) * (a - dz) / 20, -1, 1) * clamp(this.settings.sens, 0.4, 3);
    }

    /* 松手回正会改 this.steer，而 apply 每帧都跑 —— 顺手刷新调试快照，
       否则外部读到的 steer 会停留在「松手那一刻」的值。 */
    if (this._mirrorSteer !== this.steer) { this._mirrorSteer = this.steer; this._sync(); }

    const kbActive = !!kb && (kb.gas || kb.brake || kb.left || kb.right || kb.handbrake);
    if (kbActive) {
      // 键盘接管：只回写键盘态，转向交给 left/right，模拟量归零避免叠加
      racer.input.gas = !!kb.gas;
      racer.input.brake = !!kb.brake;
      racer.input.handbrake = !!kb.handbrake;
      racer.input.left = !!kb.left;
      racer.input.right = !!kb.right;
      racer.input.steer = 0;
      return;
    }

    const p = this.pedals;
    const auto = !!this.settings.autoGas;
    // 自动油门在踩刹车时让位，否则永远刹不住
    racer.input.gas = auto ? !p.brake : p.gas;
    racer.input.brake = p.brake;
    racer.input.handbrake = p.handbrake;

    /* 只写模拟量，不写 left/right 开关量：
       car.js 里两者相加后再夹紧，若同时置位，小幅转向会被开关量顶到满舵。
       左右手布局只换手的位置，不翻转物理方向（右拖永远是右转）。
       此处的 steer 已是「正值=左转 / 负值=右转」的约定（见 _steerValue 注释）。 */
    racer.input.steer = steer;
    racer.input.left = false;
    racer.input.right = false;
  }

  /* ================================================== 调试/验收用快照 */
  _sync() {
    const el = this._el;
    if (!el.root || !el.ring || !el.knob) { window.__DR_TOUCH__ = null; return null; }
    window.__DR_TOUCH__ = {
      enabled: this.enabled,
      supported: this.supported,
      isTouch: this.isTouch,
      maxTouchPoints: navigator.maxTouchPoints || 0,
      steer: Number(this.steer.toFixed(3)),
      rawSteer: this.steer,
      pedals: Object.assign({}, this.pedals),
      pointers: this.pointerCount,
      steering: this._steerPid !== null,
      autoGas: !!this.settings.autoGas,
      hand: this.settings.hand,
      sens: this.settings.sens,
      tilt: !!this.settings.tilt,
      tiltActive: this._tilt.active,
      tiltOk: this._tilt.ok,
      radius: this._ringR(),
      ring: {
        floating: this._el.ring.classList.contains('floating'),
        active: this._el.ring.classList.contains('active'),
        locking: this._el.ring.classList.contains('locking'),
      },
      knob: this._el.knob.style.transform || 'translate(0px,0px)',
    };
    return window.__DR_TOUCH__;
  }
}
