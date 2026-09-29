/* ===========================================================================
 * config.js — 全局常量 / 赛道布局表 / 车辆涂装 / 成就表
 * 纯数据模块，不依赖 three.js
 * =========================================================================*/

export const CFG = {
  SEED: 20260924,

  /* --- 赛道采样 --- */
  POLAR_SAMPLES: 1400, // 极坐标采样数（平滑前）
  SMOOTH_PASSES: 3, // 环形平滑次数
  SMOOTH_K: 0.18,
  TRACK_STEP: 2.0, // 弧长重采样步长（单位）

  /* --- 路面 --- */
  HALF_W: 7.0, // 路面半宽
  SHOULDER: 1.7, // 路肩宽
  DASH_PERIOD: 6.0, // 中央虚线周期
  WALL: 1.9, // 护墙外推距离（相对半宽）

  /* --- 车辆物理（街机漂移模型） --- */
  MAX_SPEED: 62, // 单位/秒 ≈ 223 km/h
  ENGINE: 26,
  BRAKE: 44,
  REV_ACC: 13,
  MAX_REV: 15,
  DRAG: 0.006,
  ROLL: 0.35,
  GRIP: 5.6, // 正常侧向抓地
  GRIP_DRIFT: 1.55, // 手刹漂移
  GRIP_OFFROAD: 0.62, // 出界草地
  MAX_YAW: 2.25,
  YAW_DAMP: 8.5,
  FIXED_DT: 1 / 120, // 物理固定步长

  /* --- 比赛 --- */
  LAPS_DEFAULT: 3,
  CAM_MODES: { en: ["Chase", "Nose", "Cinematic", "Aerial"], zh: ["追尾", "车头", "电影", "航拍"] },
  MAX_PLAYERS: 8,
  NET_HZ: 20, // 快照发送频率
};

/* ---------------------------------------------------------------------------
 * 赛道布局：r(θ) = base + Σ amp·trig(k·θ + phase)
 * r 恒正 ⇒ 星形域 ⇒ 曲线天然不自交；再由 tools/check_track.mjs 校验
 * 分支净距与最小转弯半径（必须 > 17 才可驾驶）。
 * -------------------------------------------------------------------------*/
export const TRACKS = {
  coast: {
    id: "coast",
    name: { en: "Dusk Coast", zh: "黄昏海岸" },
    desc: { en: "Long bends & gentle slopes — easy to drift", zh: "长弯与缓坡，适合练漂移" },
    laps: 3,
    polar: {
      base: 175,
      terms: [
        { k: 3, amp: 50, phase: 0.5, fn: "cos" },
        { k: 2, amp: 22, phase: 0.0, fn: "sin" },
        { k: 5, amp: 12, phase: 1.1, fn: "cos" },
      ],
    },
    /* 高程幅度收在 ±5.2：海平面是个全局常数，路面必须始终明显地高于它，
       否则低点会掉到水面以下（原 ±7.5 时最低段 cy≈-7.5，与水面几乎齐平）。
       「缓坡」的赛道定位本来也不需要更大的起伏。 */
    elev: {
      terms: [
        { k: 2, amp: 3.4, phase: 0.7 },
        { k: 3, amp: 1.8, phase: 2.1 },
      ],
    },
    sky: { top: 0x8ec8ff, mid: 0x69a9e6, bot: 0xf9d7b3 },
    /* 云量：0=万里无云，1=阴天。云写在共享的 skyColor() 里，所以每加一分，
       海面反射里就多一分云 —— 这是"水看起来像水"最省成本的一招。 */
    cloud: 0.85,
    fog: { color: 0xe9cda4, near: 90, far: 1600 },
    sun: { color: 0xffefd0, intensity: 3.1, dir: [-0.42, 0.42, -0.82] },
    hemi: { sky: 0xc5dfef, ground: 0x4c3829, intensity: 1.12 },
    ambient: { color: 0x6d8198, intensity: 0.48 },
    ground: {
      grass: 0x497a3d,
      dry: 0x9a8357,
      rock: 0x746d66,
      sand: 0xd9be8b,
      mix: 0.46,
    },
    /* 真实海岸：海侧地形按「离赛道距离」平滑下沉成海床，海面是沿赛道生成的
       带状动态水体，两者高度差由 level/floor 保证（海面永远浮在海床上，不穿模）。
       注意：这套参数只在海侧生效，内陆侧的地形照旧走 terrainHeight 的起伏。 */
    /* 海岸落在环线的哪一侧：1 = 环线**外侧**（默认，海能一直铺到海平线）、
       -1 = 环线内侧（会被内场宽度截断成湖）。注意这里只表达「外/内」，
       真正的朝向由 world.js 的 outwardSign() 从赛道几何算出 —— 法向 (sx,sz)
       朝内还是朝外取决于绕向，纯改相位就可能翻面，配置里不该猜。 */
    coastSide: 1,
    water: {
      /* 海平面是绝对高度：路面 cy∈±5.2，故水面比路面低 5~15，永远在水面之上。 */
      level: -10.0,
      floor: -26.0, // 海床：比水面低 16，坡度看得见
      /* 岸坡：从离中线 shoreFrom 起下沉、到 shoreTo 完全落到海床。
         这套距离决定了「水面到路边有多远」—— 改前是 72→230 才沉完，
         路肩外还留着一道 5~9 高的土坎，视线被它挡死，海只剩天边一条线。
         现在 11→62：可见岸线落在离路 33~45 处（即路缘外 25 米左右），路边就是海。
         而且坡度更陡（≈30°）还有第二个好处 —— 地形网格与水面的交线在水线的
         水平方向上摆动更小，回头看岸线就不是锯齿了。 */
      shoreFrom: 11,
      shoreTo: 62,
      startDist: 32, // 海面网格内缘：略早于可见岸线，被地形盖住，看不到接缝
      shallow: 0x7ad7d8,
      deep: 0x1a4f6f,
      /* 泡沫用冷白而不是米黄：米黄混进蓝水会变成绿，整片海都是绿莹莹的网状纹
         （改前就是这样，很容易误判成"反射不对"或"浅海色不对"）。 */
      foam: 0xeef5f4,
    },
    tree: { hue: 0.26, sat: 0.3, light: 0.24, count: 620, size: [0.8, 2.3] },
    building: {
      count: 120,
      emissive: 0x1a0e06,
      tall: 30,
      hueWarm: 0.07,
      hueCool: 0.58,
    },
    mountain: { count: 130, hue: 0.62, sat: 0.22, light: 0.2 },
    music: { root: 55, mode: [0, 3, 5, 7, 10] },
  },

  city: {
    id: "city",
    name: { en: "Midnight City", zh: "午夜都市" },
    desc: { en: "Tight dense corners — tests your racing line", zh: "窄弯密集，考验走线精度" },
    laps: 3,
    polar: {
      base: 164,
      terms: [
        { k: 4, amp: 33, phase: 1.15, fn: "cos" },
        { k: 3, amp: 21, phase: -0.35, fn: "sin" },
        { k: 2, amp: 13, phase: 0.9, fn: "sin" },
        { k: 6, amp: 5, phase: 0.8, fn: "cos" },
      ],
    },
    elev: {
      terms: [
        { k: 3, amp: 3.2, phase: 1.4 },
        { k: 4, amp: 1.8, phase: 0.2 },
      ],
    },
    sky: { top: 0x03050c, mid: 0x0d1430, bot: 0x2b3a68 },
    cloud: 0.28,
    fog: { color: 0x141c38, near: 130, far: 1000 },
    sun: { color: 0x9fb4ff, intensity: 0.85, dir: [-0.3, 0.26, -0.92] },
    hemi: { sky: 0x40538c, ground: 0x1a1c28, intensity: 0.75 },
    ambient: { color: 0x2a3350, intensity: 0.5 },
    ground: {
      grass: 0x28304a,
      dry: 0x323a52,
      rock: 0x3a4058,
      sand: 0x2c3450,
      mix: 0.3,
    },
    tree: { hue: 0.34, sat: 0.18, light: 0.14, count: 380, size: [0.7, 1.9] },
    building: {
      count: 260,
      emissive: 0x2a1a06,
      tall: 62,
      hueWarm: 0.06,
      hueCool: 0.6,
    },
    mountain: { count: 150, hue: 0.63, sat: 0.18, light: 0.1 },
    music: { root: 49, mode: [0, 3, 5, 6, 10] },
  },

  desert: {
    id: "desert",
    name: { en: "Desert Canyon", zh: "沙漠峡谷" },
    desc: { en: "High-speed straights into big climbs", zh: "高速直道接大幅爬坡" },
    laps: 3,
    polar: {
      base: 205,
      terms: [
        { k: 2, amp: 46, phase: 2.1, fn: "cos" },
        { k: 3, amp: 28, phase: -0.75, fn: "cos" },
        { k: 5, amp: 9, phase: 0.3, fn: "sin" },
      ],
    },
    elev: {
      terms: [
        { k: 1, amp: 7.5, phase: 0.9 },
        { k: 2, amp: 4.0, phase: 2.6 },
      ],
    },
    sky: { top: 0x2b1a3a, mid: 0xcf6a38, bot: 0xffc46a },
    cloud: 0.45,
    fog: { color: 0xe0a070, near: 170, far: 1350 },
    sun: { color: 0xffe0b0, intensity: 2.8, dir: [-0.62, 0.24, -0.75] },
    hemi: { sky: 0xffd9ac, ground: 0x6a4a2a, intensity: 1.05 },
    ambient: { color: 0x6a5238, intensity: 0.35 },
    ground: {
      grass: 0xb08a52,
      dry: 0xc9a066,
      rock: 0x8a6a44,
      sand: 0xd9b070,
      mix: 0.6,
    },
    tree: { hue: 0.24, sat: 0.34, light: 0.26, count: 300, size: [0.6, 1.5] },
    building: {
      count: 70,
      emissive: 0x2a1608,
      tall: 26,
      hueWarm: 0.08,
      hueCool: 0.1,
    },
    mountain: { count: 120, hue: 0.06, sat: 0.32, light: 0.3 },
    music: { root: 58, mode: [0, 2, 5, 7, 9] },
  },

  snow: {
    id: "snow",
    name: { en: "Snow Glacier", zh: "雪原冰川" },
    desc: { en: "Low-grip long drifts, wide open views", zh: "低抓地长漂，视线开阔" },
    laps: 3,
    polar: {
      base: 178,
      terms: [
        { k: 2, amp: 40, phase: 0.35, fn: "cos" },
        { k: 3, amp: 26, phase: 1.7, fn: "cos" },
        { k: 4, amp: 12, phase: -0.9, fn: "cos" },
        { k: 7, amp: 9, phase: 0.0, fn: "sin" },
      ],
    },
    elev: {
      terms: [
        { k: 2, amp: 5.0, phase: 2.2 },
        { k: 4, amp: 1.6, phase: 0.5 },
      ],
    },
    sky: { top: 0x5f86c8, mid: 0xa8c4e8, bot: 0xe8f0ff },
    cloud: 0.7,
    fog: { color: 0xd8e6f8, near: 190, far: 1500 },
    sun: { color: 0xeaf2ff, intensity: 2.1, dir: [0.35, 0.42, -0.84] },
    hemi: { sky: 0xcfe2ff, ground: 0x8fa4be, intensity: 1.25 },
    ambient: { color: 0x7f95b5, intensity: 0.45 },
    ground: {
      grass: 0xdae6f5,
      dry: 0xc2d2e6,
      rock: 0x9aa8ba,
      sand: 0xeff5ff,
      mix: 0.75,
    },
    tree: { hue: 0.38, sat: 0.22, light: 0.18, count: 460, size: [0.8, 2.0] },
    building: {
      count: 60,
      emissive: 0x0e1626,
      tall: 24,
      hueWarm: 0.1,
      hueCool: 0.56,
    },
    mountain: { count: 140, hue: 0.6, sat: 0.14, light: 0.62 },
    music: { root: 52, mode: [0, 4, 7, 11, 14] },
  },

  /* 晨雾山道：布局刻意做出真实山路的两段式节奏 ——
     前半段 k2/k3 大摆幅的长弯爬坡，后半段 k8 高频项压出连续 S 弯与近发卡，
     配合浓雾与低角度晨光强化「清晨进山」的临场感。 */
  mountain: {
    id: "mountain",
    name: { en: "Misty Mountain", zh: "晨雾山道" },
    desc: { en: "Hairpins & S-bends chained together — shifting rhythm", zh: "发卡与 S 弯连环，节奏多变" },
    laps: 3,
    polar: {
      base: 186,
      terms: [
        { k: 2, amp: 38, phase: 1.2, fn: "cos" },
        { k: 3, amp: 21, phase: -0.5, fn: "sin" },
        { k: 5, amp: 11, phase: 2.0, fn: "cos" },
        { k: 8, amp: 11, phase: 0.6, fn: "sin" },
      ],
    },
    elev: {
      terms: [
        { k: 1, amp: 7.0, phase: 1.8 },
        { k: 3, amp: 2.4, phase: 0.4 },
      ],
    },
    sky: { top: 0x27354f, mid: 0x9a8fb0, bot: 0xf2c9a0 },
    cloud: 0.6,
    fog: { color: 0xc9d4e8, near: 100, far: 900 },
    sun: { color: 0xffe8c8, intensity: 1.9, dir: [0.5, 0.2, -0.85] },
    hemi: { sky: 0xbcc8e0, ground: 0x2e3b28, intensity: 1.0 },
    ambient: { color: 0x4a5568, intensity: 0.4 },
    ground: {
      grass: 0x3e5a38,
      dry: 0x6a6a48,
      rock: 0x5c5c64,
      sand: 0x77765c,
      mix: 0.3,
    },
    tree: { hue: 0.3, sat: 0.32, light: 0.16, count: 700, size: [0.7, 2.6] },
    building: {
      count: 46,
      emissive: 0x1a120a,
      tall: 18,
      hueWarm: 0.08,
      hueCool: 0.55,
    },
    mountain: { count: 170, hue: 0.58, sat: 0.16, light: 0.3 },
    music: { root: 50, mode: [0, 2, 3, 7, 10] },
  },
};

export const TRACK_ORDER = ["coast", "city", "desert", "snow", "mountain"];

/* ---------------------------------------------------------------------------
 * 车辆涂装（联机时用涂装索引区分玩家）
 * -------------------------------------------------------------------------*/
export const PAINTS = [
  { id: 0, name: { en: "Crimson Red", zh: "赤焰红" }, body: 0xd8323c, rim: 0xc9d2dc },
  { id: 1, name: { en: "Deep Blue", zh: "深海蓝" }, body: 0x2b6cd8, rim: 0xd8e2ec },
  { id: 2, name: { en: "Lemon Yellow", zh: "柠檬黄" }, body: 0xe8c23a, rim: 0x2c3038 },
  { id: 3, name: { en: "Mint Green", zh: "薄荷绿" }, body: 0x2fc07a, rim: 0xe4ecf4 },
  { id: 4, name: { en: "Violet", zh: "幻紫" }, body: 0x8f4ce0, rim: 0xf0e6ff },
  { id: 5, name: { en: "Carbon Black", zh: "碳黑" }, body: 0x24262e, rim: 0xe0a13a },
  { id: 6, name: { en: "Orange Wind", zh: "橙风" }, body: 0xf07a24, rim: 0x2c3038 },
  { id: 7, name: { en: "Snow White", zh: "雪白" }, body: 0xe8eef6, rim: 0x3a4a5e },
];

/* ---------------------------------------------------------------------------
 * 成就表
 * 每个成就：id / 标题 / 描述 / 稀有度(starter|pro|master)
 * 判定逻辑在 achievements.js，此处只放元数据以便 UI 直接渲染
 * -------------------------------------------------------------------------*/
export const ACHIEVEMENTS = [
  {
    id: "first_lap",
    title: { en: "First Drive", zh: "初次上路" },
    desc: { en: "Complete your first lap", zh: "完成你的第一圈" },
    tier: "starter",
  },
  {
    id: "first_race",
    title: { en: "First Win", zh: "首战告捷" },
    desc: { en: "Finish a full race", zh: "完成一场完整比赛" },
    tier: "starter",
  },
  {
    id: "speed_150",
    title: { en: "Wind Rises", zh: "风起了" },
    desc: { en: "Break 150 km/h", zh: "时速突破 150 km/h" },
    tier: "starter",
  },
  { id: "speed_210", title: { en: "Windbreaker", zh: "破风者" }, desc: { en: "Break 210 km/h", zh: "时速突破 210 km/h" }, tier: "pro" },
  {
    id: "drift_500",
    title: { en: "Drift Novice", zh: "漂移入门" },
    desc: { en: "Bank 500 drift points in one race", zh: "单场漂移积分累计 500" },
    tier: "starter",
  },
  {
    id: "drift_3000",
    title: { en: "Drift Master", zh: "甩尾大师" },
    desc: { en: "Bank 3000 drift points in one race", zh: "单场漂移积分累计 3000" },
    tier: "pro",
  },
  {
    id: "combo_5",
    title: { en: "Combo Artist", zh: "连击艺术家" },
    desc: { en: "Reach a 5.0x drift combo multiplier", zh: "漂移连击倍数达到 5.0" },
    tier: "pro",
  },
  {
    id: "clean_lap",
    title: { en: "Clean Lap", zh: "干净的一圈" },
    desc: { en: "Finish a lap without leaving the track", zh: "单圈全程不出赛道完赛" },
    tier: "pro",
  },
  {
    id: "no_brake",
    title: { en: "Brakes Are For Cowards", zh: "刹车是懦夫" },
    desc: { en: "Finish a lap without braking", zh: "单圈全程不踩刹车完赛" },
    tier: "master",
  },
  {
    id: "wall_ride",
    title: { en: "Wall Rider", zh: "贴墙走线" },
    desc: { en: "Hug the wall continuously for 2 seconds", zh: "紧贴护墙连续行驶 2 秒" },
    tier: "pro",
  },
  {
    id: "win_ai",
    title: { en: "AI Conqueror", zh: "人机之王" },
    desc: { en: "Win a race that includes AI opponents", zh: "在带 AI 对手的比赛中夺冠" },
    tier: "pro",
  },
  {
    id: "comeback",
    title: { en: "Comeback", zh: "绝地反击" },
    desc: { en: "Climb from last place to first", zh: "从最后一名反超至第一名" },
    tier: "master",
  },
  {
    id: "online_first",
    title: { en: "Online Debut", zh: "联机首战" },
    desc: { en: "Finish an online multiplayer race", zh: "完成一场在线联机比赛" },
    tier: "starter",
  },
  {
    id: "online_party",
    title: { en: "Full House", zh: "人齐了" },
    desc: { en: "Finish a race in a room of 4+ players", zh: "在 4 人以上的房间完赛" },
    tier: "pro",
  },
  {
    id: "splitscreen",
    title: { en: "Couch Duel", zh: "沙发对决" },
    desc: { en: "Finish a local split-screen match", zh: "完成一场本地分屏对战" },
    tier: "starter",
  },
  {
    id: "tour_all",
    title: { en: "Track Conqueror", zh: "全图制霸" },
    desc: { en: "Complete a lap on every track", zh: "在全部赛道上各完成一圈" },
    tier: "master",
  },
  {
    id: "ai_beater",
    title: { en: "Golden Foot", zh: "黄金右脚" },
    desc: { en: "Win on Hard AI difficulty", zh: "AI 难度设为「困难」并夺冠" },
    tier: "master",
  },
  {
    id: "night_owl",
    title: { en: "Night Owl", zh: "夜猫子" },
    desc: { en: "Lap Midnight City in under 60s", zh: "在午夜都市跑进单圈 60 秒" },
    tier: "pro",
  },
  {
    id: "photo_finish",
    title: { en: "Photo Finish", zh: "毫厘之争" },
    desc: { en: "Win by a margin under 0.3s", zh: "以 0.3 秒内的差距赢得比赛" },
    tier: "master",
  },
  {
    id: "perfectionist",
    title: { en: "Perfect Launch", zh: "完美起步" },
    desc: { en: "Launch within 0.35s of the start signal", zh: "发车信号后 0.35 秒内起步" },
    tier: "starter",
  },
];

/** AI 难度预设 */
export const AI_LEVELS = {
  easy: {
    id: "easy",
    name: { en: "Easy", zh: "轻松" },
    latAccel: 26, // 弯道可用侧向加速度（决定过弯速度上限）
    speedMul: 0.9, // 极速倍率
    rubber: 0.22, // 橡皮筋强度（追赶玩家）
    mistakeRate: 0.1, // 每秒失误概率
    count: 3,
  },
  normal: {
    id: "normal",
    name: { en: "Normal", zh: "普通" },
    latAccel: 34,
    speedMul: 0.97,
    rubber: 0.12,
    mistakeRate: 0.045,
    count: 5,
  },
  hard: {
    id: "hard",
    name: { en: "Hard", zh: "困难" },
    latAccel: 43,
    speedMul: 1.0,
    rubber: 0.0,
    mistakeRate: 0.012,
    count: 5,
  },
};

/** 游戏模式 */
export const MODES = {
  SOLO: "solo", // 单人计时 + AI
  SPLIT: "split", // 本地分屏双人 + AI
  ONLINE: "online", // 在线联机
};

/** 赛制：竞速比圈速名次；道具赛有道具箱（联机暂不支持道具） */
export const FORMATS = {
  CLASSIC: "classic",
  ITEM: "item",
};

export const ITEMS_CFG = {
  BOX_GROUPS: 8, // 道具箱组数（沿赛道均布，跳过发车区）
  BOX_LANES: [-5.5, 0, 5.5],
  BOX_RESPAWN: 5, // 道具箱被吃后再生秒数
  PICKUP_R: 2.6, // 吃箱半径
  ROLL_TIME: 0.9, // 抽道具滚动时长（秒）
  BOOST_T: 2.2, // 氮气持续
  BOOST_ACC: 1.45, // 氮气额外推力（×ENGINE）
  BOOST_MAX_MUL: 1.2, // 氮气时极速放宽
  SHIELD_T: 6, // 护盾持续
  OIL_TTL: 30, // 油污存留
  OIL_R: 1.9, // 触油半径
  MISSILE_SPEED: 56, // 导弹沿赛道速度 m/s
  MISSILE_TTL: 9,
  SPIN_T: 1.25, // 打滑时长
};

export const STORAGE = {
  BEST: "drift-rush-best-v2",
  ACH: "drift-rush-ach-v2",
  TRACKS_DONE: "drift-rush-tracks-v2",
  NAME: "drift-rush-name",
  PAINT: "drift-rush-paint",
};
