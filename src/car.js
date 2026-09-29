/* ===========================================================================
 * car.js — 车辆网格 + 街机漂移物理（本地玩家 / AI / 分屏共用同一份物理）
 *
 * 物理模型：把速度分解到车身「前向 vF / 侧向 vL」两个轴，
 *   前向由引擎与阻力驱动，侧向按抓地力指数衰减。
 *   转向让「车头朝向」转得比「速度方向」快 ⇒ 产生侧滑 ⇒ 漂移。
 * 约定：车体局部 +Z 为车头，group.rotation.y = heading 时
 *       世界前向 = (sin h, 0, cos h)
 * =========================================================================*/

import { t } from './i18n.js';
import { CFG } from './config.js';
import { clamp, damp, smoothstep } from './util.js';

export const WHEEL_R = 0.38;
const CAR_HALF_W = 0.96;      // 车身半宽（用于碰撞圆与护墙判定）
const COLLIDE_R = 1.25;       // 单车体的碰撞圆半径

/** 程序化低多边形跑车：无模型文件、无贴图 */
export function buildCarMesh(THREE, paint) {
  const g = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({
    color: paint.body, roughness: 0.36, metalness: 0.55,
  });
  const dark = new THREE.MeshStandardMaterial({ color: 0x16181f, roughness: 0.62, metalness: 0.35 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x0d1420, roughness: 0.10, metalness: 0.85 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xb9c2cc, roughness: 0.28, metalness: 0.95 });

  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    g.add(m);
    return m;
  };

  add(new THREE.BoxGeometry(1.92, 0.52, 4.3), bodyMat, 0, 0.62, 0);           // 底盘
  add(new THREE.BoxGeometry(1.66, 0.30, 1.5), bodyMat, 0, 0.50, 2.35);        // 鼻锥
  add(new THREE.BoxGeometry(1.9, 0.09, 0.5), dark, 0, 0.36, 2.92);            // 前唇
  add(new THREE.BoxGeometry(1.42, 0.46, 1.85), glass, 0, 1.05, -0.18);        // 座舱
  add(new THREE.BoxGeometry(1.30, 0.12, 1.25), bodyMat, 0, 1.30, -0.30);      // 车顶
  for (const s of [1, -1]) {
    add(new THREE.BoxGeometry(0.20, 0.20, 2.7), dark, s * 1.00, 0.40, 0);     // 侧裙
    add(new THREE.BoxGeometry(0.10, 0.42, 0.12), chrome, s * 0.72, 1.03, -1.98); // 尾翼支柱
    add(new THREE.CylinderGeometry(0.11, 0.11, 0.30, 8), chrome, s * 0.44, 0.48, -2.16, Math.PI / 2); // 排气
  }
  add(new THREE.BoxGeometry(1.82, 0.09, 0.52), dark, 0, 1.24, -2.02);         // 尾翼

  // 前大灯（自发光，夜景赛道尤其明显）
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xfff4d8, emissive: 0xffe9b0, emissiveIntensity: 1.5, roughness: 0.3,
  });
  for (const s of [1, -1]) add(new THREE.BoxGeometry(0.46, 0.15, 0.10), headMat, s * 0.60, 0.60, 3.03);

  // 尾灯（刹车时点亮）
  const tailMat = new THREE.MeshStandardMaterial({
    color: 0x5a0d10, emissive: 0xff2222, emissiveIntensity: 0.35, roughness: 0.4,
  });
  for (const s of [1, -1]) add(new THREE.BoxGeometry(0.52, 0.14, 0.08), tailMat, s * 0.58, 0.66, -2.16);

  // 车轮：pivot(转向) → spin(滚动) → mesh(轴向对齐)
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x101216, roughness: 0.88 });
  const rimMat = new THREE.MeshStandardMaterial({ color: paint.rim, roughness: 0.30, metalness: 0.9 });
  const wheels = [];
  for (const [x, z] of [[0.92, 1.42], [-0.92, 1.42], [0.92, -1.44], [-0.92, -1.44]]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, WHEEL_R, z);
    const spin = new THREE.Group();
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.30, 14), tireMat);
    tire.rotation.z = Math.PI / 2;
    tire.castShadow = true;
    const rim = new THREE.Mesh(
      new THREE.CylinderGeometry(WHEEL_R * 0.55, WHEEL_R * 0.55, 0.33, 8), rimMat);
    rim.rotation.z = Math.PI / 2;
    spin.add(tire, rim);
    pivot.add(spin);
    g.add(pivot);
    wheels.push({ pivot, spin, front: z > 0 });
  }

  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return { group: g, wheels, tailMat, headMat, bodyMat, paint };
}

/* ---------------------------------------------------------------------------
 * 赛车对象工厂
 * -------------------------------------------------------------------------*/
export function makeRacer(opts) {
  return {
    id: opts.id,
    name: opts.name || t('lobby.driver'),
    paint: opts.paint ?? 0,
    kind: opts.kind || 'local',       // local | split2 | ai | remote
    slot: opts.slot ?? 0,

    /* 运动状态 */
    x: 0, y: 0, z: 0,
    heading: 0,
    vF: 0, vL: 0, yawRate: 0,
    idx: 0, lateral: 0, offroad: 0,
    shake: 0, airTime: 0,

    /* 输入（local 由键鼠/触屏填，ai 由 ai.js 填）
       steer：-1..1 的模拟转向量（触屏拖动 / 陀螺仪）；键盘走 left/right */
    input: { gas: false, brake: false, left: false, right: false, handbrake: false, steer: 0 },

    /* 比赛进度 */
    lap: 1, prevProgress: 0, progress: 0,
    lapStart: 0, lapTime: 0, lapTimes: [], lastLap: 0, bestLap: 0,
    totalTime: 0, finished: false, finishTime: 0, finishOrder: 0,
    rank: 1, wrongWay: false,

    /* 漂移积分 */
    score: 0, driftPending: 0, driftMult: 1, driftTimer: 0, drifting: false,
    maxSpeedSeen: 0, offroadTime: 0, wallTime: 0, noBrakeLap: true, cleanLap: true,

    /* 道具赛：当前道具 / 抽取滚动 / 氮气 / 护盾 / 打滑（竞速赛恒为空/0） */
    item: null, itemRollT: 0, itemRollFinal: null, itemCd: 0,
    boostT: 0, shieldT: 0, spinT: 0,

    /* 网络 */
    remoteTarget: null, remotePrev: null,

    /* 渲染对象 */
    mesh: null,
    netAlpha: 0,
  };
}

/** 把赛车放到赛道上的指定格位 */
export function placeOnGrid(racer, track, slot) {
  const g = track.gridSlot(slot);
  const i = g.index;
  racer.idx = i;
  racer.x = track.cx[i] + track.sx[i] * g.lateral;
  racer.y = track.cy[i];
  racer.z = track.cz[i] + track.sz[i] * g.lateral;
  racer.heading = Math.atan2(track.tx[i], track.tz[i]);
  racer.vF = 0; racer.vL = 0; racer.yawRate = 0;
  racer.lateral = g.lateral;
  racer.prevProgress = i / track.n;
  racer.progress = i / track.n;
  racer.offroad = 0;
  if (racer.mesh) {
    racer.mesh.position.set(racer.x, racer.y, racer.z);
    racer.mesh.rotation.set(0, racer.heading, 0, 'YXZ');
  }
}

/**
 * 单个物理步。只对「本地玩家 / 分屏玩家 / AI」调用；远端车靠插值。
 * @param ctx { track, onImpact(racer,strength), onWall(racer,strength), fullStep(bool) }
 */
export function stepRacer(racer, dt, ctx) {
  const track = ctx.track;
  const input = racer.input;
  // inputFrozen：倒计时等「不可操控阶段」的闸门（app.js 每步按相位设置）。
  // 未设置时默认可控，因此单独调用 stepRacer 也不会被意外锁住。
  const controllable = !racer.inputFrozen && (!racer.finished || racer.kind === 'remote');

  const sh = Math.sin(racer.heading), ch = Math.cos(racer.heading);
  const fX = sh, fZ = ch;              // 车头方向
  const rX = ch, rZ = -sh;             // 车侧向（+ 与 S 同向）

  const speedAbs = Math.abs(racer.vF);
  const speedNorm = clamp(speedAbs / CFG.MAX_SPEED, 0, 1);

  /* ---- 道具状态计时（竞速赛这些值恒为 0，不进分支） ---- */
  const spinning = racer.spinT > 0;
  if (spinning) racer.spinT -= dt;
  if (racer.boostT > 0) racer.boostT -= dt;
  if (racer.shieldT > 0) racer.shieldT -= dt;

  /* ---- 动力：油门 / 刹车 / 倒车（打滑时油门刹车全部失效） ---- */
  const gas = controllable && input.gas && !spinning;
  const brake = controllable && input.brake && !spinning;
  if (gas) {
    racer.vF += CFG.ENGINE * (1 - 0.72 * speedNorm) * dt;
  }
  if (brake) {
    racer.noBrakeLap = false;
    if (racer.vF > 0.6) racer.vF -= CFG.BRAKE * dt;
    else racer.vF -= CFG.REV_ACC * dt;
  }
  /* 氮气：额外推力 + 极速放宽 */
  if (racer.boostT > 0) {
    racer.vF += CFG.ENGINE * 1.45 * (1 - 0.55 * speedNorm) * dt;
  }
  const vMax = CFG.MAX_SPEED * (racer.boostT > 0 ? 1.2 : 1);
  racer.vF = clamp(racer.vF, -CFG.MAX_REV, vMax * 1.02);
  racer.maxSpeedSeen = Math.max(racer.maxSpeedSeen, speedAbs);

  /* ---- 阻力 ---- */
  racer.vF -= (CFG.DRAG * racer.vF * Math.abs(racer.vF) + CFG.ROLL * racer.vF) * dt;

  /* ---- 转向 ----
     两路输入叠加后夹紧：
       · 键盘：left/right 是 ±1 的开关量
       · 触屏拖动 / 陀螺仪：input.steer 是 -1..1 的模拟量
     夹紧是必须的 —— 否则任何一路单独用满时叠加会溢出到 2，转向会突变。 */
  const digital = (input.left ? 1 : 0) - (input.right ? 1 : 0);
  const analog = Number.isFinite(input.steer) ? input.steer : 0;
  const steer = clamp(analog + digital, -1, 1) * (controllable ? 1 : 0);
  const speedFactor = clamp(speedAbs / 13, 0, 1);       // 静止时不给转向
  const highSpeedDamp = 1 - 0.34 * speedNorm;
  const handMul = input.handbrake ? 1.5 : 1.0;
  const targetYaw = steer * CFG.MAX_YAW * speedFactor * highSpeedDamp * handMul
    * (racer.vF < -0.3 ? -1 : 1);
  racer.yawRate = damp(racer.yawRate, targetYaw, CFG.YAW_DAMP, dt);
  /* 打滑：夺走方向盘，车身定轴旋转（约 1.25s 转一圈多） */
  if (spinning) racer.yawRate = damp(racer.yawRate, 5.6, 10, dt);
  racer.heading += racer.yawRate * dt;

  /* ---- 抓地力 ---- */
  let grip = CFG.GRIP;
  if (input.handbrake) grip = CFG.GRIP_DRIFT;
  if (racer.offroad > 0.35) grip = Math.min(grip, CFG.GRIP_OFFROAD);

  // 转向时把一部分前向速度甩给侧向 —— 漂移的来源
  racer.vL -= racer.yawRate * racer.vF * dt * 0.92;
  racer.vL -= racer.vL * grip * dt;

  /* ---- 积分位置 ---- */
  racer.x += (fX * racer.vF + rX * racer.vL) * dt;
  racer.z += (fZ * racer.vF + rZ * racer.vL) * dt;

  /* ---- 贴赛道 ---- */
  const proj = track.project(racer.x, racer.z, racer.idx, 34);
  racer.idx = proj.index;
  racer.lateral = proj.lateral;
  const latAbs = Math.abs(proj.lateral);
  const offT = smoothstep(CFG.HALF_W, CFG.HALF_W + 1.4, latAbs);
  racer.offroad = damp(racer.offroad, offT, 9, dt);
  if (racer.offroad > 0.5) racer.offroadTime += dt;
  else racer.cleanLap = racer.cleanLap && racer.offroad < 0.5;

  const roadY = track.cy[racer.idx];
  racer.y = damp(racer.y, roadY, 14, dt);

  /* ---- 外侧护墙：软性阻挡 ---- */
  const wall = CFG.HALF_W + CFG.WALL;
  if (latAbs > wall) {
    const over = latAbs - wall;
    const sgn = Math.sign(proj.lateral);
    racer.x -= track.sx[racer.idx] * sgn * over;
    racer.z -= track.sz[racer.idx] * sgn * over;
    const impact = clamp(over * 1.4 + speedAbs / CFG.MAX_SPEED, 0, 1);
    racer.vF *= (1 - 0.30 * impact);
    racer.vL *= -0.22;
    racer.shake = Math.max(racer.shake, impact * 0.85);
    racer.wallTime += dt;
    if (impact > 0.2 && ctx.onWall) ctx.onWall(racer, impact);
  } else {
    // 紧贴护墙但没撞上：累计计时用于「贴墙走线」成就
    if (latAbs > wall - 1.0 && speedAbs > 18) racer.wallTime += dt;
    else racer.wallTime = 0;
  }
  if (latAbs > CFG.HALF_W + 0.8) racer.cleanLap = false;

  /* ---- 出界阻力 ---- */
  if (racer.offroad > 0.02) {
    racer.vF -= racer.vF * 0.72 * racer.offroad * dt;
    racer.shake = Math.max(racer.shake, racer.offroad * 0.13 * speedNorm);
  }

  /* ---- 车体姿态 ---- */
  const tY = track.ty[racer.idx];
  const pitch = -Math.asin(clamp(tY, -1, 1));
  const roll = clamp(-racer.vL * 0.014 - racer.yawRate * 0.075, -0.16, 0.16);
  if (racer.mesh) {
    racer.mesh.position.set(racer.x, racer.y, racer.z);
    racer.mesh.rotation.order = 'YXZ';
    racer.mesh.rotation.set(pitch, racer.heading, roll);
  }

  /* ---- 车轮与尾灯 ---- */
  const md = racer.meshData;
  if (md) {
    const spin = (racer.vF / WHEEL_R) * dt;
    for (const w of md.wheels) {
      w.spin.rotation.x += spin;
      if (w.front) w.pivot.rotation.y = damp(w.pivot.rotation.y, steer * 0.42, 12, dt);
    }
    md.tailMat.emissiveIntensity =
      damp(md.tailMat.emissiveIntensity, brake ? 3.4 : 0.35, 12, dt);
  }

  /* ---- 漂移判定与积分 ---- */
  const slip = Math.abs(racer.vL) / Math.max(7, speedAbs);
  const isDrift = slip > 0.20 && speedAbs > 13 && racer.offroad < 0.6;
  if (isDrift) {
    if (!racer.drifting) { racer.drifting = true; racer.driftMult = 1; }
    racer.driftTimer = 0;
    racer.driftMult = Math.min(8, racer.driftMult + dt * 0.62);
    racer.driftPending += slip * speedAbs * dt * 2.6;
  } else {
    racer.driftTimer += dt;
    if (racer.drifting && racer.driftTimer > 0.85) {
      const bank = Math.floor(racer.driftPending * racer.driftMult);
      if (bank > 0) {
        racer.score += bank;
        if (ctx.onDriftBank) ctx.onDriftBank(racer, bank, racer.driftMult);
      }
      racer.drifting = false;
      racer.driftPending = 0;
      racer.driftMult = 1;
    }
  }

  /* ---- 挡位 / 转速（纯表现） ---- */
  const bands = [0, 13, 24, 35, 46, 62];
  let gear = 1;
  for (let i = 0; i < 5; i++) if (speedAbs >= bands[i]) gear = i + 1;
  const lo = bands[gear - 1], hi = bands[gear];
  racer.gear = gear;
  racer.rpm = damp(racer.rpm || 0, clamp(0.16 + 0.84 * ((speedAbs - lo) / Math.max(1, hi - lo)), 0, 1), 10, dt);
}

/**
 * 车与车碰撞：每车前后两个碰撞圆，重叠时互相推开并交换部分动量。
 * 这是让「多人」真的像在赛车、而不是互相穿模的关键。
 */
export function resolveCarCollisions(racers, ctx) {
  const FRONT_OFF = 1.15;
  const pts = [];
  for (const r of racers) {
    if (r.finished && r.kind === 'remote') continue;
    const sh = Math.sin(r.heading), ch = Math.cos(r.heading);
    pts.push([
      { r, x: r.x + sh * FRONT_OFF, z: r.z + ch * FRONT_OFF, end: 1 },
      { r, x: r.x - sh * FRONT_OFF, z: r.z - ch * FRONT_OFF, end: -1 },
    ]);
  }
  for (let a = 0; a < pts.length; a++) {
    for (let b = a + 1; b < pts.length; b++) {
      if (pts[a][0].r === pts[b][0].r) continue;
      for (const pa of pts[a]) {
        for (const pb of pts[b]) {
          let dx = pb.x - pa.x, dz = pb.z - pa.z;
          let d = Math.hypot(dx, dz);
          const minD = COLLIDE_R * 2;
          if (d > minD || d < 1e-6) continue;
          const nx = dx / d, nz = dz / d;
          const overlap = (minD - d) * 0.5;
          const ra = pa.r, rb = pb.r;
          // 远端车由权威位置驱动，这里只推本地车
          const wa = ra.kind === 'remote' ? 0 : 1;
          const wb = rb.kind === 'remote' ? 0 : 1;
          const wsum = wa + wb;
          if (wsum === 0) continue;
          ra.x -= nx * overlap * (wa ? (2 * wa / wsum) : 0);
          ra.z -= nz * overlap * (wa ? (2 * wa / wsum) : 0);
          rb.x += nx * overlap * (wb ? (2 * wb / wsum) : 0);
          rb.z += nz * overlap * (wb ? (2 * wb / wsum) : 0);

          // 侧向速度损失 + 轻微弹开
          const strength = clamp((minD - d) / minD, 0, 1);
          if (wa) {
            ra.vF *= 1 - 0.16 * strength;
            ra.shake = Math.max(ra.shake, strength * 0.5);
          }
          if (wb) {
            rb.vF *= 1 - 0.16 * strength;
            rb.shake = Math.max(rb.shake, strength * 0.5);
          }
          if (ctx && ctx.onContact && strength > 0.25) ctx.onContact(ra, rb, strength);
        }
      }
    }
  }
}

/** 按进度重算名次（未完成者按 圈数→进度 排序，已完成者按完赛时间置顶） */
export function computeRanks(racers) {
  const arr = racers.slice().sort((a, b) => {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (a.finished && b.finished) return a.finishTime - b.finishTime;
    if (a.lap !== b.lap) return b.lap - a.lap;
    return b.progress - a.progress;
  });
  arr.forEach((r, i) => { r.rank = i + 1; });
  return arr;
}
