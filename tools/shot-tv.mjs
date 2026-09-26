/* ===========================================================================
 * shot-tv.mjs — 电视模式截图（菜单 + 比赛中）
 *
 * 视口强行设成 1920×1080：电视模式的判据是**观看距离**，只有在真实电视分辨率
 * 下才能看出「放大到什么程度」。验收脚本用的 1000×609 会让 fit() 把菜单倍率
 * 收到 1.14，截图完全不能代表实际效果。
 * =========================================================================*/
import { Browser, sleep } from './cdp.mjs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const BASE = process.env.DR_BASE || 'http://127.0.0.1:8790';

async function ensureServer() {
  const alive = () => fetch(BASE + '/api/health').then((r) => r.ok).catch(() => false);
  if (await alive()) return;
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    env: { ...process.env, PORT: new URL(BASE).port || '3000' },
    stdio: 'ignore', detached: true,
  });
  child.unref();
  for (let i = 0; i < 40; i++) { await delay(250); if (await alive()) return; }
  throw new Error('本地服务器启动失败');
}

await ensureServer();
const b = await Browser.launch({ port: 9446, profileName: 'cdp-shtv' });
const page = await b.newPage();
await page.send('Emulation.setDeviceMetricsOverride', {
  width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false,
});
await page.readyUrl(BASE + '/?tv=1');
for (let i = 0; i < 80; i++) {
  const r = await page.eval(`(window.__DR_READY__ && window.__DR_API__) ? 1 : 0`).catch(() => 0);
  if (r === 1) break;
  await sleep(300);
}
await sleep(3500);

/* 菜单：让焦点落在一个赛道卡上，顺便证明焦点框可见 */
await page.eval(`window.__DR_TVNAV__.focus()`);
await sleep(300);
await page.shot('shot-tv-menu.png');
console.log('菜单截图 shot-tv-menu.png', await page.eval(`(() => {
  const cs = getComputedStyle(document.documentElement);
  return { ui: cs.getPropertyValue('--ui').trim(), menu: cs.getPropertyValue('--ui-menu').trim() };
})()`));

await page.eval(`window.__DR_API__.start({ mode: 'solo', track: 'coast', laps: 3 })`);
await sleep(2000);
await page.eval(`window.__DR_API__.skipCountdown()`);
await sleep(6000);
await page.shot('shot-tv-race.png');
console.log('比赛截图 shot-tv-race.png');
await b.kill();
