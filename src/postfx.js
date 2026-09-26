/* ===========================================================================
 * postfx.js — HDR 后处理链：场景→浮点缓冲 → 阈值提取 → 三级降采样模糊 → 合成
 *
 * 【为什么要有它】
 * 参考实现（pelican-bike）的画面之所以"电影感"，最大的一块不是水也不是天空，
 * 而是 UnrealBloom：太阳、云缘、水面高光这些超过 1.0 的亮度会向外溢出一圈光晕。
 * 没有泛光的画面，亮部一律被裁在 1.0，看着就像一张压平了的贴纸。
 *
 * 【为什么自己写】
 * 本项目只 vendor 了 three.module.js，没有 addons（EffectComposer/UnrealBloomPass
 * 都在 addons 里）。所以整条链手写：三个全屏 pass 材质 + 一组渲染目标而已。
 *
 * 【一个必须一起改的点：色调映射搬到合成阶段】
 * 泛光要"超过 1.0 的亮度"才有东西可提，所以场景必须先渲染成 **未做色调映射的
 * HDR 浮点缓冲**。因此 renderer.toneMapping 设为 NoToneMapping，ACES 改在合成
 * shader 里做（见 composite 的 acesFilm）。顺序错了就全白干：先 ACES 压到 0..1
 * 再提亮部，几乎提不出任何东西。
 *
 * 【抗锯齿】渲染到 RT 会丢掉画布自带的 MSAA，所以场景缓冲要显式开 samples
 * （WebGL2 的多样本渲染目标）。不开的话开了泛光反而更糊更锯齿。
 * =========================================================================*/

/* 全屏三角形：比全屏四边形少一次光栅化接缝，且不用管顶点属性 */
const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy * 2.0, 0.0, 1.0);
}`;

/* 亮部提取：软膝盖，避免阈值处出现硬边（硬阈值会让泛光边界出现一圈台阶） */
const BRIGHT_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform float uThreshold;
uniform float uKnee;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // 软膝盖：阈值附近线性过渡，超过 knee 后才全额提取
  float soft = clamp(lum - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float contrib = max(soft, lum - uThreshold) / max(lum, 1e-4);
  gl_FragColor = vec4(c * contrib, 1.0);
}`;

/* 可分离高斯：9 抽样用 5 次纹理读取（线性插值折半），uDir 决定横向/纵向 */
const BLUR_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec2 o = uTexel * uDir;
  vec3 s = texture2D(tSrc, vUv).rgb * 0.227027;
  s += (texture2D(tSrc, vUv + o * 1.3846).rgb + texture2D(tSrc, vUv - o * 1.3846).rgb) * 0.316216;
  s += (texture2D(tSrc, vUv + o * 3.2308).rgb + texture2D(tSrc, vUv - o * 3.2308).rgb) * 0.070270;
  gl_FragColor = vec4(s, 1.0);
}`;

/* 合成：底色 + 三级泛光 →（按掩码）色调映射 → sRGB。另加一点暗角。
 *
 * 【alpha 掩码：为什么需要它，以及它是怎么来的】
 * 场景缓冲里其实住着两群脾气完全不同的像素：
 *   · three 内置材质（地形/路面/树/车……）—— 自带 ACES 光环。
 *   · 天空球与海面（自定义 ShaderMaterial）—— **从来就没有经历过色调映射**。
 *     内置材质的 shader 里有 #include <tonemapping_fragment>，自定义的没有；
 *     而且 three 在渲染到渲染目标时会强制把 toneMapping 置成 NoToneMapping
 *     （见 WebGLPrograms：currentRenderTarget === null 才取 renderer.toneMapping），
 *     所以这两个自定义 shader 一直是"线性值直接当像素"在显示。
 *
 * 一旦在后处理末端无差别地补上 ACES，天空会立刻从浓蓝洗成灰白 —— 因为 ACES 天生
 * 压饱和，而调色板里的天蓝（0x8ec8ff）在这条曲线上会掉到接近浅灰蓝。
 * 这不是"变亮了"，是"换了个颜色"，而且没有任何报错会提示你。
 *
 * 所以约定：**alpha = 0 表示"这片像素已是显示参考，只需 sRGB 编码，不要色调映射"**，
 * 天空球与海面主动写 0，其余内置材质天然是 1。
 * 注意它们必须用 NoBlending：默认的 NormalBlending 对 alpha 通道是
 * (One, OneMinusSrcAlpha)，写 0 的结果是 dst.a = 0 + dst.a*1 = 1 —— 掩码根本传不出来。
 */
const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom0;
uniform sampler2D tBloom1;
uniform sampler2D tBloom2;
uniform float uStrength;
uniform float uExposure;
uniform float uVignette;
varying vec2 vUv;

// ACES 近似（Narkowicz）。three 的 ACESFilmicToneMapping 用的就是这一条，
// 所以观感与改动前保持一致（那时候是内置材质在各自 shader 里做的）。
vec3 acesFilm(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec4 s = texture2D(tScene, vUv);
  /* 三级权重近大远小：近级给太阳/高光一圈紧实的光晕，远级负责大面积的空气感。
     全堆在近级会变成"整块发白"，全堆在远级就只剩一层灰雾。 */
  vec3 bloom = texture2D(tBloom0, vUv).rgb * 1.00
             + texture2D(tBloom1, vUv).rgb * 0.55
             + texture2D(tBloom2, vUv).rgb * 0.30;

  vec3 toned = acesFilm(s.rgb * uExposure);  // 内置材质：带曝光
  vec3 raw = s.rgb;                          // 天空/海面：曝光与曲线都不施加
  vec3 col = mix(raw, toned, s.a) + bloom * uStrength;

  // 暗角：极轻，只是为了把视线收进画面中心；过重会像老照片
  float d = distance(vUv, vec2(0.5));
  col *= mix(1.0, smoothstep(0.86, 0.30, d), uVignette);

  // 线性 → sRGB（渲染到画布这一步不会自动做，因为全程用的是自定义 shader）
  vec3 srgb = mix(col * 12.92,
                  1.055 * pow(max(col, vec3(1e-5)), vec3(1.0 / 2.4)) - 0.055,
                  step(0.0031308, col));
  gl_FragColor = vec4(clamp(srgb, 0.0, 1.0), 1.0);
}`;

export function createPostFX(THREE, renderer) {
  const maxSamples = 3; // 泛光降采样级数（1/2、1/4、1/8）
  const isWebGL2 =
    typeof WebGL2RenderingContext !== "undefined" &&
    renderer.getContext() instanceof WebGL2RenderingContext;

  const rtOpts = {
    type: THREE.HalfFloatType, // HDR：亮部必须能超过 1.0，否则没东西可提
    depthBuffer: true,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  };
  const rtOptsNoDepth = { ...rtOpts, depthBuffer: false };

  let sceneRT = new THREE.WebGLRenderTarget(1, 1, rtOpts);
  if (isWebGL2) sceneRT.samples = 4; // 补回画布自带的 MSAA
  const levels = [];
  for (let i = 0; i < maxSamples; i++) {
    levels.push({
      a: new THREE.WebGLRenderTarget(1, 1, rtOptsNoDepth),
      b: new THREE.WebGLRenderTarget(1, 1, rtOptsNoDepth),
    });
  }

  const quad = new THREE.BufferGeometry();
  quad.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 1.5, -0.5, 0, -0.5, 1.5, 0], 3),
  );
  quad.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(quad, null);
  mesh.frustumCulled = false;
  scene.add(mesh);

  const mkMat = (frag, uniforms) =>
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader: FS_VERT,
      fragmentShader: frag,
      depthTest: false,
      depthWrite: false,
    });

  /* 阈值是这套后处理里最容易搞错的一个数，而且它有一个**可算出来的**正确位置：
     three 的 PBR 里方向光的漫反射贡献是 intensity/π × albedo，海岸光照强度 3.1
     除以 π 约等于 0.99，再乘 albedo(≤1) —— 所以**受光表面能到的上限就是 1.0 左右**。
     阈值放在这个上限正上方（1.05），地面就永远进不了泛光，而日轮、水面双叶镜面、
     浪尖高光这些真正的 HDR 源（可以到 3 以上）能进。
     阈值定低了会把整片地面算进去，画面立刻蒙上一层雾 —— 那不是泛光，是加了个雾层，
     而且**看起来像"曝光调高了"，很容易往错的方向去调曝光**。
     （上一版定 1.4 又走了另一个极端：连日的内晕都够不着，等于装了个永远不亮的灯。） */
  const brightMat = mkMat(BRIGHT_FRAG, {
    tSrc: { value: null },
    uThreshold: { value: 1.05 },
    uKnee: { value: 0.4 },
  });
  const blurMat = mkMat(BLUR_FRAG, {
    tSrc: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uDir: { value: new THREE.Vector2(1, 0) },
  });
  const compMat = mkMat(COMPOSITE_FRAG, {
    tScene: { value: sceneRT.texture },
    tBloom0: { value: levels[0].a.texture },
    tBloom1: { value: levels[1].a.texture },
    tBloom2: { value: levels[2].a.texture },
    /* 强度是「亮部提取结果」的倍率。三级权重和约 1.85，所以 0.20 的实际观感
       约等于给高光加了 0.37 倍的通量。0.55（改前的值）等于加了整整一倍，
       高光会连着周围一大片一起糊掉。 */
    uStrength: { value: 0.32 },
    uExposure: { value: 1.06 },
    uVignette: { value: 0.22 },
  });

  /* W/H = 设备像素（渲染目标的实际尺寸）；CW/CH = CSS 像素（setViewport 的输入单位，
     three 内部会再乘 pixelRatio）。两者混用会让合成只画进画面的一角。 */
  let W = 1,
    H = 1,
    CW = 1,
    CH = 1;

  function blit(mat, target) {
    mesh.material = mat;
    renderer.setRenderTarget(target || null);
    renderer.render(scene, cam);
  }

  return {
    /** 强度/曝光/暗角，供画质档位与偏好调节 */
    set strength(v) {
      compMat.uniforms.uStrength.value = v;
    },
    get strength() {
      return compMat.uniforms.uStrength.value;
    },
    set exposure(v) {
      compMat.uniforms.uExposure.value = v;
    },
    set vignette(v) {
      compMat.uniforms.uVignette.value = v;
    },

    /** 供验收断言缓冲尺寸与 drawing buffer 是否一致（不一致就是拉伸/错位） */
    get size() {
      return { w: W, h: H, cssW: CW, cssH: CH, pixelRatio: renderer.getPixelRatio() };
    },
    /** 供验收断言"亮部确实能超过 1.0" —— 用字节缓冲做泛光是自欺欺人 */
    get hdrType() {
      return sceneRT.texture.type === THREE.HalfFloatType ? 'HalfFloat' : 'Byte';
    },
    get samples() {
      return sceneRT.samples || 0;
    },

    /** @param w,h CSS 像素（与 renderer.setSize 同一单位） */
    setSize(w, h) {
      CW = Math.max(1, Math.floor(w));
      CH = Math.max(1, Math.floor(h));
      const pr = renderer.getPixelRatio();
      W = Math.max(1, Math.round(CW * pr));
      H = Math.max(1, Math.round(CH * pr));
      sceneRT.setSize(W, H);
      for (let i = 0; i < levels.length; i++) {
        const d = 2 << i; // 2,4,8
        levels[i].a.setSize(Math.max(1, W / d), Math.max(1, H / d));
        levels[i].b.setSize(Math.max(1, W / d), Math.max(1, H / d));
      }
    },

    /**
     * 渲染一帧。drawScene 由调用方提供（分屏时它自己处理两个视口），
     * 本函数只负责把结果接进 RT 并跑后处理。
     */
    render(drawScene) {
      renderer.setRenderTarget(sceneRT);
      renderer.setScissorTest(false);
      /* 不清屏：drawScene 里的 renderer.render 自带 autoClear，分屏时它还依赖
         scissor 保证"只清自己那半"，这里先清反而会破坏那套配合。 */
      drawScene();
      renderer.setRenderTarget(null);

      // ① 阈值提取到 1/2
      brightMat.uniforms.tSrc.value = sceneRT.texture;
      blit(brightMat, levels[0].a);

      // ② 每一级：横向 → 纵向 → 降采样到下一级
      for (let i = 0; i < levels.length; i++) {
        const L = levels[i];
        const w = L.a.width,
          h = L.a.height;
        blurMat.uniforms.uTexel.value.set(1 / w, 1 / h);
        blurMat.uniforms.tSrc.value = L.a.texture;
        blurMat.uniforms.uDir.value.set(1, 0);
        blit(blurMat, L.b);
        blurMat.uniforms.tSrc.value = L.b.texture;
        blurMat.uniforms.uDir.value.set(0, 1);
        blit(blurMat, L.a);
        if (i + 1 < levels.length) {
          // 降采样直接用横向模糊再采一次，省一个 pass
          blurMat.uniforms.uTexel.value.set(1 / levels[i + 1].a.width, 1 / levels[i + 1].a.height);
          blurMat.uniforms.tSrc.value = L.a.texture;
          blurMat.uniforms.uDir.value.set(1, 0);
          blit(blurMat, levels[i + 1].a);
        }
      }

      // ③ 合成到画布。**必须先把视口恢复成整屏**：分屏时 drawScene 把 _viewport
      // 改成了其中半屏，而 setRenderTarget(null) 会照着 _viewport 算视口 ——
      // 不恢复的话合成只画进半屏，另半屏是上一帧的残影。
      renderer.setViewport(0, 0, CW, CH);
      renderer.setScissor(0, 0, CW, CH);
      renderer.setScissorTest(false);
      blit(compMat, null);
    },

    dispose() {
      sceneRT.dispose();
      levels.forEach((l) => (l.a.dispose(), l.b.dispose()));
      quad.dispose();
      brightMat.dispose();
      blurMat.dispose();
      compMat.dispose();
    },
  };
}
