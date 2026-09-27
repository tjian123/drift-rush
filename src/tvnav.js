/* ===========================================================================
 * src/tvnav.js — 手柄 / 电视遥控器的菜单导航（焦点系统）
 *
 * 【为什么非做不可】
 * 用户选的是「电视上用手柄玩」。手柄在**比赛里**早就通了（src/pad.js 直接写
 * racer.input），但**菜单**全是按钮 —— 手柄没有任何可聚焦目标，接上电视就成了
 * 「能开车、但开不了局」：必须有人用鼠标点「开始比赛」。所以这里补一套焦点系统。
 *
 * 【电视遥控器 = 键盘方向键】
 * 大部分智能电视的浏览器把遥控器的上下左右映射成 ArrowUp/Down/Left/Right、
 * OK 映射成 Enter、返回映射成 Escape 或 Backspace。所以键盘方向键走的是同一套
 * 导航逻辑（本模块里 keydown 与 gamepad 汇成同一组动作），一条代码同时支持
 * 「真手柄」和「电视遥控器」，不需要为遥控器单独分支。
 *
 * 【导航为什么用空间最近而不是 DOM 顺序】
 * 菜单是 flex/grid 混排（赛道卡横排 + 赛制竖排 + 步骤条），DOM 顺序和视觉顺序
 * 不一致：按 DOM 顺序「下」会从赛道卡跳到右上角「账号」按钮。所以按屏幕坐标
 * 找该方向上最近的元素，纵横向权重不同（横向错位惩罚更重）。
 *
 * 【不接管什么】
 * 比赛中不运行（screen 全隐藏），驾驶输入仍然归 pad.js；暂停界面里 Start 也
 * 留给 pad.js 做「继续」，本模块只用 B 返回 —— 避免一次按键被两处各解释一遍。
 * =========================================================================*/

const REPEAT_DELAY = 380; // 按住多久开始连发（ms）
const REPEAT_RATE = 120; // 连发间隔（ms）
const STICK_DZ = 0.55; // 摇杆当作方向键用的死区（比驾驶死区大得多，否则误触）

/** 可聚焦控件：按钮 / 角色开关 / 涂装色块 / 赛道卡 / 步骤圆点。
    刻意不含 input[type=text]：遥控器上没法打字，聚焦它只会出现一个进得去、
    出不来（A 键无效、方向键被吃掉）的死角。名字用默认值，联机建房不受影响。 */
// Include the name input so TV/gamepad users can update their player name via a prompt.
const FOCUS_SEL =
  'button:not([disabled]), [role="switch"], .paint, .trackcard, .stp, input#name-input';

const DIRS = ["up", "down", "left", "right"];

/* 标准映射（XInput / Xbox 布局）：十字键在 buttons[12..15] */
const BTN = { A: 0, B: 1, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };

const center = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

/** 该方向上最近的元素：主距离 + 2.2×横向错位。找不到就返回 -1（保持原位）。 */
function pick(dir, items, i) {
  const c = center(items[i].rect);
  let best = -1;
  let bestScore = Infinity;
  for (let k = 0; k < items.length; k++) {
    if (k === i) continue;
    const p = center(items[k].rect);
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    let primary = 0;
    let cross = 0;
    if (dir === "left") {
      if (dx >= -2) continue;
      primary = -dx;
      cross = Math.abs(dy);
    } else if (dir === "right") {
      if (dx <= 2) continue;
      primary = dx;
      cross = Math.abs(dy);
    } else if (dir === "up") {
      if (dy >= -2) continue;
      primary = -dy;
      cross = Math.abs(dx);
    } else {
      if (dy <= 2) continue;
      primary = dy;
      cross = Math.abs(dx);
    }
    const score = primary + cross * 2.2;
    if (score < bestScore) {
      bestScore = score;
      best = k;
    }
  }
  return best;
}

/**
 * @param {object} opts
 * @param {{activeScreen: () => ({id:string, el:HTMLElement}|null), toast: Function}} opts.ui
 */
export function createTVNav(opts = {}) {
  const ui = opts.ui;
  const root = document.documentElement;

  const st = {
    screen: null, // 当前导航所在的屏 id
    items: [], // 该屏内的可聚焦控件
    index: -1, // 当前焦点在 items 里的下标
    padSeen: false,
    raf: 0,
    // 连发控制：记录「方向 / 动作」上次触发时间与按钮上一帧状态
    lastDir: null,
    lastDirAt: 0,
    prev: {},
  };

  /* ---------------- 当前屏内的可聚焦控件 ---------------- */
  function collect() {
    const s = ui.activeScreen();
    if (!s) {
      clearFocus();
      st.screen = null;
      st.items = [];
      st.index = -1;
      return null;
    }
    if (s.id !== st.screen) {
      // 换屏（含「回菜单」）时焦点必须重置：上一屏的焦点 DOM 可能已被重建
      clearFocus();
      st.screen = s.id;
      st.index = -1;
    }
    const nodes = s.el.querySelectorAll(FOCUS_SEL);
    const items = [];
    for (const el of nodes) {
      // 三道可见性过滤：display:none（rect 为 0）、祖先带 .hide、视觉隐藏。
      // 分步菜单里另外两步是 .hide，不过滤就会聚焦到看不见的按钮上。
      if (el.closest(".hide")) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      items.push({ el, rect: r });
    }
    st.items = items;
    if (st.index >= items.length) st.index = -1;
    // 焦点元素被重建（如 setMenuStep 重渲步骤条）后，按原 DOM 节点找回下标
    if (st.index >= 0 && st.focusedEl && items[st.index].el !== st.focusedEl) {
      const k = items.findIndex((x) => x.el === st.focusedEl);
      st.index = k >= 0 ? k : -1;
    }
    return s.id;
  }

  function paintFocus() {
    clearFocus();
    const it = st.items[st.index];
    if (!it) return;
    st.focusedEl = it.el;
    it.el.classList.add("navfocus");
    try {
      it.el.scrollIntoView({ block: "nearest", inline: "nearest" });
    } catch (e) {
      /* 老电视浏览器可能不认对象参数，忽略即可（焦点框本身仍然正确） */
    }
  }

  function clearFocus() {
    if (st.focusedEl) st.focusedEl.classList.remove("navfocus");
    const old = document.querySelector(".navfocus");
    if (old && old !== st.focusedEl) old.classList.remove("navfocus");
    st.focusedEl = null;
  }

  /** 没有焦点时的默认项：优先「已选中的赛道卡」→ 已选中的非按钮项 → 已选中项 → 第一个。
      为什么把 .btn 排在后面：菜单右上角那排入口按钮里有带 .on 的（如电视模式开关），
      按 DOM 顺序它排在最前，一接手柄焦点就落在右上角，玩家得一路按回来。 */
  function defaultIndex() {
    const card = st.items.findIndex(
      (x) =>
        x.el.classList.contains("trackcard") && x.el.classList.contains("on"),
    );
    if (card >= 0) return card;
    const seg = st.items.findIndex(
      (x) => x.el.classList.contains("on") && !x.el.classList.contains("btn"),
    );
    if (seg >= 0) return seg;
    const any = st.items.findIndex((x) => x.el.classList.contains("on"));
    return any >= 0 ? any : 0;
  }

  function ensureFocus() {
    if (!st.items.length) return false;
    if (st.index < 0) st.index = defaultIndex();
    paintFocus();
    return true;
  }

  /* ---------------- 动作 ---------------- */
  function move(dir) {
    if (!st.items.length) return false;
    if (st.index < 0) {
      ensureFocus();
      return true;
    }
    const k = pick(dir, st.items, st.index);
    if (k < 0) return false; // 该方向没有东西：停在原地，不绕圈
    st.index = k;
    paintFocus();
    return true;
  }

  function activate() {
    const it = st.items[st.index];
    if (!it) return false;
    // If focused element is a text input (name input), open a prompt to allow
    // TV / gamepad users to enter text (avoids getting stuck in an unfocusable
    // input on non-keyboard devices). Otherwise trigger a normal click.
    try {
      const el = it.el;
      if (el && el.tagName && el.tagName.toLowerCase() === "input") {
        // Use prompt() as a simple on-screen keyboard fallback.
        const cur = el.value || "";
        const v = prompt("输入车手名字：", cur);
        if (v !== null) {
          el.value = String(v).slice(0, el.maxLength || 32);
          // Dispatch input event so existing listeners (HUD) react and persist.
          const ev = new Event("input", { bubbles: true });
          el.dispatchEvent(ev);
        }
        return true;
      }
    } catch (e) {
      /* ignore prompt failures */
    }
    it.el.click();
    return true;
  }

  /** B / 返回：各屏的「上一步」按钮；菜单里则是退回上一步骤 */
  function back() {
    const id = st.screen;
    if (id === "menu") {
      // 步骤面板里退一步；已经是第 1 步就不动（没有可返回的上一层）
      if (ui.menuStep > 0) {
        ui.setMenuStep(ui.menuStep - 1);
        return true;
      }
      return false;
    }
    const map = {
      lobby: "btn-lobby-back",
      pause: "btn-resume",
      result: "btn-back-menu",
      account: "btn-acc-back",
      board: "btn-board-back",
    };
    const b = document.getElementById(map[id] || "");
    if (b && !b.closest(".hide")) {
      b.click();
      return true;
    }
    return false;
  }

  /** Start / 主按钮：推进流程（菜单下一步 → 最后一步直接开赛） */
  function advance() {
    const id = st.screen;
    if (id === "menu") {
      ui.menuAdvance();
      return true;
    }
    const map = {
      lobby: "btn-race-start",
      result: "btn-again",
      pause: "btn-resume",
    };
    const b = document.getElementById(map[id] || "");
    if (b && !b.closest(".hide")) {
      b.click();
      return true;
    }
    return false;
  }

  /* ---------------- 手柄轮询 ---------------- */
  function gamepad() {
    if (!navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    for (let i = 0; i < pads.length; i++) {
      const g = pads[i];
      if (g && g.connected) return g;
    }
    return null;
  }

  function edge(name, pressed) {
    const was = !!st.prev[name];
    st.prev[name] = pressed;
    return pressed && !was;
  }

  function tick() {
    st.raf = requestAnimationFrame(tick);
    const screen = collect();
    const g = gamepad();
    if (g && !st.padSeen) {
      st.padSeen = true;
      root.classList.add("padnav"); // 让焦点框常驻可见（电视上更醒目）
      if (opts.onPadSeen) opts.onPadSeen();
    }
    if (!screen) return; // 比赛中：不抢输入

    /* 手柄一连上就把焦点亮出来：没有鼠标，玩家必须能看到「现在选中了谁」，
       否则接上手柄后菜单看着还是完全没有响应。 */
    if (g && st.items.length && st.index < 0) ensureFocus();

    /* --- 方向：十字键 + 左摇杆，带连发 --- */
    let dir = null;
    const b = (i) =>
      (g && g.buttons && g.buttons[i]) || { pressed: false, value: 0 };
    if (g) {
      if (b(BTN.UP).pressed) dir = "up";
      else if (b(BTN.DOWN).pressed) dir = "down";
      else if (b(BTN.LEFT).pressed) dir = "left";
      else if (b(BTN.RIGHT).pressed) dir = "right";
      else {
        const ax = g.axes && g.axes.length ? g.axes[0] : 0;
        const ay = g.axes && g.axes.length > 1 ? g.axes[1] : 0;
        if (ay < -STICK_DZ) dir = "up";
        else if (ay > STICK_DZ) dir = "down";
        else if (ax < -STICK_DZ) dir = "left";
        else if (ax > STICK_DZ) dir = "right";
      }
    }
    const now = performance.now();
    if (dir) {
      if (dir !== st.lastDir) {
        st.lastDir = dir;
        st.lastDirAt = now;
        move(dir);
      } else if (now - st.lastDirAt > REPEAT_DELAY) {
        // 连发：到点后按固定间隔重复，避免摇杆一推扫过整排
        if (now - st.lastDirAt - REPEAT_DELAY > REPEAT_RATE) {
          st.lastDirAt = now - REPEAT_DELAY;
          move(dir);
        }
      }
    } else {
      st.lastDir = null;
    }

    if (!g) return;
    if (edge("A", b(BTN.A).pressed)) activate();
    if (edge("B", b(BTN.B).pressed)) back();
    if (edge("START", b(BTN.START).pressed)) advance();
  }

  /* ---------------- 键盘（= 电视遥控器） ---------------- */
  const KEYDIR = {
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
  };
  function onKey(e) {
    if (e.repeat) return; // 长按不该连发确认键（回车的默认重复会连跳好几步）
    const t = e.target;
    // 正在输入框里打字时不抢方向键（联机房间码、车手名）
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    const dir = KEYDIR[e.key];
    if (dir) {
      if (!ui.activeScreen()) return; // 比赛中方向键另有用途
      if (!st.items.length) collect();
      if (move(dir)) e.preventDefault();
      return;
    }
    if (e.key === "Enter") {
      if (!ui.activeScreen()) return;
      if (activate()) e.preventDefault();
      return;
    }
    if (e.key === "Escape" || e.key === "Backspace") {
      if (!ui.activeScreen()) return;
      if (back()) e.preventDefault();
    }
  }
  addEventListener("keydown", onKey);
  // 鼠标一动就撤掉焦点框：同一台机器上键鼠与手柄混用时，不该留一个假焦点
  addEventListener(
    "pointermove",
    () => {
      if (st.index >= 0) {
        clearFocus();
        st.index = -1;
      }
    },
    { passive: true },
  );

  st.raf = requestAnimationFrame(tick);

  return {
    /** 供验收脚本直接驱动（不依赖真实手柄） */
    move,
    activate,
    back,
    advance,
    focus() {
      collect();
      ensureFocus();
      return st.focusedEl;
    },
    /** 当前有没有焦点（app.js 的回车快捷键靠它避免一次回车被处理两遍） */
    hasFocus() {
      return st.index >= 0 && !!st.focusedEl && !!st.focusedEl.isConnected;
    },
    state() {
      return {
        screen: st.screen,
        count: st.items.length,
        index: st.index,
        focus: st.focusedEl
          ? st.focusedEl.id || st.focusedEl.className || st.focusedEl.tagName
          : null,
        pad: !!gamepad(),
        padSeen: st.padSeen,
      };
    },
    stop() {
      cancelAnimationFrame(st.raf);
      removeEventListener("keydown", onKey);
    },
  };
}
