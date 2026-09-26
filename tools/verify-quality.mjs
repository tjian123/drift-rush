/* ===========================================================================
 * verify-quality.mjs — 后处理 / 色调映射 / 泛光 / 云 / 阴影 的定量验收
 *
 * 【为什么需要它】
 * 这一整条链路有个讨厌的性质：**错了不会报错，只会"看起来不对"**。
 * 这轮就连续踩了四个全都无声无息的坑：
 *   ① 泛光阈值取 1.0 → 整片地面被算进泛光，画面洗白（不是"亮"，是"蒙了层雾"）
 *   ② 天空/海面是自定义 shader，从来不走色调映射；在后处理末端无差别补 ACES
 *      会把调色板的浓蓝洗成灰白（不是"变亮"，是"换了颜色"）
 *   ③ three 渲染到 RenderTarget 时强制 toneMapping = NoToneMapping，
 *      所以 ACES 只能放在合成阶段 —— 这条决定了整条链怎么摆
 *   ④ 云的投影系数取 0.30 → 天顶整片落进一个噪声格子，云糊成一条白带
 *       （不是"云太少"，是"尺度错了"）
 * 四个都不会抛异常，靠人眼看截图也说不清"到底差多少"。所以这里把它们变成断言。
 *
 * 【判据怎么定的】
 * 最关键的一条是 Q3：「天顶像素必须等于调色板里天顶色的十六进制值」。
 * 它一次性钉死了 调色板→线性→(掩码决定跳过 ACES)→sRGB 编码→屏幕 这整条路径，
 * 任何一环摆错位置都会让它偏移 —— 这正是②的回归断言。
 * ===========================================================================*/
import { Browser, sleep } from './cdp.mjs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { TRACKS } from '../src/config.js';

const BASE = process.env.DR_BASE || 'http://127.0.0.1:8790';
let passed = 0,
  failed = 0;

function check(name, ok, detail = '') {
  ok ? passed++ : failed++;
  console.log(
    `  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✘\x1b[0m'} ${name}` +
      (detail ? `  \x1b[2m${detail}\x1b[0m` : ''),
  );
}

async function ensureServer() {
  const alive = () =>
    fetch(BASE + '/api/health')
      .then((r) => r.ok)
      .catch(() => false);
  if (await alive()) return;
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    env: { ...process.env, PORT: new URL(BASE).port || '3000' },
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await delay(250);
    if (await alive()) return;
  }
  throw new Error('本地服务器启动失败');
}

const hex = (n) => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
const lum = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];

await ensureServer();
console.log('\x1b[1m画质 / 后处理验收\x1b[0m');
const b = await Browser.launch({ port: 9423, profileName: 'cdp-quality' });
const page = await b.newPage();
await page.readyUrl(BASE + '/');
await sleep(4000);
await page.eval(`(() => { window.__DR_API__.start({ mode: 'solo', track: 'coast', laps: 1 }); return true; })()`);
await sleep(1500);
await page.eval(`(() => { window.__DR_API__.skipCountdown(); return true; })()`);
await sleep(2500);

/* ---- Q1: 后处理链存在，且场景缓冲是 HDR 浮点 + 尺寸与 drawing buffer 一致 ---- */
const rt = await page.eval(`(() => {
  const p = window.__DR_API__.post();
  if (!p) return { err: 'no post' };
  const r = window.__DR_API__.state();
  return { size: p.size };
})()`);
const bufSize = await page.eval(`(() => {
  const c = document.querySelector('canvas');
  const r = window.__DR_API__.post().size;
  return { dw: c.width, dh: c.height, dwCss: c.clientWidth, dhCss: c.clientHeight, ratio: r.pixelRatio };
})()`);
check(
  'Q1 后处理缓冲尺寸与 drawing buffer 严格一致（不一致=拉伸或错位）',
  !!rt.size &&
    rt.size.w === bufSize.dw &&
    rt.size.h === bufSize.dh &&
    Math.abs(rt.size.cssW - bufSize.dwCss) <= 1,
  `rt=${rt.size?.w}×${rt.size?.h} · canvas=${bufSize.dw}×${bufSize.dh} · dpr=${bufSize.ratio}`,
);

const hdr = await page.eval(`(() => {
  const p = window.__DR_API__.post();
  return { half: p.hdrType === 'HalfFloat', samples: p.samples };
})()`);
check(
  'Q2 场景缓冲是浮点 HDR（亮部能超过 1.0，否则泛光无源可提）',
  hdr.half === true,
  `type=${hdr.half ? 'HalfFloatType' : '?'} · samples=${hdr.samples}`,
);

/* ---- Q3: 色彩管线往返（本轮最重要的回归断言） ----
   天顶像素必须等于调色板的 sky.top。为此把云量临时打到 0、相机近乎垂直朝天，
   此时 skyColor() 恒等于 uSkyTop，任何一环摆错都会让结果偏移。 */
const EXPECT_TOP = hex(TRACKS.coast.sky.top);
const zenith = await page.eval(`(() => {
  const A = window.__DR_API__;
  let sky = null;
  window.__DR_SCENE__.traverse((o) => { if (o.name === 'sky') sky = o; });
  sky.material.uniforms.uCloudAmt.value = 0;      // 排除云的干扰
  const i = Math.floor(A.trackN() * 0.3);
  const p = A.trackPoint(i, -80);
  // 不能给一个与 up 完全平行的 look，那样 lookAt 会退化；偏 1 个单位即可
  A.freeCam({ pos: [p[0], 60, p[1]], look: [p[0] + 1, 460, p[1]], fov: 60 });
  return true;
})()`);
await sleep(900);
const skyPx = await page.eval(`window.__DR_API__.sample(320, 240, 6)`);
const dR = Math.abs(skyPx[0] - EXPECT_TOP[0]);
const dG = Math.abs(skyPx[1] - EXPECT_TOP[1]);
const dB = Math.abs(skyPx[2] - EXPECT_TOP[2]);
check(
  'Q3 天顶像素 == 调色板 sky.top（色调映射被正确跳过，色彩空间往返成立）',
  dR <= 8 && dG <= 8 && dB <= 8,
  `实测 rgb(${skyPx.map((v) => Math.round(v)).join(',')}) · 期望 #${TRACKS.coast.sky.top.toString(16)}`
    + ` · Δ=(${dR.toFixed(0)},${dG.toFixed(0)},${dB.toFixed(0)})`,
);
// 还原云量（后面几条还要用云）
await page.eval(`(() => {
  let sky = null;
  window.__DR_SCENE__.traverse((o) => { if (o.name === 'sky') sky = o; });
  sky.material.uniforms.uCloudAmt.value = ${TRACKS.coast.cloud};
  return true;
})()`);

/* ---- Q4: 云真的出现在画面上，且带来的是"结构"而不是"整体变亮" ----
   只看亮度会被"云=加了一层白"骗过去，所以判据是**亮度的标准差**：
   云的明暗起伏会把画面方差拉大，均匀提亮不会。 */
/* 采样窗刻意避开两侧 HUD（左侧 RANK 面板、右上小地图）。它们又暗又有高对比线条，
   混进统计会把"云的起伏"整个稀释掉 —— 第一版 σ 只从 5.7 涨到 7.6 就是这个原因，
   而画面上云明明很显眼。**统计量不该被取景框以外的 UI 影响。** */
const GRID = `(() => {
  const out = [];
  for (let y = 55; y <= 335; y += 20)
    for (let x = 290; x <= 780; x += 30) out.push(A.sample(x, y, 2));
  return out.map((p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]);
})()`;

async function skyLum(amt) {
  await page.eval(`(() => {
    const A = window.__DR_API__;
    let sky = null;
    window.__DR_SCENE__.traverse((o) => { if (o.name === 'sky') sky = o; });
    sky.material.uniforms.uCloudAmt.value = ${amt};
    const i = Math.floor(A.trackN() * 0.3);
    const p = A.trackPoint(i, -80), q = A.trackPoint(i, -560);
    A.freeCam({ pos: [p[0], 20, p[1]], look: [q[0], 330, q[1]], fov: 62 });
    return true;
  })()`);
  await sleep(700);
  return page.eval(`(() => { const A = window.__DR_API__; return ${GRID}; })()`);
}

const noCloud = await skyLum(0);
const withCloud = await skyLum(TRACKS.coast.cloud);
/* 判据是「逐点比对」而不是「两个 σ 比大小」：同一批像素、同一个机位，两次之间
   唯一的差别就是云量，所以 HUD、地形、波浪全部自动抵消。
   它同时回答两个问题：云盖住了多少天（占比），以及云和天空差多少（强度）。
   而"整体提亮"这种伪影会在占比很小时也把均值拉高 —— 看均值就不上当。 */
const diff = noCloud.map((v, i) => Math.abs(withCloud[i] - v));
const changed = diff.filter((d) => d > 4).length / diff.length;
const meanDiff = diff.reduce((a, c) => a + c, 0) / diff.length;
const meanOf = (a) => a.reduce((x, y) => x + y, 0) / a.length;
check(
  'Q4 云确实盖住了可观的天空面积，且是局部结构（逐点比对，HUD/地形自动抵消）',
  changed > 0.12 && meanDiff > 3 && meanDiff < 40,
  `${(changed * 100).toFixed(0)}% 的天空被云改变（>4/255）· 平均变化 ${meanDiff.toFixed(1)}`
    + ` · 整幅均值 ${meanOf(noCloud).toFixed(0)}→${meanOf(withCloud).toFixed(0)}`
    + `（未整体提亮）`,
);

/* ---- Q5: 泛光真的在做功（对着太阳比较开/关） ---- */
async function sunShot(strength) {
  await page.eval(`(() => {
    const A = window.__DR_API__;
    let sky = null, sun = null;
    window.__DR_SCENE__.traverse((o) => { if (o.name === 'sky') sky = o; });
    sun = sky.material.uniforms.uSunDir.value;
    const i = Math.floor(A.trackN() * 0.3);
    const p = A.trackPoint(i, -80);
    A.freeCam({
      pos: [p[0], 40, p[1]],
      look: [p[0] + sun.x * 400, 40 + sun.y * 400, p[1] + sun.z * 400],
      fov: 62,
    });
    A.post().strength = ${strength};
    return true;
  })()`);
  await sleep(800);
  /* 不能手写几个点就去比：手写的点八成落在日轮本体上（两边都是 255 的饱和白），
     于是"泛光没生效"和"泛光把整片糊白"这两种相反的结论会同时看不出来。
     改成先扫一整片网格，再**只在亮度居中的那些点上**比较 —— 那里才有光晕。 */
  return page.eval(`(() => {
    const A = window.__DR_API__, out = [];
    /* 机位正对太阳，日轮就在画面中心：采样网格要**密**，否则一圈约 100 px 的
       晕光里只落得下几个点，会被判成"泛光没生效"（30px 网格实测只有 9 个点被提亮）。 */
    for (let y = 120; y <= 490; y += 18)
      for (let x = 250; x <= 740; x += 18) out.push(A.sample(x, y, 3));
    return out.map((p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]);
  })()`);
}
const bloomOff = await sunShot(0);
const bloomOn = await sunShot(0.2);
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
/* 取"关泛光时亮度在 60~235 之间"的像素：排除日轮本体（饱和）与地面阴影（无光晕） */
/* 判据不能是"整幅平均亮度"，那会被大量远离日轮的像素稀释成 0.5/255，
   看着像"泛光没生效"，其实是"测法不灵敏"。泛光是一圈**局部**晕光，
   所以要问的是：有多少个像素被它显著提亮了（以及最亮提到多少）。
   同时保留饱和守卫：如果整幅都被推到 255，那是"糊了"而不是"发光"。 */
const d = bloomOff.map((v, i) => bloomOn[i] - v);
const lit = d.filter((v) => v > 3).length;
const maxD = Math.max(...d);
/* 饱和占比要和"关泛光"时对比：这个机位正对太阳，本来就有一大片日轮本体是 255，
   拿绝对值当阈值只会测出"我在拍太阳"。有意义的判据是泛光有没有**额外**制造饱和。 */
const satOff = bloomOff.filter((v) => v >= 254).length / bloomOff.length;
const sat = bloomOn.filter((v) => v >= 254).length / bloomOn.length;
check(
  'Q5 泛光在日轮周围形成可测的局部晕光，且没有把整幅画面糊白',
  lit >= 30 && maxD > 8 && sat - satOff < 0.06
    && Math.abs(avg(bloomOn) - avg(bloomOff)) < 6,
  `被提亮 >3 的采样点 ${lit}/${d.length} · 峰值 +${maxD.toFixed(0)}`
    + ` · 饱和占比 ${(satOff * 100).toFixed(0)}%→${(sat * 100).toFixed(0)}%`
    + ` · 全幅均值 ${avg(bloomOff).toFixed(0)}→${avg(bloomOn).toFixed(0)}`,
);
await page.eval(`(() => { window.__DR_API__.post().strength = 0.2; return true; })()`);

/* ---- Q6: 阴影分辨率与包围盒 ---- */
const shadow = await page.eval(`(() => {
  let d = null;
  window.__DR_SCENE__.traverse((o) => { if (o.isDirectionalLight && o.castShadow) d = o; });
  if (!d) return { err: 'no shadow light' };
  const c = d.shadow.camera;
  return { size: d.shadow.mapSize.x, span: c.right - c.left };
})()`);
check(
  'Q6 阴影图 2048 且范围收紧（texel 越小，车与树的投影边缘越干净）',
  shadow.size === 2048 && shadow.span <= 100,
  `${shadow.size}² · 覆盖 ${shadow.span} 单位 · ${(shadow.span / shadow.size).toFixed(3)} 单位/texel`,
);

/* ---- Q7: 分屏时两半都被真实渲染（后处理只在半屏合成的经典 bug） ---- */
await page.eval(`(() => { window.__DR_API__.freeCam(null); window.__DR_API__.quit(); return true; })()`);
await sleep(1200);
await page.eval(`(() => {
  window.__DR_API__.start({ mode: 'split', track: 'coast', laps: 1 });
  return true;
})()`);
await sleep(2500);
const split = await page.eval(`(() => {
  const A = window.__DR_API__, out = { top: [], bottom: [] };
  for (let x = 300; x <= 700; x += 100) {
    out.top.push(A.sample(x, Math.round(innerHeight * 0.25), 3));
    out.bottom.push(A.sample(x, Math.round(innerHeight * 0.75), 3));
  }
  return {
    top: out.top.map((p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]),
    bottom: out.bottom.map((p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]),
  };
})()`);
const topAvg = avg(split.top),
  botAvg = avg(split.bottom);
check(
  'Q7 分屏上下两半都有真实内容（防"合成只画进半屏、另半屏是残影"）',
  topAvg > 8 && botAvg > 8,
  `上半亮度 ${topAvg.toFixed(1)} · 下半亮度 ${botAvg.toFixed(1)}`,
);

console.log(
  `\n${failed === 0 ? '\x1b[32m全部通过' : '\x1b[31m有失败项'} ${passed}/${passed + failed}\x1b[0m`,
);
await b.kill();
process.exit(failed === 0 ? 0 : 1);
