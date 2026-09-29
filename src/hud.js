/* ===========================================================================
 * hud.js — 全部 DOM 界面：菜单 / 联机大厅 / 比赛 HUD / 小地图 / 结算 / 成就
 * 只负责渲染与事件回调，不含任何游戏逻辑
 * =========================================================================*/

import {
  ACHIEVEMENTS,
  PAINTS,
  TRACKS,
  TRACK_ORDER,
  AI_LEVELS,
  STORAGE,
} from "./config.js";
import { ITEM_ICONS, ITEM_NAMES, ITEM_SEQ } from "./items.js";
import { fmtTime } from "./util.js";
import { analytics } from "./analytics.js";
import { t, pick } from "./i18n.js";

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------------------
 * 小地图投影：把赛道归一化到任意方形画布
 * -------------------------------------------------------------------------*/
export function makeMapProjection(track, size, pad = 22) {
  const b = track.bounds;
  const w = b.maxX - b.minX,
    h = b.maxZ - b.minZ;
  const sc = Math.min((size - pad * 2) / w, (size - pad * 2) / h);
  const ox = (size - w * sc) / 2 - b.minX * sc;
  const oz = (size - h * sc) / 2 - b.minZ * sc;
  return {
    sc,
    size,
    toX: (x) => x * sc + ox,
    toY: (z) => z * sc + oz,
  };
}

/** 把赛道描边烘焙到离屏 canvas（只做一次），运行时只画车 */
function bakeTrackShape(track, size, lineScale = 1) {
  const p = makeMapProjection(track, size);
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const g = cv.getContext("2d");
  g.lineJoin = "round";
  g.lineCap = "round";
  const path = () => {
    g.beginPath();
    for (let i = 0; i <= track.n; i++) {
      const k = i % track.n;
      const x = p.toX(track.cx[k]),
        y = p.toY(track.cz[k]);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
  };
  const s = size / 300;
  path();
  g.strokeStyle = "rgba(255,255,255,.12)";
  g.lineWidth = 17 * s * lineScale;
  g.stroke();
  path();
  g.strokeStyle = "rgba(255,205,120,.66)";
  g.lineWidth = 6.2 * s * lineScale;
  g.stroke();
  path();
  g.strokeStyle = "rgba(18,22,38,.8)";
  g.lineWidth = 2.6 * s * lineScale;
  g.stroke();
  return { cv, p };
}

export class UI {
  constructor(cb) {
    this.cb = cb;
    this.el = {
      menu: $("screen-menu"),
      lobby: $("screen-lobby"),
      pause: $("screen-pause"),
      result: $("screen-result"),
      lapnum: $("lapnum"),
      curtime: $("curtime"),
      besttime: $("besttime"),
      lasttime: $("lasttime"),
      score: $("score"),
      speednum: $("speednum"),
      gear: $("gear"),
      rpmfill: $("rpmfill"),
      driftbox: $("driftbox"),
      driftnum: $("driftnum"),
      driftmult: $("driftmult"),
      cdnum: $("cdnum"),
      toast: $("toast"),
      banner: $("banner"),
      achstack: $("achstack"),
      netstat: $("netstat"),
      nettext: $("nettext"),
      ranklist: $("ranklist"),
      minimap: $("minimap"),
      splitHud: $("split-hud"),
      speedlines: $("speedlines"),
      flash: $("flash"),
      fatal: $("fatal"),
      itemSlot: $("item-slot"),
      itemIcon: $("item-icon"),
      itemKey: $("item-key"),
      sp1Item: $("sp1-item"),
      sp2Item: $("sp2-item"),
      trackList: $("track-list"),
      paintList: $("paint-list"),
      nameInput: $("name-input"),
      menuFoot: $("menu-foot"),
      roomCode: $("room-code"),
      playerList: $("player-list"),
      lobbyConnect: $("lobby-connect"),
      lobbyRoom: $("lobby-room"),
      lobbyCount: $("lobby-count"),
      lobbyFoot: $("lobby-foot"),
      resultTable: $("result-table"),
      resultTitle: $("result-title"),
      resultSub: $("result-sub"),
      resultAch: $("result-ach"),
      resultAchSection: $("result-ach-section"),
      achGrid: $("ach-grid"),
      achCount: $("ach-count"),
      pauseTitle: $("pause-title"),
      achPanel: $("ach-panel"),
      touch: $("touch"),
      helpScreen: $("screen-help"),
      helpFab: $("btn-help"),
      helpClose: $("btn-help-close"),
      raceHint: $("race-hint"),
    };
    this.mm = this.el.minimap.getContext("2d");
    this.mapCache = new Map();
    this.lastTrackId = null;
    this.bannerTimer = 0;
    this.toastTimer = 0;
    this.state = {
      mode: "solo",
      track: "coast",
      level: "normal",
      laps: 3,
      format: "classic",
      name: "",
      paint: 0,
    };
    this.split = false;
    this.showNet = false; // 是否显示联机状态条（app 按模式设置）
    this._wire();
  }

  /* ==================================================== 界面切换 */
  showScreen(name) {
    for (const k of ["menu", "lobby", "pause", "result"]) {
      this.el[k].classList.toggle("hide", k !== name);
    }
    const inRace = name === null;
    this.el.splitHud.classList.toggle("hidden", !(inRace && this.split));
    for (const id of ["lapbox", "mapwrap", "ranks", "speedbox", "driftbox"]) {
      $(id).classList.toggle("hidden", !inRace || this.split);
    }
    // 联机状态指示条：只在联机模式或大厅里出现
    this.el.netstat.classList.toggle("hidden", !this.showNet);
    if (!inRace) this.el.splitHud.classList.add("hidden");
    // 进入比赛（非触屏）时弹出键位提示，降低桌面玩家上手成本
    if (inRace && !document.body.classList.contains("touch-on")) this.showRaceHint();
  }

  setSplit(on) {
    this.split = on;
    this.el.splitHud.classList.toggle("hidden", !on);
    for (const id of ["lapbox", "mapwrap", "ranks", "speedbox", "driftbox"]) {
      $(id).classList.toggle("hidden", on);
    }
  }

  /** 电视模式开关的视觉状态（按钮本身在 index.html 的 .menu-links 里） */
  setTV(on) {
    const b = $("btn-tv");
    if (!b) return;
    b.classList.toggle("on", !!on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.textContent = on ? t("tvMode.on") : t("tvMode.off");
  }

  /** 当前可见的全屏界面（menu/lobby/pause/result/account/board），比赛中为 null。
      手柄菜单导航靠它判断该在哪一屏里找可聚焦控件。
      注意 account/board 排在前面：它们是叠在菜单之上的浮层，菜单那一刻并没有
      加 .hide，按 DOM 顺序会先命中菜单、把焦点放到被盖住的按钮上。 */
  activeScreen() {
    for (const k of ["account", "board", "menu", "lobby", "pause", "result"]) {
      const el = document.getElementById("screen-" + k);
      if (el && !el.classList.contains("hide")) return { id: k, el };
    }
    return null;
  }

  /* ==================================================== 菜单分步引导 */
  /* 1 赛道 → 2 赛制 → 3 车手。首屏只切赛道，每步一屏内放得下，
     不依赖滚动（移动端矮横屏也全部可达）。 */
  static MENU_STEPS = ["step-track", "step-format", "step-driver"];
  // 存的是 i18n key，渲染时再 t() 取值（参数名不能再用 t，避免遮蔽翻译函数）
  static STEP_NAMES = ["step.track", "step.format", "step.driver"];

  setMenuStep(i) {
    i = Math.max(0, Math.min(UI.MENU_STEPS.length - 1, i));
    this.menuStep = i;
    UI.MENU_STEPS.forEach((id, k) => $(id).classList.toggle("hide", k !== i));
    $("menu-steps").innerHTML = UI.STEP_NAMES.map(
      (key, k) =>
        `<button class="stp${k === i ? " on" : ""}" data-step="${k}">${k + 1} ${t(key)}</button>`,
    ).join("");
    $("btn-prev").classList.toggle("hide", i === 0);
    const last = i === UI.MENU_STEPS.length - 1;
    $("btn-next").classList.toggle("hide", last);
    $("btn-go").classList.toggle("hide", !last);
  }

  menuAdvance() {
    // 只有主菜单可见时才响应（成就/排行榜/账号面板打开时菜单是隐藏的）
    if (this.el.menu.classList.contains("hide")) return false;
    if (this.menuStep >= UI.MENU_STEPS.length - 1) {
      this.cb.onGo(this.state);
      return true;
    }
    this.setMenuStep(this.menuStep + 1);
    return true;
  }

  /* ==================================================== 操作帮助浮层 */
  /** 桌面/手柄模式才显示「?」入口：TV 用遥控器、触屏用自带操控 UI，不需要它 */
  syncHelpFab() {
    if (!this.el.helpFab) return;
    const body = document.body;
    const show = !body.classList.contains("tv") && !body.classList.contains("touch-on");
    this.el.helpFab.classList.toggle("show", show);
  }

  showHelp() {
    if (!this.el.helpScreen) return;
    // 触屏设备显示「触屏」一栏，否则隐藏（桌面/手柄不需要）
    const isTouch = document.body.classList.contains("touch-on") ||
      (("ontouchstart" in window) || navigator.maxTouchPoints > 0);
    const tc = this.el.helpScreen.querySelector(".help-touch");
    if (tc) tc.classList.toggle("touch", isTouch);
    this.el.helpScreen.classList.remove("hide");
  }

  hideHelp() {
    if (this.el.helpScreen) this.el.helpScreen.classList.add("hide");
  }

  /** 首次启动（仅桌面/手柄、且未读过）自动弹教学浮层；TV/触屏不自弹，避免无法便捷关闭 */
  maybeShowFirstLaunchHelp() {
    let seen = false;
    try { seen = localStorage.getItem("dr-tut-done") === "1"; } catch (e) {}
    const body = document.body;
    const ok = !body.classList.contains("tv") && !body.classList.contains("touch-on");
    if (!seen && ok) this.showHelp();
  }

  /* ==================================================== 比赛中键位提示 */
  showRaceHint() {
    if (!this.el.raceHint) return;
    const mode = this.state.mode;
    let html =
      '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> ' + t("raceHint.drive") + ' · ' +
      '<kbd>Space</kbd> ' + t("raceHint.hb") + ' · <kbd>C</kbd> ' + t("raceHint.cam") +
      ' · <kbd>P</kbd> ' + t("raceHint.pause");
    if (mode === "split") {
      html =
        '<b>P1</b> <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> · ' +
        '<b>P2</b> <kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> + <kbd>R-Shift</kbd> ' +
        t("raceHint.hb");
    }
    html += '　<span class="dim">' + t("raceHint.hide", '<kbd>H</kbd>') + '</span>';
    this.el.raceHint.innerHTML = html;
    this.el.raceHint.classList.remove("hide");
    clearTimeout(this._raceHintTimer);
    this._raceHintTimer = setTimeout(() => {
      this.el.raceHint.classList.add("hide");
    }, 6000);
  }

  toggleRaceHint() {
    if (!this.el.raceHint) return;
    const hidden = this.el.raceHint.classList.contains("hide");
    if (hidden) {
      this.el.raceHint.classList.remove("hide");
      clearTimeout(this._raceHintTimer);
      this._raceHintTimer = setTimeout(() => this.el.raceHint.classList.add("hide"), 6000);
    } else {
      this.el.raceHint.classList.add("hide");
    }
  }

  /* ==================================================== 菜单构建 */
  buildMenu(prefs, bests, achievements) {
    this.state = { ...this.state, ...prefs };
    this.el.nameInput.value = this.state.name;

    /* 模式 */
    const syncSeg = (container, attr, value) => {
      container.querySelectorAll("button").forEach((b) => {
        b.classList.toggle("on", b.dataset[attr] === String(value));
      });
    };
    this._syncSeg = syncSeg;
    syncSeg($("mode-seg"), "mode", this.state.mode);
    syncSeg($("level-seg"), "level", this.state.level);
    syncSeg($("laps-seg"), "laps", this.state.laps);
    syncSeg($("format-seg"), "format", this.state.format);
    this.el.levelSeg = $("level-seg");

    /* 涂装 */
    this.el.paintList.innerHTML = "";
    PAINTS.forEach((p) => {
      const d = document.createElement("div");
      d.className = "paint" + (p.id === this.state.paint ? " on" : "");
      d.style.background = "#" + p.body.toString(16).padStart(6, "0");
      d.title = pick(p.name);
      d.dataset.paint = p.id;
      d.addEventListener("click", () => {
        this.state.paint = p.id;
        this.el.paintList
          .querySelectorAll(".paint")
          .forEach((x) => x.classList.toggle("on", +x.dataset.paint === p.id));
        this.cb.onPrefs && this.cb.onPrefs(this.state);
        analytics.track("menu.paint.select", { paint: p.id });
      });
      this.el.paintList.appendChild(d);
    });

    this.renderMenuFoot(bests, achievements);
    this.setMenuStep(0); // 每次回到菜单都从「选赛道」开始
    this.syncHelpFab();
    this.maybeShowFirstLaunchHelp();
  }

  renderMenuFoot(bests, achievements) {
    const bits = [];
    for (const id of TRACK_ORDER) {
      /* 局部变量不能叫 t：会遮蔽 i18n 的翻译函数 t()，下面 t("menuFoot") 就炸了 */
      const meta = TRACKS[id];
      bits.push(`${pick(meta.name)} <b>${bests[id] ? fmtTime(bests[id]) : "--:--"}</b>`);
    }
    const a = achievements;
    this.el.menuFoot.innerHTML =
      bits.join(" · ") +
      "<br>" +
      t("menuFoot", `<b>${a.count()} / ${a.total()}</b>`);
  }

  /** 赛道卡片（含迷你赛道图形与本赛道最佳圈速） */
  buildTrackCards(trackObjects, bests, selected) {
    this.el.trackList.innerHTML = "";
    for (const id of TRACK_ORDER) {
      const track = trackObjects[id];
      const meta = TRACKS[id]; // 不能叫 t：会遮蔽翻译函数
      const card = document.createElement("button");
      card.className = "trackcard" + (id === selected ? " on" : "");
      card.dataset.track = id;
      card.title = `${pick(meta.desc)} · ${t("track.len", Math.round(track.total))}`;

      const cv = document.createElement("canvas");
      cv.width = cv.height = 124;
      const { cv: baked } = bakeTrackShape(track, 124, 0.9);
      cv.getContext("2d").drawImage(baked, 0, 0);

      const info = document.createElement("div");
      const difficulty =
        track.minR < 24 ? t("track.diff3") : track.minR < 30 ? t("track.diff2") : t("track.diff1");
      info.innerHTML = `<div class="nm">${pick(meta.name)}</div>
        <div class="ds">${pick(meta.desc)}<br>${difficulty} · ${t("track.len", Math.round(track.total))}</div>
        <div class="bs">${t("track.best")} ${bests[id] ? fmtTime(bests[id]) : "--:--.--"}</div>`;

      card.append(cv, info);
      card.addEventListener("click", () => {
        this.state.track = id;
        this.el.trackList
          .querySelectorAll(".trackcard")
          .forEach((x) => x.classList.toggle("on", x.dataset.track === id));
        this.cb.onPrefs && this.cb.onPrefs(this.state);
        analytics.track("menu.track.select", { track: id });
      });
      this.el.trackList.appendChild(card);
    }
    this.wireTrackNav(selected);
  }

  /** 赛道卡横向翻看：一行放不下时显示左右箭头，按页滚动（buildTrackCards 会多次调用，必须幂等） */
  wireTrackNav(selected) {
    const list = this.el.trackList;
    const prev = document.getElementById("track-prev");
    const next = document.getElementById("track-next");
    if (!prev || !next) return;
    if (!prev.dataset.wired) {
      prev.dataset.wired = "1";
      const page = (dir) =>
        list.scrollBy({
          left: dir * (list.clientWidth - 70),
          behavior: "smooth",
        });
      prev.addEventListener("click", () => {
        page(-1);
        analytics.track("menu.track.page", { dir: -1 });
      });
      next.addEventListener("click", () => {
        page(1);
        analytics.track("menu.track.page", { dir: 1 });
      });
      const sync = () => {
        const max = list.scrollWidth - list.clientWidth;
        prev.classList.toggle("off", max <= 4 || list.scrollLeft <= 4);
        next.classList.toggle("off", max <= 4 || list.scrollLeft >= max - 4);
      };
      list.addEventListener("scroll", sync, { passive: true });
      window.addEventListener("resize", sync);
      this._trackNavSync = sync;
    }
    // 重建卡片后 scrollLeft 归零，重算箭头可见性；选中卡若在视野外则滚到可见
    if (this._trackNavSync) requestAnimationFrame(this._trackNavSync);
    const on = list.querySelector(".trackcard.on");
    if (on && on.scrollIntoView) {
      requestAnimationFrame(() =>
        on.scrollIntoView({ block: "nearest", inline: "nearest" }),
      );
    }
  }

  /* ==================================================== 比赛 HUD */
  resetForRace(trackId) {
    this.lastTrackId = trackId;
    this.el.curtime.textContent = "0:00.00";
    this.el.lasttime.textContent = "--:--.--";
    this.el.score.textContent = "0";
    this.el.driftbox.classList.remove("on");
    this.el.toast.classList.remove("on", "info");
    this.el.achstack.innerHTML = "";
    this.renderItemSlot(this.el.itemSlot, null);
    this.renderItemSlot(this.el.sp1Item, null);
    this.renderItemSlot(this.el.sp2Item, null);
  }

  /** 道具赛开关：隐藏/显示道具槽 */
  setItemMode(on) {
    this.el.itemSlot.classList.toggle("hidden", !on);
    this.el.sp1Item.classList.toggle("hidden", !on);
    this.el.sp2Item.classList.toggle("hidden", !on);
    if (!on) {
      this.renderItemSlot(this.el.itemSlot, null);
      this.renderItemSlot(this.el.sp1Item, null);
      this.renderItemSlot(this.el.sp2Item, null);
    }
  }

  /** 单个道具槽：抽取滚动动画 → 定格 → 空槽 */
  renderItemSlot(el, r) {
    if (!el) return;
    const ic = el.querySelector(".ic");
    if (!r || (!r.item && !(r.itemRollT > 0))) {
      el.classList.remove("rolling", "has");
      if (ic) ic.textContent = "";
      return;
    }
    if (r.itemRollT > 0) {
      el.classList.add("rolling");
      el.classList.remove("has");
      const ic2 =
        ITEM_ICONS[ITEM_SEQ[((performance.now() / 90) | 0) % ITEM_SEQ.length]];
      if (ic) ic.textContent = ic2;
      el.title = t("item.rolling");
    } else {
      el.classList.add("has");
      el.classList.remove("rolling");
      if (ic) ic.textContent = ITEM_ICONS[r.item] || "?";
      el.title = t("item.use", pick(ITEM_NAMES[r.item]) || r.item);
    }
  }

  updateRaceHud(r, totalLaps, bestLap) {
    const kmh = Math.round(Math.abs(r.vF) * 3.6);
    this.el.speednum.textContent = kmh;
    this.el.gear.textContent = r.vF < -0.5 ? "R" : r.gear || 1;
    this.el.rpmfill.style.width = ((r.rpm || 0) * 100).toFixed(1) + "%";
    this.el.rpmfill.style.background =
      (r.rpm || 0) > 0.86
        ? "linear-gradient(90deg,#ff9d5c,#ff4d4d)"
        : "linear-gradient(90deg,#39d98a 0%,#ffd479 62%,#ff4d4d 88%)";
    this.el.lapnum.textContent = `${Math.min(r.lap, totalLaps)} / ${totalLaps}`;
    this.el.curtime.textContent = fmtTime(r.lapTime);
    this.el.besttime.textContent = fmtTime(r.bestLap || bestLap);
    this.el.lasttime.textContent = fmtTime(r.lastLap);
    this.el.score.textContent = r.score.toLocaleString();
    this.el.speedlines.style.opacity = (
      Math.min(1, Math.max(0, (kmh - 105) / 130)) * 0.65
    ).toFixed(2);

    if (r.drifting && r.driftPending > 1) {
      this.el.driftbox.classList.add("on");
      this.el.driftnum.textContent = Math.floor(
        r.driftPending * r.driftMult,
      ).toLocaleString();
      this.el.driftmult.textContent = "×" + r.driftMult.toFixed(1);
    } else {
      this.el.driftbox.classList.remove("on");
    }
    this.renderItemSlot(this.el.itemSlot, r);
  }

  updateSplitHud(r1, r2, totalLaps, ranks) {
    const set = (n, r) => {
      $("sp" + n + "-kmh").textContent = Math.round(Math.abs(r.vF) * 3.6);
      $("sp" + n + "-lap").textContent =
        `${Math.min(r.lap, totalLaps)}/${totalLaps}`;
      $("sp" + n + "-time").textContent = fmtTime(r.lapTime);
      $("sp" + n + "-rank").textContent = `${r.rank} / ${ranks}`;
    };
    set(1, r1);
    set(2, r2);
    this.renderItemSlot(this.el.sp1Item, r1);
    this.renderItemSlot(this.el.sp2Item, r2);
  }

  /** 名次榜（最多显示 8 行，自己高亮） */
  renderRanks(allRacers, localIds) {
    const rows = allRacers.slice(0, 8).map((r) => {
      const me = localIds.has(r.id) ? " me" : "";
      const paint = PAINTS[r.paint % PAINTS.length];
      const time = r.finished
        ? fmtTime(r.finishTime)
        : r.lap > 1
          ? "L" + r.lap
          : "";
      return `<div class="rank-row${me}">
        <span class="pos">${r.rank}</span>
        <span class="dot" style="background:#${paint.body.toString(16).padStart(6, "0")}"></span>
        <span class="nm">${r.name}</span>
        <span class="tm">${time}</span>
      </div>`;
    });
    this.el.ranklist.innerHTML = rows.join("");
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
    g.strokeStyle = "#8ee6b0";
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(
      p.toX(track.cx[I] + track.sx[I] * 8),
      p.toY(track.cz[I] + track.sz[I] * 8),
    );
    g.lineTo(
      p.toX(track.cx[I] - track.sx[I] * 8),
      p.toY(track.cz[I] - track.sz[I] * 8),
    );
    g.stroke();

    // 所有赛车（NPC 小点，本地玩家大箭头）
    for (const r of racers) {
      if (!r.mesh && !r.isRemote) continue;
      const x = p.toX(r.x),
        y = p.toY(r.z);
      const isLocal = localIds.has(r.id);
      const paint = PAINTS[(r.paint || 0) % PAINTS.length];
      const col = "#" + paint.body.toString(16).padStart(6, "0");
      if (!isLocal) {
        g.fillStyle = col;
        g.globalAlpha = 0.85;
        g.beginPath();
        g.arc(x, y, 5.5, 0, Math.PI * 2);
        g.fill();
        g.globalAlpha = 1;
      } else {
        g.save();
        g.translate(x, y);
        // 世界 +z → 画布 +y，前向 (sin h, cos h) ⇒ rotate(-h) 配默认朝下的箭头
        g.rotate(-r.heading);
        g.fillStyle = col;
        g.shadowColor = col;
        g.shadowBlur = 10;
        g.beginPath();
        g.moveTo(0, 11);
        g.lineTo(7, -8.5);
        g.lineTo(0, -4.5);
        g.lineTo(-7, -8.5);
        g.closePath();
        g.fill();
        g.restore();
      }
    }
  }

  /* ==================================================== 提示 / 横幅 */
  toast(msg, info = false, ms = 1600) {
    this.el.toast.textContent = msg;
    this.el.toast.classList.toggle("info", info);
    this.el.toast.classList.add("on");
    this.toastTimer = ms / 1000;
  }

  banner(big, sm) {
    this.el.banner.querySelector(".big").textContent = big;
    this.el.banner.querySelector(".sm").textContent = sm;
    this.el.banner.classList.remove("on");
    void this.el.banner.offsetWidth;
    this.el.banner.classList.add("on");
  }

  countdown(text) {
    this.el.cdnum.textContent = text;
    this.el.cdnum.classList.remove("pop");
    void this.el.cdnum.offsetWidth;
    this.el.cdnum.classList.add("pop");
  }

  flashWhite(alpha = 0.5, ms = 180) {
    this.el.flash.style.transition = "none";
    this.el.flash.style.opacity = String(alpha);
    requestAnimationFrame(() => {
      this.el.flash.style.transition = `opacity ${ms}ms ease-out`;
      this.el.flash.style.opacity = "0";
    });
  }

  tickTimers(dt) {
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.el.toast.classList.remove("on");
    }
  }

  achToast(meta) {
    const card = document.createElement("div");
    card.className = "achcard";
    card.innerHTML = `<div class="achicon">★</div>
      <div class="achtxt"><div class="l">${t("ach.unlock")}</div>
      <div class="t">${pick(meta.title)}</div><div class="d">${pick(meta.desc)}</div></div>`;
    this.el.achstack.appendChild(card);
    setTimeout(() => {
      card.classList.add("out");
      setTimeout(() => card.remove(), 360);
    }, 3600);
  }

  /* ==================================================== 联机 */
  setNetStatus(status, transport, room, players) {
    const el = this.el.netstat;
    el.classList.remove("online", "warn", "err");
    if (status === "online") {
      el.classList.add(transport === "poll" ? "warn" : "online");
      this.el.nettext.innerHTML = t(
        "netstat.line",
        `<b>${room || "----"}</b>`,
        players,
        transport === "poll" ? t("netstat.poll") : t("netstat.ws")
      );
    } else if (status === "connecting") {
      this.el.nettext.textContent = t("net.connecting");
    } else if (status === "error") {
      el.classList.add("err");
      this.el.nettext.textContent = t("net.failed");
    } else {
      this.el.nettext.textContent = t("net.offline");
    }
  }

  showLobbyRoom(roomCode, players, myId, hostId, isHost, trackName, laps) {
    this.el.lobbyConnect.classList.add("hide");
    this.el.lobbyRoom.classList.remove("hide");
    this.el.roomCode.textContent = roomCode || "----";
    this.el.lobbyCount.textContent = `(${players.length}/${8})`;
    this.el.playerList.innerHTML = players
      .map((p) => {
        const paint = PAINTS[p.paint % PAINTS.length];
        const tags = [];
        if (p.id === hostId) tags.push(`<span class="tag host">${t("lobby.host")}</span>`);
        if (p.id === myId) tags.push(`<span class="tag">${t("lobby.you")}</span>`);
        return `<div class="plrow">
        <span class="dot" style="background:#${paint.body.toString(16).padStart(6, "0")}"></span>
        <span style="flex:1">${p.name || t("lobby.driver")}</span>${tags.join("")}</div>`;
      })
      .join("");
    const btn = $("btn-race-start");
    btn.disabled = !isHost;
    btn.textContent = isHost ? t("lobby.startBtn") : t("lobby.waitHost");
    this.el.lobbyFoot.textContent = t("lobby.foot", trackName, laps);
  }

  showLobbyConnect() {
    this.el.lobbyConnect.classList.remove("hide");
    this.el.lobbyRoom.classList.add("hide");
  }

  /* ==================================================== 结算 */
  showResults({ title, sub, rows, unlocked, myIds }) {
    this.el.resultTitle.textContent = title;
    this.el.resultSub.textContent = sub || "";
    const head = `<tr><th>${t("result.colRank")}</th><th>${t(
      "result.colDriver"
    )}</th><th>${t("result.colLaps")}</th><th>${t("result.colTotal")}</th><th>${t(
      "result.colBest"
    )}</th></tr>`;
    const body = rows
      .map((r) => {
        const paint = PAINTS[(r.paint || 0) % PAINTS.length];
        const me = myIds.has(r.id) ? ' class="me"' : "";
        const pos = r.rank === 1 ? '<span class="p1">1</span>' : r.rank;
        return `<tr${me}>
        <td class="pos">${pos}</td>
        <td><span class="dot" style="background:#${paint.body.toString(16).padStart(6, "0")}"></span>${r.name}</td>
        <td>${r.laps}</td>
        <td>${r.finished ? fmtTime(r.finishTime) : t("result.dnf")}</td>
        <td>${r.bestLap ? fmtTime(r.bestLap) : "--:--.--"}</td>
      </tr>`;
      })
      .join("");
    this.el.resultTable.innerHTML = head + body;

    if (unlocked && unlocked.length) {
      this.el.resultAchSection.classList.remove("hide");
      this.el.resultAch.innerHTML = unlocked
        .map(
          (a) => `
        <div class="achitem"><div class="ic">★</div>
        <div><div class="t">${pick(a.title)}</div><div class="d">${pick(a.desc)}</div></div></div>`,
        )
        .join("");
    } else {
      this.el.resultAchSection.classList.add("hide");
    }
  }

  /* ==================================================== 成就面板 */
  renderAchievements(ach) {
    this.el.achCount.textContent = `${ach.count()} / ${ach.total()}`;
    this.el.achGrid.innerHTML = ACHIEVEMENTS.map((a) => {
      const un = ach.isUnlocked(a.id);
      const tier = a.tier === "master" ? "★" : a.tier === "pro" ? "✦" : "·";
      return `<div class="achitem${un ? "" : " locked"}">
        <div class="ic">${un ? tier : "?"}</div>
        <div><div class="t">${pick(a.title)}</div><div class="d">${pick(a.desc)}</div></div></div>`;
    }).join("");
  }

  /* ==================================================== 事件接线 */
  _wire() {
    /* 操作帮助浮层：入口按钮 + 关闭按钮（关闭即记「已读」避免每次弹） */
    if (this.el.helpFab) {
      this.el.helpFab.addEventListener("click", () => this.showHelp());
    }
    if (this.el.helpClose) {
      this.el.helpClose.addEventListener("click", () => {
        this.hideHelp();
        try { localStorage.setItem("dr-tut-done", "1"); } catch (e) {}
      });
    }
    /* H 键随时唤出/隐藏比赛中键位提示（菜单态与输入框内不触发） */
    addEventListener("keydown", (e) => {
      if (e.code !== "KeyH") return;
      if (e.target && e.target.tagName === "INPUT") return;
      if (this.el.menu && !this.el.menu.classList.contains("hide")) return;
      this.toggleRaceHint();
    });

    const segClick = (id, attr, key) => {
      $(id).addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b || !b.dataset[attr]) return;
        this.state[key] =
          attr === "laps" ? Number(b.dataset[attr]) : b.dataset[attr];
        $(id)
          .querySelectorAll("button")
          .forEach((x) => x.classList.toggle("on", x === b));
        this.cb.onPrefs && this.cb.onPrefs(this.state);
      });
    };
    segClick("level-seg", "level", "level");
    segClick("laps-seg", "laps", "laps");
    /* 模式：联机不支持道具赛，切到联机时道具赛自动回落竞速 */
    $("mode-seg").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b || !b.dataset.mode) return;
      this.state.mode = b.dataset.mode;
      $("mode-seg")
        .querySelectorAll("button")
        .forEach((x) => x.classList.toggle("on", x === b));
      if (this.state.mode === "online" && this.state.format === "item") {
        this.state.format = "classic";
        $("format-seg")
          .querySelectorAll("button")
          .forEach((x) =>
            x.classList.toggle("on", x.dataset.format === "classic"),
          );
        this.toast(t("toast.onlineClassic"), true, 1400);
      }
      this.cb.onPrefs && this.cb.onPrefs(this.state);
    });
    /* 赛制：联机暂不支持道具赛，选中即时拦截 */
    $("format-seg").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b || !b.dataset.format) return;
      if (this.state.mode === "online" && b.dataset.format === "item") {
        this.toast(t("toast.itemNoOnline"), false);
        return;
      }
      this.state.format = b.dataset.format;
      $("format-seg")
        .querySelectorAll("button")
        .forEach((x) => x.classList.toggle("on", x === b));
      this.cb.onPrefs && this.cb.onPrefs(this.state);
    });

    /* 道具槽点击 = 使用道具（触屏玩家的唯一使用入口） */
    this.el.itemSlot.addEventListener("click", () => {
      this.cb.onUseItem && this.cb.onUseItem(1);
      analytics.track("menu.item.use", { slot: 1 });
    });
    this.el.sp1Item.addEventListener("click", () => {
      this.cb.onUseItem && this.cb.onUseItem(1);
      analytics.track("menu.item.use", { slot: 1 });
    });
    this.el.sp2Item.addEventListener("click", () => {
      this.cb.onUseItem && this.cb.onUseItem(2);
      analytics.track("menu.item.use", { slot: 2 });
    });

    /* 分步导航 */
    $("btn-prev").addEventListener("click", () => {
      this.setMenuStep(this.menuStep - 1);
      analytics.track("menu.nav.prev", { step: this.menuStep - 1 });
    });
    $("btn-next").addEventListener("click", () => {
      this.menuAdvance();
      analytics.track("menu.nav.next", { step: this.menuStep + 1 });
    });
    $("menu-steps").addEventListener("click", (e) => {
      const b = e.target.closest(".stp");
      if (b) {
        this.setMenuStep(Number(b.dataset.step));
        analytics.track("menu.nav.step", { step: Number(b.dataset.step) });
      }
    });

    this.el.nameInput.addEventListener("input", () => {
      this.state.name = this.el.nameInput.value.slice(0, 10);
      this.cb.onPrefs && this.cb.onPrefs(this.state);
      analytics.track("menu.name.input", { nameLen: this.state.name.length });
    });

    $("btn-go").addEventListener("click", () => {
      this.cb.onGo(this.state);
      analytics.track("menu.go", { state: this.state });
    });
    /* 电视模式 / 全屏：投屏到电视的两件事（放大 + 占满屏），详见 src/tv.js */
    $("btn-tv").addEventListener("click", () => {
      this.cb.onTV && this.cb.onTV();
      analytics.track("menu.tv", {});
    });
    $("btn-fs").addEventListener("click", () => {
      this.cb.onFullscreen && this.cb.onFullscreen();
      analytics.track("menu.fullscreen", {});
    });
    const fb = $("btn-send-feedback");
    if (fb) {
      fb.addEventListener("click", async () => {
        analytics.track("menu.feedback.click", {});
        this.toast(t("feedback.sending"), true, 3000);
        try {
          const ok = await analytics.sendNow();
          if (ok) this.toast(t("feedback.sent"), true, 1600);
          else this.toast(t("feedback.saveLocal"), false, 2000);
        } catch (e) {
          this.toast(t("feedback.fail"), false, 2000);
        }
      });
    }

    // menu navigation telemetry: focus and key navigation to capture "跳来跳去" behaviour
    document.addEventListener("focusin", (e) => {
      const active = this.activeScreen();
      if (active && active.id === "menu") {
        analytics.track("menu.focus.in", {
          id: e.target && e.target.id ? e.target.id : null,
        });
      }
    });
    document.addEventListener("keydown", (e) => {
      const active = this.activeScreen();
      if (active && active.id === "menu") {
        analytics.track("menu.focus.keydown", {
          key: e.key,
          activeId: document.activeElement && document.activeElement.id,
        });
      }
    });
    $("btn-ach").addEventListener("click", () => {
      this.el.pauseTitle.textContent = t("pause.ach");
      this.el.achPanel.classList.remove("hide");
      this.showScreen("pause");
      $("btn-resume").classList.add("hide");
      $("btn-restart").classList.add("hide");
      $("btn-quit").textContent = t("pause.quit");
      analytics.track("menu.ach.open", {});
    });
    $("btn-lobby-back").addEventListener("click", () => {
      this.cb.onBackMenu && this.cb.onBackMenu();
      analytics.track("menu.lobby.back", {});
    });
    $("btn-create").addEventListener("click", () => {
      this.cb.onCreate(this.state);
      analytics.track("menu.create", { state: this.state });
    });
    $("btn-join").addEventListener("click", () => {
      const code = ($("join-code").value || "").toUpperCase().trim();
      if (code.length !== 4) {
        this.toast(t("toast.room4"), false);
        return;
      }
      analytics.track("menu.join.attempt", { room: code });
      this.cb.onJoin({ ...this.state, room: code });
    });
    $("join-code").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        analytics.track("menu.join.key", {});
        $("btn-join").click();
      }
    });
    $("btn-race-start").addEventListener("click", () => {
      this.cb.onRaceStart && this.cb.onRaceStart();
      analytics.track("menu.race.start", {});
    });
    $("btn-leave").addEventListener("click", () => {
      this.cb.onLeave && this.cb.onLeave();
      analytics.track("menu.leave", {});
    });
    $("btn-resume").addEventListener("click", () => {
      this.cb.onResume && this.cb.onResume();
      analytics.track("menu.resume", {});
    });
    $("btn-restart").addEventListener("click", () => {
      this.cb.onRestart && this.cb.onRestart();
      analytics.track("menu.restart", {});
    });
    $("btn-quit").addEventListener("click", () => {
      this.cb.onQuit && this.cb.onQuit();
      analytics.track("menu.quit", {});
    });
    $("btn-again").addEventListener("click", () => {
      this.cb.onRestart && this.cb.onRestart();
      analytics.track("menu.again", {});
    });
    $("btn-back-menu").addEventListener("click", () => {
      this.cb.onQuit && this.cb.onQuit();
      analytics.track("menu.back", {});
    });
  }

  /** 进入比赛界面时恢复正常暂停菜单按钮 */
  restorePauseButtons() {
    this.el.pauseTitle.textContent = t("pause.title");
    this.el.achPanel.classList.remove("hide");
    $("btn-resume").classList.remove("hide");
    $("btn-restart").classList.remove("hide");
    $("btn-quit").textContent = t("pause.quit");
  }

  showFatal(msg) {
    this.el.fatal.style.display = "block";
    this.el.fatal.textContent = t("fatal", msg);
    document.title = "ERR · " + String(msg).slice(0, 120);
    window.__DR_ERROR__ = String(msg);
  }
}
