/* ===========================================================================
 * app.js — 主程序：渲染 / 场景 / 相机 / 输入 / 比赛流程 / 联机 / 特效
 *
 * 三种模式共用同一套「赛车对象 + 物理 + 特效」：
 *   solo   本地 1 位玩家 + AI
 *   split  同屏上下分屏 2 位玩家（各自独立相机与 HUD）+ AI
 *   online 联机 8 人房间（自己本地算，他人快照插值）
 * =========================================================================*/

import * as THREE from "three";

import {
  CFG,
  TRACKS,
  TRACK_ORDER,
  PAINTS,
  AI_LEVELS,
  MODES,
  FORMATS,
  STORAGE,
} from "./config.js";
import { createItemSystem, ITEM_NAMES } from "./items.js";
import { buildTrack, terrainHeight } from "./track.js";
import { buildRoad } from "./road.js";
import { buildWorld } from "./world.js";
import {
  buildCarMesh,
  makeRacer,
  placeOnGrid,
  stepRacer,
  resolveCarCollisions,
  computeRanks,
} from "./car.js";
import { createAIDriver, racerDistance } from "./ai.js";
import {
  createSmokeSystem,
  createSkidSystem,
  emitRacerEffects,
} from "./effects.js";
import { AudioEngine } from "./audio.js";
import { Achievements } from "./achievements.js";
import { UI } from "./hud.js";
import { NetClient, probeRoom } from "./net.js";
import { cloud, pullCloudState } from "./cloud.js";
import { CloudUI } from "./cloudui.js";
import { TouchControls } from "./touch.js";
import { createPadController } from "./pad.js";
import { clamp, damp, makeRng, DRIVER_NAMES, fmtTime } from "./util.js";

/* ------------------------------------------------------------ 持久化偏好 */
function loadPrefs() {
  const get = (k, d) => {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : JSON.parse(v);
    } catch (e) {
      return d;
    }
  };
  return {
    mode: get("dr-mode", "solo"),
    track: get("dr-track", "coast"),
    level: get("dr-level", "normal"),
    laps: get("dr-laps", 3),
    format: get("dr-format", "classic"),
    name: get("dr-name", ""),
    paint: get("dr-paint", 0),
    bests: get("dr-bests", {}),
    /* 触屏操控偏好（桌面端用不到，但存着不影响） */
    touchAutoGas: get("dr-touch-autogas", true),
    touchHand: get("dr-touch-hand", "right"),
    touchSens: get("dr-touch-sens", 1),
    touchTilt: get("dr-touch-tilt", false),
    touchTold: get("dr-touch-told", false),
  };
}
const saveKey = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch (e) {}
};

const prefs = loadPrefs();
if (!prefs.name)
  prefs.name = DRIVER_NAMES[Math.floor(Math.random() * DRIVER_NAMES.length)];

/* ------------------------------------------------------------------ 全局态 */
const game = {
  mode: MODES.SOLO,
  phase: "menu", // menu | lobby | countdown | race | paused | result
  trackId: prefs.track,
  laps: prefs.laps,
  level: prefs.level,
  format: prefs.format || FORMATS.CLASSIC,
  items: null, // 道具赛系统（item 赛制时创建，clearRace 销毁）
  track: null,
  world: null,
  road: null,
  racers: [],
  locals: [],
  aiDrivers: new Map(), // racer.id -> aiDriver
  remoteMeshes: new Map(), // netId -> meshData
  raceStartAt: 0,
  countdownEnds: 0,
  rankTimer: 0,
  netTimer: 0,
  onlineFinished: false,
  waitingResults: false,
  resultsFallbackAt: 0,
  startDelay: null,
  maxKmh: 0, // 本场最高时速（结算时随成绩一起上传）
};
const localIds = new Set();

/* ------------------------------------------------------------------ 渲染器 */
const app = document.getElementById("app");
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.06;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();

/** 每路相机（分屏时两路） */
function makeCamState() {
  return {
    cam: new THREE.PerspectiveCamera(64, innerWidth / innerHeight, 0.35, 2600),
    fov: 64,
    mode: 0,
    look: new THREE.Vector3(),
    tmp: new THREE.Vector3(),
    up: new THREE.Vector3(0, 1, 0),
  };
}
const camA = makeCamState();
const camB = makeCamState();

/* 调试机位覆写（默认 null = 不生效，正常玩法零影响）。
   用于验收脚本把镜头对准海岸线、远山这类从赛道视角看不到的景物做截图比对。
   —— 若没有它，赛道视角永远朝内陆，海面改动根本没法用截图证明。 */
let camOverride = null;

/* -------------------------------------------------------------- 赛道数据 */
const trackObjects = {};
for (const id of TRACK_ORDER) trackObjects[id] = buildTrack(id);

/* -------------------------------------------------------------- 特效系统 */
const smoke = createSmokeSystem(THREE, scene);
const skid = createSkidSystem(THREE, scene);
const quality = { level: 2, samples: [], lastAdjust: 0 };

/* 画质等级：2=满血 1=省电(半分辨率) 0=最低(半分辨率+关阴影+远景减半)
   与旧版本的区别：旧逻辑只会往下掉、从不回升；现在 fps 回稳后会自动升回去，
   长时间卡顿的设备也不会因为「曾经掉过帧」就永远停在低画质。 */
const DETAIL_FACTOR = [0.42, 0.7, 1];
function applyQualityLevel(level) {
  level = clamp(level, 0, 2);
  quality.level = level;
  renderer.setPixelRatio(Math.min(devicePixelRatio, level >= 2 ? 2 : 1));
  const shadowsOn = level >= 1;
  if (renderer.shadowMap.enabled !== shadowsOn) {
    renderer.shadowMap.enabled = shadowsOn;
    scene.traverse((o) => {
      if (o.material) o.material.needsUpdate = true;
    });
  }
  if (game.world && game.world.setDetail)
    game.world.setDetail(DETAIL_FACTOR[level]);
}

/* ---------------------------------------------------------------- 音频 */
const audio = new AudioEngine();

/* ---------------------------------------------------------------- 成就 */
const ach = new Achievements();

/* ---------------------------------------------------------------- 联机 */
const net = new NetClient();

/* ------------------------------------------------------------------ UI */
const ui = new UI({
  onPrefs(s) {
    const trackChanged = prefs.track !== s.track;
    const changed =
      prefs.mode !== s.mode ||
      trackChanged ||
      prefs.level !== s.level ||
      prefs.laps !== s.laps ||
      prefs.format !== s.format ||
      prefs.name !== s.name ||
      prefs.paint !== s.paint;
    Object.assign(prefs, s);
    saveKey("dr-mode", s.mode);
    saveKey("dr-track", s.track);
    saveKey("dr-level", s.level);
    saveKey("dr-laps", s.laps);
    saveKey("dr-format", s.format);
    saveKey("dr-name", s.name);
    saveKey("dr-paint", s.paint);
    // 菜单动态背景实时跟随所选赛道：点卡片即换景（重建世界与演示车）
    if (trackChanged && game.phase === "menu") {
      ensureWorld(s.track);
      ensureAttract();
    }
    if (changed) audio.chime("click");
    ui.renderMenuFoot(prefs.bests, ach);
  },
  onGo(s) {
    Object.assign(prefs, s);
    if (s.mode === "online") {
      ui.showScreen("lobby");
      ui.showLobbyConnect();
      ui.showNet = true;
      ui.setNetStatus("idle", null, null, 0);
      game.phase = "lobby";
      audio.init();
    } else {
      ui.showNet = false;
      startRace({
        mode: s.mode,
        track: s.track,
        laps: s.laps,
        level: s.level,
        format: s.format,
      });
    }
  },
  async onCreate(s) {
    audio.init();
    ui.setNetStatus("connecting", null, null, 0);
    net.open({
      mode: "create",
      name: s.name,
      paint: s.paint,
      track: s.track,
      laps: s.laps,
      level: s.level,
    });
  },
  async onJoin(s) {
    audio.init();
    const probe = await probeRoom(s.room);
    if (!probe.exists) {
      ui.toast("房间不存在，检查一下房间码", false);
      return;
    }
    if (probe.started) {
      ui.toast("这局已经发车了", false);
      return;
    }
    ui.setNetStatus("connecting", null, s.room, probe.players);
    net.open({ mode: "join", room: s.room, name: s.name, paint: s.paint });
  },
  onRaceStart() {
    net.start();
  },
  onLeave() {
    net.close();
    ui.showLobbyConnect();
    game.phase = "lobby";
  },
  onResume() {
    if (game.phase === "paused") {
      game.phase = "race";
      ui.showScreen(null);
    }
  },
  onRestart() {
    startRace({
      mode: game.mode,
      track: game.trackId,
      laps: game.laps,
      level: game.level,
      format: game.format,
    });
  },
  onQuit() {
    quitToMenu();
  },
  onBackMenu() {
    quitToMenu();
  },
  onUseItem: (slot) => useLocalItem(slot),
});

ach.onUnlock = (meta) => {
  ui.achToast(meta);
  audio.chime("ach");
  queueAchievementPush();
};
ach.onChange = () => ui.renderMenuFoot(prefs.bests, ach);

/* ==========================================================================
 * 云服务集成
 *
 * 定位：本地存档永远是第一位的（断网、未登录都能完整游戏）；云端是叠加层。
 * 三条硬规则：
 *   1) 云调用失败必须降级为本地行为，并把失败如实告诉玩家，绝不假装保存成功
 *   2) 只上传「本机玩家」的成绩；分屏 P2 与 AI、远端玩家不存在账号身份
 *   3) 云不可用时游戏功能完全不受影响
 * =========================================================================*/
const cloudUI = new CloudUI({
  cloud,
  toast: (msg, ok) => ui.toast(msg, !!ok, 2200),
  onBack() {
    ui.showScreen("menu");
    renderCloudLine();
  },
  onSignedIn: () => syncCloudAfterLogin(),
  onSignedOut() {
    renderCloudLine();
    ui.toast("已退出登录，本机成绩与成就仍然保留", true);
  },
});

function escapeText(s) {
  return String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

/** 菜单底部的云端状态行 */
function renderCloudLine() {
  const el = document.getElementById("cloudline");
  if (!el) return;
  if (cloud.status === "idle" || cloud.status === "loading") {
    el.innerHTML = '<span class="cd wait"></span>正在连接云服务…';
    return;
  }
  if (cloud.status !== "ready") {
    el.innerHTML =
      '<span class="cd bad"></span>云服务不可用 · 离线模式，成绩与成就保存在本机';
    return;
  }
  if (cloud.signedIn) {
    const email = (cloud.user && cloud.user.email) || "";
    el.innerHTML = `<span class="cd ok"></span>已登录 ${escapeText(email)} · 圈速与成就已云端同步`;
  } else {
    el.innerHTML =
      '<span class="cd"></span>未登录 · 成绩只保存在本机，点「账号」登录后可上榜';
  }
}

/** 登录成功后的编排：档案以云端为准，成就取并集 */
async function syncCloudAfterLogin() {
  const res = await pullCloudState(ach);
  if (res.profile) {
    // 云端档案优先，换设备后昵称与涂装保持一致
    if (res.profile.display_name) {
      prefs.name = res.profile.display_name;
      saveKey("dr-name", prefs.name);
    }
    if (typeof res.profile.paint === "number") {
      prefs.paint = res.profile.paint;
      saveKey("dr-paint", prefs.paint);
    }
    ui.buildMenu(prefs, prefs.bests, ach);
    ui.buildTrackCards(trackObjects, prefs.bests, game.trackId);
  } else {
    // 首次登录：把本机昵称/涂装作为云端档案初始值
    await cloud.saveProfile({
      display_name: prefs.name,
      paint: prefs.paint,
      races: 0,
      wins: 0,
      total_km: 0,
    });
  }
  if (res.mergedAchievements) {
    const added = ach.mergeUnlocked(res.mergedAchievements);
    if (added) ui.renderAchievements(ach);
    achPushed = new Set(ach.unlocked); // 刚才已整体推送过
    ui.renderMenuFoot(prefs.bests, ach);
  }
  if (res.errors.length) ui.toast(res.errors[0], false);
  renderCloudLine();
}

/* --- 新解锁成就的增量推送 --- */
let achPushed = new Set();
let achPushTimer = 0;
function queueAchievementPush() {
  if (!cloud.signedIn) return;
  clearTimeout(achPushTimer);
  achPushTimer = setTimeout(async () => {
    const fresh = [...ach.unlocked].filter((id) => !achPushed.has(id));
    if (!fresh.length) return;
    try {
      await cloud.syncAchievements(fresh, prefs.name);
      for (const id of fresh) achPushed.add(id);
    } catch (e) {
      /* 推送失败不打断游戏；下次登录会整体合并补齐 */
    }
  }, 1200);
}

/**
 * 结算后提交：本场最佳圈速上榜 + 累加云端战绩。
 * 未登录/云不可用时明确提示「只存本机」，不产生任何伪成功。
 */
async function submitCloudResult({
  trackId,
  lapMs,
  topKmh,
  driftScore,
  mode,
  rank,
}) {
  if (!cloud.available) {
    ui.toast("云服务不可用，成绩已保存在本机", false);
    return null;
  }
  if (!cloud.signedIn) {
    ui.toast("未登录 · 成绩只保存在本机（点「账号」登录后可上榜）", false);
    return null;
  }
  if (!lapMs) return null;

  let row = null;
  try {
    row = await cloud.submitLap({
      trackId,
      lapMs,
      topKmh,
      driftScore,
      mode,
      playerName: prefs.name,
    });
    ui.toast("本场最佳圈速已上传排行榜", true);
  } catch (e) {
    ui.toast("成绩上传失败：" + (e.message || e), false);
    return null;
  }

  try {
    const cur = (await cloud.loadProfile()) || {};
    const km = game.track ? (game.track.total * game.laps) / 1000 : 0;
    await cloud.saveProfile({
      display_name: prefs.name,
      paint: prefs.paint,
      races: (cur.races || 0) + 1,
      wins: (cur.wins || 0) + (rank === 1 ? 1 : 0),
      total_km: Math.round(((cur.total_km || 0) + km) * 10) / 10,
      best_lap_ms: cur.best_lap_ms ? Math.min(cur.best_lap_ms, lapMs) : lapMs,
    });
  } catch (e) {
    ui.toast("云端战绩更新失败：" + (e.message || e), false);
  }
  return row;
}

cloud.subscribe(() => renderCloudLine());

/* ==========================================================================
 * 世界构建（换赛道时重建）
 * =========================================================================*/
function ensureWorld(trackId) {
  const track = trackObjects[trackId];
  if (game.track === track && game.world) return track;
  if (game.world) {
    game.world.dispose();
    game.world = null;
  }
  if (game.road) {
    scene.remove(game.road.group);
    game.road.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (o.material.map) o.material.map.dispose();
        o.material.dispose();
      }
    });
    game.road = null;
  }
  game.track = track;
  game.trackId = trackId;
  game.world = buildWorld(THREE, scene, track, renderer);
  game.road = buildRoad(THREE, track, renderer);
  scene.add(game.road.group);
  skid.clear();
  smoke.clear();
  applyQualityLevel(quality.level); // 新世界的远景实例默认满编，按当前画质等级同步一次
  return track;
}

/* ==========================================================================
 * 菜单动态背景（attract mode）
 *
 * 菜单不再是静态底图：当前所选赛道的世界常驻渲染，3 台 AI 演示车沿赛道
 * 巡航，相机在「追尾 / 航拍 / 环绕」三种机位间轮换。离开菜单（开局、进
 * 大厅）自动清理，回到菜单（含换赛道）自动重建 —— 状态完全由主循环托管。
 * =========================================================================*/
const attract = {
  on: false,
  trackId: null,
  racers: [],
  drivers: new Map(),
  acc: 0,
  shot: 0,
  shotAt: 0,
  leader: null,
};
const ATTRACT_SHOT_MS = 8500;
const ATTRACT_SHOTS = [0, 3, 2]; // 追尾 → 航拍 → 环绕
const ATTRACT_CTX = {
  track: null,
  onWall: () => {},
  onDriftBank: () => {},
  onContact: () => {},
};

function disposeAttract() {
  for (const r of attract.racers) detachMesh(r);
  attract.racers = [];
  attract.drivers.clear();
  attract.on = false;
  attract.leader = null;
}

function ensureAttract() {
  if (game.phase !== "menu") return;
  if (attract.on && attract.trackId === game.trackId) return;
  disposeAttract();
  const T = game.track;
  ATTRACT_CTX.track = T;
  const rng = makeRng(
    (CFG.SEED + 777 + Math.round(trackObjects[game.trackId].total)) | 0,
  );
  for (let i = 0; i < 3; i++) {
    const name = DRIVER_NAMES[Math.floor(rng() * DRIVER_NAMES.length)];
    const r = makeRacer({
      id: "demo" + i,
      name,
      kind: "ai",
      slot: i,
      paint: (prefs.paint + 1 + i * 3) % PAINTS.length,
    });
    attachMesh(r);
    placeOnGrid(r, T, i);
    attract.racers.push(r);
    attract.drivers.set(r.id, createAIDriver(T, "normal", i + 1));
  }
  attract.trackId = game.trackId;
  attract.on = true;
  attract.acc = 0;
  attract.shot = 0;
  attract.shotAt = performance.now();
  attract.leader = attract.racers[0];
  // 相机直接落到领头车后侧，避免从结算/大厅视角长距离飞过来
  const p = attract.leader,
    sh = Math.sin(p.heading),
    ch = Math.cos(p.heading);
  camA.cam.position.set(p.x - sh * 11, p.y + 4.5, p.z - ch * 11);
  camA.cam.lookAt(p.x, p.y + 1, p.z);
}

function stepAttract(rawDt) {
  attract.acc = Math.min(attract.acc + rawDt, 0.1);
  let guard = 0;
  while (attract.acc >= FIXED_DT && guard++ < 24) {
    attract.acc -= FIXED_DT;
    for (const r of attract.racers) {
      const driver = attract.drivers.get(r.id);
      if (driver)
        driver.update(r, FIXED_DT, { racers: attract.racers, gapToHuman: 0 });
      stepRacer(r, FIXED_DT, ATTRACT_CTX);
    }
    resolveCarCollisions(attract.racers, ATTRACT_CTX);
  }
  // 相机主体 = 沿赛道进度最大的一台演示车
  let lead = attract.racers[0],
    leadD = -Infinity;
  for (const r of attract.racers) {
    const d = racerDistance(game.track, r);
    if (d > leadD) {
      leadD = d;
      lead = r;
    }
  }
  attract.leader = lead;
  for (const r of attract.racers)
    emitRacerEffects(r, smoke, skid, game.track, quality, THREE);
}

/** 机位轮换。updateCamera 内部用 damp 收敛，切换机位时镜头自然过渡 */
function updateAttractCamera(rawDt) {
  if (!attract.leader) return;
  const now = performance.now();
  if (now - attract.shotAt > ATTRACT_SHOT_MS) {
    attract.shot = (attract.shot + 1) % ATTRACT_SHOTS.length;
    attract.shotAt = now;
  }
  const realMode = camA.mode;
  camA.mode = ATTRACT_SHOTS[attract.shot];
  updateCamera(camA, attract.leader, rawDt);
  camA.mode = realMode;
}

/* ==========================================================================
 * 赛车网格管理
 * =========================================================================*/
function attachMesh(racer) {
  const md = buildCarMesh(THREE, PAINTS[racer.paint % PAINTS.length]);
  racer.meshData = md;
  racer.mesh = md.group;
  scene.add(md.group);
  return md;
}
function detachMesh(racer) {
  if (!racer.mesh) return;
  scene.remove(racer.mesh);
  racer.mesh.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
  });
  racer.mesh = null;
  racer.meshData = null;
}

/* ==========================================================================
 * 比赛流程
 * =========================================================================*/
function clearRace() {
  for (const r of game.racers) detachMesh(r);
  for (const r of game.locals) audio.removeEngine(r.id);
  game.racers = [];
  game.locals = [];
  game.aiDrivers.clear();
  localIds.clear();
  for (const [, md] of game.remoteMeshes) {
    scene.remove(md.group);
    md.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
  }
  game.remoteMeshes.clear();
  skid.clear();
  smoke.clear();
  if (game.items) {
    game.items.dispose();
    game.items = null;
    window.__DR_IX__ = null;
  }
  for (const r of [...net.remotes.values()]) r.hasData = false;
}

/** 使用本地玩家的道具（键盘 E / 右Shift，或点击道具槽） */
function useLocalItem(slot) {
  const r = game.locals[slot - 1];
  if (!r || !game.items || game.phase !== "race") return;
  const it = game.items.useItem(r, game.racers);
  if (it) ui.toast(`使用 ${ITEM_NAMES[it] || it}`, true, 900);
}

function startRace({ mode, track, laps, level, format }) {
  audio.init();
  clearRace();
  game.mode = mode;
  game.laps = laps;
  game.level = level;
  /* 联机暂不支持道具赛（各客户端不同步道具状态），强制回竞速 */
  game.format =
    mode === MODES.ONLINE ? FORMATS.CLASSIC : format || FORMATS.CLASSIC;
  game.phase = "countdown";
  game.onlineFinished = false;
  game.waitingResults = false;
  game.resultsFallbackAt = 0;
  game.startDelay = null;
  game.maxKmh = 0;

  const T = ensureWorld(track);
  ui.resetForRace(track);
  ui.setSplit(mode === MODES.SPLIT);
  ui.setItemMode(game.format === FORMATS.ITEM);
  ui.restorePauseButtons();
  ui.showScreen(null);
  touch.resetHome(); // 方向盘回到默认位，避免上一局的浮动位置残留

  /* ---- 道具赛：道具箱 / 油污 / 导弹系统 ---- */
  if (game.format === FORMATS.ITEM) {
    game.items = createItemSystem(THREE, scene, T);
    window.__DR_IX__ = game.items; // 验收脚本/调试钩子
    game.items.testHooks = {
      giveLocal: (type) => {
        const me = game.locals[0];
        if (!me) return false;
        me.itemRollT = 0;
        me.itemRollFinal = null;
        me.item = type || "boost";
        return true;
      },
      useLocal: (slot) => {
        useLocalItem(slot || 1);
        return true;
      },
      teleportLocalToBox: (i) => {
        const me = game.locals[0];
        const b = game.items && game.items.boxes[i];
        if (!me || !b || !b.active) return false;
        // 必须同步 idx/lateral，否则下一次 stepRacer 的 project(hint=旧idx)
        // 会在有限窗口里找不到真位置，护墙钳制把车拉离箱子好几米
        me.x = b.x;
        me.y = b.y;
        me.z = b.z;
        me.idx = b.idx;
        me.lateral = b.lane;
        me.vF = 0;
        me.vL = 0;
        return true;
      },
      oilAhead: () => {
        const me = game.locals[0];
        if (!me) return false;
        const sh = Math.sin(me.heading),
          ch = Math.cos(me.heading);
        game.items.spawnOil(me.x + sh * 16, me.y, me.z + ch * 16, me.idx, "x");
        return true;
      },
      fireMissileAtMe: () => {
        const me = game.locals[0];
        if (!me) return false;
        const n = game.track.n;
        const back = Math.round(60 / game.track.step); // 60m ≈ 多少个采样点
        return game.items.fireMissile(
          { id: "test", idx: (me.idx - back + n * 2) % n, lateral: me.lateral },
          me,
        );
      },
      spinLocal: () => {
        const me = game.locals[0];
        return me ? game.items.spinOut(me, "oil") : null;
      },
    };
    const hint =
      mode === MODES.SPLIT
        ? "P1 按 E · P2 按右Shift 使用道具，也可点击道具槽"
        : touch.isTouch
          ? "吃到道具箱后点击左下道具槽使用"
          : "按 E（或手柄 X）使用道具";
    setTimeout(
      () => ui.toast(`道具赛！吃道具箱抽道具 · ${hint}`, true, 4200),
      600,
    );
  }

  /* 触屏玩家的第一局给一次操作提示 —— 拖动转向这件事不看提示不容易猜到 */
  if (touch.isTouch && !prefs.touchTold) {
    prefs.touchTold = true;
    saveKey("dr-touch-told", true);
    setTimeout(
      () => ui.toast("左侧按住拖动 = 转向 · 右侧踏板 = 油门/刹车", true, 4200),
      500,
    );
  }

  /* ---- 本地玩家 ---- */
  const playerCount = mode === MODES.SPLIT ? 2 : 1;
  for (let i = 0; i < playerCount; i++) {
    const r = makeRacer({
      id: i === 0 ? "me" : "me2",
      name: i === 0 ? prefs.name || "你" : "P2",
      paint: i === 0 ? prefs.paint : (prefs.paint + 4) % PAINTS.length,
      kind: i === 0 ? "local" : "split2",
      slot: i,
    });
    attachMesh(r);
    placeOnGrid(r, T, i);
    game.racers.push(r);
    game.locals.push(r);
    localIds.add(r.id);
    audio.addEngine(r.id);
  }

  /* ---- AI 车手（联机模式下不加，对手是真人） ---- */
  if (mode !== MODES.ONLINE) {
    const lv = AI_LEVELS[level] || AI_LEVELS.normal;
    const rng = makeRng(CFG.SEED + track.length * 13);
    const usedNames = new Set(DRIVER_NAMES.slice(0, 0));
    for (let i = 0; i < lv.count; i++) {
      let name = DRIVER_NAMES[Math.floor(rng() * DRIVER_NAMES.length)];
      while (usedNames.has(name))
        name = DRIVER_NAMES[Math.floor(rng() * DRIVER_NAMES.length)];
      usedNames.add(name);
      const paint = (i + 1 + Math.floor(rng() * 3)) % PAINTS.length;
      const r = makeRacer({
        id: "ai" + i,
        name,
        paint,
        kind: "ai",
        slot: playerCount + i,
      });
      attachMesh(r);
      placeOnGrid(r, T, playerCount + i);
      game.racers.push(r);
      game.aiDrivers.set(r.id, createAIDriver(T, level, i + 1));
    }
  }

  ach.beginRace({
    mode,
    aiLevel: level,
    trackId: track,
    onlinePlayers: mode === MODES.ONLINE ? net.players.length : 0,
    startDelay: null,
    localScores: game.locals.map((r) => r.score),
  });

  // 联机：本地车是在服务器发车时才创建的，这里只等信号
  if (mode === MODES.ONLINE) {
    game.phase = "waiting";
    ui.showNet = true;
    ui.toast("等待房主发车…", true, 4000);
    ui.showScreen("lobby");
    return;
  }

  ui.showNet = false;
  cameraSnap(T);
  game.raceStartAt = 0;
  ui.showScreen(null);
  beginCountdown(3600);
}

function beginCountdown(ms) {
  game.phase = "countdown";
  game.countdownEnds = performance.now() + ms;
  // 让 GO 恰好落在 ms 时刻：四拍均分倒计时时长
  const stepMs = clamp(ms / 4, 280, 900);
  const steps = ["3", "2", "1", "GO"];
  steps.forEach((s, i) => {
    const at = ms - (3 - i) * stepMs;
    setTimeout(
      () => {
        if (game.phase !== "countdown" && game.phase !== "race") return;
        ui.countdown(s);
        if (s === "GO") {
          audio.chime("go");
          game.phase = "race";
          game.raceStartAt = performance.now();
          game.startDelay = 0;
          // 单圈计时从发车瞬间开始（发车位在起点线之后，第一圈就是完整一圈）
          for (const r of game.racers) {
            r.lapStartAt = game.raceStartAt;
            r.prevProgress = r.idx / game.track.n;
          }
          game.firstInputDone = false;
        } else {
          audio.chime("count");
        }
      },
      Math.max(0, at),
    );
  });
  ui.countdown("");
}

function cameraSnap(T) {
  const p = game.locals[0] || { x: 0, y: 10, z: 0, heading: 0 };
  for (const c of [camA, camB]) {
    c.cam.position.set(
      p.x - Math.sin(p.heading) * 12,
      p.y + 6,
      p.z - Math.cos(p.heading) * 12,
    );
    c.cam.lookAt(p.x, p.y, p.z);
  }
}

function quitToMenu() {
  clearRace();
  net.close();
  game.phase = "menu";
  ui.showNet = false;
  ui.setSplit(false);
  ui.showScreen("menu");
  ui.buildMenu(prefs, prefs.bests, ach);
  ui.buildTrackCards(trackObjects, prefs.bests, game.trackId);
  renderCloudLine();
}

/* ==========================================================================
 * 圈数与完赛
 * =========================================================================*/
function updateLapProgress(r) {
  const T = game.track;
  const prog = r.idx / T.n;
  r.progress = prog; // 名次排序依赖它
  const prev = r.prevProgress;

  if (r.lapStartAt && prev > 0.75 && prog < 0.25) {
    // 跨过终点线
    const now = performance.now();
    const lapTime = now - r.lapStartAt;
    r.lastLap = lapTime;
    if (!r.bestLap || lapTime < r.bestLap) r.bestLap = lapTime;
    r.lapTimes.push(lapTime);
    ach.onLap(r, lapTime, T);

    if (r.kind === "local" || r.kind === "split2") {
      audio.chime("lap");
      ui.banner(`LAP ${r.lap}`, fmtTime(lapTime));
      if (r.kind === "local") {
        const cur = prefs.bests[T.id];
        if (!cur || lapTime < cur) {
          prefs.bests[T.id] = lapTime;
          saveKey("dr-bests", prefs.bests);
        }
      }
    }

    r.lapStartAt = now;
    r.lap++;
    if (r.lap > game.laps && !r.finished) {
      r.finished = true;
      r.totalTime = now - game.raceStartAt;
      r.finishTime = r.totalTime;
      if (r.kind === "local" || r.kind === "split2") {
        ui.banner("FINISHED", fmtTime(r.finishTime));
        audio.chime("best");
      }
    }
  }
  r.prevProgress = prog;

  // 逆行检测
  const dot =
    T.tx[r.idx] * Math.sin(r.heading) + T.tz[r.idx] * Math.cos(r.heading);
  r.wrongWay = dot * r.vF < -4 && Math.abs(r.vF) > 6;
}

/* ==========================================================================
 * 相机
 * =========================================================================*/
function updateCamera(cs, racer, dt) {
  if (!racer) return;
  const cam = cs.cam;
  const speedNorm = clamp(Math.abs(racer.vF) / CFG.MAX_SPEED, 0, 1);
  const sh = Math.sin(racer.heading),
    ch = Math.cos(racer.heading);

  if (cs.mode === 0) {
    const back = 9.6 + speedNorm * 3.4;
    const height = 3.9 + speedNorm * 0.5;
    cs.tmp.set(racer.x - sh * back, racer.y + height, racer.z - ch * back);
    cam.position.x = damp(cam.position.x, cs.tmp.x, 6.5, dt);
    cam.position.y = damp(cam.position.y, cs.tmp.y, 5.5, dt);
    cam.position.z = damp(cam.position.z, cs.tmp.z, 6.5, dt);
    cs.look.set(racer.x + sh * 11, racer.y + 1.5, racer.z + ch * 11);
  } else if (cs.mode === 1) {
    cs.tmp.set(racer.x + sh * 1.4, racer.y + 1.32, racer.z + ch * 1.4);
    cam.position.copy(cs.tmp);
    cs.look.set(racer.x + sh * 26, racer.y + 1.05, racer.z + ch * 26);
  } else if (cs.mode === 2) {
    const t = performance.now() * 0.00022;
    const r = 17 + speedNorm * 5;
    cs.tmp.set(
      racer.x + Math.cos(t) * r,
      racer.y + 6.5 + Math.sin(t * 1.7) * 1.6,
      racer.z + Math.sin(t) * r,
    );
    cam.position.x = damp(cam.position.x, cs.tmp.x, 2.6, dt);
    cam.position.y = damp(cam.position.y, cs.tmp.y, 2.6, dt);
    cam.position.z = damp(cam.position.z, cs.tmp.z, 2.6, dt);
    cs.look.set(racer.x, racer.y + 1.2, racer.z);
  } else {
    // 航拍：高空俯瞰
    cs.tmp.set(racer.x - sh * 6, racer.y + 46, racer.z - ch * 6);
    cam.position.x = damp(cam.position.x, cs.tmp.x, 3.2, dt);
    cam.position.y = damp(cam.position.y, cs.tmp.y, 3.2, dt);
    cam.position.z = damp(cam.position.z, cs.tmp.z, 3.2, dt);
    cs.look.set(racer.x + sh * 8, racer.y, racer.z + ch * 8);
  }

  // 撞击抖动
  if (racer.shake > 0.001) {
    cam.position.x += (Math.random() - 0.5) * racer.shake * 0.9;
    cam.position.y += (Math.random() - 0.5) * racer.shake * 0.7;
    cam.position.z += (Math.random() - 0.5) * racer.shake * 0.9;
    racer.shake = Math.max(0, racer.shake - dt * 2.4);
  }

  const groundY =
    terrainHeight(game.track, cam.position.x, cam.position.z) + 1.15;
  if (cam.position.y < groundY) cam.position.y = groundY;

  cs.up.set(Math.sin(-racer.vL * 0.0035), 1, 0).normalize();
  cam.up.copy(cs.up);
  cam.lookAt(cs.look);

  const targetFov =
    (cs.mode === 1 ? 78 : cs.mode === 3 ? 58 : 64) +
    speedNorm * 15 +
    clamp(Math.abs(racer.vL) * 0.16, 0, 6);
  cs.fov = damp(cs.fov, targetFov, 3.4, dt);
  cam.fov = cs.fov;
  cam.updateProjectionMatrix();

  /* 调试机位覆写放在最后：设了它就完全接管相机（正常玩法下 camOverride 为 null，
     这一整段不会执行）。 */
  if (camOverride) {
    cam.position.set(camOverride.pos[0], camOverride.pos[1], camOverride.pos[2]);
    cam.up.set(0, 1, 0);
    cam.lookAt(camOverride.look[0], camOverride.look[1], camOverride.look[2]);
    cam.fov = camOverride.fov || 60;
    cam.updateProjectionMatrix();
  }
}

/* ==========================================================================
 * 输入
 * =========================================================================*/
const KM_P1 = {
  KeyW: "gas",
  KeyS: "brake",
  KeyA: "left",
  KeyD: "right",
  Space: "handbrake",
};
const KM_P2 = {
  ArrowUp: "gas",
  ArrowDown: "brake",
  ArrowLeft: "left",
  ArrowRight: "right",
  ShiftRight: "handbrake",
  Numpad0: "handbrake",
};
const KEY_P1_ARROWS = {
  ArrowUp: "gas",
  ArrowDown: "brake",
  ArrowLeft: "left",
  ArrowRight: "right",
};

function localSlotCount() {
  return game.locals.length;
}

/* 键盘的实时按键表。
 * 与 racer.input 的区别：input 是「本步生效的合成结果」，会被相位逻辑清空、
 * 也会被触屏模块按帧重写；kbHold 只忠实反映物理按键的按下/抬起，
 * 是触屏模块判断「这一轮该由键盘说话还是触屏说话」的依据。 */
const kbHold = {
  gas: false,
  brake: false,
  left: false,
  right: false,
  handbrake: false,
};

addEventListener("keydown", (e) => {
  /* 主菜单：回车推进分步引导（最后一步 = 开始比赛） */
  if (
    game.phase === "menu" &&
    e.key === "Enter" &&
    !e.repeat &&
    !e.isComposing
  ) {
    if (ui.menuAdvance()) {
      e.preventDefault();
      return;
    }
  }
  const p2 = game.mode === MODES.SPLIT && localSlotCount() > 1;
  if (p2) {
    // 分屏：方向键归 P2，WASD 归 P1
    const k2 = KM_P2[e.code];
    if (k2 && game.locals[1]) {
      game.locals[1].input[k2] = true;
      e.preventDefault();
    }
  } else if (KEY_P1_ARROWS[e.code]) {
    // 单人：方向键也归 P1（很多玩家习惯用方向键开车）
    const k = KEY_P1_ARROWS[e.code];
    kbHold[k] = true;
    if (game.locals[0]) game.locals[0].input[k] = true;
    e.preventDefault();
  }
  const k1 = KM_P1[e.code];
  if (k1) {
    kbHold[k1] = true;
    if (game.locals[0]) game.locals[0].input[k1] = true;
    e.preventDefault();
  }

  if (e.code === "KeyC") {
    cycleCamera();
  }
  if (e.code === "KeyR" && game.phase !== "menu") {
    resetLocalRacers();
  }
  if (e.code === "KeyE" && !e.repeat && game.phase === "race") {
    useLocalItem(1);
  }
  if (
    e.code === "ShiftRight" &&
    !e.repeat &&
    game.phase === "race" &&
    game.mode === MODES.SPLIT
  ) {
    useLocalItem(2);
  }
  if (e.code === "KeyM") {
    audio.setMuted(!audio.muted);
    ui.toast(audio.muted ? "已静音" : "声音开启", true, 900);
  }
  if (e.code === "KeyP") {
    togglePause();
  }
  audio.init();
});

addEventListener("keyup", (e) => {
  const p2 = game.mode === MODES.SPLIT && localSlotCount() > 1;
  if (p2) {
    const k = KM_P2[e.code];
    if (k && game.locals[1]) {
      game.locals[1].input[k] = false;
      e.preventDefault();
    }
  } else if (KEY_P1_ARROWS[e.code]) {
    const k = KEY_P1_ARROWS[e.code];
    kbHold[k] = false;
    if (game.locals[0]) game.locals[0].input[k] = false;
    e.preventDefault();
  }
  const k1 = KM_P1[e.code];
  if (k1) {
    kbHold[k1] = false;
    if (game.locals[0]) game.locals[0].input[k1] = false;
    e.preventDefault();
  }
});

addEventListener("blur", () => {
  for (const r of game.locals) for (const k in r.input) r.input[k] = false;
  for (const k in kbHold) kbHold[k] = false;
});

function resetLocalRacers() {
  for (const r of game.locals) {
    const T = game.track;
    const i = r.idx % T.n;
    r.x = T.cx[i];
    r.y = T.cy[i];
    r.z = T.cz[i];
    r.heading = Math.atan2(T.tx[i], T.tz[i]);
    r.vF = 0;
    r.vL = 0;
    r.yawRate = 0;
    r.offroad = 0;
  }
  ui.toast("已复位到赛道", true, 900);
}

/** 切换相机视角（键盘 C / 手柄 Y） */
function cycleCamera() {
  const cs = game.mode === MODES.SPLIT && game.locals.length > 1 ? null : camA;
  if (cs) {
    cs.mode = (cs.mode + 1) % CFG.CAM_MODES.length;
    ui.toast(`视角：${CFG.CAM_MODES[cs.mode]}`, true, 900);
  } else {
    camA.mode = (camA.mode + 1) % CFG.CAM_MODES.length;
    camB.mode = camA.mode;
  }
}

/** 暂停 / 继续（键盘 P / 手柄 Start / 触屏暂停键） */
function togglePause() {
  if (game.phase === "race") {
    game.phase = "paused";
    ui.restorePauseButtons();
    ui.showScreen("pause");
  } else if (game.phase === "paused") {
    game.phase = "race";
    ui.showScreen(null);
  }
}

/* ==========================================================================
 * 触屏操控
 *
 * 老版本是 5 个固定小圆钮（◀ ▶ / 油门 / 刹车 / 漂移），按下就是「打死方向」，
 * 也没法舒服地两指并用。新版交给 TouchControls：
 *   左半屏按住拖动 = 模拟量转向（方向盘），右半屏 = 踏板簇。
 * 这里只负责三件事：把受控车喂给它、按相位开关它、以及操作设置的读写。
 * =========================================================================*/
const touch = new TouchControls({
  target: () => game.locals[0] || null,
  onFirstInput: () => audio.init(),
  onPause: () => {
    if (game.phase === "race") {
      game.phase = "paused";
      ui.restorePauseButtons();
      ui.showScreen("pause");
    } else if (game.phase === "paused") {
      game.phase = "race";
      ui.showScreen(null);
    }
  },
  onSettings: (s) => {
    saveKey("dr-touch-autogas", s.autoGas);
    saveKey("dr-touch-hand", s.hand);
    saveKey("dr-touch-sens", s.sens);
    saveKey("dr-touch-tilt", s.tilt);
    prefs.touchAutoGas = s.autoGas;
    prefs.touchHand = s.hand;
    prefs.touchSens = s.sens;
    prefs.touchTilt = s.tilt;
  },
  settings: {
    autoGas: prefs.touchAutoGas,
    hand: prefs.touchHand,
    sens: prefs.touchSens,
    tilt: prefs.touchTilt,
  },
});

/* ---------------------------------------------------------------- 手柄 */
const pad = createPadController({
  onActivate() {
    audio.init();
    ui.toast(`手柄已连接：${pad.name}`, true, 2400);
  },
  onDeactivate() {
    // 拔线瞬间清空本地输入，避免残留油门让车自己跑
    for (const r of game.locals) for (const k in r.input) r.input[k] = false;
  },
  onUseItem() {
    useLocalItem(1);
  },
  onPause() {
    togglePause();
  },
  onCamera() {
    cycleCamera();
  },
  onReset() {
    if (game.phase !== "menu") resetLocalRacers();
  },
});

/** 操作设置面板：桌面端只显示键位，触屏设备才展开可调项 */
function wireCtrlSettings() {
  const grid = document.getElementById("ctrl-grid");
  const note = document.getElementById("ctrl-note");
  if (!grid) return;
  const rowIds = ["row-autogas", "row-hand", "row-sens", "row-tilt"];
  for (const id of rowIds)
    document.getElementById(id).classList.toggle("hide", !touch.isTouch);
  document.getElementById("row-keys").classList.toggle("hide", touch.isTouch);
  document.getElementById("row-pad").classList.toggle("hide", touch.isTouch);

  /* 折叠：触屏设备默认收起（矮横屏下整块会跑出屏幕），桌面默认展开；
     用户手动展开/收起后记住选择。 */
  const sec = document.getElementById("ctrl-section");
  const tgl = document.getElementById("ctrl-toggle");
  if (sec && tgl) {
    // 触屏设备默认收起（矮横屏下整块会跑出屏幕），桌面默认展开；手动切换后记住
    const stored = localStorage.getItem("dr-ctrl-collapsed");
    let isCollapsed = stored === null ? touch.isTouch : stored === "1";
    const sync = () => {
      sec.classList.toggle("collapsed", isCollapsed);
      tgl.setAttribute("aria-expanded", String(!isCollapsed));
    };
    sync();
    tgl.addEventListener("click", () => {
      isCollapsed = !isCollapsed;
      localStorage.setItem("dr-ctrl-collapsed", isCollapsed ? "1" : "0");
      sync();
    });
  }

  if (note) {
    note.textContent = touch.isTouch
      ? "左侧按住拖动转向 · 右侧踏板加速刹车"
      : navigator.getGamepads
        ? "键盘 WASD 驾驶 · 也可连接手柄"
        : "当前设备使用键盘操作";
  }

  const swAuto = document.getElementById("sw-autogas");
  const swTilt = document.getElementById("sw-tilt");
  const segHand = document.getElementById("seg-hand");
  const segSens = document.getElementById("seg-sens");

  const paint = () => {
    swAuto.setAttribute("aria-checked", String(!!touch.settings.autoGas));
    swTilt.setAttribute("aria-checked", String(!!touch.settings.tilt));
    for (const b of segHand.querySelectorAll("button")) {
      b.classList.toggle("on", b.dataset.hand === touch.settings.hand);
    }
    for (const b of segSens.querySelectorAll("button")) {
      b.classList.toggle(
        "on",
        Number(b.dataset.sens) === Number(touch.settings.sens),
      );
    }
  };
  paint();

  swAuto.addEventListener("click", () => {
    touch.applySettings({ autoGas: !touch.settings.autoGas });
    paint();
    ui.toast(
      touch.settings.autoGas
        ? "自动油门：开（只需转向）"
        : "自动油门：关（需按住油门）",
      true,
      1600,
    );
  });
  swTilt.addEventListener("click", () => {
    const next = !touch.settings.tilt;
    touch.applySettings({ tilt: next });
    paint();
    if (next && !touch.settings.tilt)
      ui.toast("本设备不支持陀螺仪，已自动关闭", false, 2000);
    else
      ui.toast(
        next ? "陀螺仪转向：开（以当前姿态为零点）" : "陀螺仪转向：关",
        true,
        1600,
      );
  });
  for (const b of segHand.querySelectorAll("button")) {
    b.addEventListener("click", () => {
      touch.applySettings({ hand: b.dataset.hand });
      paint();
    });
  }
  for (const b of segSens.querySelectorAll("button")) {
    b.addEventListener("click", () => {
      touch.applySettings({ sens: Number(b.dataset.sens) });
      paint();
    });
  }
  touch.paintCtrlPanel = paint;
}

/* ==========================================================================
 * 联机事件
 * =========================================================================*/
net.onStatus = (status, transport) => {
  ui.setNetStatus(status, transport, net.room, net.players.length);
  if (status === "online" && game.phase === "lobby") {
    ui.showLobbyRoom(
      net.room,
      net.players,
      net.myId,
      net.hostId,
      net.isHost,
      TRACKS[net.track] ? TRACKS[net.track].name : net.track,
      net.laps,
    );
  }
};
net.onWelcome = () => {
  ui.showLobbyRoom(
    net.room,
    net.players,
    net.myId,
    net.hostId,
    net.isHost,
    TRACKS[net.track] ? TRACKS[net.track].name : net.track,
    net.laps,
  );
};
net.onRoster = (players, isHost) => {
  if (game.phase === "lobby" || game.phase === "waiting") {
    ui.showLobbyRoom(
      net.room,
      players,
      net.myId,
      net.hostId,
      isHost,
      TRACKS[net.track] ? TRACKS[net.track].name : net.track,
      net.laps,
    );
  }
  ui.setNetStatus("online", net.transport, net.room, players.length);
  syncRemoteMeshes();
};
net.onBegin = (msg) => {
  const delay = Math.max(400, msg.at - Date.now());
  startOnlineRace(msg.track || net.track, msg.laps || net.laps, delay);
};
net.onEvent = (msg) => {
  if (msg.kind === "join") ui.toast(`${msg.name} 加入了房间`, true, 1600);
  else if (msg.kind === "leave") ui.toast(`${msg.name} 离开了`, true, 1600);
  else if (msg.kind === "finish" && msg.id !== net.myId) {
    ui.toast(`${msg.name} 完赛 ${fmtTime(msg.time)}`, true, 2000);
  }
};
net.onResults = (results) => {
  if (game.mode !== MODES.ONLINE) return;
  const rows = results.map((r) => {
    const racer = game.racers.find((x) => x.id === r.id);
    return {
      id: r.id,
      name: r.name,
      paint: r.paint,
      rank: r.rank,
      laps: game.laps,
      finished: r.finished,
      finishTime: r.finishTime,
      bestLap: racer ? racer.bestLap : 0,
    };
  });
  showOnlineResults(rows);
};
net.onError = (msg) => {
  const map = {
    room_not_found: "房间不存在，检查房间码",
    room_full: "房间满了（最多 8 人）",
    race_started: "这局已经发车了",
  };
  ui.toast(map[msg] || "联机错误：" + msg, false, 2600);
  ui.setNetStatus("error", net.transport, net.room, 0);
  if (map[msg]) {
    net.close();
    ui.showLobbyConnect();
    game.phase = "lobby";
  }
};

/** 远端玩家的车：按 roster 增删网格 */
function syncRemoteMeshes() {
  if (game.mode !== MODES.ONLINE) return;
  for (const r of net.remotes.values()) {
    if (game.remoteMeshes.has(r.id)) continue;
    const md = buildCarMesh(THREE, PAINTS[(r.paint || 0) % PAINTS.length]);
    scene.add(md.group);
    game.remoteMeshes.set(r.id, md);
  }
  for (const [id, md] of [...game.remoteMeshes]) {
    if (!net.remotes.has(id)) {
      scene.remove(md.group);
      md.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
      });
      game.remoteMeshes.delete(id);
    }
  }
}

function startOnlineRace(trackId, laps, delayMs) {
  clearRace();
  game.mode = MODES.ONLINE;
  game.laps = laps;
  game.phase = "countdown";
  const T = ensureWorld(trackId);
  ui.resetForRace(trackId);
  ui.setSplit(false);
  ui.showScreen(null);

  // 按服务器名次决定的发车位：把所有人排进同一个格子表
  const ids = [net.myId, ...net.remotes.keys()];
  ids.forEach((id, i) => {
    if (id === net.myId) {
      const r = makeRacer({
        id: "me",
        name: prefs.name || "你",
        paint: prefs.paint,
        kind: "local",
        slot: i,
      });
      attachMesh(r);
      placeOnGrid(r, T, i);
      game.racers.push(r);
      game.locals.push(r);
      localIds.add(r.id);
      audio.addEngine(r.id);
    }
  });
  syncRemoteMeshes();
  // 远端车初始位置先放到各自格位，等快照来了再插值
  [...net.remotes.values()].forEach((r, i) => {
    const g = T.gridSlot(i + 1);
    r.x = T.cx[g.index] + T.sx[g.index] * g.lateral;
    r.y = T.cy[g.index];
    r.z = T.cz[g.index] + T.sz[g.index] * g.lateral;
    r.heading = Math.atan2(T.tx[g.index], T.tz[g.index]);
    r.hasData = true;
    r.tx = r.x;
    r.ty = r.y;
    r.tz = r.z;
    r.th = r.heading;
  });

  ach.beginRace({
    mode: MODES.ONLINE,
    aiLevel: game.level,
    trackId,
    onlinePlayers: net.players.length,
    startDelay: 0,
    localScores: [],
  });
  cameraSnap(T);
  beginCountdown(delayMs);
}

function showOnlineResults(rows) {
  const mine = rows.filter((r) => r.id === net.myId);
  const best = mine[0];
  const title = best && best.rank === 1 ? "冠 军 ！" : "比 赛 结 束";
  const sub = best
    ? `你排名第 ${best.rank} / ${rows.length} · 总用时 ${fmtTime(best.finishTime)}`
    : `${rows.length} 位车手完赛`;
  const unlocked = [];
  ach.endRace({
    localRacers: game.locals,
    allRacers: game.racers.concat([...net.remotes.values()]),
    mode: "online",
    aiLevel: game.level,
  });
  ui.showResults({ title, sub, rows, unlocked, myIds: localIds });
  ui.setSplit(false);
  ui.showScreen("result");
  game.phase = "result";

  // 云端：联机模式的成绩同样计入排行榜
  submitCloudResult({
    trackId: game.trackId,
    lapMs: (best && best.bestLap) || 0,
    topKmh: game.maxKmh,
    driftScore: (game.locals[0] && game.locals[0].score) || 0,
    mode: "online",
    rank: (best && best.rank) || 99,
  });
  net.close();
}

/* ==========================================================================
 * 本地比赛结算
 * =========================================================================*/
function showLocalResults() {
  const ranked = computeRanks(game.racers);
  const rows = ranked.map((r) => ({
    id: r.id,
    name: r.name,
    paint: r.paint,
    rank: r.rank,
    laps: game.laps,
    finished: r.finished,
    finishTime: r.finishTime,
    bestLap: r.bestLap,
  }));
  const mine = ranked.filter((r) => localIds.has(r.id));
  const best = mine.reduce((a, b) => (a.rank <= b.rank ? a : b), mine[0]);
  const title = best && best.rank === 1 ? "冠 军 ！" : "比 赛 结 束";
  const sub =
    mine.length > 1
      ? mine.map((r) => `${r.name} 第 ${r.rank} 名`).join(" · ")
      : `你排名第 ${best ? best.rank : "-"} / ${ranked.length} · 最佳单圈 ${fmtTime(best ? best.bestLap : 0)}`;
  ach.endRace({
    localRacers: game.locals,
    allRacers: game.racers,
    mode: game.mode,
    aiLevel: game.level,
  });
  ui.showResults({ title, sub, rows, unlocked: [], myIds: localIds });
  ui.setSplit(false);
  ui.showScreen("result");
  game.phase = "result";
  for (const r of game.locals) audio.removeEngine(r.id);

  // 云端：只上传本机主玩家（P1）本场最佳圈速；P2/AI 没有账号身份，不上传
  const p1 = game.locals[0];
  if (p1) {
    submitCloudResult({
      trackId: game.trackId,
      lapMs: p1.bestLap || 0,
      topKmh: game.maxKmh,
      driftScore: p1.score || 0,
      mode: game.mode,
      rank: p1.rank || 99,
    });
  }
}

/* ==========================================================================
 * 主循环
 * =========================================================================*/
let lastTime = performance.now();
let lastFrameAt = 0;
let physAcc = 0;
const FIXED_DT = CFG.FIXED_DT;

function frame(now) {
  lastFrameAt = performance.now();
  const rawDt = Math.min(0.05, (now - lastTime) / 1000 || 0.016);
  lastTime = now;

  /* ---- 触屏操控开关 ----
     只在倒计时与比赛中启用。菜单/结算/暂停时不启用，否则整块屏幕都被触控层
     吃掉，菜单按钮点不动。setEnabled 内部幂等，可以每帧调用。 */
  const driftPhase = game.phase === "countdown" || game.phase === "race";
  touch.setEnabled(driftPhase && touch.isTouch);
  touch.setRotateGate(game.phase === "menu");

  /* ---- 手柄轮询：每帧读一次 getGamepads()，检测连接/拔线与按钮边沿。
     放在 frame 头部（而非物理步），保证菜单/结算相位也能响应手柄的
     激活与「Start 暂停 / Y 视角」等边沿键。 ---- */
  pad.poll();

  /* ---- 自适应画质 ---- */
  quality.samples.push(1 / Math.max(0.0005, rawDt));
  if (quality.samples.length > 90) quality.samples.shift();
  if (now - quality.lastAdjust > 2500 && quality.samples.length >= 60) {
    quality.lastAdjust = now;
    const avg =
      quality.samples.reduce((a, b) => a + b, 0) / quality.samples.length;
    if (avg < 42 && quality.level > 0) applyQualityLevel(quality.level - 1);
    else if (avg > 56 && quality.level < 2)
      applyQualityLevel(quality.level + 1); // fps 回稳后自动升回去
  }

  /* ---- 海面动画：赛道自带 water 配置时才存在，菜单动态背景里也要转起来 ---- */
  if (game.world && game.world.ocean) {
    game.world.ocean.material.uniforms.uTime.value = now / 1000;
  }

  /* ---- 菜单动态背景：演示车巡航；离开菜单（开局/进大厅）自动清理 ---- */
  if (game.phase === "menu") {
    ensureAttract();
    stepAttract(rawDt);
  } else if (attract.on) {
    disposeAttract();
  }

  const inRace =
    game.phase === "race" ||
    game.phase === "countdown" ||
    game.phase === "waiting";
  const frozen = !inRace && game.phase !== "paused";

  if (inRace || game.phase === "paused") {
    net.update(rawDt);
    /* ---- 物理：固定步长 ---- */
    if (game.phase === "race" || game.phase === "countdown") {
      physAcc = Math.min(physAcc + rawDt, 0.1);
      let guard = 0;
      while (physAcc >= FIXED_DT && guard++ < 24) {
        const controlAllowed = game.phase === "race";
        stepAll(FIXED_DT, controlAllowed);
        physAcc -= FIXED_DT;
      }
      for (const r of game.locals) {
        if (!r.finished) updateLapProgress(r);
        const kmh = Math.abs(r.vF) * 3.6;
        if (kmh > game.maxKmh) game.maxKmh = kmh;
      }
      for (const r of game.racers) if (r.kind === "ai") updateLapProgress(r);

      /* ---- 道具赛：道具箱/抽取/油污/导弹（帧级更新，物理量级足够） ---- */
      if (game.items && game.phase === "race") {
        game.items.update(rawDt, game.racers, now, (r, type) => {
          const local = localIds.has(r.id);
          if (!local) return;
          if (type === "get")
            ui.toast(`获得道具：${ITEM_NAMES[r.item] || r.item}`, true, 1400);
          else if (type === "spun") {
            ui.toast("被打滑了！", false, 1200);
            audio.hit(0.7);
          } else if (type === "shielded")
            ui.toast("护盾挡下了攻击", true, 1200);
        });
      }

      if (net.connected && game.mode === MODES.ONLINE) {
        game.netTimer -= rawDt;
        if (game.netTimer <= 0) {
          game.netTimer = 1 / CFG.NET_HZ;
          const me = game.locals[0];
          if (me) {
            net.sendState({
              x: me.x,
              y: me.y,
              z: me.z,
              heading: me.heading,
              vF: me.vF,
              lap: me.lap,
              idx: me.idx,
              drifting: me.drifting,
              offroad: me.offroad,
            });
          }
        }
      }
    }

    /* ---- 特效 ---- */
    for (const r of game.racers)
      emitRacerEffects(r, smoke, skid, game.track, quality, THREE);
    applyRemoteMeshes();

    /* ---- 名次与成就（降频计算） ---- */
    game.rankTimer -= rawDt;
    if (game.rankTimer <= 0) {
      game.rankTimer = 0.12;
      const all = allRacersForRanking();
      computeRanks(all);
      ach.tick(game.locals, all);
      ui.renderRanks(all, localIds);
      if (game.mode !== MODES.SPLIT) {
        ui.drawMinimap(game.track, all, localIds);
      }
    }
  }

  smoke.update(game.phase === "paused" ? 0 : rawDt);
  skid.update(game.phase === "paused" ? 0.2 : rawDt);

  /* ---- 相机 ---- */
  if (game.phase === "menu" && attract.on) {
    updateAttractCamera(rawDt);
  } else if (game.locals.length) {
    updateCamera(camA, game.locals[0], rawDt);
    if (game.locals.length > 1)
      updateCamera(camB, game.locals[1], rawDt + 0.0001);
  }

  /* ---- 阳光跟随（阴影范围）：比赛中跟玩家车，菜单跟演示车 ---- */
  const sunSubject =
    game.locals[0] || (game.phase === "menu" ? attract.leader : null);
  if (game.world && sunSubject) {
    const p = sunSubject;
    const d = game.world.sunDir;
    game.world.sun.position.set(p.x + d.x * 90, p.y + d.y * 90, p.z + d.z * 90);
    game.world.sun.target.position.set(p.x, p.y, p.z);
    game.world.sun.target.updateMatrixWorld();
  }

  /* ---- HUD ---- */
  ui.tickTimers(rawDt);
  if (game.locals[0]) {
    if (game.mode === MODES.SPLIT && game.locals.length > 1) {
      ui.updateSplitHud(
        game.locals[0],
        game.locals[1],
        game.laps,
        game.racers.length,
      );
    } else {
      ui.updateRaceHud(game.locals[0], game.laps, prefs.bests[game.trackId]);
    }
    if (game.locals[0].wrongWay && game.phase === "race")
      ui.toast("↑ 方向反了，掉头！", false, 400);

    // 完美起步：发车信号后 0.35 秒内给油
    if (
      game.phase === "race" &&
      !game.firstInputDone &&
      game.locals[0].input.gas
    ) {
      game.firstInputDone = true;
      const delay = (performance.now() - game.raceStartAt) / 1000;
      ach.race.startDelay = delay;
      if (delay <= 0.35) ach.unlock("perfectionist");
    }
  }

  /* ---- 音频 ---- */
  if (audio.ready) {
    const engines = game.locals.map((r) => ({
      id: r.id,
      rpm: r.rpm || 0,
      throttle: r.input.gas ? 1 : 0,
      slip: Math.abs(r.vL),
      drifting: r.drifting,
      offroad: r.offroad,
    }));
    audio.updateEngines(engines);
    // 近车掠过：把非本地车投影到本地玩家周围
    const me = game.locals[0];
    if (me) {
      const near = [];
      for (const r of game.racers) {
        if (localIds.has(r.id)) continue;
        near.push({
          dist: Math.hypot(r.x - me.x, r.z - me.z),
          speed: Math.abs(r.vF),
        });
      }
      for (const r of [...net.remotes.values()]) {
        near.push({
          dist: Math.hypot(r.x - me.x, r.z - me.z),
          speed: Math.abs(r.v),
        });
      }
      audio.updatePass(near);
      const intensity = clamp(Math.abs(me.vF) / CFG.MAX_SPEED, 0, 1);
      audio.updateMusic(game.track.layout, intensity, rawDt);
    }
  }

  /* ---- 比赛结束判定 ---- */
  if (game.phase === "race") {
    const localsDone = game.locals.every((r) => r.finished);
    if (game.mode === MODES.ONLINE) {
      if (localsDone && !game.waitingResults) {
        game.waitingResults = true;
        game.resultsFallbackAt = performance.now() + 9000;
        const me = game.locals[0];
        net.finish(me.totalTime);
        ui.toast("完赛！等待其他车手…", true, 4000);
      }
      if (game.waitingResults && performance.now() > game.resultsFallbackAt) {
        // 服务器没给结果也别卡住：用本地已知信息出结算
        const rows = [...net.remotes.values()].map((r) => ({
          id: r.id,
          name: r.name,
          paint: r.paint,
          rank: r.rank || 99,
          laps: game.laps,
          finished: !!r.fin,
          finishTime: 0,
          bestLap: 0,
        }));
        const me = game.locals[0];
        rows.push({
          id: net.myId,
          name: me.name,
          paint: me.paint,
          rank: 1,
          laps: game.laps,
          finished: true,
          finishTime: me.totalTime,
          bestLap: me.bestLap,
        });
        rows.sort((a, b) => a.rank - b.rank);
        showOnlineResults(rows);
      }
    } else if (localsDone) {
      showLocalResults();
    }
  }

  render();

  /* ---- 测试与调试快照 ---- */
  const me = game.locals[0];
  window.__DR__ = {
    mode: game.mode,
    phase: game.phase,
    track: game.trackId,
    laps: game.laps,
    lap: me ? me.lap : 0,
    format: game.format,
    items: game.items ? game.items.snapshot(me) : null,
    kmh: me ? Math.round(Math.abs(me.vF) * 3.6) : 0,
    score: me ? me.score : 0,
    vF: me ? me.vF : 0,
    vL: me ? me.vL : 0,
    heading: me ? me.heading : 0,
    idx: me ? me.idx : 0,
    pos: me ? [me.x, me.y, me.z] : [0, 0, 0],
    offroad: me ? me.offroad : 0,
    drifting: me ? me.drifting : false,
    // 触屏/键盘的输入快照：验收脚本据此确认「手指动作真的到达了物理层」
    steer: me ? me.input.steer || 0 : 0,
    inputGas: me ? !!me.input.gas : false,
    inputBrake: me ? !!me.input.brake : false,
    inputHand: me ? !!me.input.handbrake : false,
    pad: pad.active
      ? { active: true, name: pad.name, steer: me ? me.input.steer || 0 : 0 }
      : { active: false, name: "", steer: 0 },
    racers: game.racers.length,
    remoteCount: net.remotes.size,
    aiMaxKmh: game.racers.reduce(
      (m, r) =>
        r.kind === "ai" ? Math.max(m, Math.round(Math.abs(r.vF) * 3.6)) : m,
      0,
    ),
    aiLeaderLap: game.racers.reduce(
      (m, r) => (r.kind === "ai" ? Math.max(m, r.lap) : m),
      0,
    ),
    locals: game.locals.map((r) => ({
      id: r.id,
      kmh: Math.round(Math.abs(r.vF) * 3.6),
      lap: r.lap,
      rank: r.rank,
      x: r.x,
      z: r.z,
      heading: r.heading,
      idx: r.idx,
      finished: r.finished,
    })),
    net: net.transport,
    netStatus: net.status,
    room: net.room,
    ach: ach.count(),
    quality: quality.level,
    frames: ((window.__DR__ && window.__DR__.frames) || 0) + 1,
    fps: Math.round(
      quality.samples.length
        ? quality.samples.reduce((a, b) => a + b, 0) / quality.samples.length
        : 0,
    ),
  };
}

/** 物理步进：本地玩家 → AI → 车车碰撞 */
let inputClearedPhase = null; // 上次已清空输入的「不可操控相位」，避免每步重复清空
function stepAll(dt, controlAllowed) {
  const ctx = {
    track: game.track,
    onWall: (r, impact) => {
      if (localIds.has(r.id)) audio.hit(impact);
    },
    onDriftBank: (r, bank) => {
      if (localIds.has(r.id)) ui.toast(`漂移 +${bank}`, true, 900);
    },
    onContact: (a, b, s) => {
      if (localIds.has(a.id) || localIds.has(b.id)) audio.hit(s * 0.8);
    },
  };

  /* 不可操控阶段（倒计时）只在「刚进入时」清一次输入，不再每个物理步都清。
     原因：触屏按钮没有键盘那样的自动重复，每步清空会让按住油门的玩家发车后起不来；
     自动化脚本里的单次 keydown 也会被静默吃掉（表现为车始终 0 km/h）。
     禁止提前起跑改由 inputFrozen 闸门负责（stepRacer 会忽略被冻结车辆的输入）。 */
  if (controlAllowed) inputClearedPhase = null;
  else if (inputClearedPhase !== game.phase) {
    inputClearedPhase = game.phase;
    for (const r of game.racers) for (const k in r.input) r.input[k] = false;
  }

  /* 触屏输入的唯一写入口：必须在上面那次清空**之后**执行，
     否则倒计时开始的那一帧会把玩家正按着的油门/转向一起清掉。
     第二个参数是键盘实时按键表 —— 带触摸屏的笔记本上两者并存时，键盘优先。 */
  if (game.locals[0]) {
    touch.apply(game.locals[0], kbHold);
    // 手柄在触屏之后合成：桌面端触屏不启用（直接 return），手柄直接接管；
    // 移动端接手柄时手柄覆盖触屏。键盘有键按住时 pad.apply 让位（返回 false）。
    pad.apply(game.locals[0], kbHold);
  }

  for (const r of game.locals) {
    r.inputFrozen = !controlAllowed;
    stepRacer(r, dt, ctx);
  }

  // AI：先给它们算输入，再步进
  const humanLeader = game.locals.reduce((best, r) => {
    const d = racerDistance(game.track, r);
    return d > best ? d : best;
  }, -Infinity);
  for (const r of game.racers) {
    if (r.kind !== "ai") continue;
    r.inputFrozen = !controlAllowed;
    const driver = game.aiDrivers.get(r.id);
    if (driver && controlAllowed) {
      const gap = humanLeader - racerDistance(game.track, r);
      driver.update(r, dt, { racers: game.racers, gapToHuman: gap });
      if (game.items) game.items.aiThink(r, dt, game.racers);
    } else if (!controlAllowed) {
      for (const k in r.input) r.input[k] = false;
    }
    stepRacer(r, dt, ctx);
  }

  resolveCarCollisions(game.racers, ctx);
}

/** 远端玩家的车：把 net 的插值结果写到网格上 */
function applyRemoteMeshes() {
  if (game.mode !== MODES.ONLINE) return;
  for (const r of net.remotes.values()) {
    const md = game.remoteMeshes.get(r.id);
    if (!md) continue;
    md.group.position.set(r.x, r.y, r.z);
    md.group.rotation.order = "YXZ";
    md.group.rotation.set(0, r.heading, clamp(-r.v * 0.0004 - 0, -0.12, 0.12));
    const spin = (r.v / 0.38) * (1 / 60);
    for (const w of md.wheels) w.spin.rotation.x += spin;
  }
}

function allRacersForRanking() {
  const list = game.racers.slice();
  for (const r of net.remotes.values()) {
    list.push({
      id: r.id,
      name: r.name,
      paint: r.paint,
      x: r.x,
      y: r.y,
      z: r.z,
      heading: r.heading,
      vF: r.v,
      lap: r.lap,
      idx: r.idx,
      progress: r.idx / (game.track ? game.track.n : 1),
      rank: r.rank || 99,
      finished: !!r.fin,
      finishTime: r.finishTime || 0,
      isRemote: true,
      kind: "remote",
    });
  }
  return list;
}

function render() {
  const w = renderer.domElement.width / renderer.getPixelRatio();
  const h = renderer.domElement.height / renderer.getPixelRatio();
  if (game.mode === MODES.SPLIT && game.locals.length > 1) {
    const half = Math.floor(h / 2);
    renderer.setScissorTest(true);
    // 上半屏 P1（WebGL 视口原点在左下角，所以 y = half）
    camA.cam.aspect = w / half;
    camA.cam.updateProjectionMatrix();
    renderer.setViewport(0, half, w, half);
    renderer.setScissor(0, half, w, half);
    renderer.render(scene, camA.cam);
    // 下半屏 P2
    camB.cam.aspect = w / half;
    camB.cam.updateProjectionMatrix();
    renderer.setViewport(0, 0, w, half);
    renderer.setScissor(0, 0, w, half);
    renderer.render(scene, camB.cam);
    renderer.setScissorTest(false);
  } else {
    camA.cam.aspect = w / h;
    camA.cam.updateProjectionMatrix();
    renderer.setViewport(0, 0, w, h);
    renderer.render(scene, camA.cam);
  }
}

/* ==========================================================================
 * 启动
 * =========================================================================*/
function boot() {
  ensureWorld(game.trackId);
  ui.buildMenu(prefs, prefs.bests, ach);
  ui.buildTrackCards(trackObjects, prefs.bests, game.trackId);
  ui.showScreen("menu");
  ui.renderAchievements(ach);
  wireCtrlSettings();
  touch.setRotateGate(true);
  renderer.setAnimationLoop(frame);
  document.title = "READY · DRIFT RUSH";
  lastTime = performance.now();
  // 兜底循环：浏览器对后台标签页会节流 rAF，联机时切走标签页会导致自己的车冻结。
  // 用定时器补帧，保证后台标签页里物理与网络仍在跑（帧率自然更低，但不至于停摆）。
  setInterval(() => {
    if (performance.now() - lastFrameAt > 200) frame(performance.now());
  }, 90);
  // 就绪信号：不依赖 rAF（后台标签页的 rAF 会被浏览器节流）
  window.__DR_BOOTED__ = true;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      window.__DR_READY__ = true;
    }),
  );

  /* 云服务：异步接入。失败只降级为本地存档，绝不影响单机游戏 */
  renderCloudLine();
  cloud
    .init()
    .then((status) => {
      renderCloudLine();
      cloudUI.render();
      window.__DR_CLOUD_READY__ = status;
      if (status === "ready" && cloud.signedIn) {
        syncCloudAfterLogin().catch((e) =>
          ui.toast("云端同步失败：" + (e.message || e), false),
        );
      }
    })
    .catch(() => {
      renderCloudLine();
    });
}

addEventListener("error", (e) =>
  ui.showFatal(
    (e.message || "unknown") +
      " @ " +
      (e.filename || "") +
      ":" +
      (e.lineno || 0),
  ),
);
addEventListener("unhandledrejection", (e) =>
  ui.showFatal("Promise: " + ((e.reason && e.reason.message) || e.reason)),
);

addEventListener("resize", () => {
  renderer.setSize(innerWidth, innerHeight);
});

/* ---------------------------------------------- 自动化测试 / 调试钩子 */
window.__DR_API__ = {
  /** 直接开一局（跳过 UI），供无头验收脚本使用 */
  start(cfg = {}) {
    const mode = cfg.mode || "solo";
    const track = cfg.track || "coast";
    const laps = cfg.laps || 1;
    const level = cfg.level || "normal";
    Object.assign(prefs, {
      mode,
      track,
      laps,
      level,
      name: cfg.name || prefs.name,
      paint: cfg.paint ?? prefs.paint,
    });
    if (mode === "online") {
      ui.showScreen("lobby");
      game.phase = "lobby";
      net.open({
        mode: "create",
        name: prefs.name,
        paint: prefs.paint,
        track,
        laps,
        level,
      });
      return { mode, track };
    }
    startRace({ mode, track, laps, level });
    return { mode, track, laps, level };
  },
  /** 直接创建联机房间 */
  createRoom(cfg = {}) {
    Object.assign(prefs, cfg);
    ui.showScreen("lobby");
    game.phase = "lobby";
    net.open({
      mode: "create",
      name: prefs.name,
      paint: prefs.paint,
      track: cfg.track || "coast",
      laps: cfg.laps || 1,
      level: cfg.level || "normal",
    });
  },
  joinRoom(room, cfg = {}) {
    Object.assign(prefs, cfg);
    ui.showScreen("lobby");
    game.phase = "lobby";
    net.open({
      mode: "join",
      room,
      name: prefs.name || "P2",
      paint: cfg.paint ?? 1,
    });
  },
  startOnline() {
    net.start();
  },
  skipCountdown() {
    game.phase = "race";
    game.raceStartAt = performance.now();
  },
  /** 完整地退回菜单（会走 quitToMenu 的全套收尾），供验收脚本恢复初始状态 */
  quit() {
    quitToMenu();
  },
  ui() {
    return ui;
  },
  net() {
    return net;
  },
  ach() {
    return ach;
  },
  /** 菜单动态背景状态（attract mode 验收用） */
  attract() {
    return attract;
  },
  /** 相机世界坐标（动态背景机位轮换断言用） */
  camPos() {
    return {
      x: camA.cam.position.x,
      y: camA.cam.position.y,
      z: camA.cam.position.z,
      mode: camA.mode,
    };
  },
  /** 触屏操控实例，供移动端验收脚本做状态断言 */
  touch() {
    return touch;
  },
  /** 键位注入（键盘路径回归用）：与真实 keydown 走同一张映射表 */
  key(code, down) {
    const p2 = game.mode === MODES.SPLIT && localSlotCount() > 1;
    const r = game.locals[p2 ? 1 : 0];
    if (!r) return false;
    const k = p2 ? KM_P2[code] : KM_P1[code] || KEY_P1_ARROWS[code];
    if (!k) return false;
    r.input[k] = !!down;
    if (!p2) kbHold[k] = !!down;
    return true;
  },
  /** 调试机位：{ pos:[x,y,z], look:[x,y,z], fov } 覆写相机；传 null 还原。
      与 __DR_SCENE__/__DR_IX__ 一样属于验收钩子，正常玩法不触发。 */
  freeCam(o) {
    camOverride = o || null;
    return camOverride;
  },
  /** 赛道中心线取点，供循线自动驾驶脚本使用 */
  trackPoint(i, lateral = 0) {
    const T = game.track;
    const k = ((i % T.n) + T.n) % T.n;
    return [T.cx[k] + T.sx[k] * lateral, T.cz[k] + T.sz[k] * lateral];
  },
  trackN() {
    return game.track.n;
  },
  finishHint() {
    const me = game.locals[0];
    return me
      ? {
          lap: me.lap,
          laps: game.laps,
          finished: me.finished,
          totalTime: me.totalTime,
        }
      : null;
  },
  state() {
    return window.__DR__;
  },

  /* ---- 云服务（验收脚本用；界面操作走真实 DOM 事件） ---- */
  cloud() {
    return cloud;
  },
  cloudUI() {
    return cloudUI;
  },
  cloudState() {
    return {
      status: cloud.status,
      available: cloud.available,
      signedIn: cloud.signedIn,
      email: cloud.user ? cloud.user.email : null,
      userId: cloud.user ? cloud.user.id : null,
      profile: cloud.profile,
      error: cloud.error,
    };
  },
  showAccount() {
    cloudUI.showAccount();
  },
  showBoard() {
    cloudUI.showBoard(trackObjects);
  },
  /** 直接触发结算上传路径（等价于打完一场的提交） */
  submitResult(cfg) {
    return submitCloudResult(cfg);
  },
  syncCloud() {
    return syncCloudAfterLogin();
  },
};

boot();
