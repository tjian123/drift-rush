/* ===========================================================================
 * hud.js — 全部 DOM 界面：菜单 / 联机大厅 / 比赛 HUD / 小地图 / 结算 / 成就
 * 只负责渲染与事件回调，不含任何游戏逻辑
 * =========================================================================*/

import { ACHIEVEMENTS, PAINTS, TRACKS, TRACK_ORDER, AI_LEVELS, STORAGE } from './config.js';
import { ITEM_ICONS, ITEM_NAMES, ITEM_SEQ } from './items.js';
import { fmtTime } from './util.js';

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------------------
 * 小地图投影：把赛道归一化到任意方形画布
 * -------------------------------------------------------------------------*/
export function makeMapProjection(track, size, pad = 22) {
  const b = track.bounds;
  const w = b.maxX - b.minX, h = b.maxZ - b.minZ;
  const sc = Math.min((size - pad * 2) / w, (size - pad * 2) / h);
  const ox = (size - w * sc) / 2 - b.minX * sc;
  const oz = (size - h * sc) / 2 - b.minZ * sc;
  return {
    sc, size,
    toX: (x) => x * sc + ox,
    toY: (z) => z * sc + oz,
  };
}

/** 把赛道描边烘焙到离屏 canvas（只做一次），运行时只画车 */
function bakeTrackShape(track, size, lineScale = 1) {
  const p = makeMapProjection(track, size);
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  g.lineJoin = 'round'; g.lineCap = 'round';
  const path = () => {
    g.beginPath();
    for (let i = 0; i <= track.n; i++) {
      const k = i % track.n;
      const x = p.toX(track.cx[k]), y = p.toY(track.cz[k]);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
  };
  const s = size / 300;
  path(); g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 17 * s * lineScale; g.stroke();
  path(); g.strokeStyle = 'rgba(255,205,120,.66)'; g.lineWidth = 6.2 * s * lineScale; g.stroke();
  path(); g.strokeStyle = 'rgba(18,22,38,.8)'; g.lineWidth = 2.6 * s * lineScale; g.stroke();
  return { cv, p };
}

export class UI {
  constructor(cb) {
    this.cb = cb;
    this.el = {
      menu: $('screen-menu'), lobby: $('screen-lobby'),
      pause: $('screen-pause'), result: $('screen-result'),
      lapnum: $('lapnum'), curtime: $('curtime'), besttime: $('besttime'),
      lasttime: $('lasttime'), score: $('score'),
      speednum: $('speednum'), gear: $('gear'), rpmfill: $('rpmfill'),
      driftbox: $('driftbox'), driftnum: $('driftnum'), driftmult: $('driftmult'),
      cdnum: $('cdnum'), toast: $('toast'), banner: $('banner'),
      achstack: $('achstack'), netstat: $('netstat'), nettext: $('nettext'),
      ranklist: $('ranklist'), minimap: $('minimap'),
      splitHud: $('split-hud'),
      speedlines: $('speedlines'), flash: $('flash'),
      fatal: $('fatal'),
      itemSlot: $('item-slot'), itemIcon: $('item-icon'), itemKey: $('item-key'),
      sp1Item: $('sp1-item'), sp2Item: $('sp2-item'),
      trackList: $('track-list'), paintList: $('paint-list'), nameInput: $('name-input'),
      menuFoot: $('menu-foot'),
      roomCode: $('room-code'), playerList: $('player-list'),
      lobbyConnect: $('lobby-connect'), lobbyRoom: $('lobby-room'),
      lobbyCount: $('lobby-count'), lobbyFoot: $('lobby-foot'),
      resultTable: $('result-table'), resultTitle: $('result-title'),
      resultSub: $('result-sub'), resultAch: $('result-ach'),
      resultAchSection: $('result-ach-section'),
      achGrid: $('ach-grid'), achCount: $('ach-count'),
      pauseTitle: $('pause-title'), achPanel: $('ach-panel'),
      touch: $('touch'),
    };
    this.mm = this.el.minimap.getContext('2d');
    this.mapCache = new Map();
    this.lastTrackId = null;
    this.bannerTimer = 0;
    this.toastTimer = 0;
    this.state = {
      mode: 'solo', track: 'coast', level: 'normal', laps: 3, format: 'classic',
      name: '', paint: 0,
    };
    this.split = false;
    this.showNet = false;      // 是否显示联机状态条（app 按模式设置）
    this._wire();
  }

  /* ==================================================== 界面切换 */
  showScreen(name) {
    for (const k of ['menu', 'lobby', 'pause', 'result']) {
      this.el[k].classList.toggle('hide', k !== name);
    }
    const inRace = name === null;
    this.el.splitHud.classList.toggle('hidden', !(inRace && this.split));
    for (const id of ['lapbox', 'mapwrap', 'ranks', 'speedbox', 'driftbox']) {
      $(id).classList.toggle('hidden', !inRace || this.split);
    }
    // 联机状态指示条：只在联机模式或大厅里出现
    this.el.netstat.classList.toggle('hidden', !this.showNet);
    if (!inRace) this.el.splitHud.classList.add('hidden');
  }

  setSplit(on) {
    this.split = on;
    this.el.splitHud.classList.toggle('hidden', !on);
    for (const id of ['lapbox', 'mapwrap', 'ranks', 'speedbox', 'driftbox']) {
      $(id).classList.toggle('hidden', on);
    }
  }

  /** 电视模式开关的视觉状态（按钮本身在 index.html 的 .menu-links 里） */
  setTV(on) {
    const b = $('btn-tv');
    if (!b) return;
    b.classList.toggle('on', !!on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.textContent = on ? '电 视 模 式 · 开' : '电 视 模 式';
  }

  /** 当前可见的全屏界面（menu/lobby/pause/result/account/board），比赛中为 null。
      手柄菜单导航靠它判断该在哪一屏里找可聚焦控件。
      注意 account/board 排在前面：它们是叠在菜单之上的浮层，菜单那一刻并没有
      加 .hide，按 DOM 顺序会先命中菜单、把焦点放到被盖住的按钮上。 */
  activeScreen() {
    for (const k of ['account', 'board', 'menu', 'lobby', 'pause', 'result']) {
      const el = document.getElementById('screen-' + k);
      if (el && !el.classList.contains('hide')) return { id: k, el };
    }
    return null;
  }

  /* ==================================================== 菜单分步引导 */
  /* 1 赛道 → 2 赛制 → 3 车手。首屏只切赛道，每步一屏内放得下，
     不依赖滚动（移动端矮横屏也全部可达）。 */
  static MENU_STEPS = ['step-track', 'step-format', 'step-driver'];
  static STEP_NAMES = ['赛道', '赛制', '车手'];

  setMenuStep(i) {
    i = Math.max(0, Math.min(UI.MENU_STEPS.length - 1, i));
    this.menuStep = i;
    UI.MENU_STEPS.forEach((id, k) => $(id).classList.toggle('hide', k !== i));
    $('menu-steps').innerHTML = UI.STEP_NAMES.map((t, k) =>
      `<button class="stp${k === i ? ' on' : ''}" data-step="${k}">${k + 1} ${t}</button>`).join('');
    $('btn-prev').classList.toggle('hide', i === 0);
    const last = i === UI.MENU_STEPS.length - 1;
    $('btn-next').classList.toggle('hide', last);
    $('btn-go').classList.toggle('hide', !last);
  }

  menuAdvance() {
    // 只有主菜单可见时才响应（成就/排行榜/账号面板打开时菜单是隐藏的）
    if (this.el.menu.classList.contains('hide')) return false;
    if (this.menuStep >= UI.MENU_STEPS.length - 1) { this.cb.onGo(this.state); return true; }
    this.setMenuStep(this.menuStep + 1);
    return true;
  }

  /* ==================================================== 菜单构建 */
  buildMenu(prefs, bests, achievements) {
    this.state = { ...this.state, ...prefs };
    this.el.nameInput.value = this.state.name;

    /* 模式 */
    const syncSeg = (container, attr, value) => {
      container.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('on', b.dataset[attr] === String(value));
      });
    };
    this._syncSeg = syncSeg;
    syncSeg($('mode-seg'), 'mode', this.state.mode);
    syncSeg($('level-seg'), 'level', this.state.level);
    syncSeg($('laps-seg'), 'laps', this.state.laps);
    syncSeg($('format-seg'), 'format', this.state.format);
    this.el.levelSeg = $('level-seg');

    /* 涂装 */
    this.el.paintList.innerHTML = '';
    PAINTS.forEach((p) => {
      const d = document.createElement('div');
      d.className = 'paint' + (p.id === this.state.paint ? ' on' : '');
      d.style.background = '#' + p.body.toString(16).padStart(6, '0');
      d.title = p.name;
      d.dataset.paint = p.id;
      d.addEventListener('click', () => {
        this.state.paint = p.id;
        this.el.paintList.querySelectorAll('.paint').forEach((x) =>
          x.classList.toggle('on', +x.dataset.paint === p.id));
        this.cb.onPrefs && this.cb.onPrefs(this.state);
      });
      this.el.paintList.appendChild(d);
    });

    this.renderMenuFoot(bests, achievements);
    this.setMenuStep(0);          // 每次回到菜单都从「选赛道」开始
  }

  renderMenuFoot(bests, achievements) {
    const bits = [];
    for (const id of TRACK_ORDER) {
      const t = TRACKS[id];
      bits.push(`${t.name} <b>${bests[id] ? fmtTime(bests[id]) : '--:--'}</b>`);
    }
    const a = achievements;
    this.el.menuFoot.innerHTML =
      bits.join(' · ') + '<br>' +
      `成就 <b>${a.count()} / ${a.total()}</b> · 支持 8 人联机 · 全程序化生成，零外部素材`;
  }

  /** 赛道卡片（含迷你赛道图形与本赛道最佳圈速） */
  buildTrackCards(trackObjects, bests, selected) {
    this.el.trackList.innerHTML = '';
    for (const id of TRACK_ORDER) {
      const track = trackObjects[id];
      const t = TRACKS[id];
      const card = document.createElement('button');
      card.className = 'trackcard' + (id === selected ? ' on' : '');
      card.dataset.track = id;
      card.title = `${t.desc} · 周长 ${Math.round(track.total)}m`;

      const cv = document.createElement('canvas');
      cv.width = cv.height = 124;
      const { cv: baked } = bakeTrackShape(track, 124, 0.9);
      cv.getContext('2d').drawImage(baked, 0, 0);

      const info = document.createElement('div');
      const difficulty = track.minR < 24 ? '★★★ 技术' : track.minR < 30 ? '★★ 均衡' : '★ 高速';
      info.innerHTML = `<div class="nm">${t.name}</div>
        <div class="ds">${t.desc}<br>${difficulty} · 周长 ${Math.round(track.total)}m</div>
        <div class="bs">最佳 ${bests[id] ? fmtTime(bests[id]) : '--:--.--'}</div>`;

      card.append(cv, info);
      card.addEventListener('click', () => {
        this.state.track = id;
        this.el.trackList.querySelectorAll('.trackcard').forEach((x) =>
          x.classList.toggle('on', x.dataset.track === id));
        this.cb.onPrefs && this.cb.onPrefs(this.state);
      });
      this.el.trackList.appendChild(card);
    }
    this.wireTrackNav(selected);
  }

  /** 赛道卡横向翻看：一行放不下时显示左右箭头，按页滚动（buildTrackCards 会多次调用，必须幂等） */
  wireTrackNav(selected) {
    const list = this.el.trackList;
    const prev = document.getElementById('track-prev');
    const next = document.getElementById('track-next');
    if (!prev || !next) return;
    if (!prev.dataset.wired) {
      prev.dataset.wired = '1';
      const page = (dir) => list.scrollBy({ left: dir * (list.clientWidth - 70), behavior: 'smooth' });
      prev.addEventListener('click', () => page(-1));
      next.addEventListener('click', () => page(1));
      const sync = () => {
        const max = list.scrollWidth - list.clientWidth;
        prev.classList.toggle('off', max <= 4 || list.scrollLeft <= 4);
        next.classList.toggle('off', max <= 4 || list.scrollLeft >= max - 4);
      };
      list.addEventListener('scroll', sync, { passive: true });
      window.addEventListener('resize', sync);
      this._trackNavSync = sync;
    }
    // 重建卡片后 scrollLeft 归零，重算箭头可见性；选中卡若在视野外则滚到可见
    if (this._trackNavSync) requestAnimationFrame(this._trackNavSync);
    const on = list.querySelector('.trackcard.on');
    if (on && on.scrollIntoView) {
      requestAnimationFrame(() => on.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    }
  }

  /* ==================================================== 比赛 HUD */
  resetForRace(trackId) {
    this.lastTrackId = trackId;
    this.el.curtime.textContent = '0:00.00';
    this.el.lasttime.textContent = '--:--.--';
    this.el.score.textContent = '0';
    this.el.driftbox.classList.remove('on');
    this.el.toast.classList.remove('on', 'info');
    this.el.achstack.innerHTML = '';
    this.renderItemSlot(this.el.itemSlot, null);
    this.renderItemSlot(this.el.sp1Item, null);
    this.renderItemSlot(this.el.sp2Item, null);
  }

  /** 道具赛开关：隐藏/显示道具槽 */
  setItemMode(on) {
    this.el.itemSlot.classList.toggle('hidden', !on);
    this.el.sp1Item.classList.toggle('hidden', !on);
    this.el.sp2Item.classList.toggle('hidden', !on);
    if (!on) {
      this.renderItemSlot(this.el.itemSlot, null);
      this.renderItemSlot(this.el.sp1Item, null);
      this.renderItemSlot(this.el.sp2Item, null);
    }
  }

  /** 单个道具槽：抽取滚动动画 → 定格 → 空槽 */
  renderItemSlot(el, r) {
    if (!el) return;
    const ic = el.querySelector('.ic');
    if (!r || (!r.item && !(r.itemRollT > 0))) {
      el.classList.remove('rolling', 'has');
      if (ic) ic.textContent = '';
      return;
    }
    if (r.itemRollT > 0) {
      el.classList.add('rolling');
      el.classList.remove('has');
      const ic2 = ITEM_ICONS[ITEM_SEQ[(performance.now() / 90 | 0) % ITEM_SEQ.length]];
      if (ic) ic.textContent = ic2;
      el.title = '抽取中…';
    } else {
      el.classList.add('has');
      el.classList.remove('rolling');
      if (ic) ic.textContent = ITEM_ICONS[r.item] || '?';
      el.title = `${ITEM_NAMES[r.item] || r.item} · 点击/按键使用`;
    }
  }

  updateRaceHud(r, totalLaps, bestLap) {
    const kmh = Math.round(Math.abs(r.vF) * 3.6);
    this.el.speednum.textContent = kmh;
    this.el.gear.textContent = r.vF < -0.5 ? 'R' : (r.gear || 1);
    this.el.rpmfill.style.width = ((r.rpm || 0) * 100).toFixed(1) + '%';
    this.el.rpmfill.style.background = (r.rpm || 0) > 0.86
      ? 'linear-gradient(90deg,#ff9d5c,#ff4d4d)'
      : 'linear-gradient(90deg,#39d98a 0%,#ffd479 62%,#ff4d4d 88%)';
    this.el.lapnum.textContent = `${Math.min(r.lap, totalLaps)} / ${totalLaps}`;
    this.el.curtime.textContent = fmtTime(r.lapTime);
    this.el.besttime.textContent = fmtTime(r.bestLap || bestLap);
    this.el.lasttime.textContent = fmtTime(r.lastLap);
    this.el.score.textContent = r.score.toLocaleString();
    this.el.speedlines.style.opacity = (Math.min(1, Math.max(0, (kmh - 105) / 130)) * 0.65).toFixed(2);

    if (r.drifting && r.driftPending > 1) {
      this.el.driftbox.classList.add('on');
      this.el.driftnum.textContent = Math.floor(r.driftPending * r.driftMult).toLocaleString();
      this.el.driftmult.textContent = '×' + r.driftMult.toFixed(1);
    } else {
      this.el.driftbox.classList.remove('on');
    }
    this.renderItemSlot(this.el.itemSlot, r);
  }

  updateSplitHud(r1, r2, totalLaps, ranks) {
    const set = (n, r) => {
      $('sp' + n + '-kmh').textContent = Math.round(Math.abs(r.vF) * 3.6);
      $('sp' + n + '-lap').textContent = `${Math.min(r.lap, totalLaps)}/${totalLaps}`;
      $('sp' + n + '-time').textContent = fmtTime(r.lapTime);
      $('sp' + n + '-rank').textContent = `${r.rank} / ${ranks}`;
    };
    set(1, r1); set(2, r2);
    this.renderItemSlot(this.el.sp1Item, r1);
    this.renderItemSlot(this.el.sp2Item, r2);
  }

  /** 名次榜（最多显示 8 行，自己高亮） */
  renderRanks(allRacers, localIds) {
    const rows = allRacers.slice(0, 8).map((r) => {
      const me = localIds.has(r.id) ? ' me' : '';
      const paint = PAINTS[r.paint % PAINTS.length];
      const time = r.finished ? fmtTime(r.finishTime) : (r.lap > 1 ? 'L' + r.lap : '');
      return `<div class="rank-row${me}">
        <span class="pos">${r.rank}</span>
        <span class="dot" style="background:#${paint.body.toString(16).padStart(6, '0')}"></span>
        <span class="nm">${r.name}</span>
        <span class="tm">${time}</span>
      </div>`;
    });
    this.el.ranklist.innerHTML = rows.join('');
  }

  /* ==================================================== 小地图 */
  ensureMap(track) {
    if (this.lastMapTrack === track.id) return this.mapCache.get(track.id);
    const baked = bakeTrackShape(track, 300, 1);
    this.mapCache.set(track.id, baked);
    this.lastMapTrack = track.id;
    return baked;
  }

  drawMinimap(track, racers, localIds) {
    const { cv: baked, p } = this.ensureMap(track);
    const g = this.mm;
    g.clearRect(0, 0, 300, 300);
    g.drawImage(baked, 0, 0);

    // 起点线
    const I = 0;
    g.strokeStyle = '#8ee6b0'; g.lineWidth = 3;
    g.beginPath();
    g.moveTo(p.toX(track.cx[I] + track.sx[I] * 8), p.toY(track.cz[I] + track.sz[I] * 8));
    g.lineTo(p.toX(track.cx[I] - track.sx[I] * 8), p.toY(track.cz[I] - track.sz[I] * 8));
    g.stroke();

    // 所有赛车（NPC 小点，本地玩家大箭头）
    for (const r of racers) {
      if (!r.mesh && !r.isRemote) continue;
      const x = p.toX(r.x), y = p.toY(r.z);
      const isLocal = localIds.has(r.id);
      const paint = PAINTS[(r.paint || 0) % PAINTS.length];
      const col = '#' + paint.body.toString(16).padStart(6, '0');
      if (!isLocal) {
        g.fillStyle = col;
        g.globalAlpha = 0.85;
        g.beginPath(); g.arc(x, y, 5.5, 0, Math.PI * 2); g.fill();
        g.globalAlpha = 1;
      } else {
        g.save();
        g.translate(x, y);
        // 世界 +z → 画布 +y，前向 (sin h, cos h) ⇒ rotate(-h) 配默认朝下的箭头
        g.rotate(-r.heading);
        g.fillStyle = col;
        g.shadowColor = col; g.shadowBlur = 10;
        g.beginPath();
        g.moveTo(0, 11); g.lineTo(7, -8.5); g.lineTo(0, -4.5); g.lineTo(-7, -8.5);
        g.closePath(); g.fill();
        g.restore();
      }
    }
  }

  /* ==================================================== 提示 / 横幅 */
  toast(msg, info = false, ms = 1600) {
    this.el.toast.textContent = msg;
    this.el.toast.classList.toggle('info', info);
    this.el.toast.classList.add('on');
    this.toastTimer = ms / 1000;
  }

  banner(big, sm) {
    this.el.banner.querySelector('.big').textContent = big;
    this.el.banner.querySelector('.sm').textContent = sm;
    this.el.banner.classList.remove('on');
    void this.el.banner.offsetWidth;
    this.el.banner.classList.add('on');
  }

  countdown(text) {
    this.el.cdnum.textContent = text;
    this.el.cdnum.classList.remove('pop');
    void this.el.cdnum.offsetWidth;
    this.el.cdnum.classList.add('pop');
  }

  flashWhite(alpha = 0.5, ms = 180) {
    this.el.flash.style.transition = 'none';
    this.el.flash.style.opacity = String(alpha);
    requestAnimationFrame(() => {
      this.el.flash.style.transition = `opacity ${ms}ms ease-out`;
      this.el.flash.style.opacity = '0';
    });
  }

  tickTimers(dt) {
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.el.toast.classList.remove('on');
    }
  }

  achToast(meta) {
    const card = document.createElement('div');
    card.className = 'achcard';
    card.innerHTML = `<div class="achicon">★</div>
      <div class="achtxt"><div class="l">成 就 解 锁</div>
      <div class="t">${meta.title}</div><div class="d">${meta.desc}</div></div>`;
    this.el.achstack.appendChild(card);
    setTimeout(() => {
      card.classList.add('out');
      setTimeout(() => card.remove(), 360);
    }, 3600);
  }

  /* ==================================================== 联机 */
  setNetStatus(status, transport, room, players) {
    const el = this.el.netstat;
    el.classList.remove('online', 'warn', 'err');
    if (status === 'online') {
      el.classList.add(transport === 'poll' ? 'warn' : 'online');
      this.el.nettext.innerHTML =
        `房间 <b>${room || '----'}</b> · ${players} 人 · ` +
        (transport === 'poll' ? '轮询模式' : 'WebSocket');
    } else if (status === 'connecting') {
      this.el.nettext.textContent = '正在连接服务器…';
    } else if (status === 'error') {
      el.classList.add('err');
      this.el.nettext.textContent = '连接失败';
    } else {
      this.el.nettext.textContent = '未连接';
    }
  }

  showLobbyRoom(roomCode, players, myId, hostId, isHost, trackName, laps) {
    this.el.lobbyConnect.classList.add('hide');
    this.el.lobbyRoom.classList.remove('hide');
    this.el.roomCode.textContent = roomCode || '----';
    this.el.lobbyCount.textContent = `(${players.length}/${8})`;
    this.el.playerList.innerHTML = players.map((p) => {
      const paint = PAINTS[p.paint % PAINTS.length];
      const tags = [];
      if (p.id === hostId) tags.push('<span class="tag host">房主</span>');
      if (p.id === myId) tags.push('<span class="tag">你</span>');
      return `<div class="plrow">
        <span class="dot" style="background:#${paint.body.toString(16).padStart(6, '0')}"></span>
        <span style="flex:1">${p.name || '车手'}</span>${tags.join('')}</div>`;
    }).join('');
    const btn = $('btn-race-start');
    btn.disabled = !isHost;
    btn.textContent = isHost ? '开 始 比 赛' : '等 待 房 主';
    this.el.lobbyFoot.textContent = `赛道：${trackName} · ${laps} 圈 · 所有车手就位后由房主发车`;
  }

  showLobbyConnect() {
    this.el.lobbyConnect.classList.remove('hide');
    this.el.lobbyRoom.classList.add('hide');
  }

  /* ==================================================== 结算 */
  showResults({ title, sub, rows, unlocked, myIds }) {
    this.el.resultTitle.textContent = title;
    this.el.resultSub.textContent = sub || '';
    const head = `<tr><th>#</th><th>车手</th><th>圈数</th><th>总用时</th><th>最佳单圈</th></tr>`;
    const body = rows.map((r) => {
      const paint = PAINTS[(r.paint || 0) % PAINTS.length];
      const me = myIds.has(r.id) ? ' class="me"' : '';
      const pos = r.rank === 1 ? '<span class="p1">1</span>' : r.rank;
      return `<tr${me}>
        <td class="pos">${pos}</td>
        <td><span class="dot" style="background:#${paint.body.toString(16).padStart(6, '0')}"></span>${r.name}</td>
        <td>${r.laps}</td>
        <td>${r.finished ? fmtTime(r.finishTime) : '未完赛'}</td>
        <td>${r.bestLap ? fmtTime(r.bestLap) : '--:--.--'}</td>
      </tr>`;
    }).join('');
    this.el.resultTable.innerHTML = head + body;

    if (unlocked && unlocked.length) {
      this.el.resultAchSection.classList.remove('hide');
      this.el.resultAch.innerHTML = unlocked.map((a) => `
        <div class="achitem"><div class="ic">★</div>
        <div><div class="t">${a.title}</div><div class="d">${a.desc}</div></div></div>`).join('');
    } else {
      this.el.resultAchSection.classList.add('hide');
    }
  }

  /* ==================================================== 成就面板 */
  renderAchievements(ach) {
    this.el.achCount.textContent = `${ach.count()} / ${ach.total()}`;
    this.el.achGrid.innerHTML = ACHIEVEMENTS.map((a) => {
      const un = ach.isUnlocked(a.id);
      const tier = a.tier === 'master' ? '★' : a.tier === 'pro' ? '✦' : '·';
      return `<div class="achitem${un ? '' : ' locked'}">
        <div class="ic">${un ? tier : '?'}</div>
        <div><div class="t">${a.title}</div><div class="d">${a.desc}</div></div></div>`;
    }).join('');
  }

  /* ==================================================== 事件接线 */
  _wire() {
    const segClick = (id, attr, key) => {
      $(id).addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b || !b.dataset[attr]) return;
        this.state[key] = attr === 'laps' ? Number(b.dataset[attr]) : b.dataset[attr];
        $(id).querySelectorAll('button').forEach((x) =>
          x.classList.toggle('on', x === b));
        this.cb.onPrefs && this.cb.onPrefs(this.state);
      });
    };
    segClick('level-seg', 'level', 'level');
    segClick('laps-seg', 'laps', 'laps');
    /* 模式：联机不支持道具赛，切到联机时道具赛自动回落竞速 */
    $('mode-seg').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !b.dataset.mode) return;
      this.state.mode = b.dataset.mode;
      $('mode-seg').querySelectorAll('button').forEach((x) =>
        x.classList.toggle('on', x === b));
      if (this.state.mode === 'online' && this.state.format === 'item') {
        this.state.format = 'classic';
        $('format-seg').querySelectorAll('button').forEach((x) =>
          x.classList.toggle('on', x.dataset.format === 'classic'));
        this.toast('联机暂为竞速赛制', true, 1400);
      }
      this.cb.onPrefs && this.cb.onPrefs(this.state);
    });
    /* 赛制：联机暂不支持道具赛，选中即时拦截 */
    $('format-seg').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !b.dataset.format) return;
      if (this.state.mode === 'online' && b.dataset.format === 'item') {
        this.toast('道具赛暂不支持联机，先用竞速吧', false);
        return;
      }
      this.state.format = b.dataset.format;
      $('format-seg').querySelectorAll('button').forEach((x) =>
        x.classList.toggle('on', x === b));
      this.cb.onPrefs && this.cb.onPrefs(this.state);
    });

    /* 道具槽点击 = 使用道具（触屏玩家的唯一使用入口） */
    this.el.itemSlot.addEventListener('click', () =>
      this.cb.onUseItem && this.cb.onUseItem(1));
    this.el.sp1Item.addEventListener('click', () =>
      this.cb.onUseItem && this.cb.onUseItem(1));
    this.el.sp2Item.addEventListener('click', () =>
      this.cb.onUseItem && this.cb.onUseItem(2));

    /* 分步导航 */
    $('btn-prev').addEventListener('click', () => this.setMenuStep(this.menuStep - 1));
    $('btn-next').addEventListener('click', () => this.menuAdvance());
    $('menu-steps').addEventListener('click', (e) => {
      const b = e.target.closest('.stp');
      if (b) this.setMenuStep(Number(b.dataset.step));
    });

    this.el.nameInput.addEventListener('input', () => {
      this.state.name = this.el.nameInput.value.slice(0, 10);
      this.cb.onPrefs && this.cb.onPrefs(this.state);
    });

    $('btn-go').addEventListener('click', () => this.cb.onGo(this.state));
    /* 电视模式 / 全屏：投屏到电视的两件事（放大 + 占满屏），详见 src/tv.js */
    $('btn-tv').addEventListener('click', () => this.cb.onTV && this.cb.onTV());
    $('btn-fs').addEventListener('click', () =>
      this.cb.onFullscreen && this.cb.onFullscreen());
    $('btn-ach').addEventListener('click', () => {
      this.el.pauseTitle.textContent = '成 就';
      this.el.achPanel.classList.remove('hide');
      this.showScreen('pause');
      $('btn-resume').classList.add('hide');
      $('btn-restart').classList.add('hide');
      $('btn-quit').textContent = '返 回 菜 单';
    });
    $('btn-lobby-back').addEventListener('click', () => this.cb.onBackMenu && this.cb.onBackMenu());
    $('btn-create').addEventListener('click', () => this.cb.onCreate(this.state));
    $('btn-join').addEventListener('click', () => {
      const code = ($('join-code').value || '').toUpperCase().trim();
      if (code.length !== 4) { this.toast('房间码是 4 位', false); return; }
      this.cb.onJoin({ ...this.state, room: code });
    });
    $('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join').click(); });
    $('btn-race-start').addEventListener('click', () => this.cb.onRaceStart && this.cb.onRaceStart());
    $('btn-leave').addEventListener('click', () => this.cb.onLeave && this.cb.onLeave());
    $('btn-resume').addEventListener('click', () => this.cb.onResume && this.cb.onResume());
    $('btn-restart').addEventListener('click', () => this.cb.onRestart && this.cb.onRestart());
    $('btn-quit').addEventListener('click', () => this.cb.onQuit && this.cb.onQuit());
    $('btn-again').addEventListener('click', () => this.cb.onRestart && this.cb.onRestart());
    $('btn-back-menu').addEventListener('click', () => this.cb.onQuit && this.cb.onQuit());
  }

  /** 进入比赛界面时恢复正常暂停菜单按钮 */
  restorePauseButtons() {
    this.el.pauseTitle.textContent = '暂 停';
    this.el.achPanel.classList.remove('hide');
    $('btn-resume').classList.remove('hide');
    $('btn-restart').classList.remove('hide');
    $('btn-quit').textContent = '返 回 菜 单';
  }

  showFatal(msg) {
    this.el.fatal.style.display = 'block';
    this.el.fatal.textContent = '⚠ 运行错误\n' + msg;
    document.title = 'ERR · ' + String(msg).slice(0, 120);
    window.__DR_ERROR__ = String(msg);
  }
}
