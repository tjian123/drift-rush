/* ===========================================================================
 * tools/build-offline.mjs — 把网页版游戏打成「非 module 单文件」离线包
 *
 * 为什么需要它：
 *   电视端原生壳（Android TV / 鸿蒙 TV 的 WebView）用 file:// 或 rawfile 加载
 *   本地 HTML。浏览器在 file:// 下**禁止 ES module**（CORS 拦截），所以原本的
 *   <script type="module"> 在离线壳里跑不起来。本脚本把整棵模块依赖树（含本地
 *   自托管的 three.module.js）用 esbuild 打成单个 IIFE bundle.js，再把 CSS 内联
 *   进 index.html —— 离线壳用经典 <script src> 即可零依赖运行。
 *
 * 产物：drift-rush-tv-apps/offline/{ index.html, bundle.js }
 *   （游戏本身无二进制素材：纹理是 canvas 程序化生成、音效是 Web Audio 合成，
 *    所以离线包只有这两个文本文件，无需拷贝图片/音频。）
 *
 * 离线降级：
 *   - 不引入云 SDK（62KB），改为注入一个「离线桩」window.WorkBuddyCloud，让
 *     账号/排行榜在无网络时立即走「云服务不可用」分支，而不是卡 15s CDN 超时。
 *   - 电视模式：注入 window.__DR_TV_FORCE + 检测 file://（src/tv.js 已支持），
 *     离线包一律按电视处理；仍可用 ?tv=0 显式关闭。
 * =========================================================================*/

import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");                       // drift-rush/
const appsDir = resolve(root, "..", "drift-rush-tv-apps");  // 同级 TV 应用工程
const outDir = resolve(appsDir, "offline");

mkdirSync(outDir, { recursive: true });

const THREE_ALIAS = resolve(root, "vendor", "three.module.js");

// 1) 打包 JS -> 单个 IIFE
const result = await build({
  entryPoints: [resolve(root, "src", "app.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2018",                 // 电视 WebView 偏老，降到 es2018 更稳
  outfile: resolve(outDir, "bundle.js"),
  alias: { three: THREE_ALIAS },
  logLevel: "info",
  legalComments: "none",
  sourcemap: false,
});
if (result.errors && result.errors.length) {
  console.error("esbuild 失败：", result.errors);
  process.exit(1);
}

// 2) 读取并内联 CSS
const css = readFileSync(resolve(root, "src", "style.css"), "utf8");

// 3) 读取现网 index.html，程序化变换（保持 DOM 与源同步）
let html = readFileSync(resolve(root, "index.html"), "utf8");

// 3.1 去掉 importmap（离线不再需要裸模块映射）
html = html.replace(/<script type="importmap">[\s\S]*?<\/script>/, "");

// 3.2 去掉云 SDK 外链（离线用桩替代）
html = html.replace(
  /<script src="\/vendor\/workbuddy-cloud\.global\.js"><\/script>/,
  ""
);

// 3.3 CSS link -> 内联 <style>
html = html.replace(
  /<link rel="stylesheet" href="\/src\/style\.css" \/>/,
  `<style>\n${css}\n</style>`
);

// 3.4 离线 stub：必须在 bundle.js 之前执行（head 内）
const stub = `<script>
  /* 离线 / 打包形态：强制电视模式 + 云服务离线桩（不卡 15s CDN 超时）
     + 标记 __DR_OFFLINE —— 暂不暴露联机入口：file:// 下连不上真实服务器，
       买家点了会报错/卡死，直接拉差评与退款率。联机服务器代码完整保留，
       待商业模式验证后再接。当前出货场景只暴露 单人计时 + 本地分屏。 */
  window.__DR_OFFLINE = true;
  window.__DR_TV_FORCE = true;
  window.WorkBuddyCloud = {
    createWorkBuddyCloud: function () {
      throw new Error("offline: 云服务在离线包中不可用");
    },
  };
</script>`;
html = html.replace("</head>", `${stub}\n</head>`);

// 3.5 module 入口 -> 经典 IIFE 脚本
html = html.replace(
  /<script type="module" src="\/src\/app\.js"><\/script>/,
  `<script src="bundle.js"></script>`
);

// 3.6 注入系统控制浮层（返回 / 退出）
//     仅「桌面 / 手柄」模式显示：TV 用遥控器、触屏用 #tpause 与菜单返回键，两者都不需要它。
//     显示判据：body 既没有 .tv（电视模式）也没有 .touch-on（触屏模式）。
//     - 返回：比赛中 → 暂停并弹出暂停菜单；任何子界面（大厅/结算/账号/排行榜/暂停）→ 退回主菜单；主菜单 → 上一步。
//     - 退出：若原生壳注入 window.__drNativeExit 则交给原生（Windows 关窗 / iOS 回菜单），
//             否则退回主菜单（浏览器无法真正关闭自身）。
const sysCss = `
  /* ---------- 系统控制浮层：原生壳桌面/手柄模式显示 返回/退出 ----------
     z-index 必须高于 .screen(30) / #screen-help(31) / #rotate-hint(40)，
     否则整个屏幕层盖在按钮上：看得见、点不到（曾经写 29，就是这个毛病）。
     放在右下角而不是右上角：右上有小地图 #mapwrap，右上也是菜单顶栏 .menu-links
     （语言切换按钮就在那里），压上去等于把常用按钮挡死。 */
  #dr-sys { position: fixed; right: calc(12px * var(--ui)); bottom: calc(12px * var(--ui)); z-index: 45;
    display: none; gap: calc(8px * var(--ui)); pointer-events: none; }
  #dr-sys.show { display: flex; }
  /* 比赛中右下角是速度表 #speedbox，浮层整体上移让开它 */
  #dr-sys.racing { bottom: calc(104px * var(--ui)); }
  #dr-sys button { pointer-events: auto; font-family: inherit; cursor: pointer;
    padding: calc(8px * var(--ui)) calc(14px * var(--ui)); border-radius: calc(10px * var(--ui));
    border: calc(1px * var(--ui)) solid var(--line-strong); background: rgba(10,14,26,.62);
    color: var(--text); font-size: calc(12px * var(--ui)); font-weight: 700; letter-spacing: calc(1px * var(--ui));
    backdrop-filter: blur(7px); -webkit-backdrop-filter: blur(7px); }
  #dr-sys button:hover { border-color: var(--amber); color: var(--amber); }
  #dr-sys button.exit:hover { border-color: var(--red); color: var(--red); }

  /* 离线 / 打包形态：隐藏「在线联机」模式按钮（同屏双人 + 单人计时已够用，
     且 file:// 下无服务器可连，暴露它只会带来差评/退款）。 */
  #mode-seg button[data-mode="online"] { display: none !important; }
`;
html = html.replace("</style>", `${sysCss}\n</style>`);

const sysHtml = `
  <!-- 系统控制浮层：桌面/手柄模式显示 返回/退出（原生壳用，TV/触屏由各自 UI 负责）
       文案默认英文：离线包面向 itch.io 欧美买家；切中文时由 applyI18n 就地替换。 -->
  <div id="dr-sys">
    <button id="dr-back" type="button" data-i18n="sys.back">Back</button>
    <button id="dr-exit" class="exit" type="button" data-i18n="sys.exit">Exit</button>
  </div>
  <script>
  (function () {
    /* 取**最上层**可见的 .screen，不能只取第一个：
       showScreen() 只管 menu/lobby/pause/result 四个的 hide，
       账号 / 排行榜 / 帮助是**叠加层**——打开时菜单并不隐藏。
       判据：z-index 大的优先，同 z-index 取 DOM 里靠后的。 */
    function visibleScreen() {
      var list = [].slice.call(document.querySelectorAll('.screen:not(.hide)'));
      if (!list.length) return null;
      var best = list[0], bestZ = parseInt(getComputedStyle(best).zIndex, 10) || 0;
      for (var i = 1; i < list.length; i++) {
        var z = parseInt(getComputedStyle(list[i]).zIndex, 10) || 0;
        if (z >= bestZ) { best = list[i]; bestZ = z; } // >= ：同层时后出现的压在上面
      }
      return best;
    }
    /* 必须同时给 code 和 key：游戏里 P 键走 e.code，而 Escape 走 e.key。
       只传 code 的话 Escape 永远匹配不上 —— 按钮就成了摆设。 */
    function dispatchKey(code, key) {
      document.dispatchEvent(new KeyboardEvent('keydown',
        { code: code, key: key, bubbles: true, cancelable: true }));
    }
    function clickById(id) { var el = document.getElementById(id); if (el) { el.click(); return true; } return false; }
    function api() { return window.__DR_API__; }
    function hasNativeExit() { return typeof window.__drNativeExit === 'function'; }

    window.DriftRush = window.DriftRush || {};
    /* 叠加型面板（打开时菜单仍可见）要关它自己，不能靠 quit() —— quit 只切
       showScreen，管不到这几个叠加层，直接调用会留下一个关不掉的面板。 */
    var OWN_BACK = {
      'screen-account': 'btn-acc-back',
      'screen-board': 'btn-board-back',
      'screen-help': 'btn-help-close',
    };
    window.DriftRush.back = function () {
      var top = visibleScreen();
      if (!top) { dispatchKey('KeyP', 'p'); return; }  // 比赛中 → 暂停并弹出暂停菜单
      if (top.id === 'screen-menu') return;            // 根界面，无处可退（此时按钮本就隐藏）
      if (top.id === 'screen-pause') { clickById('btn-quit'); return; }
      if (OWN_BACK[top.id] && clickById(OWN_BACK[top.id])) return;
      /* 大厅 / 结算：走真实 API，不模拟 Escape —— Escape 只有电视导航在监听 */
      if (api() && api().quit) { api().quit(); return; }
      clickById('btn-quit');
    };
    window.DriftRush.exit = function () {
      if (hasNativeExit()) { window.__drNativeExit(); return; }
      window.DriftRush.back(); // 浏览器等无原生退出能力时，退回主菜单
    };

    function sync() {
      var el = document.getElementById('dr-sys');
      if (!el) return;
      var body = document.body;
      /* TV 用遥控器、触屏有各自的返回 UI，都不需要这个浮层 */
      var show = !body.classList.contains('tv') && !body.classList.contains('touch-on');
      el.classList.toggle('show', show);

      var scr = visibleScreen();
      el.classList.toggle('racing', !scr); // 比赛中让开右下角速度表

      /* 主菜单是根界面，没有「上一步」可退 —— 此时只留退出，避免点了没反应 */
      var b = document.getElementById('dr-back');
      if (b) b.style.display = (scr && scr.id === 'screen-menu') ? 'none' : '';
      /* 没有原生退出桥（浏览器里 window.close 对普通标签页无效）就不给退出按钮，
         否则点了只是退回菜单，看着像坏了。 */
      var x = document.getElementById('dr-exit');
      if (x) x.style.display = hasNativeExit() ? '' : 'none';
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', sync);
    } else { sync(); }
    if (window.MutationObserver) {
      new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
    /* 界面切换改的是子元素的 class，body 上的 observer 收不到，靠低频轮询补齐 */
    setInterval(sync, 300);

    var b = document.getElementById('dr-back');
    if (b) b.addEventListener('click', function () { window.DriftRush.back(); });
    var x = document.getElementById('dr-exit');
    if (x) x.addEventListener('click', function () { window.DriftRush.exit(); });
  })();
  </script>
`;
html = html.replace("</body>", `${sysHtml}\n  </body>`);

writeFileSync(resolve(outDir, "index.html"), html, "utf8");

/* --------------------------------------------------------------------------
 * 同步进各原生壳的资源目录，一条命令即可更新壳内离线包：
 *   Android：app/src/main/assets/drift-rush/   -> file:///android_asset/drift-rush/
 *   鸿蒙：   entry/.../resources/rawfile/drift-rush/
 *   iOS：    DriftRush/Game/                    -> driftrush://game/（自定义 scheme）
 *   Windows：Game/                            -> 内嵌进 exe（EmbeddedResource，运行时 file:// 解包加载）
 * -------------------------------------------------------------------------*/
function syncInto(label, dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  cpSync(outDir, dir, { recursive: true });
  const n = existsSync(resolve(dir, "bundle.js")) && existsSync(resolve(dir, "index.html"));
  console.log(`   [${label}] ${n ? "✅" : "❌"} ${dir}`);
}

syncInto("Android", resolve(appsDir, "android", "app", "src", "main", "assets", "drift-rush"));
syncInto("Harmony", resolve(appsDir, "harmony", "entry", "src", "main", "resources", "rawfile", "drift-rush"));
syncInto("iOS", resolve(appsDir, "ios", "DriftRush", "Game"));
syncInto("Windows", resolve(appsDir, "windows", "Game"));

console.log(`\n✅ 离线包已生成并同步到各端壳：`);
console.log(`   ${resolve(outDir, "index.html")}`);
console.log(`   ${resolve(outDir, "bundle.js")}`);
