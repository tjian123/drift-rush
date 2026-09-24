/* ===========================================================================
 * config.js — 全局常量 / 赛道布局表 / 车辆涂装 / 成就表
 * 纯数据模块，不依赖 three.js
 * =========================================================================*/

export const CFG = {
  SEED: 20260924,

  /* --- 赛道采样 --- */
  POLAR_SAMPLES: 1400,   // 极坐标采样数（平滑前）
  SMOOTH_PASSES: 3,      // 环形平滑次数
  SMOOTH_K: 0.18,
  TRACK_STEP: 2.0,       // 弧长重采样步长（单位）

  /* --- 路面 --- */
  HALF_W: 7.0,           // 路面半宽
  SHOULDER: 1.7,         // 路肩宽
  DASH_PERIOD: 6.0,      // 中央虚线周期
  WALL: 1.9,             // 护墙外推距离（相对半宽）

  /* --- 车辆物理（街机漂移模型） --- */
  MAX_SPEED: 62,         // 单位/秒 ≈ 223 km/h
  ENGINE: 26,
  BRAKE: 44,
  REV_ACC: 13,
  MAX_REV: 15,
  DRAG: 0.0060,
  ROLL: 0.35,
  GRIP: 5.6,             // 正常侧向抓地
  GRIP_DRIFT: 1.55,      // 手刹漂移
  GRIP_OFFROAD: 0.62,    // 出界草地
  MAX_YAW: 2.25,
  YAW_DAMP: 8.5,
  FIXED_DT: 1 / 120,     // 物理固定步长

  /* --- 比赛 --- */
  LAPS_DEFAULT: 3,
  CAM_MODES: ['追尾', '车头', '电影', '航拍'],
  MAX_PLAYERS: 8,
  NET_HZ: 20,            // 快照发送频率
};

/* ---------------------------------------------------------------------------
 * 赛道布局：r(θ) = base + Σ amp·trig(k·θ + phase)
 * r 恒正 ⇒ 星形域 ⇒ 曲线天然不自交；再由 tools/check_track.mjs 校验
 * 分支净距与最小转弯半径（必须 > 17 才可驾驶）。
 * -------------------------------------------------------------------------*/
export const TRACKS = {
  coast: {
    id: 'coast',
    name: '黄昏海岸',
    desc: '长弯与缓坡，适合练漂移',
    laps: 3,
    polar: {
      base: 175,
      terms: [
        { k: 3, amp: 50, phase: 0.5, fn: 'cos' },
        { k: 2, amp: 22, phase: 0.0, fn: 'sin' },
        { k: 5, amp: 12, phase: 1.1, fn: 'cos' },
      ],
    },
    elev: { terms: [{ k: 2, amp: 5.0, phase: 0.7 }, { k: 3, amp: 2.5, phase: 2.1 }] },
    sky: { top: 0x101a3a, mid: 0x6b5aa8, bot: 0xffa469 },
    fog: { color: 0xffb07a, near: 150, far: 1200 },
    sun: { color: 0xffd2a1, intensity: 2.35, dir: [-0.42, 0.30, -0.86] },
    hemi: { sky: 0x9fb6e8, ground: 0x53443a, intensity: 0.95 },
    ambient: { color: 0x40506e, intensity: 0.35 },
    ground: { grass: 0x5c7a44, dry: 0x8a7c4a, rock: 0x6a6a72, sand: 0x8d7f62, mix: 0.35 },
    tree: { hue: 0.26, sat: 0.30, light: 0.24, count: 620, size: [0.8, 2.3] },
    building: { count: 120, emissive: 0x1a0e06, tall: 30, hueWarm: 0.07, hueCool: 0.58 },
    mountain: { count: 130, hue: 0.62, sat: 0.22, light: 0.20 },
    music: { root: 55, mode: [0, 3, 5, 7, 10] },
  },

  city: {
    id: 'city',
    name: '午夜都市',
    desc: '窄弯密集，考验走线精度',
    laps: 3,
    polar: {
      base: 164,
      terms: [
        { k: 4, amp: 33, phase: 1.15, fn: 'cos' },
        { k: 3, amp: 21, phase: -0.35, fn: 'sin' },
        { k: 2, amp: 13, phase: 0.9, fn: 'sin' },
        { k: 6, amp: 5, phase: 0.8, fn: 'cos' },
      ],
    },
    elev: { terms: [{ k: 3, amp: 3.2, phase: 1.4 }, { k: 4, amp: 1.8, phase: 0.2 }] },
    sky: { top: 0x03050c, mid: 0x0d1430, bot: 0x2b3a68 },
    fog: { color: 0x141c38, near: 130, far: 1000 },
    sun: { color: 0x9fb4ff, intensity: 0.85, dir: [-0.30, 0.26, -0.92] },
    hemi: { sky: 0x40538c, ground: 0x1a1c28, intensity: 0.75 },
    ambient: { color: 0x2a3350, intensity: 0.5 },
    ground: { grass: 0x28304a, dry: 0x323a52, rock: 0x3a4058, sand: 0x2c3450, mix: 0.30 },
    tree: { hue: 0.34, sat: 0.18, light: 0.14, count: 380, size: [0.7, 1.9] },
    building: { count: 260, emissive: 0x2a1a06, tall: 62, hueWarm: 0.06, hueCool: 0.60 },
    mountain: { count: 150, hue: 0.63, sat: 0.18, light: 0.10 },
    music: { root: 49, mode: [0, 3, 5, 6, 10] },
  },

  desert: {
    id: 'desert',
    name: '沙漠峡谷',
    desc: '高速直道接大幅爬坡',
    laps: 3,
    polar: {
      base: 205,
      terms: [
        { k: 2, amp: 46, phase: 2.1, fn: 'cos' },
        { k: 3, amp: 28, phase: -0.75, fn: 'cos' },
        { k: 5, amp: 9, phase: 0.3, fn: 'sin' },
      ],
    },
    elev: { terms: [{ k: 1, amp: 7.5, phase: 0.9 }, { k: 2, amp: 4.0, phase: 2.6 }] },
    sky: { top: 0x2b1a3a, mid: 0xcf6a38, bot: 0xffc46a },
    fog: { color: 0xe0a070, near: 170, far: 1350 },
    sun: { color: 0xffe0b0, intensity: 2.8, dir: [-0.62, 0.24, -0.75] },
    hemi: { sky: 0xffd9ac, ground: 0x6a4a2a, intensity: 1.05 },
    ambient: { color: 0x6a5238, intensity: 0.35 },
    ground: { grass: 0xb08a52, dry: 0xc9a066, rock: 0x8a6a44, sand: 0xd9b070, mix: 0.6 },
    tree: { hue: 0.24, sat: 0.34, light: 0.26, count: 300, size: [0.6, 1.5] },
    building: { count: 70, emissive: 0x2a1608, tall: 26, hueWarm: 0.08, hueCool: 0.10 },
    mountain: { count: 120, hue: 0.06, sat: 0.32, light: 0.30 },
    music: { root: 58, mode: [0, 2, 5, 7, 9] },
  },

  snow: {
    id: 'snow',
    name: '雪原冰川',
    desc: '低抓地长漂，视线开阔',
    laps: 3,
    polar: {
      base: 178,
      terms: [
        { k: 2, amp: 40, phase: 0.35, fn: 'cos' },
        { k: 3, amp: 26, phase: 1.7, fn: 'cos' },
        { k: 4, amp: 12, phase: -0.9, fn: 'cos' },
        { k: 7, amp: 9, phase: 0.0, fn: 'sin' },
      ],
    },
    elev: { terms: [{ k: 2, amp: 5.0, phase: 2.2 }, { k: 4, amp: 1.6, phase: 0.5 }] },
    sky: { top: 0x5f86c8, mid: 0xa8c4e8, bot: 0xe8f0ff },
    fog: { color: 0xd8e6f8, near: 190, far: 1500 },
    sun: { color: 0xeaf2ff, intensity: 2.1, dir: [0.35, 0.42, -0.84] },
    hemi: { sky: 0xcfe2ff, ground: 0x8fa4be, intensity: 1.25 },
    ambient: { color: 0x7f95b5, intensity: 0.45 },
    ground: { grass: 0xdae6f5, dry: 0xc2d2e6, rock: 0x9aa8ba, sand: 0xeff5ff, mix: 0.75 },
    tree: { hue: 0.38, sat: 0.22, light: 0.18, count: 460, size: [0.8, 2.0] },
    building: { count: 60, emissive: 0x0e1626, tall: 24, hueWarm: 0.10, hueCool: 0.56 },
    mountain: { count: 140, hue: 0.60, sat: 0.14, light: 0.62 },
    music: { root: 52, mode: [0, 4, 7, 11, 14] },
  },

  /* 晨雾山道：布局刻意做出真实山路的两段式节奏 ——
     前半段 k2/k3 大摆幅的长弯爬坡，后半段 k8 高频项压出连续 S 弯与近发卡，
     配合浓雾与低角度晨光强化「清晨进山」的临场感。 */
  mountain: {
    id: 'mountain',
    name: '晨雾山道',
    desc: '发卡与 S 弯连环，节奏多变',
    laps: 3,
    polar: {
      base: 186,
      terms: [
        { k: 2, amp: 38, phase: 1.2, fn: 'cos' },
        { k: 3, amp: 21, phase: -0.5, fn: 'sin' },
        { k: 5, amp: 11, phase: 2.0, fn: 'cos' },
        { k: 8, amp: 11, phase: 0.6, fn: 'sin' },
      ],
    },
    elev: { terms: [{ k: 1, amp: 7.0, phase: 1.8 }, { k: 3, amp: 2.4, phase: 0.4 }] },
    sky: { top: 0x27354f, mid: 0x9a8fb0, bot: 0xf2c9a0 },
    fog: { color: 0xc9d4e8, near: 100, far: 900 },
    sun: { color: 0xffe8c8, intensity: 1.9, dir: [0.50, 0.20, -0.85] },
    hemi: { sky: 0xbcc8e0, ground: 0x2e3b28, intensity: 1.0 },
    ambient: { color: 0x4a5568, intensity: 0.4 },
    ground: { grass: 0x3e5a38, dry: 0x6a6a48, rock: 0x5c5c64, sand: 0x77765c, mix: 0.3 },
    tree: { hue: 0.30, sat: 0.32, light: 0.16, count: 700, size: [0.7, 2.6] },
    building: { count: 46, emissive: 0x1a120a, tall: 18, hueWarm: 0.08, hueCool: 0.55 },
    mountain: { count: 170, hue: 0.58, sat: 0.16, light: 0.30 },
    music: { root: 50, mode: [0, 2, 3, 7, 10] },
  },
};

export const TRACK_ORDER = ['coast', 'city', 'desert', 'snow', 'mountain'];

/* ---------------------------------------------------------------------------
 * 车辆涂装（联机时用涂装索引区分玩家）
 * -------------------------------------------------------------------------*/
export const PAINTS = [
  { id: 0, name: '赤焰红', body: 0xd8323c, rim: 0xc9d2dc },
  { id: 1, name: '深海蓝', body: 0x2b6cd8, rim: 0xd8e2ec },
  { id: 2, name: '柠檬黄', body: 0xe8c23a, rim: 0x2c3038 },
  { id: 3, name: '薄荷绿', body: 0x2fc07a, rim: 0xe4ecf4 },
  { id: 4, name: '幻紫', body: 0x8f4ce0, rim: 0xf0e6ff },
  { id: 5, name: '碳黑', body: 0x24262e, rim: 0xe0a13a },
  { id: 6, name: '橙风', body: 0xf07a24, rim: 0x2c3038 },
  { id: 7, name: '雪白', body: 0xe8eef6, rim: 0x3a4a5e },
];

/* ---------------------------------------------------------------------------
 * 成就表
 * 每个成就：id / 标题 / 描述 / 稀有度(starter|pro|master)
 * 判定逻辑在 achievements.js，此处只放元数据以便 UI 直接渲染
 * -------------------------------------------------------------------------*/
export const ACHIEVEMENTS = [
  { id: 'first_lap', title: '初次上路', desc: '完成你的第一圈', tier: 'starter' },
  { id: 'first_race', title: '首战告捷', desc: '完成一场完整比赛', tier: 'starter' },
  { id: 'speed_150', title: '风起了', desc: '时速突破 150 km/h', tier: 'starter' },
  { id: 'speed_210', title: '破风者', desc: '时速突破 210 km/h', tier: 'pro' },
  { id: 'drift_500', title: '漂移入门', desc: '单场漂移积分累计 500', tier: 'starter' },
  { id: 'drift_3000', title: '甩尾大师', desc: '单场漂移积分累计 3000', tier: 'pro' },
  { id: 'combo_5', title: '连击艺术家', desc: '漂移连击倍数达到 5.0', tier: 'pro' },
  { id: 'clean_lap', title: '干净的一圈', desc: '单圈全程不出赛道完赛', tier: 'pro' },
  { id: 'no_brake', title: '刹车是懦夫', desc: '单圈全程不踩刹车完赛', tier: 'master' },
  { id: 'wall_ride', title: '贴墙走线', desc: '紧贴护墙连续行驶 2 秒', tier: 'pro' },
  { id: 'win_ai', title: '人机之王', desc: '在带 AI 对手的比赛中夺冠', tier: 'pro' },
  { id: 'comeback', title: '绝地反击', desc: '从最后一名反超至第一名', tier: 'master' },
  { id: 'online_first', title: '联机首战', desc: '完成一场在线联机比赛', tier: 'starter' },
  { id: 'online_party', title: '人齐了', desc: '在 4 人以上的房间完赛', tier: 'pro' },
  { id: 'splitscreen', title: '沙发对决', desc: '完成一场本地分屏对战', tier: 'starter' },
  { id: 'tour_all', title: '全图制霸', desc: '在全部赛道上各完成一圈', tier: 'master' },
  { id: 'ai_beater', title: '黄金右脚', desc: 'AI 难度设为「困难」并夺冠', tier: 'master' },
  { id: 'night_owl', title: '夜猫子', desc: '在午夜都市跑进单圈 60 秒', tier: 'pro' },
  { id: 'photo_finish', title: '毫厘之争', desc: '以 0.3 秒内的差距赢得比赛', tier: 'master' },
  { id: 'perfectionist', title: '完美起步', desc: '发车信号后 0.35 秒内起步', tier: 'starter' },
];

/** AI 难度预设 */
export const AI_LEVELS = {
  easy: {
    id: 'easy', name: '轻松',
    latAccel: 26,        // 弯道可用侧向加速度（决定过弯速度上限）
    speedMul: 0.90,      // 极速倍率
    rubber: 0.22,        // 橡皮筋强度（追赶玩家）
    mistakeRate: 0.10,   // 每秒失误概率
    count: 3,
  },
  normal: {
    id: 'normal', name: '普通',
    latAccel: 34,
    speedMul: 0.97,
    rubber: 0.12,
    mistakeRate: 0.045,
    count: 5,
  },
  hard: {
    id: 'hard', name: '困难',
    latAccel: 43,
    speedMul: 1.0,
    rubber: 0.0,
    mistakeRate: 0.012,
    count: 5,
  },
};

/** 游戏模式 */
export const MODES = {
  SOLO: 'solo',           // 单人计时 + AI
  SPLIT: 'split',         // 本地分屏双人 + AI
  ONLINE: 'online',       // 在线联机
};

export const STORAGE = {
  BEST: 'drift-rush-best-v2',
  ACH: 'drift-rush-ach-v2',
  TRACKS_DONE: 'drift-rush-tracks-v2',
  NAME: 'drift-rush-name',
  PAINT: 'drift-rush-paint',
};
