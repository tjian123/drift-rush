/* ===========================================================================
 * verify-i18n.mjs — 多语言（默认英文 / 一键切中文）回归验收
 *
 * 【为什么必须写成断言，而不是"我看着没问题"】
 *   i18n 最容易犯的错是**漏改一处**，而漏改一处的结果不是报错，是英文界面里
 *   孤零零冒出一行中文 —— 本地跑一遍根本注意不到，上架 itch.io 才被欧美玩家
 *   截图吐槽。所以这里用两条**机器可判**的判据钉死：
 *
 *   ① 缺键判据：元素渲染后的文本 === 它自己的 data-i18n key
 *      （t() 缺键时回退成 key 本身，所以"文本等于 key"就是缺翻译的铁证）
 *   ② 残中文判据：英文模式下，遍历所有可见文本节点，不允许出现 CJK 字符
 *      （唯一例外是 #btn-lang —— 它显示的是"切过去的语言"，本来就该是"中"）
 *
 *   另外覆盖三类**动态**内容：赛道卡 / 菜单底栏 / 成就面板。它们是 JS 拼出来的，
 *   不会跟着 applyI18n 自动换语言，必须在切换时显式重建 —— 这里断言它们真的重建了。
 * =========================================================================*/
import { Browser, sleep } from './cdp.mjs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const BASE = process.env.DR_BASE || 'http://127.0.0.1:8790';
const PORT = Number(process.env.DR_I18N_PORT || 9431);
let passed = 0, failed = 0;

function check(name, ok, detail = '') {
  ok ? passed++ : failed++;
  console.log(
    `  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✘\x1b[0m'} ${name}` +
      (detail ? `  \x1b[2m${detail}\x1b[0m` : ''),
  );
}

async function ensureServer() {
  const alive = () =>
    fetch(BASE + '/api/health').then((r) => r.ok).catch(() => false);
  if (await alive()) return;
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    env: { ...process.env, PORT: new URL(BASE).port || '3000' },
    stdio: 'ignore', detached: true,
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await delay(250);
    if (await alive()) return;
  }
  throw new Error('本地服务器启动失败');
}

async function waitReady(page, ms = 25000) {
  for (let i = 0; i < ms / 300; i++) {
    const r = await page.eval(`(window.__DR_READY__ && window.__DR_API__) ? 1 : 0`).catch(() => 0);
    if (r === 1) return true;
    await sleep(300);
  }
  return false;
}

/* ---------------------------------------------------------------- 探针 */
/**
 * ① 缺键：直接问字典「这个 key 两种语言都有吗」。
 *    不能拿「渲染文本 === key」当判据 —— HTML 里写的是中文默认值，
 *    applyI18n 没跑时文本是中文、也不等于 key，那条断言会假通过。
 */
const missingKeys = (page) => page.eval(`(() => {
  const out = [];
  const seen = new Set();
  const test = (k, tag) => {
    if (!k || seen.has(tag + k)) return;
    seen.add(tag + k);
    if (window.I18N && !window.I18N.has(k)) out.push(tag + k);
  };
  for (const el of document.querySelectorAll('[data-i18n]')) test(el.getAttribute('data-i18n'), '');
  for (const el of document.querySelectorAll('[data-i18n-ph]')) test(el.getAttribute('data-i18n-ph'), 'ph:');
  for (const el of document.querySelectorAll('[data-i18n-title]')) test(el.getAttribute('data-i18n-title'), 'title:');
  for (const el of document.querySelectorAll('[data-i18n-aria]')) test(el.getAttribute('data-i18n-aria'), 'aria:');
  return out;
})()`);

/** ①b applyI18n 真的跑过：抽查一个「中英明显不同」的 key */
const applied = (page) => page.eval(`(() => {
  const el = document.querySelector('[data-i18n="keys.drive"]');
  const want = window.I18N ? window.I18N.t('keys.drive') : null;
  return { got: el ? el.textContent.trim() : null, want };
})()`);

/** ② 残中文：可见文本里的 CJK（排除 #btn-lang） */
const cjkHits = (page) => page.eval(`(() => {
  const hit = [];
  const walk = (root) => {
    for (const n of root.childNodes) {
      if (n.nodeType === 3) {
        if (/[\\u4e00-\\u9fa5]/.test(n.nodeValue)) {
          const p = n.parentElement;
          if (!p || p.closest('#btn-lang')) continue;
          hit.push((p && (p.id || p.className) ? (p.id || p.className) : '?') + ' → ' + n.nodeValue.trim().slice(0, 24));
        }
      } else if (n.nodeType === 1) {
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        if (n.closest('#btn-lang')) continue;
        /* 排行榜里的车手名是**其他玩家填的**（云端数据），本来就该保留原样 */
        if (n.closest('#board-table')) continue;
        if (n.tagName === 'SCRIPT' || n.tagName === 'STYLE') continue;
        walk(n);
      }
    }
  };
  walk(document.body);
  return hit;
})()`);

/** 菜单里几个「动态拼装」区域的快照：判据是它们真的跟着语言变了 */
const dynSnapshot = (page) => page.eval(`(() => {
  const cards = [...document.querySelectorAll('#track-list .trackcard .nm')]
    .slice(0, 3).map((e) => e.textContent.trim().slice(0, 24));
  const foot = (document.getElementById('menu-foot') || {}).textContent || '';
  const ach = [...document.querySelectorAll('#ach-panel .ach-t, #ach-panel .t')]
    .slice(0, 3).map((e) => e.textContent.trim().slice(0, 24));
  return { cards, foot: foot.trim().slice(0, 60), ach };
})()`);

const lang = (page) => page.eval(`window.I18N ? window.I18N.getLang() : null`);

await ensureServer();
console.log('\x1b[1m多语言验收（默认 en · 一键切 zh）\x1b[0m');
const b = await Browser.launch({ port: PORT, profileName: 'cdp-i18n' });

/* ======================================================================
 * A：默认语言 —— 必须是英文（面向 itch.io 欧美买家）
 * ====================================================================*/
{
  const page = await b.newPage();
  await page.eval(`localStorage.removeItem('dr-lang')`).catch(() => {});
  await page.readyUrl(BASE + '/');
  const ok = await waitReady(page);
  check('A0 页面加载完成', ok);
  await sleep(1200);

  check('A1 默认语言为 en（未设置过 localStorage 时）', (await lang(page)) === 'en',
    `getLang()=${await lang(page)}`);

  const miss = await missingKeys(page);
  check('A2 静态文案无缺键（字典里 en/zh 都有）', miss.length === 0,
    miss.length ? miss.slice(0, 8).join(', ') : '全部命中翻译');

  const ap = await applied(page);
  check('A2b applyI18n 真的生效（渲染值 = 字典值）', ap.got === ap.want,
    `keys.drive 渲染="${ap.got}" 期望="${ap.want}"`);

  const cjk = await cjkHits(page);
  check('A3 英文界面无残留中文（可见文本零 CJK）', cjk.length === 0,
    cjk.length ? cjk.slice(0, 6).join(' | ') : '干净');

  const snapEn = await dynSnapshot(page);
  check('A4 赛道卡为英文名', snapEn.cards.length > 0 && !/[\u4e00-\u9fa5]/.test(snapEn.cards.join('')),
    snapEn.cards.join(' / '));

  /* 打开账号面板 + 排行榜：这两块是 JS 建的，最容易漏 */
  await page.click('btn-account');
  await sleep(700);
  const accCjk = await cjkHits(page);
  check('A5 账号面板（登录/注册/重置密码）无中文', accCjk.length === 0,
    accCjk.length ? accCjk.slice(0, 6).join(' | ') : '干净');
  await page.click('btn-board-back').catch(() => page.click('btn-acc-back').catch(() => {}));
  await sleep(400);

  await page.click('btn-board');
  await sleep(900);
  const boardCjk = await cjkHits(page);
  check('A6 排行榜面板无中文', boardCjk.length === 0,
    boardCjk.length ? boardCjk.slice(0, 6).join(' | ') : '干净');
  await page.click('btn-board-back');
  await sleep(400);

  /* 留两张对照图：给人工肉眼复核（英文版是 itch.io 买家看到的第一屏） */
  await page.shot('shot-i18n-en.png');

  global.__SNAP_EN = snapEn;
  await page.close();
}

/* ======================================================================
 * B：切到中文 —— 静态 + 动态都要跟着变
 * ====================================================================*/
{
  const page = await b.newPage();
  await page.readyUrl(BASE + '/');
  check('B0 页面加载完成', await waitReady(page));
  await sleep(1200);

  await page.click('btn-lang');
  await sleep(600);

  check('B1 点击后语言切到 zh', (await lang(page)) === 'zh', `getLang()=${await lang(page)}`);

  const miss = await missingKeys(page);
  check('B2 中文也无缺键（不会出现裸 key）', miss.length === 0,
    miss.length ? miss.slice(0, 8).join(', ') : '全部命中翻译');

  const snapZh = await dynSnapshot(page);
  check('B3 赛道卡已重建为中文（动态内容跟着切换）',
    snapZh.cards.length > 0 && /[\u4e00-\u9fa5]/.test(snapZh.cards.join('')),
    snapZh.cards.join(' / '));
  check('B4 菜单底栏已重建（含成就计数）', snapZh.foot !== global.__SNAP_EN.foot,
    `zh: ${snapZh.foot.slice(0, 40)}`);
  await page.shot('shot-i18n-zh.png');

  /* 刷新后要记住选择 */
  await page.readyUrl(BASE + '/');
  await sleep(1500);
  check('B5 刷新后仍是 zh（localStorage 记忆）', (await lang(page)) === 'zh',
    `getLang()=${await lang(page)}`);

  /* 切回英文：必须完全还原，不能"切过去就切不回来" */
  await page.click('btn-lang');
  await sleep(600);
  check('B6 切回 en', (await lang(page)) === 'en', `getLang()=${await lang(page)}`);
  const cjk = await cjkHits(page);
  check('B7 切回英文后界面无残留中文', cjk.length === 0,
    cjk.length ? cjk.slice(0, 6).join(' | ') : '干净');
  const snapBack = await dynSnapshot(page);
  check('B8 赛道卡回到英文', snapBack.cards.join('|') === global.__SNAP_EN.cards.join('|'),
    snapBack.cards.join(' / '));

  await page.close();
}

/* ======================================================================
 * C：比赛内 HUD —— 圈速/名次/道具提示也不能漏
 * ====================================================================*/
{
  const page = await b.newPage();
  await page.readyUrl(BASE + '/');
  check('C0 页面加载完成', await waitReady(page));
  await sleep(1000);

  await page.eval(`window.__DR_API__.start({ mode: 'solo', track: 'coast', laps: 1 })`);
  await sleep(1500);
  await page.eval(`window.__DR_API__.skipCountdown()`);
  await sleep(2500);

  const cjk = await cjkHits(page);
  check('C1 比赛 HUD 无中文', cjk.length === 0,
    cjk.length ? cjk.slice(0, 8).join(' | ') : '干净');

  /* 暂停面板是 JS 拼的（标题 + 退出按钮） */
  await page.eval(`window.__DR_API__.pause ? window.__DR_API__.pause() : 1`).catch(() => {});
  await sleep(600);
  const pauseCjk = await cjkHits(page);
  check('C2 暂停面板无中文', pauseCjk.length === 0,
    pauseCjk.length ? pauseCjk.slice(0, 6).join(' | ') : '干净');
  await page.close();
}

await b.kill();
console.log(`\n\x1b[1m结果：${passed} 通过 / ${failed} 失败\x1b[0m`);
process.exit(failed ? 1 : 0);
