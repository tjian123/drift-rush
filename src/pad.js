/* ===========================================================================
 * pad.js — 游戏手柄输入（HTML5 Gamepad API）
 *
 * 设计要点：
 *   1) 不依赖 gamepadconnected —— 浏览器要求用户先按键才会触发该事件，
 *      改为每帧轮询 navigator.getGamepads()，这是唯一可靠的检测方式。
 *   2) 与厂商协议无关：盖世小鸡「启明星 2」切到 XInput / 安卓 / PC 模式后，
 *      浏览器统一暴露标准 Xbox 布局（左摇杆 axes[0]/[1]、扳机 buttons[6]/[7]）。
 *      本模块只认标准映射，不需要厂商 SDK。
 *   3) 输入优先级：键盘 > 手柄 > 触屏。键盘有键按住时手柄整轮让位。
 *   4) 只驱动 P1（game.locals[0]）；分屏 P2 仍走键盘 / 触屏。
 *
 * 键位映射（标准 Xbox 布局）：
 *   左摇杆 X        → 转向（模拟量，右推 = 右转 = D 键）
 *   RT buttons[7]   → 油门（模拟扳机，> 死区即触发）
 *   LT buttons[6]   → 刹车 / 倒车（刹车优先于油门）
 *   A  buttons[0]   → 手刹（漂移）
 *   X  buttons[2]   → 使用道具（边沿触发）
 *   Y  buttons[3]   → 切换视角（边沿触发）
 *   Start buttons[9]→ 暂停 / 继续（边沿触发）
 *   Back buttons[8] → 复位到赛道（边沿触发）
 * =========================================================================*/

const STEER_DZ = 0.14; // 摇杆转向死区
const GAS_DZ = 0.18; // 扳机油门死区（部分手柄扳机有零点漂移）

/** 把冗长的 Gamepad.id 缩成友好名 */
function shortName(id) {
  const s = String(id || "").toLowerCase();
  if (s.includes("gamesir")) return "盖世小鸡手柄";
  if (s.includes("xbox")) return "Xbox 手柄";
  if (s.includes("dualsense")) return "DualSense 手柄";
  if (s.includes("dualshock") || s.includes("ps4") || s.includes("ps5"))
    return "PlayStation 手柄";
  if (s.includes("pro controller") || s.includes("switch"))
    return "Switch Pro 手柄";
  return "游戏手柄";
}

/** 死区 + 响应曲线：小角度更细腻，大角度打满（smoothstep） */
function curve(v, dz) {
  const a = Math.abs(v);
  if (a < dz) return 0;
  const n = (a - dz) / (1 - dz);
  return Math.sign(v) * n * n * (3 - 2 * n);
}

export function createPadController(cb) {
  const state = {
    active: false, // 是否已识别到连接中的手柄
    index: -1,
    id: "",
    steer: 0, // -1..1（左摇杆 X，右推 = 正）
    gas: false, // RT
    brake: false, // LT
    handbrake: false, // A
    // 边沿检测：按钮按下瞬间只触发一次
    _prevUse: false, // X
    _prevStart: false, // Start
    _prevCam: false, // Y
    _prevReset: false, // Back
  };

  function poll() {
    if (!navigator.getGamepads) return;
    const pads = navigator.getGamepads();
    let gp = null;
    // 优先沿用上一次的 index，其次找第一个已连接的手柄。
    // 同时校验 connected：真实浏览器拔线后数组位变 null，但个别 UA / mock
    // 可能返回 connected=false 的对象，仅判非空会误判为仍在连接。
    if (state.index >= 0 && pads[state.index] && pads[state.index].connected)
      gp = pads[state.index];
    else {
      for (let i = 0; i < pads.length; i++) {
        if (pads[i] && pads[i].connected) {
          gp = pads[i];
          break;
        }
      }
    }

    if (!gp) {
      // 拔线：复位并通知上层清空输入，避免残留油门让车自己跑
      if (state.active) {
        state.active = false;
        state.index = -1;
        state.id = "";
        state.steer = 0;
        state.gas = state.brake = state.handbrake = false;
        if (cb.onDeactivate) cb.onDeactivate();
      }
      return;
    }

    const firstSeen = !state.active;
    state.active = true;
    state.index = gp.index;
    state.id = gp.id || "";

    // 左摇杆 X → 转向。右推 = +1，对齐 D 键（D → steer=-1），故取负。
    const ax = gp.axes && gp.axes.length ? gp.axes[0] : 0;
    state.steer = -curve(ax, STEER_DZ);

    const btn = (i) =>
      (gp.buttons && gp.buttons[i]) || { pressed: false, value: 0 };
    const rt = btn(7).value; // RT 油门
    const lt = btn(6).value; // LT 刹车
    const brakeFirst = lt > GAS_DZ; // 刹车优先：同时踩两端时优先刹车/倒车
    state.brake = brakeFirst;
    state.gas = !brakeFirst && rt > GAS_DZ;
    state.handbrake = btn(0).pressed;

    // ---- 边沿触发 ----
    const use = btn(2).pressed;
    if (use && !state._prevUse && cb.onUseItem) cb.onUseItem();
    state._prevUse = use;

    const start = btn(9).pressed;
    if (start && !state._prevStart && cb.onPause) cb.onPause();
    state._prevStart = start;

    const cam = btn(3).pressed;
    if (cam && !state._prevCam && cb.onCamera) cb.onCamera();
    state._prevCam = cam;

    const reset = btn(8).pressed;
    if (reset && !state._prevReset && cb.onReset) cb.onReset();
    state._prevReset = reset;

    if (firstSeen && cb.onActivate) cb.onActivate(state.id);
  }

  /** 把当前手柄状态写入受控车。键盘有键按住时整轮让位（返回 false）。 */
  function apply(racer, kb) {
    if (!racer || !state.active) return false;
    const kbActive =
      !!kb && (kb.gas || kb.brake || kb.left || kb.right || kb.handbrake);
    if (kbActive) {
      // 键盘接管：键盘只写 left/right 开关量、不写 steer，这里必须把
      // 手柄上一帧写入的模拟转向归零，否则会残留叠加到键盘转向里。
      racer.input.steer = 0;
      return false;
    }
    racer.input.gas = state.gas;
    racer.input.brake = state.brake;
    racer.input.handbrake = state.handbrake;
    racer.input.steer = state.steer;
    racer.input.left = false;
    racer.input.right = false;
    return true;
  }

  return {
    poll,
    apply,
    get active() {
      return state.active;
    },
    get id() {
      return state.id;
    },
    get name() {
      return shortName(state.id);
    },
  };
}
