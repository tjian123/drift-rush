/* ===========================================================================
 * ai.js — 竞速 AI 车手
 *
 * 不是"看着前车屁股走"，而是一套正经的走线 AI：
 *   1. 由赛道曲率半径算每条采样点上的过弯速度上限 vmax = √(a_lat · R)
 *   2. 从后往前做刹车点传播 v[i] = min(v[i], √(v[i+1]² + 2·a_brake·ds))
 *      ⇒ AI 会提前刹车，而不是进弯才发现要减速
 *   3. 前瞻点取在「竞速线」上（弯道内侧偏移，已平滑）
 *   4. 前瞻距离随车速增长（低速看得近、高速看得远）
 *   5. 邻车避让 + 性格差异 + 橡皮筋 + 偶发失误
 *
 * 速度剖面按 (赛道, 侧向加速度) 缓存，5 台 AI 共用一份，零重复计算。
 * =========================================================================*/

import { CFG, AI_LEVELS } from './config.js';
import { clamp, wrapAngle, makeRng, damp } from './util.js';

const profileCache = new Map();

function getProfile(track, latAccel) {
  const key = `${track.id}:${latAccel}`;
  let p = profileCache.get(key);
  if (!p) {
    p = track.speedProfile(latAccel, CFG.MAX_SPEED, 30);
    profileCache.set(key, p);
  }
  return p;
}

/**
 * 创建一个 AI 车手。
 * @param track 赛道对象
 * @param levelId 'easy' | 'normal' | 'hard'
 * @param seed    决定性格差异
 */
export function createAIDriver(track, levelId, seed) {
  const level = AI_LEVELS[levelId] || AI_LEVELS.normal;
  const rng = makeRng(1000 + seed * 7919);
  const profile = getProfile(track, level.latAccel);

  const style = {
    // 走线偏好：略微偏内 / 偏外，形成可辨识的"性格"
    laneBias: (rng() * 2 - 1) * 1.5,
    // 极速个体差异
    speedMul: level.speedMul * (0.975 + rng() * 0.05),
    // 转向平滑度：越大越稳
    steerGain: 1.5 + rng() * 0.9,
    // 前瞻系数差异
    lookK: 0.38 + rng() * 0.18,
    // 刹车保守度：>1 更早刹车
    brakeMargin: 0.94 + rng() * 0.12,
  };

  let mistakeTimer = 0;      // > 0 表示正在失误
  let mistakeCd = 2 + rng() * 6;
  let jitter = 0;

  return {
    level: levelId,
    style,

    /**
     * 每个物理步调用，写入 racer.input。
     * @param ctx { racers, humanLeaderDistance }
     */
    update(racer, dt, ctx) {
      const n = track.n;
      const speed = Math.max(0, racer.vF);
      const idx = racer.idx;

      /* ---------- 1. 失误计时（模拟人类手抖 / 松油门） ---------- */
      mistakeCd -= dt;
      if (mistakeTimer > 0) {
        mistakeTimer -= dt;
        jitter = damp(jitter, (rng() * 2 - 1) * 0.55, 6, dt);
      } else {
        jitter = damp(jitter, 0, 4, dt);
        if (mistakeCd <= 0 && rng() < level.mistakeRate * dt * 60) {
          mistakeTimer = 0.35 + rng() * 0.55;
          mistakeCd = 4 + rng() * 9;
        }
      }

      /* ---------- 2. 前瞻点：距离随速度增长 ---------- */
      const lookDist = 13 + speed * style.lookK;
      const la = Math.max(3, Math.round(lookDist / track.step));
      const tIdx = (idx + la) % n;

      // 竞速线 + 性格偏移（左右都不越出路面）
      let lane = track.laneOff[tIdx] + style.laneBias;
      lane = clamp(lane, -(CFG.HALF_W - 1.6), CFG.HALF_W - 1.6);

      /* ---------- 3. 邻车避让：前方同向车辆 → 侧向让开 + 收油 ---------- */
      let yieldMul = 1;
      if (ctx && ctx.racers) {
        const sh = Math.sin(racer.heading), ch = Math.cos(racer.heading);
        for (const o of ctx.racers) {
          if (o === racer) continue;
          const dx = o.x - racer.x, dz = o.z - racer.z;
          const fwd = dx * sh + dz * ch;                 // 前方距离
          const side = dx * ch - dz * sh;                // 侧向距离
          if (fwd < 1 || fwd > 16) continue;
          if (Math.abs(side) > 4.5) continue;
          // 躲到对方外侧
          lane += (side >= 0 ? -1 : 1) * (4.0 - Math.abs(side)) * 0.9;
          if (Math.abs(side) < 2.4) {
            yieldMul = Math.min(yieldMul, 0.45 + fwd / 34);  // 贴太近就收油
          }
        }
        lane = clamp(lane, -(CFG.HALF_W - 1.4), CFG.HALF_W - 1.4);
      }

      /* ---------- 4. 转向：角度误差 + 微分阻尼 ---------- */
      const tx = track.cx[tIdx] + track.sx[tIdx] * lane;
      const tz = track.cz[tIdx] + track.sz[tIdx] * lane;
      const want = Math.atan2(tx - racer.x, tz - racer.z);
      const diff = wrapAngle(want - racer.heading);

      // 车头方向与赛道切线的夹角（用于判断是否在漂移过大）
      const tangent = Math.atan2(track.tx[idx], track.tz[idx]);
      const vsTrack = wrapAngle(racer.heading - tangent);

      let steerCmd = clamp(diff * style.steerGain - racer.yawRate * 0.42, -1, 1);
      steerCmd += jitter;
      racer.input.left = steerCmd > 0.08;
      racer.input.right = steerCmd < -0.08;

      /* ---------- 5. 速度目标：取前方一段距离内的最低限速 ---------- */
      const brakeAhead = Math.max(2, Math.round((6 + speed * 0.55) / track.step));
      let desired = Infinity;
      for (let k = 0; k <= brakeAhead; k += 2) {
        const j = (idx + k) % n;
        const v = profile[j];
        if (v < desired) desired = v;
      }
      // 本车极速 + 橡皮筋
      let topMul = style.speedMul;
      if (level.rubber > 0 && ctx && isFinite(ctx.gapToHuman)) {
        // gapToHuman > 0 表示 AI 落后，给一点点提速；领先则收一点。
        // 上限 ±6%，避免出现"作弊感"明显的瞬移式追赶。
        const gap = clamp(ctx.gapToHuman / 90, -1, 1);
        topMul *= 1 + level.rubber * gap * 0.06;
        topMul = clamp(topMul, style.speedMul * 0.94, style.speedMul * 1.06);
      }
      const topSpeed = CFG.MAX_SPEED * topMul;
      desired = Math.min(desired * style.brakeMargin, topSpeed) * yieldMul;

      /* ---------- 6. 油门 / 刹车 / 手刹 ---------- */
      const vNow = racer.vF;
      if (vNow < desired * 0.985) {
        racer.input.gas = true;
        racer.input.brake = false;
      } else if (vNow > desired * 1.045) {
        racer.input.gas = false;
        racer.input.brake = true;
      } else {
        racer.input.gas = true;      // 巡航时保持油门，靠阻力平衡
        racer.input.brake = false;
      }
      if (mistakeTimer > 0) {
        // 失误表现：短暂松油门（但不会把车刹停）
        racer.input.gas = false;
      }

      // 大角度 + 高速 → 拉手刹甩尾过弯（让 AI 也敢漂移）
      const wantDrift = Math.abs(vsTrack) > 0.42 && speed > 22 && Math.abs(diff) < 1.5
        && Math.abs(steerCmd) > 0.3;
      racer.input.handbrake = wantDrift;
    },
  };
}

/** 距离起点的累计里程（用于排名与橡皮筋） */
export function racerDistance(track, racer) {
  return (racer.lap - 1) * track.total + racer.idx * track.step;
}
