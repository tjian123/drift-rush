/* 临时脚本：拍海岸线效果图。
   · r1/r2/r3：站在路肩朝海看（玩家真实视角）
   · drive   ：贴着海岸的巡航视角（看海平线与岸线是否连贯）
   · water   ：离岸低空看水面（判断反射/波浪/岸边碎浪）
   用法：SHOT_NAME=xxx node tools/_shot-coast.mjs
   机位全部由赛道几何推导（trackPoint），不依赖海面自身的位置，
   这样 before/after 两次拍摄即使几何完全改掉也能对齐。 */
import { Browser, sleep } from './cdp.mjs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const BASE = process.env.DR_BASE || 'http://127.0.0.1:8790';
const NAME = process.env.SHOT_NAME || 'shot';

async function ensureServer() {
  if (await fetch(BASE + '/api/health').then((r) => r.ok).catch(() => false)) return;
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

await ensureServer();
const b = await Browser.launch({ port: 9422, profileName: 'cdp-coast-' + NAME });
const page = await b.newPage();
await page.readyUrl(BASE + '/');
await sleep(4000);

await page.eval(`(() => { window.__DR_API__.start({ mode: 'solo', track: 'coast', laps: 1 }); return true; })()`);
await sleep(1500);
await page.eval(`(() => { window.__DR_API__.skipCountdown(); return true; })()`);
await sleep(2500);

/* 海岸朝向不写死：从海面网格里量出「最近海面顶点在赛道的哪一侧」。
   过去手写 SEA_SIGN 曾把镜头怼向内陆，纯属自找麻烦。 */
const SEA_SIGN = await page.eval(`(() => {
  const A = window.__DR_API__, scene = window.__DR_SCENE__;
  let ocean = null;
  scene.traverse((o) => { if (o.isMesh && o.material && o.material.uniforms && o.material.uniforms.uShallow) ocean = o; });
  if (!ocean) return 1;
  const p = ocean.geometry.attributes.position;
  let acc = 0, n = 0;
  for (let s = 0; s < 12; s++) {
    const i = Math.floor((A.trackN() * s) / 12);
    const c = A.trackPoint(i, 0), u = A.trackPoint(i, 1);
    const ux = u[0] - c[0], uz = u[1] - c[1];
    let bd = Infinity, bi = -1;
    for (let k = 0; k < p.count; k += 7) {
      const d = (p.getX(k) - c[0]) ** 2 + (p.getZ(k) - c[1]) ** 2;
      if (d < bd) { bd = d; bi = k; }
    }
    acc += (p.getX(bi) - c[0]) * ux + (p.getZ(bi) - c[1]) * uz;
    n++;
  }
  return acc / n > 0 ? 1 : -1;
})()`);
console.log('海岸侧: lateral * ' + SEA_SIGN);

async function roadShot(tag, frac) {
  const info = await page.eval(`(() => {
    const A = window.__DR_API__, s = ${SEA_SIGN};
    const i = Math.floor(A.trackN() * ${frac});
    const p0 = A.trackPoint(i, 0), p8 = A.trackPoint(i, 9 * s);
    const dx = p8[0] - p0[0], dz = p8[1] - p0[1];
    const L = Math.hypot(dx, dz) || 1, ux = dx / L, uz = dz / L;
    A.freeCam({
      pos: [p0[0] + ux * 4, 6.0, p0[1] + uz * 4],
      look: [p0[0] + ux * 380, 1.5, p0[1] + uz * 380],
      fov: 72,
    });
    return { i };
  })()`);
  await sleep(2200);
  await page.shot(`tools/shot-coast-${NAME}-${tag}.png`);
  console.log('拍摄 ' + tag, JSON.stringify(info));
}

/* 沿路朝前方看：这才是玩家真实所见 —— 岸线是否连贯、海平线是否成一条线。
   机位挂在路面上方 4.5，朝前 340 单位；同时向海侧偏一点点，
   让画面里既有路面又有海面。 */
async function driveShot(tag, frac) {
  await page.eval(`(() => {
    const A = window.__DR_API__, s = ${SEA_SIGN};
    const i = Math.floor(A.trackN() * ${frac});
    const p0 = A.trackPoint(i, 0), p6 = A.trackPoint(i + 9, 0);
    const dx = p6[0] - p0[0], dz = p6[1] - p0[1];
    const L = Math.hypot(dx, dz) || 1, ux = dx / L, uz = dz / L;
    const u = A.trackPoint(i, 1), c = A.trackPoint(i, 0);
    const nx = (u[0] - c[0]) * s, nz = (u[1] - c[1]) * s; // 朝海的法向
    const ahead = A.trackPoint(i + 46, 14 * s);
    A.freeCam({
      pos: [p0[0] - ux * 26 + nx * 5, 4.6, p0[1] - uz * 26 + nz * 5],
      look: [ahead[0] + nx * 10, 2.0, ahead[1] + nz * 10],
      fov: 74,
    });
    return true;
  })()`);
  await sleep(2200);
  await page.shot(`tools/shot-coast-${NAME}-${tag}.png`);
  console.log('拍摄 ' + tag);
}

async function waterShot() {
  await page.eval(`(() => {
    const A = window.__DR_API__, s = ${SEA_SIGN};
    const i = Math.floor(A.trackN() * 0.42);
    const p0 = A.trackPoint(i, 0), p8 = A.trackPoint(i, 9 * s);
    const dx = p8[0] - p0[0], dz = p8[1] - p0[1];
    const L = Math.hypot(dx, dz) || 1, ux = dx / L, uz = dz / L;
    A.freeCam({
      pos: [p0[0] + ux * 240, 12, p0[1] + uz * 240],
      look: [p0[0] + ux * 900, -1, p0[1] + uz * 900],
      fov: 64,
    });
    return true;
  })()`);
  await sleep(2200);
  await page.shot(`tools/shot-coast-${NAME}-water.png`);
  console.log('拍摄 water');
}

await roadShot('r1', 0.15);
await roadShot('r2', 0.42);
await roadShot('r3', 0.7);
await driveShot('drive', 0.3);
await waterShot();

/* 最后一张：撤掉调试机位，拍游戏真实的追尾相机 —— 前面几张都是验收机位，
   玩家实际看到的是这一张，它才是"能不能感受到海岸线"的最终判据。 */
await page.eval(`(() => { window.__DR_API__.freeCam(null); return true; })()`);
await sleep(2500);
await page.shot(`tools/shot-coast-${NAME}-chase.png`);
console.log('拍摄 chase（真实追尾相机）');

await b.kill();
