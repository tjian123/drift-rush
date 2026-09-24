/**
 * 循线自动驾驶（验收脚本共用的测试驱动）
 *
 * 原先 verify.mjs 与 verify-signup.mjs 各有一份近似实现，容易在修复时只改一边：
 * 这里统一为一份，供所有端到端脚本 import。
 *
 * 设计要点：
 * - 用 __DR_API__.trackPoint 取前瞻点算角度误差，再按键（真实 keydown/keyup，不碰内部状态）；
 * - **定期重发按住状态的 keydown**：真实键盘按住时会自动重复，测试里必须显式模拟。
 *   否则游戏在「不可操控阶段」（倒计时）清空输入时，单次 keydown 会被静默吃掉，
 *   表现为车永远 0 km/h —— 曾把一次验收带偏成误判；
 * - 长时间低速视为卡住，自动按 R 复位，保证长测试不挂在墙角。
 */

/**
 * @param page  CDP 页面对象（需提供 eval / key）
 * @param player 本地玩家序号：1 = WASD+Space，2 = 方向键+ShiftRight
 * @param opts.lane 循线的横向偏移（米）：让两台自动驾驶走不同车道
 */
export async function makeDriver(page, player = 1, opts = {}) {
  const codes = player === 2
    ? { gas: ['ArrowUp', 'ArrowUp', 38], left: ['ArrowLeft', 'ArrowLeft', 37], right: ['ArrowRight', 'ArrowRight', 39] }
    : { gas: ['KeyW', 'w', 87], left: ['KeyA', 'a', 65], right: ['KeyD', 'd', 68] };
  const lane = opts.lane || 0;
  const held = { left: false, right: false, gas: false };
  let tick = 0;

  const set = async (name, spec, want, force = false) => {
    if (!force && held[name] === want) return;
    held[name] = want;
    await page.key(spec[0], spec[1], spec[2], want);
  };

  const stat = { maxKmh: 0, maxOff: 0, driftFrames: 0, samples: 0, stuck: 0, resets: 0 };

  return {
    stat,
    async release() {
      await set('left', codes.left, false);
      await set('right', codes.right, false);
      await set('gas', codes.gas, false);
    },
    async step() {
      const st = await page.eval(`(() => {
        const s = window.__DR__;
        const me = s.locals[${player - 1}];
        if (!me) return null;
        const lookN = 10 + Math.floor(me.kmh / 16);
        const p = window.__DR_API__.trackPoint(me.idx + lookN, ${lane});
        let diff = Math.atan2(p[0] - me.x, p[1] - me.z) - me.heading;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        return {
          diff, kmh: me.kmh, off: s.offroad, drift: s.drifting,
          lap: me.lap, fin: me.finished, idx: me.idx,
          phase: s.phase, t: me.totalTime || 0,
        };
      })()`);
      if (!st) return null;

      stat.maxKmh = Math.max(stat.maxKmh, st.kmh);
      stat.maxOff = Math.max(stat.maxOff, st.off);
      if (st.drift) stat.driftFrames++;
      stat.samples++;
      if (st.kmh < 6) stat.stuck++; else stat.stuck = 0;
      if (stat.stuck > 12) {
        await page.key('KeyR', 'r', 82, true);
        await page.key('KeyR', 'r', 82, false);
        stat.stuck = 0;
      }

      tick++;
      // 每 ~6 步重发一次按住状态，模拟键盘自动重复。
      // 间隔不能太长：机器负载高时 eval 往返变慢，控制回路采样变稀，
      // 若死区又宽，车会在两次修正之间冲向护墙 —— A8 曾因此偶发失败。
      const refresh = tick % 6 === 0;
      await set('gas', codes.gas, true, refresh);
      await set('left', codes.left, st.diff > 0.05, refresh);
      await set('right', codes.right, st.diff < -0.05, refresh);
      return st;
    },
  };
}
