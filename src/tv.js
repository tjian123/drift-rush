/* ===========================================================================
 * src/tv.js — 电视模式 / 投屏支持
 *
 * 投屏要解决的其实是三件互相独立的事，本模块只管前两件：
 *   ① 画面怎么过去 —— 系统级投屏（HDMI / AirPlay / Miracast / 投射标签页）。
 *      Web 标准里没有「把 canvas 投到电视」的通用 API：Remote Playback API 只
 *      作用于 <video>/<audio>，Presentation API 需要 Chromecast 且仅 Chromium
 *      支持。所以这件事只能交给操作系统，本模块负责把画面**适配成在电视上看
 *      得清的样子**。
 *   ② 看得清 —— HUD 与菜单按**观看距离**放大。注意判据不是分辨率：电视和
 *      显示器可能都是 1920×1080，但观看距离从 50cm 变成 3 米，同样的 70px
 *      码表在视网膜上的张角只剩几分之一。
 *   ③ 用什么操控 —— 手柄（src/pad.js）驾驶，菜单焦点导航见 src/tvnav.js。
 *
 * 电视模式的触发优先级：URL 参数 > 本地存储 > UA 自动识别。
 * 之所以把 UA 放在最后且允许覆盖：UA 会骗人（安卓 TV 的浏览器 UA 有时和手机
 * 一样，而接了电视的桌面浏览器 UA 完全看不出来），所以必须有显式开关兜底。
 * =========================================================================*/

/** 智能电视 / 电视盒子 / 游戏主机的 UA 特征（不含裸 "TV" 二字，误判太多） */
const TV_UA_RE =
  /Tizen|webOS|Android TV|GoogleTV|Chromecast|CrKey|PlayStation|Xbox|SMART-?TV|NetCast|AppleTV|Roku|Hisense|Viera|BRAVIA|AQUOS|FireTV/i;

/** 移动/嵌入式 GPU：出现在电视或盒子上时，说明满画质基本跑不动 */
const WEAK_GPU_RE =
  /Mali|Adreno|PowerVR|VideoCore|Apple A|IMG|Tegra|Vivante|GC\d000/i;

const KEY = "dr-tv-mode";

/* 默认缩放：桌面 24" 观看 50cm 的张角约 46°，55" 电视观看 3 米约 22°，
   所以要达到同样的视觉张角需要放大到约 2 倍。
   菜单另取 1.5 —— 它是 flex 纵向布局，跟着 HUD 放大 2 倍会顶出视口。 */
const DEFAULT_HUD_SCALE = 2.0;
const DEFAULT_MENU_SCALE = 1.5;

function readStored() {
  try {
    return JSON.parse(localStorage.getItem(KEY));
  } catch (e) {
    return null;
  }
}

function writeStored(v) {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch (e) {
    /* 隐私模式下写不进去，不影响本次会话 */
  }
}

/**
 * @param {{onChange?: (on: boolean, why: string) => void}} opts
 */
export function createTV(opts = {}) {
  const root = document.documentElement;
  const url = new URLSearchParams(location.search);

  /* ---- 1. 判定初始状态 ---- */
  let enabled;
  let why;
  const q = (url.get("tv") || "").toLowerCase();
  if (q === "1" || q === "on" || q === "true") {
    enabled = true;
    why = "url";
  } else if (q === "0" || q === "off" || q === "false") {
    enabled = false;
    why = "url";
  } else {
    /* 原生壳可用 __DR_TV_OVERRIDE 显式覆盖（如 Windows PC 桌面模式要关电视模式）。
       未设置时沿用旧逻辑：离线/打包（file: 或 __DR_TV_FORCE）一律电视，线上 https
       不受影响。仍可用 ?tv=0 显式关闭。 */
    if (typeof window.__DR_TV_OVERRIDE === "boolean") {
      enabled = window.__DR_TV_OVERRIDE;
      why = "override";
    } else if (location.protocol === "file:" || window.__DR_TV_FORCE === true) {
      enabled = true;
      why = "offline";
    } else {
      const stored = readStored();
      if (typeof stored === "boolean") {
        enabled = stored;
        why = "stored";
      } else {
        enabled = TV_UA_RE.test(navigator.userAgent);
        why = enabled ? "ua" : "default";
      }
    }
  }

  /* 允许用 URL 微调缩放（电视尺寸/观看距离差异很大，2.0 只是中位值） */
  const num = (k, d) => {
    const v = parseFloat(url.get(k));
    return Number.isFinite(v) && v > 0.5 && v <= 4 ? v : d;
  };
  const hudScale = num("ui", DEFAULT_HUD_SCALE);
  const menuScale = num("uimenu", DEFAULT_MENU_SCALE);

  let fullscreenWanted = false;

  function apply() {
    root.style.setProperty("--ui", enabled ? String(hudScale) : "1");
    root.style.setProperty("--ui-menu", enabled ? String(menuScale) : "1");
    document.body.classList.toggle("tv", enabled);
    fit();
  }

  /* 菜单整屏可见的兜底。
     为什么必须做：菜单是纵向 flex，放大 1.5 倍后在 720p 的电视上很容易顶出
     视口 —— 而电视上**没有滚动条可拖**，超出部分等于永久不可达（焦点系统的
     scrollIntoView 能救一部分，但"开始比赛"被顶到屏幕外就没法开赛了）。
     所以放大后量一次 scrollHeight，放不下就逐档往回收，最低回到 1（不放大）。
     注意要在菜单内容构建完之后量才有意义，故由 app 在 boot 末尾再调一次。 */
  let fitted = null; // 已收回到过的最小倍率

  function fit(force) {
    const menu = document.getElementById("screen-menu");
    if (!menu) return;
    if (!enabled) {
      fitted = null;
      root.style.setProperty("--ui-menu", "1");
      return;
    }
    if (force) fitted = null; // 视口变了才允许放大回去
    /* 从「上次收回后的倍率」起步并且只降不升：分步菜单的第 3 步最高，
       若每次都从 1.5 重来，切步骤时菜单会忽大忽小地跳。 */
    let s = fitted === null ? menuScale : Math.min(menuScale, fitted);
    for (let i = 0; i < 16; i++) {
      root.style.setProperty("--ui-menu", s.toFixed(2));
      if (menu.scrollHeight <= menu.clientHeight) break;
      s -= 0.06;
      if (s <= 1) {
        s = 1;
      }
    }
    root.style.setProperty("--ui-menu", s.toFixed(2));
    fitted = s;
  }

  addEventListener("resize", () => {
    clearTimeout(fit._t);
    fit._t = setTimeout(() => fit(true), 150);
  });

  /* 菜单内容是分批补齐的（云端状态行、成就统计、最佳圈速都在 boot 之后才写），
     只在 boot 末尾量一次会偏小。而且有些增长**不产生 DOM 变更**（字体度量、
     赛道卡横向滚动条占位等），MutationObserver 抓不到 —— 所以主力用
     ResizeObserver 盯各块的**实际高度**，任何一块变高就重量一次倍率。 */
  try {
    const menu = document.getElementById("screen-menu");
    if (!menu) throw new Error("no menu");
    const refit = () => {
      clearTimeout(fit._m);
      fit._m = setTimeout(() => fit(), 80);
    };
    if (typeof MutationObserver !== "undefined")
      new MutationObserver(refit).observe(menu, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(refit);
      for (const c of menu.children) ro.observe(c);
    }
  } catch (e) {
    /* 老浏览器没有这些 API：退回「只在 boot / resize 时量」，不放大到溢出即可 */
  }

  /* ---- 2. 全屏 ----
     必须由用户手势触发：自动进入电视模式（URL/UA）时浏览器会拒绝，
     所以挂一个「首次交互再补一次」的钩子，而不是在启动时直接调。 */
  async function requestFullscreen() {
    const el = document.documentElement;
    try {
      if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: "hide" });
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      return true;
    } catch (e) {
      return false;
    }
  }

  function onFirstGesture() {
    if (!enabled || document.fullscreenElement || fullscreenWanted) return;
    fullscreenWanted = true; // 只试一次，被拒就不反复打扰
    requestFullscreen();
  }
  addEventListener("pointerdown", onFirstGesture, { passive: true });
  addEventListener("keydown", onFirstGesture, { passive: true });

  /* ---- 3. 画质上限 ----
     电视/盒子的 GPU 普遍弱，而且满画质还带后处理与 2048 阴影贴图。
     这里只给「上限」，用户的手动选择低于上限时不受影响。 */
  function maxLevel() {
    if (!enabled) return 2;
    if (WEAK_GPU_RE.test(gpuName())) return 0;
    return TV_UA_RE.test(navigator.userAgent) ? 1 : 2;
  }

  let cachedGpu = null;
  function gpuName() {
    if (cachedGpu !== null) return cachedGpu;
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl") || c.getContext("experimental-webgl");
      const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
      cachedGpu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "";
    } catch (e) {
      cachedGpu = "";
    }
    return cachedGpu;
  }

  /* ---- 4. 对外接口 ---- */
  const api = {
    get enabled() {
      return enabled;
    },
    get reason() {
      return why;
    },
    get hudScale() {
      return enabled ? hudScale : 1;
    },
    get menuScale() {
      return enabled ? menuScale : 1;
    },
    /** 菜单内容重建 / 视口变化后重新量一次放大倍率（见 fit 的注释） */
    fit,
    /** 是否识别为电视设备（与「是否开启电视模式」是两回事） */
    isTVDevice() {
      return TV_UA_RE.test(navigator.userAgent);
    },
    gpuName,
    maxLevel,
    requestFullscreen,
    get isFullscreen() {
      return !!document.fullscreenElement;
    },
    set(on) {
      const next = !!on;
      if (next === enabled) return enabled;
      enabled = next;
      why = "manual";
      writeStored(enabled);
      apply();
      opts.onChange && opts.onChange(enabled, why);
      return enabled;
    },
    toggle() {
      return api.set(!enabled);
    },
  };

  apply();
  return api;
}
