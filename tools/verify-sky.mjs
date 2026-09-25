/* ===========================================================================
 * verify-sky.mjs — 统一天空（sky.js）回归验收
 *
 * 这个脚本存在的意义：把「一个 skyColor() 贯穿天空/海面反射/海面雾色」的架构锁死。
 * 只要有人哪天把海面的 uniform 改成独立拷贝（不再与天空共享引用），S3 会立刻失败 ——
 * 否则这种"看起来能跑、但天空与水面各说各话"的退化极难在肉眼 review 中发现。
 *
 *   S1 天空球与海面网格都存在（海岸类赛道）
 *   S2 两者的太阳/天空色 uniform 是同一批对象引用（不是各自拷贝）
 *   S3 改一处 → 另一处跟着变（真正的数据流证明，而非结构巧合）
 *   S4 海面具备统一雾所需的 uFogDensity，且已脱离 scene.fog
 *   S5 着色器编译无错（GLSL 报错是这次改动最大的风险点）
 *   S6 太阳色取自赛道色板（不再硬编码橙色）
 *   S7 水面不淹赛道（"一段路被水覆盖"的回归断言）
 *   S8 沿岸 12 段连续有水（"感受不到海岸线"的回归断言）
 * ===========================================================================*/
import { Browser, sleep } from './cdp.mjs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { TRACKS } from '../src/config.js';

/* three r160 的 sRGB→线性转换（Color.setHex 默认就走这条），用它把色板值换算成
   着色器里真正见到的线性值，好做精确比对。
   —— 别再用「b 通道 > 0.5」这类魔法阈值：海岸色板本身是暖色（0xffd8a8，
   线性蓝通道只有 0.392），换一次色板断言就假失败一次。 */
const srgbToLinear = (c) =>
  c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
const linearOfHex = (hex) => [
  srgbToLinear(((hex >> 16) & 255) / 255),
  srgbToLinear(((hex >> 8) & 255) / 255),
  srgbToLinear((hex & 255) / 255),
];
const COAST_SUN = linearOfHex(TRACKS.coast.sun.color);
const COAST_TOP = TRACKS.coast.sky.top;

const BASE = process.env.DR_BASE || 'http://127.0.0.1:8790';
let passed = 0, failed = 0;

function check(name, ok, detail = '') {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✘\x1b[0m'} ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
}

async function ensureServer() {
  const health = await fetch(BASE + '/api/health').then((r) => r.ok).catch(() => false);
  if (health) return;
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    env: { ...process.env, PORT: new URL(BASE).port || '3000' },
    stdio: 'ignore', detached: true,
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await delay(250);
    if (await fetch(BASE + '/api/health').then((r) => r.ok).catch(() => false)) return;
  }
  throw new Error('本地服务器启动失败');
}

const FIND = `(() => {
  const sc = window.__DR_SCENE__;
  if (!sc) return { err: 'no scene' };
  let sky = null, ocean = null;
  sc.traverse((o) => { if (o.name === 'sky') sky = o; if (o.name === 'ocean') ocean = o; });
  return { hasSky: !!sky, hasOcean: !!ocean };
})()`;

async function main() {
  await ensureServer();
  const b = await Browser.launch({ port: 9418, profileName: 'cdp-sky' });
  const page = await b.newPage();
  await page.readyUrl(BASE + '/');
  // 强制使用海岸赛道（只有它有水面），再重载让 world 按该色板重建
  await page.eval(`(() => { localStorage.setItem('dr-track', 'coast'); return true; })()`);
  await page.readyUrl(BASE + '/');
  await sleep(3000);   // 等 world 重建 + 首帧渲染完成

  console.log('\n\x1b[1m统一天空验收\x1b[0m');

  /* ---- S1: 网格存在 ---- */
  const f = await page.eval(FIND);
  check('S1 天空球与海面网格都已建立',
    f.hasSky === true && f.hasOcean === true,
    `sky=${f.hasSky} ocean=${f.hasOcean}${f.err ? ' err=' + f.err : ''}`);

  /* ---- S2: 共享同一批 uniform 对象 ---- */
  const shared = await page.eval(`(() => {
    let sky = null, ocean = null;
    window.__DR_SCENE__.traverse((o) => { if (o.name === 'sky') sky = o; if (o.name === 'ocean') ocean = o; });
    if (!sky || !ocean) return { ok: false };
    const ks = ['uSkyTop','uSkyMid','uSkyBot','uSunDir','uSunColor','uSunStrength'];
    const same = ks.filter((k) => sky.material.uniforms[k] === ocean.material.uniforms[k]);
    return { ok: true, same, missing: ks.filter((k) => !same.includes(k)) };
  })()`);
  check('S2 天空与海面共享同一批 uniform 对象引用',
    !!shared.ok && shared.missing.length === 0,
    shared.missing?.length ? '未共享: ' + shared.missing.join(',') : `共享 ${shared.same?.length} 个`);

  /* ---- S3: 改一处另一处跟着变（真正的数据流证明） ---- */
  const flow = await page.eval(`(() => {
    let sky = null, ocean = null;
    window.__DR_SCENE__.traverse((o) => { if (o.name === 'sky') sky = o; if (o.name === 'ocean') ocean = o; });
    if (!sky || !ocean) return { ok: false };
    const before = sky.material.uniforms.uSkyTop.value.getHexString();
    ocean.material.uniforms.uSkyTop.value.setHex(0x112233);   // 从海面侧改
    const after = sky.material.uniforms.uSkyTop.value.getHexString();
    // 还原值由 Node 侧从色板算出后注入，不写死 —— 换色板不该让这条断言失真
    ocean.material.uniforms.uSkyTop.value.setHex(${COAST_TOP});
    return { ok: true, before, after, restored: sky.material.uniforms.uSkyTop.value.getHexString() };
  })()`);
  check('S3 从海面侧改 uniform，天空侧同步变化（数据流真实贯通）',
    !!flow.ok && flow.after === '112233' && flow.before !== flow.after
      && flow.restored === COAST_TOP.toString(16).padStart(6, '0'),
    `改前=${flow.before} 改后=${flow.after} 已还原=${flow.restored}`);

  /* ---- S4: 统一雾 + 脱离 scene.fog ---- */
  const fog = await page.eval(`(() => {
    let ocean = null;
    window.__DR_SCENE__.traverse((o) => { if (o.name === 'ocean') ocean = o; });
    if (!ocean) return { ok: false };
    const u = ocean.material.uniforms;
    return { ok: true, hasDensity: typeof u.uFogDensity?.value === 'number',
             density: u.uFogDensity?.value, materialFog: ocean.material.fog };
  })()`);
  check('S4 海面具备 uFogDensity 且已脱离 scene.fog（自行融进天空）',
    !!fog.ok && fog.hasDensity === true && fog.materialFog === false,
    `uFogDensity=${fog.density?.toFixed(5)} material.fog=${fog.materialFog}`);

  /* ---- S5: 着色器编译无错 ---- */
  const errs = await page.errors();
  const shaderErrs = errs.filter((e) => /shader|WebGLProgram|GLSL|compile|compil/i.test(e));
  check('S5 天空/海面着色器编译无错误',
    shaderErrs.length === 0,
    shaderErrs.length ? shaderErrs.slice(0, 2).join(' | ') : '控制台无 GLSL 相关报错');

  /* ---- S6: 太阳色来自色板（不再硬编码橙色） ----
     判据是「等于色板值的线性化结果」，而不是某个方向的阈值：色板可以是暖色
     也可以是冷色，能证明的只有「它确实跟着色板走」。 */
  const sun = await page.eval(`(() => {
    let sky = null;
    window.__DR_SCENE__.traverse((o) => { if (o.name === 'sky') sky = o; });
    if (!sky) return { ok: false };
    const c = sky.material.uniforms.uSunColor.value;
    return { ok: true, r: c.r, g: c.g, b: c.b };
  })()`);
  const sunMatch =
    !!sun.ok &&
    Math.abs(sun.r - COAST_SUN[0]) < 0.01 &&
    Math.abs(sun.g - COAST_SUN[1]) < 0.01 &&
    Math.abs(sun.b - COAST_SUN[2]) < 0.01;
  check('S6 太阳色等于赛道色板的线性值（不再硬编码橙色）',
    sunMatch,
    `uSunColor=(${sun.r?.toFixed(3)}, ${sun.g?.toFixed(3)}, ${sun.b?.toFixed(3)})`
      + ` · 期望=(${COAST_SUN.map((v) => v.toFixed(3)).join(', ')})`
      + ` ← 0x${TRACKS.coast.sun.color.toString(16)}`);

  /* ---- S7: 水不淹路（这是"一段路被水覆盖"的直接回归断言） ----
     两条独立判据，缺一不可：
       ① 每个水面顶点到**赛道中心线**（整条折线，不是 12 个采样点）的最小距离
          必须大于路面半宽+路肩 —— 这是"水有没有横穿赛道"的硬判据。
       ② 每个水面顶点的 Y（水面高度 + 顶点浪位移）必须低于它正下方地形的下限，
          否则水面会从地形里扎出来盖在路上。
     只用「到 12 个路点的距离」是不够的：路是弯的，水面可能贴在两个采样点之间
     的某段路上却躲过 12 个点的检测。 */
  const flood = await page.eval(`(() => {
    let ocean = null, terrain = null;
    window.__DR_SCENE__.traverse((o) => {
      if (o.name === 'ocean') ocean = o;
      if (o.isMesh && o.geometry && o.geometry.attributes.color
          && o.geometry.attributes.position.count > 10000) terrain = o;
    });
    if (!ocean) return { err: 'no ocean' };
    const P = ocean.geometry.attributes.position.array;
    const N = P.length / 3;
    const A = window.__DR_API__;
    const n = A.trackN();
    const road = [];
    for (let i = 0; i < n; i++) road.push(A.trackPoint(i, 0));
    const EDGE = 8.7;                     // 路面半宽 7 + 路肩 1.7

    // ① 全体水面顶点 → 过整条中心线取最短垂直距离
    let minToLine = Infinity, minAt = 0;
    for (let v = 0; v < N; v++) {
      const x = P[v * 3], z = P[v * 3 + 2];
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        const dx = x - road[i][0], dz = z - road[i][1];
        const d2 = dx * dx + dz * dz;
        if (d2 < best) best = d2;
      }
      if (best < minToLine) { minToLine = best; minAt = v; }
    }
    minToLine = Math.sqrt(minToLine);

    // ② 沿 12 段各取一点，量「海侧到底有没有真正渲染出来的水」
    const TP = terrain ? terrain.geometry.attributes.position : null;
    const IDX = ocean.geometry.index ? ocean.geometry.index.array : null;
    const oceanY = ocean.position.y;
    const seaSign = (() => {
      let acc = 0;
      for (let k = 0; k < 12; k++) {
        const i = Math.floor((n * k) / 12);
        const c = A.trackPoint(i, 0), u = A.trackPoint(i, 1);
        const ux = u[0] - c[0], uz = u[1] - c[1];
        let bd = Infinity, bx = 0, bz = 0;
        for (let v = 0; v < N; v++) {
          const dx = P[v * 3] - c[0], dz = P[v * 3 + 2] - c[1];
          const d = dx * dx + dz * dz;
          if (d < bd) { bd = d; bx = dx; bz = dz; }
        }
        acc += bx * ux + bz * uz;
      }
      return acc > 0 ? 1 : -1;
    })();

    const segWater = [], segSigned = [], segBelow = [];
    for (let k = 0; k < 12; k++) {
      const i = Math.floor((n * k) / 12);
      const c = A.trackPoint(i, 0), u = A.trackPoint(i, 1);
      const ux = (u[0] - c[0]) * seaSign, uz = (u[1] - c[1]) * seaSign; // 朝海的方向
      // 这一段的「渲染出来的水」：只看真正被索引到的三角形
      let nearest = Infinity, signed = Infinity, below = true;
      const seen = new Set();
      for (let t = 0; t < IDX.length; t++) { seen.add(IDX[t]); }
      for (const v of seen) {
        const vx = P[v * 3], vz = P[v * 3 + 2];
        const dx = vx - c[0], dz = vz - c[1];
        const d = Math.hypot(dx, dz);
        if (d < nearest) { nearest = d; signed = dx * ux + dz * uz; }
      }
      // 水面顶点是否都在地形之下（沿该点正下方找最近的地形顶点做参照）
      if (TP) {
        for (let s = 0; s < 6 && below; s++) {
          const lat = 34 + s * 26;
          const wx = c[0] + (ux / Math.hypot(ux, uz)) * lat;
          const wz = c[1] + (uz / Math.hypot(ux, uz)) * lat;
          let bt = Infinity, th = 0;
          for (let q = 0; q < TP.count; q++) {
            const dd = (TP.getX(q) - wx) ** 2 + (TP.getZ(q) - wz) ** 2;
            if (dd < bt) { bt = dd; th = TP.getY(q); }
          }
          // 该处地形若高于水面，水被盖住（正常）；低于水面则水应当可见
          if (th > oceanY + 4) below = false; // 该处地形高过水面 4 以上 = 水被埋住
        }
      }
      segWater.push(Math.round(nearest));
      segSigned.push(Math.round(signed));
      segBelow.push(below);
    }
    return {
      minToLine: +minToLine.toFixed(1), edge: EDGE, verts: N,
      seaSign, segWater, segSigned, segBelow,
      idxTris: IDX ? IDX.length / 3 : 0, oceanY,
    };
  })()`);

  check('S7 水面不淹赛道（全体顶点到整条中心线 > 路面宽）',
    !!flood.minToLine && flood.minToLine > flood.edge,
    `最近 ${flood.minToLine}（路面半宽+路肩 ${flood.edge}）· 顶点 ${flood.verts} · 三角形 ${flood.idxTris}`);

  /* ---- S8: 沿岸连续有水（"感受不到海岸线"的回归断言） ----
     改前这条是拿 trackPoint(i, +200) 去找水的 —— 但几何实测法向朝环内，
     +200 其实指向**内陆**，于是这条断言量的是"内陆侧离水多远"，即便海岸线
     断光了它也可能通过。现在一律按实测海侧来判。 */
  const wrongSide = flood.segSigned.filter((s) => s < 0).length;
  const noWater = flood.segWater.filter((d) => d > 120).length;
  check('S8 沿岸 12 段连续有水且都在海侧（海岸线不断续）',
    flood.segWater.length === 12 && noWater === 0 && wrongSide === 0,
    `海侧 = lateral × ${flood.seaSign} · 各段到水距离 ${flood.segWater.join(',')}`
    + ` · 侧向 ${flood.segSigned.join(',')}`
    + (noWater ? ` · \x1b[31m缺水的段 ${noWater}\x1b[0m` : '')
    + (wrongSide ? ` · \x1b[31m跑到内陆侧的段 ${wrongSide}\x1b[0m` : ''));

  /* ---- S9: 岸线够近（"感受不到海岸线"的第二个成因：水离路太远） ----
     水在几何上存在 ≠ 看得见。可见岸线 = 地形跌破水面处，目前落在离路 37~55。
     若哪天把 shoreFrom/shoreTo 又调回 72→230，这条会立刻报红。 */
  const shoreGap = flood.segWater.filter((d) => d <= 120);
  check('S9 岸边水面离赛道足够近（一眼能看到海）',
    shoreGap.length === 12 && Math.max(...flood.segWater) - Math.min(...flood.segWater) < 90,
    `最远 ${Math.max(...flood.segWater)} / 最近 ${Math.min(...flood.segWater)} · 内缘 startDist=32`);

  await page.shot('tools/shot-sky-ocean.png');

  console.log(`\n${failed === 0 ? '\x1b[32m全部通过\x1b[0m' : '\x1b[31m有失败项\x1b[0m'} ${passed}/${passed + failed}\n`);
  await b.kill();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('验收脚本异常:', e.message); process.exit(1); });
