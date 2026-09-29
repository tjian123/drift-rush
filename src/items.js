/* ===========================================================================
 * items.js — 道具赛系统
 *
 * 道具箱沿赛道均布（跳过发车区），吃到后滚动抽取一个道具：
 *   ⚡ 氮气   —— 短时强推力 + 极速放宽
 *   🛡 护盾   —— 持续期内免疫油污 / 导弹（导弹会被护盾挡下并消耗护盾）
 *   🛢 油污   —— 往车后丢一滩油，别人压上就打滑
 *   🚀 导弹   —— 沿赛道自动追击前车，命中打滑
 * 排名越靠后，抽到进攻/加速道具的概率越高（橡皮筋式补偿）。
 * 联机模式不启用本系统（各客户端不同步道具状态）。
 * =========================================================================*/

import { ITEMS_CFG } from './config.js';
import { clamp } from './util.js';

export const ITEM_ICONS = { boost: '⚡', shield: '🛡', oil: '🛢', missile: '🚀' };
/* 双语道具名：{en,zh} 由 i18n 的 pick() 取值；渲染处统一 pick(ITEM_NAMES[x]) */
export const ITEM_NAMES = {
  boost: { en: 'Boost', zh: '氮气' },
  shield: { en: 'Shield', zh: '护盾' },
  oil: { en: 'Oil Slick', zh: '油污' },
  missile: { en: 'Missile', zh: '导弹' },
};
export const ITEM_SEQ = ['boost', 'shield', 'oil', 'missile'];   // 抽取滚动动画的轮转序列

/** 按名次加权抽道具：behind ∈ [0..1]，0=领跑，1=垫底 */
export function pickItem(rank, total) {
  const total2 = Math.max(2, total);
  const behind = clamp((rank - 1) / (total2 - 1), 0, 1);
  const w = {
    boost: 0.28 + 0.26 * behind,
    missile: 0.14 + 0.16 * behind,
    shield: 0.30 - 0.14 * behind,
    oil: 0.28 - 0.24 * behind,
  };
  let sum = 0;
  for (const k in w) sum += Math.max(0.02, w[k]);
  let r = Math.random() * sum;
  for (const k in w) {
    r -= Math.max(0.02, w[k]);
    if (r <= 0) return k;
  }
  return 'boost';
}

/**
 * 创建道具系统。生命周期：startRace(item 赛制) 创建 → 每帧 update → clearRace dispose。
 * 打滑/加速/护盾的物理在 car.js（读 racer.spinT / boostT / shieldT）。
 */
export function createItemSystem(THREE, scene, track) {
  const C = ITEMS_CFG;
  const segLen = track.step;   // 相邻采样点间距（= total/n，track 自带字段）
  const group = new THREE.Group();
  scene.add(group);

  /* ---- 道具箱 ---- */
  const boxGeo = new THREE.BoxGeometry(1.5, 1.5, 1.5);
  const boxMat = new THREE.MeshStandardMaterial({
    color: 0xffb84d, emissive: 0xff9a1f, emissiveIntensity: 0.55,
    roughness: 0.3, metalness: 0.2, transparent: true, opacity: 0.92,
  });
  const boxes = [];
  for (let g = 0; g < C.BOX_GROUPS; g++) {
    const idx = Math.floor((0.14 + (0.74 * g) / C.BOX_GROUPS) * track.n) % track.n;
    for (const lane of C.BOX_LANES) {
      const mesh = new THREE.Mesh(boxGeo, boxMat);
      const x = track.cx[idx] + track.sx[idx] * lane;
      const z = track.cz[idx] + track.sz[idx] * lane;
      mesh.position.set(x, track.cy[idx] + 1.15, z);
      group.add(mesh);
      boxes.push({ idx, lane, x, y: track.cy[idx], z, mesh, active: true, respawn: 0 });
    }
  }

  /* ---- 护盾视觉：每车一个透明球，按需创建并缓存 ---- */
  const shieldGeo = new THREE.SphereGeometry(2.3, 18, 12);
  const shieldMat = new THREE.MeshBasicMaterial({
    color: 0x4fd8ff, transparent: true, opacity: 0.22, depthWrite: false,
  });
  const shieldMeshes = new Map();
  function shieldMesh(racer) {
    let m = shieldMeshes.get(racer.id);
    if (!m) {
      m = new THREE.Mesh(shieldGeo, shieldMat);
      group.add(m);
      shieldMeshes.set(racer.id, m);
    }
    return m;
  }

  /* ---- 油污 ---- */
  const oilGeo = new THREE.CircleGeometry(1.5, 18);
  oilGeo.rotateX(-Math.PI / 2);
  const patches = [];
  function spawnOil(x, y, z, idx, owner) {
    if (patches.length >= 24) {           // 池满回收最旧的
      const old = patches.shift();
      group.remove(old.mesh);
    }
    const mesh = new THREE.Mesh(oilGeo, new THREE.MeshBasicMaterial({
      color: 0x0b0d12, transparent: true, opacity: 0.8, depthWrite: false,
    }));
    mesh.position.set(x, y + 0.07, z);
    group.add(mesh);
    patches.push({ x, y, z, idx, owner, ttl: C.OIL_TTL, mesh });
  }

  /* ---- 导弹 ---- */
  const mslGeo = new THREE.ConeGeometry(0.42, 1.7, 8);
  mslGeo.rotateX(Math.PI / 2);            // 锥尖朝 +Z，配合 lookAt 取向
  const mslMat = new THREE.MeshStandardMaterial({
    color: 0xff4444, emissive: 0xff2222, emissiveIntensity: 1.1,
  });
  const missiles = [];
  function fireMissile(shooter, target) {
    const u = shooter.idx;
    const mesh = new THREE.Mesh(mslGeo, mslMat);
    group.add(mesh);
    missiles.push({
      owner: shooter.id, u, lat: shooter.lateral,
      ttl: C.MISSILE_TTL, target: target ? target.id : null, mesh,
    });
    return !!target;
  }

  /* ---- 打滑 ---- */
  function spinOut(racer, reason) {
    if (racer.shieldT > 0) {              // 护盾挡下并消耗
      racer.shieldT = 0;
      racer.vF *= 0.9;
      return 'shielded';
    }
    if (racer.spinT > 0) return 'spun';   // 已经在打滑不叠加
    racer.spinT = C.SPIN_T;
    racer.vF *= 0.5;
    racer.drifting = false;
    racer.driftPending = 0;
    racer.driftMult = 1;
    return reason || 'spun';
  }

  /* ---- 赛道距离（沿行车方向，a 在 b 前方为正） ---- */
  function gapSamples(a, b) {
    const n = track.n;
    return (b - a + n) % n;
  }

  function giveItem(racer, rank, total, force) {
    if (racer.item || racer.itemRollT > 0) return false;
    racer.itemRollT = C.ROLL_TIME;
    racer.itemRollFinal = force || pickItem(rank, total);
    return true;
  }

  function useItem(racer, racers) {
    if (!racer.item || racer.itemRollT > 0) return null;
    const it = racer.item;
    racer.item = null;
    racer.itemCd = 0.5;
    if (it === 'boost') {
      racer.boostT = C.BOOST_T;
    } else if (it === 'shield') {
      racer.shieldT = C.SHIELD_T;
    } else if (it === 'oil') {
      const sh = Math.sin(racer.heading), ch = Math.cos(racer.heading);
      const bx = racer.x - sh * 3.4, bz = racer.z - ch * 3.4;
      spawnOil(bx, racer.y, bz, racer.idx, racer.id);
    } else if (it === 'missile') {
      // 找正前方最近的车（沿赛道 8~260m 窗口内）
      let best = null, bestGap = Infinity;
      for (const o of racers) {
        if (o.id === racer.id || !o.mesh) continue;
        const gap = gapSamples(racer.idx, o.idx) * segLen;
        if (gap > 6 && gap < 260 && gap < bestGap) { bestGap = gap; best = o; }
      }
      fireMissile(racer, best);
    }
    return it;
  }

  /* ---- AI 用道具：简明启发式 ---- */
  function aiThink(racer, dt, racers) {
    racer.itemCd = Math.max(0, (racer.itemCd || 0) - dt);
    if (!racer.item || racer.itemCd > 0) return;
    if (racer.itemRollT > 0) return;
    const rank = racer.rank || 4;
    // 领跑且手里是进攻道具 → 憋一会儿再交
    if (rank === 1 && (racer.item === 'missile' || racer.item === 'oil') && Math.random() > 0.02) return;
    if (racer.item === 'shield') {
      // 有导弹追自己或落后时尽快开盾
      let hunted = false;
      for (const m of missiles) if (m.target === racer.id) hunted = true;
      if (hunted || Math.random() < 0.02) useItem(racer, racers);
      return;
    }
    if (racer.item === 'boost') {
      if (racer.offroad < 0.25 && Math.random() < 0.035) useItem(racer, racers);
      return;
    }
    if (racer.item === 'missile') {
      if (Math.random() < 0.03) useItem(racer, racers);
      return;
    }
    if (racer.item === 'oil') {
      if (Math.random() < 0.02) useItem(racer, racers);
    }
  }

  /* ---- 每帧更新 ---- */
  function update(dt, racers, now, onEvent) {
    const ev = onEvent || (() => {});

    /* 道具箱：旋转 / 再生 / 拾取 */
    for (const b of boxes) {
      if (!b.active) {
        b.respawn -= dt;
        if (b.respawn <= 0) { b.active = true; b.mesh.visible = true; }
        continue;
      }
      b.mesh.rotation.y += dt * 2.2;
      b.mesh.rotation.x += dt * 0.9;
      for (const r of racers) {
        if (!r.mesh || r.finished) continue;
        const dx = r.x - b.x, dz = r.z - b.z;
        if (dx * dx + dz * dz > C.PICKUP_R * C.PICKUP_R) continue;
        b.active = false;
        b.respawn = C.BOX_RESPAWN;
        b.mesh.visible = false;
        giveItem(r, r.rank || 4, racers.length);
        ev(r, 'pickup');
        break;
      }
    }

    /* 抽取滚动 */
    for (const r of racers) {
      if (r.itemRollT > 0) {
        r.itemRollT -= dt;
        if (r.itemRollT <= 0) {
          r.itemRollT = 0;
          r.item = r.itemRollFinal;
          r.itemRollFinal = null;
          ev(r, 'get');
        }
      }
    }

    /* 油污：超时回收 + 压上打滑 */
    for (let i = patches.length - 1; i >= 0; i--) {
      const p = patches[i];
      p.ttl -= dt;
      p.mesh.material.opacity = Math.min(0.8, p.ttl / 3);
      if (p.ttl <= 0) { group.remove(p.mesh); p.mesh.material.dispose(); patches.splice(i, 1); continue; }
      for (const r of racers) {
        if (!r.mesh || r.finished || r.id === p.owner) continue;
        const dx = r.x - p.x, dz = r.z - p.z;
        if (dx * dx + dz * dz > C.OIL_R * C.OIL_R) continue;
        const res = spinOut(r, 'oil');
        ev(r, res);
        if (res === 'shielded') break;
      }
    }

    /* 护盾视觉 */
    const seen = new Set();
    for (const r of racers) {
      if (!r.mesh) continue;
      const on = r.shieldT > 0;
      if (on) {
        seen.add(r.id);
        const m = shieldMesh(r);
        m.visible = true;
        m.position.set(r.x, r.y + 1.1, r.z);
        m.material.opacity = 0.16 + 0.10 * Math.sin(now / 130);
      }
    }
    for (const [id, m] of shieldMeshes) {
      if (!seen.has(id)) m.visible = false;
    }

    /* 导弹：沿赛道飞行 + 逐帧寻的 + 命中 */
    for (let i = missiles.length - 1; i >= 0; i--) {
      const mi = missiles[i];
      mi.ttl -= dt;
      let victim = null;
      if (mi.target) victim = racers.find((r) => r.id === mi.target && r.mesh) || null;
      // 目标没了（完赛/掉线）就直飞到超时
      mi.u += (C.MISSILE_SPEED * dt) / segLen;
      const i0 = Math.floor(mi.u) % track.n;
      const fr = mi.u - Math.floor(mi.u);
      const i1 = (i0 + 1) % track.n;
      if (victim) {
        // 横向缓动逼近目标车道
        mi.lat += clamp(victim.lateral - mi.lat, -8 * dt, 8 * dt);
      }
      const mx = track.cx[i0] * (1 - fr) + track.cx[i1] * fr + track.sx[i0] * mi.lat;
      const mz = track.cz[i0] * (1 - fr) + track.cz[i1] * fr + track.sz[i0] * mi.lat;
      const my = track.cy[i0] * (1 - fr) + track.cy[i1] * fr + 0.8;
      mi.mesh.position.set(mx, my, mz);
      mi.mesh.lookAt(
        track.cx[i1] + track.sx[i1] * mi.lat, my + 0.1,
        track.cz[i1] + track.sz[i1] * mi.lat
      );
      // 命中判定：撞到任何非发射者的车
      let hit = null;
      for (const r of racers) {
        if (!r.mesh || r.id === mi.owner) continue;
        const dx = r.x - mx, dz = r.z - mz;
        if (dx * dx + dz * dz < 2.4 * 2.4) { hit = r; break; }
      }
      if (hit) {
        const res = spinOut(hit, 'missile');
        ev(hit, res);
      }
      if (hit || mi.ttl <= 0) {
        group.remove(mi.mesh);
        missiles.splice(i, 1);
      }
    }
  }

  function snapshot(me) {
    const active = boxes.filter((b) => b.active).length;
    return {
      boxes: boxes.length, active,
      myItem: me ? (me.item || null) : null,
      rolling: me ? me.itemRollT > 0 : false,
      boostT: me ? Math.max(0, me.boostT || 0) : 0,
      shieldT: me ? Math.max(0, me.shieldT || 0) : 0,
      spinT: me ? Math.max(0, me.spinT || 0) : 0,
      oils: patches.length, missiles: missiles.length,
      boxPos: boxes.slice(0, 3).map((b) => [+b.x.toFixed(1), +b.y.toFixed(1), +b.z.toFixed(1)]),
    };
  }

  function dispose() {
    scene.remove(group);
    group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material.dispose();
      }
    });
  }

  return {
    update, useItem, aiThink, giveItem, spawnOil, fireMissile, spinOut, snapshot, dispose,
    get boxes() { return boxes; },
    get patches() { return patches; },
    get missiles() { return missiles; },
  };
}
