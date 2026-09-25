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
  };
}

/* ===========================================================================
 * SKY_GLSL — 天空的核心函数。任何需要"朝某个方向看到的天空颜色"的地方都 include 它。
 * 渐变三段：地平线暖色 uSkyBot → 中段 uSkyMid → 天顶 uSkyTop，再叠三层太阳光晕。
 * =========================================================================*/
export const SKY_GLSL = /* glsl */ `
uniform vec3 uSkyTop;
uniform vec3 uSkyMid;
uniform vec3 uSkyBot;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunStrength;

vec3 skyColor(vec3 dir) {
  vec3 d = normalize(dir);
  // y*0.5+0.5：把 [-1,1] 的仰角映射到 [0,1]，0=正下方 0.5=地平线 1=天顶
  float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(uSkyBot, uSkyMid, smoothstep(0.42, 0.60, h));
  col = mix(col, uSkyTop, smoothstep(0.58, 0.92, h));
  // 日轮 + 内外两层霞光（由色板的太阳色驱动，保证夜间/雪天也是对的色）
  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunColor * pow(sd, 240.0) * uSunStrength;
  col += uSunColor * pow(sd, 14.0) * 0.42;
  col += uSunColor * pow(sd, 3.0) * 0.08;
  return col;
}
`;

/** 轻量值噪声：给水面细波纹打碎规则感用（零贴图，纯数学） */
export const NOISE_GLSL = /* glsl */ `
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
`;

/** 天空球：内壁渲染 skyColor()，即"实景背景" */
export function buildSkyMesh(THREE, uniforms, radius = 1800) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
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
      void main() { gl_FragColor = vec4(skyColor(vDir), 1.0); }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 36, 20), mat);
  mesh.name = "sky";
  return mesh;
}
