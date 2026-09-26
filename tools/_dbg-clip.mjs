import { Browser, sleep } from './cdp.mjs';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:8790';
const b = await Browser.launch({ port: 9447, profileName: 'cdp-clip' });
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
await sleep(2500);
await page.eval(`window.__DR_API__.start({ mode: 'solo', track: 'coast', laps: 3 })`);
await sleep(2000);
await page.eval(`window.__DR_API__.skipCountdown()`);
await sleep(5000);

// 底部右侧 HUD 区域放大看
const r = await page.send('Page.captureScreenshot', {
  format: 'png',
  clip: { x: 1620, y: 880, width: 300, height: 200, scale: 2 },
});
fs.writeFileSync('tools/_clip-speed.png', Buffer.from(r.data, 'base64'));
console.log('boxes:', await page.eval(`(() => {
  const ids = ['speedbox','speednum','speedunit','gear','rpmbar','rpmfill'];
  const out = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) { out[id] = null; continue; }
    const b = el.getBoundingClientRect();
    out[id] = { l: Math.round(b.left), t: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
  }
  return { vw: innerWidth, vh: innerHeight, out };
})()`));
await b.kill();
