/* ===========================================================================
 * util.js — 纯数学 / 随机 / 格式化工具（零依赖，可在 Node 与浏览器中直接跑）
 * =========================================================================*/

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
/** 帧率无关的指数趋近：lambda 越大越快 */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

/** 确定性伪随机（同一 seed 永远得到同一张地图） */
export function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 把角度归一化到 (-PI, PI] */
export function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** 毫秒 → m:ss.cc */
export function fmtTime(ms) {
  if (!isFinite(ms) || ms <= 0) return '--:--.--';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const c = Math.floor((ms % 1000) / 10);
  return `${m}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

/** 秒 → m:ss.cc */
export const fmtSec = (s) => fmtTime(s * 1000);

/** 生成 4 位房间码（去掉易混淆字符） */
export function makeRoomCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

/** 十六进制颜色 → [r,g,b] 0..1（供不依赖 three 的模块使用） */
export function hexToRgb(hex) {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

/** 从数组里按权重随机取 */
export function pickWeighted(rng, arr, weights) {
  let total = 0;
  for (const w of weights) total += w;
  let r = rng() * total;
  for (let i = 0; i < arr.length; i++) {
    r -= weights[i];
    if (r <= 0) return arr[i];
  }
  return arr[arr.length - 1];
}

/**
 * 名字池：AI 车手与默认玩家名。
 * 双语 {en,zh}，取用时用 pick(DRIVER_NAMES) 拿到当前语言的数组。
 * 注意：玩家名一旦生成就写进 prefs 持久化，切语言不会反过来改写已存的名字。
 */
export const DRIVER_NAMES = {
  en: [
    'Night Rider', 'Corner Poet', 'Turbo Freak', 'Brake Pad Killer',
    'Dusk Knight', 'Silent Wheel', 'Twin Tigers', 'Drift Intern',
    'Mirror Phobia', 'Third Corner', 'Pedal to the Metal', 'Rainy Night Run',
    'Sea Breeze & Oil', 'Desert Bell', 'Above the Snowline', 'City Hunter',
  ],
  zh: [
    '夜路狂飙', '弯道诗人', '涡轮怪客', '刹车片杀手', '黄昏骑士', '沉默方向盘',
    '两只老虎', '漂移实习生', '后视镜恐惧', '第三个弯道', '油门到底', '雨夜行车',
    '海风与机油', '沙漠驼铃', '雪线以上', '城市猎人',
  ],
};
