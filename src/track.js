/* ===========================================================================
 * track.js — 赛道生成器（严格零 three.js 依赖）
 *
 * 为什么不用 three：这样 tools/check_track.mjs 能在 Node 里直接 import 本文件，
 * 校验的就是线上真正跑的那份代码，而不是另写一份"差不多"的实现。
 *
 * 生成流程：
 *   极坐标闭合曲线 r(θ)（r 恒正 ⇒ 星形域 ⇒ 曲线不自交）
 *   → 环形拉普拉斯平滑（压掉采样曲率尖刺）
 *   → 按弧长等距重采样（保证 AI 前瞻与速度剖面的尺度一致）
 *   → 叠加周期闭合高程
 *   → 计算切线/侧向/上向正交基
 *   → 由外接圆中心推导竞速线偏移、由曲率半径推导过弯速度上限
 * =========================================================================*/

import { CFG, TRACKS } from './config.js';
import { clamp, smoothstep } from './util.js';

/** 二维三点外接圆圆心（用于判断弯道内侧方向），退化时返回 null */
function circumcenter2(p0, p1, p2) {
  const ax = p0[0], az = p0[1], bx = p1[0], bz = p1[1], cx = p2[0], cz = p2[1];
  const d = 2 * (ax * (bz - cz) + bx * (cz - az) + cx * (az - bz));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = ax * ax + az * az, b2 = bx * bx + bz * bz, c2 = cx * cx + cz * cz;
  return [
    (a2 * (bz - cz) + b2 * (cz - az) + c2 * (az - bz)) / d,
    (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d,
  ];
}

/** 三点外接圆半径 = 该处曲率半径 */
function circumradius(p0, p1, p2) {
  const a = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  const b = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  const c = Math.hypot(p2[0] - p0[0], p2[1] - p0[1]);
  const area2 = Math.abs((p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]));
  if (area2 < 1e-9) return Infinity;
  return (a * b * c) / (2 * area2);
}

export function polarRadius(layout, t) {
  let r = layout.polar.base;
  for (const term of layout.polar.terms) {
    r += term.amp * (term.fn === 'sin' ? Math.sin(term.k * t + term.phase)
      : Math.cos(term.k * t + term.phase));
  }
  return r;
}

/**
 * 构建一条赛道。返回纯 TypedArray 数据 + 查询函数，不含任何渲染对象。
 */
export function buildTrack(trackId) {
  const layout = TRACKS[trackId];
  if (!layout) throw new Error('未知赛道: ' + trackId);

  /* ---------- 1. 极坐标采样 ---------- */
  const N = CFG.POLAR_SAMPLES;
  let pts = new Array(N);
  for (let i = 0; i < N; i++) {
    const t = (2 * Math.PI * i) / N;
    const r = polarRadius(layout, t);
    pts[i] = [r * Math.cos(t), r * Math.sin(t)];
  }

  /* ---------- 2. 环形拉普拉斯平滑 ---------- */
  for (let pass = 0; pass < CFG.SMOOTH_PASSES; pass++) {
    const out = new Array(N);
    for (let i = 0; i < N; i++) {
      const a = pts[(i - 1 + N) % N], b = pts[(i + 1) % N], s = pts[i];
      out[i] = [
        s[0] + CFG.SMOOTH_K * ((a[0] + b[0]) / 2 - s[0]),
        s[1] + CFG.SMOOTH_K * ((a[1] + b[1]) / 2 - s[1]),
      ];
    }
    pts = out;
  }

  /* ---------- 3. 弧长重采样 ---------- */
  const cum = new Float64Array(N + 1);
  let total = 0;
  for (let i = 0; i < N; i++) {
    const a = pts[i], b = pts[(i + 1) % N];
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
    cum[i + 1] = total;
  }
  const n = Math.max(64, Math.round(total / CFG.TRACK_STEP));
  const step = total / n;
  const flat = new Array(n);
  let j = 0;
  for (let k = 0; k < n; k++) {
    const s = total * (k / n);
    while (j < N - 1 && s > cum[j + 1]) j++;
    const segLen = cum[j + 1] - cum[j];
    const f = segLen < 1e-9 ? 0 : (s - cum[j]) / segLen;
    const a = pts[j], b = pts[(j + 1) % N];
    flat[k] = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  }

  /* ---------- 4. 高程（周期闭合，首尾无缝） ---------- */
  const cx = new Float32Array(n), cy = new Float32Array(n), cz = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    cx[i] = flat[i][0];
    cz[i] = flat[i][1];
    let y = 0;
    for (const e of layout.elev.terms) {
      y += e.amp * Math.sin((2 * Math.PI * e.k * (i * step)) / total + e.phase);
    }
    cy[i] = y;
  }

  /* ---------- 5. 正交基 ---------- */
  const tx = new Float32Array(n), ty = new Float32Array(n), tz = new Float32Array(n);
  const sx = new Float32Array(n), sz = new Float32Array(n);
  const ux = new Float32Array(n), uy = new Float32Array(n), uz = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n, b = (i + 1) % n;
    let dx = cx[b] - cx[a], dy = cy[b] - cy[a], dz = cz[b] - cz[a];
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;
    tx[i] = dx; ty[i] = dy; tz[i] = dz;
    // S = normalize(T × up) ；up = (0,1,0)
    let ax = -dz, az = dx;
    const al = Math.hypot(ax, az) || 1;
    ax /= al; az /= al;
    sx[i] = ax; sz[i] = az;
    // U = S × T，其中 S=(ax,0,az)、T=(dx,dy,dz) ⇒ (-az·dy, az·dx-ax·dz, ax·dy)
    ux[i] = -az * dy;
    uy[i] = az * dx - ax * dz;
    uz[i] = ax * dy;
    const ul = Math.hypot(ux[i], uy[i], uz[i]) || 1;
    ux[i] /= ul; uy[i] /= ul; uz[i] /= ul;
  }

  /* ---------- 6. 曲率半径 + 弯道内侧竞速线 ---------- */
  const SPAN = 6;
  const radius = new Float32Array(n);
  const laneOff = new Float32Array(n);
  const MAX_LANE = 3.6;                 // 竞速线最大横向偏移
  const R_REF = 70;                     // 参考半径：比它缓的弯基本走中线
  for (let i = 0; i < n; i++) {
    const a = (i - SPAN + n) % n, b = (i + SPAN) % n;
    const p0 = [cx[a], cz[a]], p1 = [cx[i], cz[i]], p2 = [cx[b], cz[b]];
    const R = circumradius(p0, p1, p2);
    radius[i] = R;
    const c = circumcenter2(p0, p1, p2);
    if (!c || !isFinite(R)) { laneOff[i] = 0; continue; }
    let vx = c[0] - cx[i], vz = c[1] - cz[i];
    const vl = Math.hypot(vx, vz) || 1;
    vx /= vl; vz /= vl;
    // 内侧方向在 S 上的投影 × 弯道紧度
    const inward = vx * sx[i] + vz * sz[i];
    const tight = clamp(1 - R / R_REF, 0, 1);
    laneOff[i] = inward * MAX_LANE * tight;
  }
  // 竞速线必须连续，做几轮平滑
  for (let pass = 0; pass < 6; pass++) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = (laneOff[(i - 1 + n) % n] + laneOff[i] * 2 + laneOff[(i + 1) % n]) / 4;
    }
    laneOff.set(out);
  }

  const dist = new Float32Array(n);
  for (let i = 0; i < n; i++) dist[i] = i * step;

  /* ---------- 7. 查询函数 ---------- */
  function pointAt(i, lateral = 0, out = [0, 0, 0]) {
    const k = ((i % n) + n) % n;
    out[0] = cx[k] + sx[k] * lateral;
    out[1] = cy[k];
    out[2] = cz[k] + sz[k] * lateral;
    return out;
  }

  function nearestBrute(x, z, stride = 6) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < n; i += stride) {
      const d = (x - cx[i]) ** 2 + (z - cz[i]) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    let fine = best, fd = bd;
    for (let k = -stride; k <= stride; k++) {
      const i = (best + k + n * 2) % n;
      const d = (x - cx[i]) ** 2 + (z - cz[i]) ** 2;
      if (d < fd) { fd = d; fine = i; }
    }
    return { index: fine, dist: Math.sqrt(fd) };
  }

  function nearestLocal(x, z, hint, win = 30) {
    let best = hint % n, bd = Infinity;
    for (let k = -win; k <= win; k++) {
      const i = (hint + k + n * 2) % n;
      const d = (x - cx[i]) ** 2 + (z - cz[i]) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return { index: best, dist: Math.sqrt(bd) };
  }

  /** 世界坐标 → 赛道参数：横向偏移 lateral（+ 为 S 方向一侧）与最近索引 */
  function project(x, z, hint, win = 34) {
    const { index, dist: d } = nearestLocal(x, z, hint, win);
    const lateral = (x - cx[index]) * sx[index] + (z - cz[index]) * sz[index];
    return { index, lateral, dist: d };
  }

  /** 起跑格位：起点线（索引 0）之前排布，左右交错 */
  function gridSlot(slot) {
    const index = (10 + slot * 4) % n;
    const lateral = (slot % 2 === 0 ? 1 : -1) * 2.9 * (1 + Math.floor(slot / 4) * 0.35);
    return { index, lateral };
  }

  /**
   * AI 速度剖面：先由曲率得到过弯上限，再从后往前传播刹车点。
   * v[i] = min(vmax[i], sqrt(v[i+1]² + 2·a_brake·ds))
   * 绕环两圈以处理跨起点的刹车段。
   */
  function speedProfile(latAccel, topSpeed, brakeDecel = 30) {
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const R = Math.max(4, radius[i]);
      v[i] = Math.min(topSpeed, Math.sqrt(latAccel * R));
    }
    for (let loop = 0; loop < 2; loop++) {
      for (let s = n - 1; s >= 0; s--) {
        const nxt = (s + 1) % n;
        const cap = Math.sqrt(v[nxt] * v[nxt] + 2 * brakeDecel * step);
        if (v[s] > cap) v[s] = cap;
      }
    }
    return v;
  }

  /* ---------- 8. 汇总 ---------- */
  let minR = Infinity, maxR = 0;
  for (let i = 0; i < n; i++) {
    if (radius[i] < minR) minR = radius[i];
    if (radius[i] > maxR && isFinite(radius[i])) maxR = radius[i];
  }

  return {
    id: trackId, layout, n, step, total,
    cx, cy, cz, tx, ty, tz, sx, sz, ux, uy, uz, dist,
    radius, laneOff, minR, maxR,
    pointAt, nearestBrute, nearestLocal, project, gridSlot, speedProfile,
    /** 赛道包围盒（用于地形与相机限制） */
    bounds: (() => {
      let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
      for (let i = 0; i < n; i++) {
        a = Math.min(a, cx[i]); b = Math.max(b, cx[i]);
        c = Math.min(c, cz[i]); d = Math.max(d, cz[i]);
      }
      return { minX: a, maxX: b, minZ: c, maxZ: d };
    })(),
  };
}

/**
 * 赛道地形高度：以最近中心线高程为基准，随离赛道距离平滑过渡到起伏丘陵。
 * 这样路面永远"陷在地里"，不会出现悬空路段。
 */
export function terrainHeight(track, x, z, probe) {
  const { index, dist } = probe ? probe(x, z) : track.nearestBrute(x, z, 6);
  const base = track.cy[index] - 0.45;
  const far = 11 * Math.sin(x * 0.0062 + 1.3) * Math.cos(z * 0.0051 - 0.4)
    + 5.5 * Math.sin(x * 0.0171) * Math.sin(z * 0.0143 + 0.9);
  const t = smoothstep(CFG.HALF_W + CFG.SHOULDER + 1.5, CFG.HALF_W + 46, dist);
  return base + (far + 1.2) * t;
}
