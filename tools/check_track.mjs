/* ===========================================================================
 * check_track.mjs — 赛道几何离线校验（Node 直接跑，import 生产代码）
 *
 * 之所以要这一步：赛道是程序化生成的，"看起来没问题"不代表能开。
 * 自交、过急弯、坡度超限、竞速线跑出路面、AI 速度剖面不平滑，
 * 这几类问题必须在写 UI 之前就拦掉，否则后面所有调试都会被误导。
 *
 *   node tools/check_track.mjs
 * =========================================================================*/

import { buildTrack } from '../src/track.js';
import { TRACK_ORDER, TRACKS, CFG } from '../src/config.js';

const HALF_W = CFG.HALF_W;
const CLEAR_NEED = HALF_W * 2 + 4;      // 两条路段之间的最小净距
const MIN_R = 17;                        // 最小可驾驶转弯半径
const MAX_GRADE = 0.12;                  // 最大坡度 12%

const C = { ok: '\x1b[32m', bad: '\x1b[31m', dim: '\x1b[2m', y: '\x1b[33m', off: '\x1b[0m' };

function pct(arr, p) { return arr[Math.min(arr.length - 1, Math.floor(arr.length * p))]; }

function checkTrack(id) {
  const t = buildTrack(id);
  const L = TRACKS[id];
  const n = t.n;
  const fails = [];

  /* ---- 1. 采样均匀性（弧长重采样是否真的等距） ---- */
  let minSeg = Infinity, maxSeg = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const d = Math.hypot(t.cx[j] - t.cx[i], t.cz[j] - t.cz[i]);
    minSeg = Math.min(minSeg, d); maxSeg = Math.max(maxSeg, d);
  }
  const segErr = (maxSeg - minSeg) / t.step;
  if (segErr > 0.6) fails.push(`采样间距不均(${(segErr * 100).toFixed(0)}%)`);

  /* ---- 2. 分支净距：曲线不能自己贴着自己 ---- */
  const skip = Math.max(12, Math.ceil((CLEAR_NEED * 3) / t.step));
  let minClear = Infinity, clearAt = null;
  for (let i = 0; i < n; i++) {
    for (let j = i + skip; j < n; j++) {
      if (Math.min(j - i, n - (j - i)) <= skip) continue;
      const d = Math.hypot(t.cx[i] - t.cx[j], t.cz[i] - t.cz[j]);
      if (d < minClear) { minClear = d; clearAt = [i, j]; }
    }
  }
  if (minClear < CLEAR_NEED) fails.push(`分支净距 ${minClear.toFixed(1)} < ${CLEAR_NEED}`);

  /* ---- 3. 最小转弯半径 ---- */
  if (t.minR < MIN_R) fails.push(`最小转弯半径 ${t.minR.toFixed(1)} < ${MIN_R}`);

  /* ---- 4. 坡度 ---- */
  let maxGrade = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dy = Math.abs(t.cy[j] - t.cy[i]);
    const ds = Math.hypot(t.cx[j] - t.cx[i], t.cz[j] - t.cz[i]) || 1;
    maxGrade = Math.max(maxGrade, dy / ds);
  }
  if (maxGrade > MAX_GRADE) fails.push(`最大坡度 ${(maxGrade * 100).toFixed(1)}% > ${MAX_GRADE * 100}%`);

  /* ---- 5. 竞速线必须留在路面内 ---- */
  let maxLane = 0;
  for (let i = 0; i < n; i++) maxLane = Math.max(maxLane, Math.abs(t.laneOff[i]));
  if (maxLane > HALF_W - 1.2) fails.push(`竞速线偏移 ${maxLane.toFixed(2)} 超出路面安全区`);

  /* ---- 6. AI 速度剖面（normal 难度） ---- */
  const v = t.speedProfile(34, CFG.MAX_SPEED, 30);
  let vMin = Infinity, vMax = 0, maxJump = 0;
  for (let i = 0; i < n; i++) {
    vMin = Math.min(vMin, v[i]); vMax = Math.max(vMax, v[i]);
    const j = (i + 1) % n;
    maxJump = Math.max(maxJump, Math.abs(v[j] - v[i]));
  }
  if (vMin < 10) fails.push(`AI 最慢过弯速度 ${vMin.toFixed(1)} 过低（会像蜗牛）`);
  // 每步速度变化不应超过 2·a·ds 的理论上限太多
  const jumpCap = 30 * t.step * 1.35;
  if (maxJump > jumpCap) fails.push(`AI 速度剖面跳变 ${maxJump.toFixed(1)} > ${jumpCap.toFixed(1)}`);

  /* ---- 7. 起跑格位必须落在路面内 ---- */
  for (let s = 0; s < CFG.MAX_PLAYERS; s++) {
    const g = t.gridSlot(s);
    if (Math.abs(g.lateral) + 1.1 > HALF_W) fails.push(`格位 ${s} 偏移 ${g.lateral} 越界`);
  }

  const radii = [];
  for (let i = 0; i < n; i += 4) if (isFinite(t.radius[i])) radii.push(t.radius[i]);
  radii.sort((a, b) => a - b);

  const ok = fails.length === 0;
  console.log(`\n${ok ? C.ok + '✔' : C.bad + '✘'} ${L.name} ${C.dim}(${id})${C.off}`);
  console.log(`   周长 ${t.total.toFixed(0)} 单位 · 采样 ${n} 点 · 步长 ${t.step.toFixed(2)}`);
  console.log(`   转弯半径  最小 ${t.minR.toFixed(1)} / P10 ${pct(radii, 0.1).toFixed(1)} / 中位 ${pct(radii, 0.5).toFixed(1)}`);
  console.log(`   分支净距  ${minClear.toFixed(1)} ${C.dim}(需 > ${CLEAR_NEED})${C.off}   最大坡度 ${(maxGrade * 100).toFixed(1)}%`);
  console.log(`   竞速线    最大偏移 ${maxLane.toFixed(2)} ${C.dim}(路面半宽 ${HALF_W})${C.off}`);
  console.log(`   AI 速度   ${vMin.toFixed(0)} ~ ${vMax.toFixed(0)} 单位/秒 ${C.dim}(≈ ${(vMin * 3.6).toFixed(0)} ~ ${(vMax * 3.6).toFixed(0)} km/h)${C.off}`);
  if (!ok) for (const f of fails) console.log(`   ${C.bad}✘ ${f}${C.off}`);
  return ok;
}

console.log('=== 赛道几何校验（校验的就是 src/track.js 生产代码） ===');
const results = TRACK_ORDER.map(checkTrack);
const pass = results.filter(Boolean).length;
console.log(`\n${pass === results.length ? C.ok : C.bad}结果：${pass}/${results.length} 条赛道通过${C.off}\n`);
process.exit(pass === results.length ? 0 : 1);
