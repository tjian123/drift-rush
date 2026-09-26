/* ===========================================================================
 * sky.js — 统一天空：一个 skyColor() 函数贯穿「天空球 / 海面反射 / 海面雾色」
 *
 * 【为什么要这么设计】
 * 画面真实感的关键不在于堆 shader，而在于"自洽"。参考优秀实现（pelican-bike）的
 * 核心思路是：把天空定义为一个 GLSL 函数，而不是一张贴图或一段只给天空球用的 shader。
 *
 *   · 天空球渲染它               → 我们看到的天空
 *   · 海面用 reflect() 采样它    → 海面反射到的就是那片天（真实海水约七成以上是反射）
 *   · 远处雾色也取自它           → 海天在地平线处无缝融合，不会出现"色带断层"
 *
 * 三者共用同一份数学，因此永远不可能不一致。这也顺带修掉了一个老问题：原先天空球的
 * 太阳光晕是硬编码的橙色 vec3(1.0,0.72,0.42)，夜之城/雪山的 sun.color 色板完全没生效；
 * 现在全部由 uSunColor（取自赛道色板 layout.sun.color）驱动。
 *
 * 【云为什么也写进这里】
 * 云层是这个共享结构的最大红利：只要把它加进 skyColor()，海面反射里立刻就有了云
 * —— 不需要任何屏幕空间反射或立方体贴图。真实海面之所以好看，七成来自"反射了
 * 有内容的天空"；一块纯渐变色的天空反射出来就是一块纯渐变色的水（改前就是这样，
 * 所以水怎么看都像一块塑料板）。云的明暗还给泛光提供了 HDR 高光源。
 *
 * 【用法】makeSkyUniforms() 产出的 uniform 对象里每个 uniform 都是独立对象引用，
 * 用 Object.assign 浅拷贝给其他材质时仍能共享同一份 —— 改一处，天空与海面同步。
 * =========================================================================*/

/** 天空所需的共享 uniforms（每个 value 都是独立对象，便于跨材质共享引用） */
export function makeSkyUniforms(THREE, layout) {
  const sunDir = new THREE.Vector3(...layout.sun.dir).normalize();
  return {
    uSkyTop: { value: new THREE.Color(layout.sky.top) },
    uSkyMid: { value: new THREE.Color(layout.sky.mid) },
    uSkyBot: { value: new THREE.Color(layout.sky.bot) },
    uSunDir: { value: sunDir },
    uSunColor: { value: new THREE.Color(layout.sun.color) },
    // 沿用原天空球的强弱分档：强光赛道给足日轮，弱光赛道不至于糊成一片
    uSunStrength: { value: layout.sun.intensity > 2 ? 3.2 : 1.6 },
    /* 云量与时间。uTime 由 app 每帧写入（与海面同一个时钟），天空球与海面共用
       同一个引用，所以云的移动和浪的起伏天然同步，不会各走各的。 */
    uCloudAmt: { value: layout.cloud ?? 0.5 },
    uTime: { value: 0 },
  };
}

/* ===========================================================================
 * SKY_GLSL — 天空的核心函数。任何需要"朝某个方向看到的天空颜色"的地方都 include 它。
 *
 * 组成（顺序即依赖顺序，GLSL 必须先声明后使用）：
 *   ① 值噪声 hash12/vnoise —— 云与水面细波纹共用
 *   ② 云层 cloudColor()    —— 4 段 fbm + 朝太阳方向的二次采样做自阴影
 *   ③ skyColor()           —— 三段渐变 + 云 + 三层太阳光晕
 * =========================================================================*/
export const SKY_GLSL = /* glsl */ `
uniform vec3 uSkyTop;
uniform vec3 uSkyMid;
uniform vec3 uSkyBot;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunStrength;
uniform float uCloudAmt;
uniform float uTime;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}

/* 云的密度场：4 段 fbm，各段用不同速度漂移 —— 同速会让整片云像贴纸一样整体平移，
   错速才有"云在各自翻卷"的感觉。权重和 = 1，返回值域 [0,1]。 */
float cloudField(vec2 uv, float t) {
  float f = 0.0;
  f += 0.50 * vnoise(uv * 1.00 + vec2(t * 0.020, t * 0.0080));
  f += 0.25 * vnoise(uv * 2.10 + vec2(-t * 0.031, t * 0.0110));
  f += 0.15 * vnoise(uv * 4.30 + vec2(t * 0.047, -t * 0.0190));
  f += 0.10 * vnoise(uv * 8.70 + vec2(-t * 0.063, t * 0.0290));
  return f;
}

/* 云层：把视线方向投影到云层平面再采样密度场，返回 (颜色, 覆盖率)。
   —— 用 d.xz / d.y 做平面投影是有意的：越靠近地平线，同一片云在屏幕上被压得越扁、
   在 uv 空间被拉得越长，这正是真实云层贴向地平线的透视压缩，比"按仰角插值"自然得多。

   **覆盖率必须单独返回、不要预先乘进颜色**：调用方是 mix(sky, cloud, amt*cover)，
   若颜色里已经乘过一次 cover，云量就会被平方 —— 表面上只是"淡了一点"，
   实际后果是把整个天空压成一片均匀的白，这类二次衰减极难从画面上反推。 */
vec4 cloudColor(vec3 d) {
  /* 云层平面投影在 d.y→0 时 uv→∞，噪声频率爆炸会走样成一片跳动的白噪点。
     所以在 d.y 低到 0.10 之前就把云整个淡掉：那一段本来也该没入地面雾里。 */
  float fade = smoothstep(0.10, 0.42, d.y);
  if (fade <= 0.001) return vec4(0.0);

  /* 投影系数 = 云层高度 / 云团特征尺度，是「视野里能看到几朵云」的唯一决定因素。
     取 0.30 时，仰角 35° 处的 uv 幅值只有 0.5 —— 整个天顶落进**一个**噪声格子里，
     于是天空只剩一条糊开的白带（不是"云太少"，是"尺度错了"，肉眼极难反推）。
     取 2.4 后同一视野横跨约 4 个格子，才是散着的几朵云。 */
  float y = max(d.y, 0.12);
  vec2 uv = d.xz / y * 2.4;
  float f = cloudField(uv, uTime);
  /* 覆盖率阈值决定云的"厚薄"。这个区间要贴着密度场的实际分布来定：4 段 fbm 的
     标准差只有 0.08 左右，所以这个区间必须*窄*：区间宽了（如 0.44~0.68）天空一大半
     落在「全白云」一侧，成了阴天；区间窄而位置高（如 0.52~0.74）又几乎没人能到 1，
     云永远半透明，糊成一层薄纱（肉眼很容易误判成"对比度不够"，然后去调颜色）。
     0.50~0.62 才让积云该实的地方真的实起来。 */
  float cover = smoothstep(0.50, 0.62, f) * fade;

  /* 自阴影：朝太阳的水平方向再采一次密度 —— 那个方向密度高，说明视线与太阳之间
     还隔着云，当前点就落在阴影里。这是最廉价的云体光照，一次采样换出立体感。 */
  vec2 toSun = uSunDir.xz / max(abs(uSunDir.y), 0.25);
  float fs = cloudField(uv + toSun * 0.22, uTime);
  float shadow = smoothstep(0.40, 0.72, fs);

  float sd = max(dot(d, uSunDir), 0.0);
  /* 基础亮度必须**低于**天空本身的观感亮度，否则天顶上会糊出一块纯白。
     只有朝太阳一侧的散射项（pow(sd,6)）才允许越过 1.0 —— 那才是泛光该抓的
     高光。整片云都 >1 的话，泛光抓到的就是"整个天空"，画面直接洗白。 */
  vec3 lit = vec3(0.58) + uSunColor * (0.18 + 1.10 * pow(sd, 6.0));
  vec3 shade = mix(uSkyMid, uSkyBot, 0.40) * 0.72;
  return vec4(mix(lit, shade, shadow * 0.80), cover);
}

vec3 skyColor(vec3 dir) {
  vec3 d = normalize(dir);
  // y*0.5+0.5：把 [-1,1] 的仰角映射到 [0,1]，0=正下方 0.5=地平线 1=天顶
  float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(uSkyBot, uSkyMid, smoothstep(0.42, 0.60, h));
  col = mix(col, uSkyTop, smoothstep(0.58, 0.92, h));

  /* 云盖在霞光之前、但记录遮挡率：太阳要能从云后透出来，而不是被云整块抹掉。 */
  vec4 cc = cloudColor(d);
  float amt = clamp(uCloudAmt, 0.0, 1.0) * cc.a;
  float occl = amt * 0.55;

  /* 日轮 + 三层霞光。分三档不是"叠得多好看"，而是每一档有各自的去处：
       · pow(sd, 900)  —— 日轮本体，一个很小的实心点
       · pow(sd, 60)*2.2 —— **唯一刻意越过 1.0 的一项**，是泛光的高光源。
                            没有它，泛光的阈值无论怎么调都提不到东西：散射项
                            的天花板只有 0.42，永远够不着阈值，看起来就是"泛光
                            开关没反应"（第一版就是这样，实测开/关差 0.1/255）。
       · pow(sd, 12/3)  —— 大气散射的暖调，属于 LDR 观感，不该参与泛光。 */
  float sd = max(dot(d, uSunDir), 0.0);
  col = mix(col, cc.rgb, amt);
  col += uSunColor * pow(sd, 900.0) * uSunStrength;
  /* 指数决定"过曝圆盘"的直径：pow(sd, n) > 0.5 对应约 53/√n 度。
     n=60 → 约 6.8°，配 62° 视场就是直径约 130 px 的一大团白 —— 泛光再往外铺一圈，
     整块天就被吃掉了。n=120 → 约 4.8°，是"亮得刺眼但仍是个太阳"的尺度。 */
  col += uSunColor * pow(sd, 120.0) * 2.0 * (1.0 - occl);
  col += uSunColor * pow(sd, 12.0) * 0.30 * (1.0 - occl * 0.6);
  col += uSunColor * pow(sd, 3.0) * 0.06;
  return col;
}
`;

/** 轻量值噪声：给水面细波纹打碎规则感用（零贴图，纯数学）
 *  已并入 SKY_GLSL（云也要用），保留导出仅为兼容旧引用。 */
export const NOISE_GLSL = "";

/** 天空球：内壁渲染 skyColor()，即"实景背景" */
export function buildSkyMesh(THREE, uniforms, radius = 1800) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    /* NoBlending 是必须的，不是优化：天空要把 alpha 写成 0 作为「不做色调映射」的
       标记传给后处理，而默认的 NormalBlending 在 alpha 通道上是 (One, OneMinusSrcAlpha)，
       写 0 的结果是 dst.a = 0 + dst.a*1 = 1 —— 标记根本传不出去。 */
    blending: THREE.NoBlending,
    uniforms,
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      ${SKY_GLSL}
      varying vec3 vDir;
      /* alpha = 0：告诉后处理「这片像素已是显示参考，只做 sRGB 编码，不要套 ACES」。
         自定义 shader 从项目最初就没有经过色调映射，这个 0 是在保持既有观感。 */
      void main() { gl_FragColor = vec4(skyColor(vDir), 0.0); }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 36, 20), mat);
  mesh.name = "sky";
  return mesh;
}
