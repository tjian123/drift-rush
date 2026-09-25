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
 * ===========================================================================*/
import { Browser, sleep } from './cdp.mjs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

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
    ocean.material.uniforms.uSkyTop.value.setHex(0x8ec8ff);   // 还原成海岸色板原值
    return { ok: true, before, after, restored: sky.material.uniforms.uSkyTop.value.getHexString() };
  })()`);
  check('S3 从海面侧改 uniform，天空侧同步变化（数据流真实贯通）',
    !!flow.ok && flow.after === '112233' && flow.before !== flow.after,
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

  /* ---- S6: 太阳色来自色板（不再硬编码橙色） ---- */
  const sun = await page.eval(`(() => {
    let sky = null;
    window.__DR_SCENE__.traverse((o) => { if (o.name === 'sky') sky = o; });
    if (!sky) return { ok: false };
    const c = sky.material.uniforms.uSunColor.value;
    // 海岸色板 sun.color = 0xffefd0：线性空间下蓝通道应明显高于硬编码橙(1,0.72,0.42)
    return { ok: true, r: c.r, g: c.g, b: c.b };
  })()`);
  check('S6 太阳色取自赛道色板而非硬编码橙色（b 通道偏高）',
    !!sun.ok && sun.b > 0.5,
    `uSunColor = (${sun.r?.toFixed(3)}, ${sun.g?.toFixed(3)}, ${sun.b?.toFixed(3)})`);

  await page.shot('tools/shot-sky-ocean.png');

  console.log(`\n${failed === 0 ? '\x1b[32m全部通过\x1b[0m' : '\x1b[31m有失败项\x1b[0m'} ${passed}/${passed + failed}\n`);
  await b.kill();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('验收脚本异常:', e.message); process.exit(1); });
