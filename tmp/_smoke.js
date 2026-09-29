(() => {
  // src/util.js
  var clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  var lerp = (a, b, t) => a + (b - a) * t;
  var smoothstep = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  var damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
  function makeRng(seed) {
    let s = seed >>> 0 || 1;
    return () => {
      s = s * 1664525 + 1013904223 >>> 0;
      return s / 4294967296;
    };
  }
  function wrapAngle(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }
  function fmtTime(ms) {
    if (!isFinite(ms) || ms <= 0) return "--:--.--";
    const m = Math.floor(ms / 6e4);
    const s = Math.floor(ms % 6e4 / 1e3);
    const c = Math.floor(ms % 1e3 / 10);
    return `${m}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
  }
  var fmtSec = (s) => fmtTime(s * 1e3);
  function makeRoomCode() {
    const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let s = "";
    for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
    return s;
  }
  function hexToRgb(hex) {
    return [(hex >> 16 & 255) / 255, (hex >> 8 & 255) / 255, (hex & 255) / 255];
  }
  function pickWeighted(rng, arr, weights) {
    let total = 0;
    for (const w of weights) total += w;
    let r = rng() * total;
    for (let i = 0; i < arr.length; i++) {
      r -= weights[i];
      if (r <= 0) return arr[i];
    }
    return arr[arr.length - 1];
  }
  var DRIVER_NAMES = [
    "\u591C\u8DEF\u72C2\u98D9",
    "\u5F2F\u9053\u8BD7\u4EBA",
    "\u6DA1\u8F6E\u602A\u5BA2",
    "\u5239\u8F66\u7247\u6740\u624B",
    "\u9EC4\u660F\u9A91\u58EB",
    "\u6C89\u9ED8\u65B9\u5411\u76D8",
    "\u4E24\u53EA\u8001\u864E",
    "\u6F02\u79FB\u5B9E\u4E60\u751F",
    "\u540E\u89C6\u955C\u6050\u60E7",
    "\u7B2C\u4E09\u4E2A\u5F2F\u9053",
    "\u6CB9\u95E8\u5230\u5E95",
    "\u96E8\u591C\u884C\u8F66",
    "\u6D77\u98CE\u4E0E\u673A\u6CB9",
    "\u6C99\u6F20\u9A7C\u94C3",
    "\u96EA\u7EBF\u4EE5\u4E0A",
    "\u57CE\u5E02\u730E\u4EBA"
  ];
})();
