/* ===========================================================================
 * world.js — 天空 / 光照 / 地形 / 植被 / 建筑 / 远山
 * 全部按赛道色板程序化生成；换赛道时整体重建。
 * =========================================================================*/

import { CFG } from "./config.js";
import { terrainHeight } from "./track.js";
import { makeRng, smoothstep, clamp, hexToRgb, lerp } from "./util.js";
import {
  makeSkyUniforms,
  SKY_GLSL,
  NOISE_GLSL,
  buildSkyMesh,
} from "./sky.js";

/* 天空已抽到 sky.js：一个 skyColor() 同时供货给天空球、海面反射与海面雾色，
   三者共用同一份数学与同一组 uniform，因此不可能不一致。
   原先这里是一段只给天空球用的 shader，而且日轮颜色硬编码成橙色，
   夜之城/雪山的 sun.color 色板根本没生效 —— 一并修掉。 */

/* 环线赛道的「外侧」符号。
   法向 (sx,sz) 只是切线旋转 90°，究竟朝环内还是环外全看绕向，而绕向由极坐标
   参数决定、改一个相位就可能翻过来。实测本赛道的法向是**朝环内**的，于是
   coastSide=1 把海铺进了内场：内场直径只有约 300~460，水往外铺一百多单位就撞上
   对向路段被截断 —— 既没有海平线，也看不到连贯的海岸，这正是「感受不到海岸线」
   的几何根因。所以这里不再靠配置猜，而是直接从几何算出朝外的符号。 */
function outwardSign(track) {
  let gx = 0,
    gz = 0;
  for (let i = 0; i < track.n; i++) {
    gx += track.cx[i];
    gz += track.cz[i];
  }
  gx /= track.n;
  gz /= track.n;
  const step = Math.max(1, Math.floor(track.n / 64));
  let acc = 0;
  for (let i = 0; i < track.n; i += step) {
    const ox = track.cx[i] - gx,
      oz = track.cz[i] - gz;
    const L = Math.hypot(ox, oz);
    if (L < 1e-3) continue;
    acc += (track.sx[i] * ox + track.sz[i] * oz) / L;
  }
  return acc >= 0 ? 1 : -1;
}

/** 地形：顶点色 + PBR 平滑着色，贴赛道起伏（地面是大面积视觉主体，平滑+微粗糙最出质感） */
function buildTerrain(THREE, track, layout, coastSign) {
  // 尺寸随赛道包围盒缩放，保证能盖住整条赛道
  const b = track.bounds;
  const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
  const SIZE = Math.round((span * 2.6 + 600) / 4) * 4;
  /* 网格密度直接决定岸线干不干净：地形与水面的交线是逐格走出来的，
     格距越大、岸线锯齿越粗。SIZE≈1708 时 104 段 = 16.4 单位/格（原值）在
     追尾镜头里能看到明显的锯齿轮廓；224 段 = 7.6 单位/格才够平顺。 */
  const SEG = 224;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  const colors = new Float32Array(p.count * 3);
  const g = layout.ground;
  const cA = new THREE.Color(g.grass),
    cB = new THREE.Color(g.dry);
  const cC = new THREE.Color(g.rock),
    cD = new THREE.Color(g.sand);
  const water = layout.water;
  const cDeep = water ? new THREE.Color(water.deep) : null;
  const tmp = new THREE.Color();
  const coastSide = coastSign ?? layout.coastSide ?? 1;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i),
      z = p.getZ(i);
    const near = water ? track.nearestBrute(x, z, 6) : null;
    let h = terrainHeight(track, x, z, near ? () => near : undefined);
    let wet = 0;
    let shoreMix = 0;
    let rockMix = 0;
    if (water && near) {
      const idx = near.index;
      const side =
        (x - track.cx[idx]) * track.sx[idx] +
        (z - track.cz[idx]) * track.sz[idx];
      const coastDist = side * coastSide; // >0 = 海侧
      rockMix = clamp((Math.abs(coastDist) - 18) / 90, 0, 1) * (coastDist < 0 ? 1 : 0.25);
      if (coastDist > water.shoreFrom) {
        /* 海侧地形 = 「路面基准高度 → 海床」的纯斜坡。
           这里刻意**不**用 terrainHeight 的远场起伏（far，±16.5）：一旦掺进去，
           岸线高度会被噪声推着走，可见岸线在 38~65 之间来回摆，海面看起来一截
           一截的。只用 base（贴近路面的高程）当起点，岸线就是一条干净、随路面
           缓坡自然起伏的线。wob 只在浅处给沙滩一点起伏，随坡深迅速衰减。 */
        const flat = terrainHeight(track, x, z, () => ({ index: idx, dist: 9 }));
        const slope = smoothstep(water.shoreFrom, water.shoreTo, near.dist);
        const wob =
          1.8 * Math.sin(x * 0.0125 + 1.1) * Math.cos(z * 0.0107 - 0.6);
        h = lerp(flat, water.floor, slope) + wob * (1 - slope);
        /* 沙滩：海侧的边坡本身就是沙滩，只把紧贴路肩的那一小段留给草 ——
           改前沙滩只在水位上下十几米内出现，路缘到沙滩之间就空出一大条纯绿的
           缓坡，镜头里是一整片绿疙瘩，完全没有海滨感。
           第二个因子按**高度**而不是距离卡下界（水位以下 16 米到底），
           这样水位以上的坡面全部是沙，干沙、湿沙、水下沙自然连成一条。 */
        shoreMix =
          clamp((coastDist - water.shoreFrom) / 6, 0, 1) *
          clamp((h - water.level + 16) / 16, 0, 1);
        wet = 1 - smoothstep(-2, 6, h - water.level);
        rockMix = Math.max(rockMix, clamp((slope - 0.55) / 0.45, 0, 1) * 0.4);
      }
    }
    p.setY(i, h);

    const inland = clamp(0.28 + 0.42 * (1 - shoreMix) + 0.2 * Math.sin(x * 0.01 + z * 0.008), 0, 1);
    tmp.copy(cB).lerp(cA, inland);
    tmp.lerp(cD, shoreMix * 0.9);
    tmp.lerp(cC, rockMix * 0.8 + smoothstep(6, 14, h) * 0.28);

    const dune = Math.abs(Math.sin(x * 0.004) * Math.cos(z * 0.0037));
    tmp.lerp(cD, smoothstep(0.25, 0.95, dune) * 0.2);
    tmp.multiplyScalar(0.82 + 0.38 * clamp((h + 8) / 22, 0, 1));
    if (water && wet > 0) tmp.lerp(cDeep, wet);
    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0.02,
    }),
  );
  mesh.receiveShadow = true;
  return mesh;
}

/* 原先这里有两个「海岸装饰件」：一块 1200 长的沙滩平板 + 一个 30 高的崖壁长方体，
 * 都只朝 track[0] 的单一方向摆放。那套做法默认海岸是一条直线，放到闭环赛道上必然
 * 穿场 —— 垂直俯拍里那道横贯全图的灰绿色直墙就是它（详见 tools/shot-coast-topdown.png）。
 * 现在沙滩由地形顶点色的 shoreMix 沿真实海岸线渐变生成、坡度由地形下沉负责，
 * 两者都天然贴着赛道走，不需要额外的平板与墙。故整体删除。 */

function buildOcean(THREE, track, layout, skyUniforms, coastSign) {
  const w = layout.water;
  const coast = coastSign ?? layout.coastSide ?? 1;

  /* === 海面几何：沿赛道生成的「带状水面」，而不是一块偏置大平面 ===
     为什么必须换掉平面：赛道是闭环，一块朝某个方向偏置的大平面只能盖住环线
     的一部分 —— 实测 12 段采样里 4 段完全没有水，还有几段的水跑到环线内侧
     直接把路淹了，海岸线因此断断续续、完全不成景。
     带状水面从路肩外侧（startDist）起、沿海岸侧向外铺开，绕整圈连续不断，
     水线始终平行于公路；更关键的是「离岸距离」从此成为可用的着色依据，
     才能做出近岸浅、远海深以及岸边碎浪（见片元着色器）。
     注意：海是铺在环线**外侧**的 —— 内侧只有一两百单位的内场，水铺不开、
     也出不来海平线。外侧符号由 outwardSign() 从几何算出，见那边注释。 */
  const START = w.startDist; // 内缘：必定在路面之外，绝不会淹路
  /* 外缘：一直铺到雾的 far 之前，海面在淡出之前就被雾吃干净，
     于是没有"海面戛然而止"的硬边。远山里那圈 r≈720~960 的锥体全在这片海里，
     山脚又压在水面以下，于是天然成了对岸的群岛。 */
  const END = Math.max(900, layout.fog.far * 0.9);
  /* 列（离岸距离）：近岸密集，保证短波不被网格采样拉花；远处按几何增长省顶点 */
  const lats = [];
  // 岸侧列间距 9：顶点波长最短 24，采样必须密于半波长（12）才不会被采成拍频花样
  for (let d = START; d < 260; d += 9) lats.push(d);
  for (let d = lats[lats.length - 1]; d < END; ) {
    const nd = Math.min(d * 1.22, END);
    if (nd > lats[lats.length - 1]) lats.push(nd);
    d = nd;
  }
  const stride = 2;
  const rows = Math.ceil(track.n / stride);
  const cols = lats.length;

  /* === 每行能延伸多远，必须动态截断 ===
     直筒式地向外铺到 END 会出事：赛道是个闭环，某一侧延伸出去的水会横扫
     整个环线、盖到对面那段路上 —— 实测最近的水面顶点离路面只有 0.6。
     所以逐列检查「该点到赛道的最近距离」，一旦逼近任何路段（包括对面的），
     这一行就停止延伸。这样从构造上保证水面永远淹不到路。 */
  const valid = new Int32Array(rows);
  for (let r = 0; r < rows; r++) {
    const k = (r * stride) % track.n;
    const cxp = track.cx[k],
      czp = track.cz[k];
    const sxp = track.sx[k] * coast,
      szp = track.sz[k] * coast;
    let v = cols;
    for (let c = 0; c < cols; c++) {
      /* stride 用 3 而不是默认的 6：nearestBrute 是「粗筛 + 局部精修」，粗筛步长
         越大、在自相贴近的弯道里越可能挑错谷底、把距离报大。加密粗筛能收紧误差，
         但它是近似算法、不保证取到全局最近点，所以守卫只能当作"足够好"的过滤：
         实测全体顶点到整条中心线的最紧处是 26.2（路缘 8.7，仍余 17 单位），
         而真正看得见的水线由岸坡决定、恒定落在 33~45。verify:sky 的 S7 就是量这个。 */
      const near = track.nearestBrute(cxp + sxp * lats[c], czp + szp * lats[c], 3);
      if (near && near.dist < START * 0.9) { v = c; break; }
    }
    valid[r] = v;
  }

  /* === 每行的「水线距离」 ===
     地形高度是 base(=cy-0.45) → floor 的平滑坡，水面是 level，所以水线落在
     slope = (base-level)/(base-floor) 的位置。把这根线解出来（smoothstep 反函数），
     就能知道"这一行的水面，从哪里开始露出水面"。
     为什么不能直接用离中心线的距离当深浅/泡沫的坐标：路是有高程的，可见水线因此
     在离路 30~45 之间来回摆，用固定距离当基准的话，泡沫带会有一半落在岸上、一半
     铺到水里，糊成一片灰膜。用「距水线的距离」当坐标，泡沫就永远焊在水线上。 */
  const wl = w.level,
    fl = w.floor,
    sf = w.shoreFrom,
    stw = w.shoreTo;
  const shoreDist = new Float32Array(rows);
  for (let r = 0; r < rows; r++) {
    const k = (r * stride) % track.n;
    const b = track.cy[k] - 0.45;
    // smoothstep 反函数：x²(3-2x) = s  ⇒  x = 0.5 - sin(asin(1-2s)/3)
    const s = clamp((b - wl) / (b - fl), 0.02, 0.98);
    const x = 0.5 - Math.sin(Math.asin(1 - 2 * s) / 3);
    shoreDist[r] = sf + x * (stw - sf);
  }

  const pos = new Float32Array(rows * cols * 3);
  const shoreAttr = new Float32Array(rows * cols); // 离中心线的绝对侧向距离（给顶点浪做频率衰减）
  const depthAttr = new Float32Array(rows * cols); // 距水线的距离（给深浅渐变与岸边碎浪）
  for (let r = 0; r < rows; r++) {
    const k = (r * stride) % track.n;
    const cxp = track.cx[k],
      czp = track.cz[k];
    const sxp = track.sx[k] * coast,
      szp = track.sz[k] * coast;
    const lastValid = Math.max(0, valid[r] - 1); // 截断后不再用的列也收在合法位置
    for (let c = 0; c < cols; c++) {
      const cc = Math.min(c, lastValid);
      const i3 = (r * cols + c) * 3;
      pos[i3] = cxp + sxp * lats[cc];
      pos[i3 + 1] = 0;
      pos[i3 + 2] = czp + szp * lats[cc];
      shoreAttr[r * cols + c] = lats[cc];
      depthAttr[r * cols + c] = lats[cc] - shoreDist[r];
    }
  }
  const idx = [];
  for (let r = 0; r < rows; r++) {
    const rn = (r + 1) % rows; // 闭环：最后一行接回第一行
    const cmax = Math.min(valid[r], valid[rn]);
    for (let c = 0; c < cmax - 1; c++) {
      const a = r * cols + c, b = r * cols + c + 1;
      const e = rn * cols + c, f = rn * cols + c + 1;
      idx.push(a, e, b, b, e, f);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("aShore", new THREE.Float32BufferAttribute(shoreAttr, 1));
  geo.setAttribute("aDepth", new THREE.Float32BufferAttribute(depthAttr, 1));
  geo.setIndex(idx);
  geo.computeBoundingSphere();

  /* 关键：把天空那份 uniform 浅拷贝进来 —— 里面每个子对象仍是同一个引用，
     于是海面与天空球共用同一组太阳/天空色，换赛道时天然同步，不会各写各的。
     海面的雾也不再用 scene.fog 的平台色，而是直接融进 skyColor()，见片元末尾。 */
  const uniforms = Object.assign({}, skyUniforms, {
    uTime: { value: 0 },
    uDeep: { value: new THREE.Color(w.deep) },
    uShallow: { value: new THREE.Color(w.shallow) },
    uFoam: { value: new THREE.Color(w.foam) },
    // 指数雾密度反推自 each 赛道的 fog.far，保证到了 far 处刚好融透
    uFogDensity: { value: 2.5 / layout.fog.far },
    /* 深浅渐变与岸边碎浪的基准已改为「距水线的距离」（见 aDepth）：
       路有高程，可见水线在离路 30~45 间摆动，用固定距离当基准的泡沫带会有
       一半落在岸上，糊成一片灰膜。原先的 uStartDist/uFullDist 因此退役。 */
  });

  const mat = new THREE.ShaderMaterial({
    fog: false,
    side: THREE.DoubleSide,
    uniforms,
    vertexShader: `
      uniform float uTime;
      attribute float aShore;
      attribute float aDepth;
      varying vec3 vNormal;
      varying vec3 vWorldPos;
      varying float vHeight;
      varying float vShore;
      varying float vDepth;

      /* 波长必须落进「视野里能装下好几道浪」的尺度：原来主频 0.045 → 波长 140 单位，
         而岸边到 300 单位内只装得下两道，海面看着就是一块平整色板。
         现在主频 0.115 → 波长 55，一路到 0.26 → 波长 24，视野里就有层层浪了。
         更细的波纹交给片元里的细节法线（网格采样不了那么密）。

         shore 用来按离岸距离收放振幅，这一条是必须的：外侧环是几何增长的
         （×1.22），到 1000 单位处环距已经两百多，短浪在那里被欠采样成「一圈亮
         一圈暗」的同心条纹，配合浪尖泡沫会变成一圈圈的白色涟漪。所以短浪只留
         在采样够密的近岸带，远海换成一道波长 ~680 的超长涌浪 —— 环距再大也
         表现得出，而且正好是远海该有的那种大尺度起伏。 */
      float waveH(vec2 p, float t, float shore) {
        /* 环距是 9→56→69→84→103… 的几何序列，所以每种波长都有它「过不了奈奎斯特」
           的边界：波长 24 的环向分量 29，环距到 56 就只剩 0.5 个采样/波长 —— 那不是
           波纹，是一圈亮一圈暗的同心梳齿。判据很简单：振幅必须在环距接近半波长
           之前收到 0。于是 near 在 250 前退完（波长短的），mid 在 300 前退完
           （波长 140 的），250 之外只留波长 ~680 的长涌 —— 它在最疏的环距下也有
           六七个采样点，正好撑起远海该有的大起伏。 */
        float near = 1.0 - smoothstep(70.0, 250.0, shore);
        float mid = 1.0 - smoothstep(120.0, 300.0, shore);
        float far = smoothstep(120.0, 700.0, shore);
        float h = 0.0;
        h += sin(p.x * 0.115 + t * 1.35) * 0.30 * near;
        h += sin(p.y * 0.088 - t * 1.05 + 1.7) * 0.24 * near;
        h += sin((p.x + p.y) * 0.045 + t * 0.70) * 0.22 * mid;
        h += sin(p.x * 0.260 - p.y * 0.215 + t * 2.10) * 0.08 * near;
        h += sin(p.x * 0.0092 + p.y * 0.0074 + t * 0.22) * 1.30 * far;
        return h;
      }
      void main() {
        vec3 pos = position;
        float eps = 1.2;
        float h0 = waveH(pos.xz, uTime, aShore);
        float hx = waveH(pos.xz + vec2(eps, 0.0), uTime, aShore);
        float hz = waveH(pos.xz + vec2(0.0, eps), uTime, aShore);
        pos.y += h0;
        vHeight = clamp(h0 / 0.9, -1.4, 1.4); // 约 [-1,1]，供浪尖泡沫与透光使用
        vShore = aShore;      // 离中心线的绝对侧向距离：只用来给顶点浪做频率衰减
        vDepth = aDepth;      // 距水线的距离：深浅渐变与岸边碎浪都用它
        vNormal = normalize(vec3(-(hx - h0) / eps, 1.0, -(hz - h0) / eps));
        vec4 worldPos = modelMatrix * vec4(pos, 1.0);
        vWorldPos = worldPos.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }`,
    fragmentShader: `
      ${SKY_GLSL}
      ${NOISE_GLSL}
      uniform float uTime;
      uniform vec3 uDeep, uShallow, uFoam;
      uniform float uFogDensity;
      varying vec3 vNormal;
      varying vec3 vWorldPos;
      varying float vHeight;
      varying float vShore;
      varying float vDepth;

      void main() {
        vec3 N = normalize(vNormal);
        float dist = length(vWorldPos - cameraPosition);

        /* 细节法线：两层滚动噪声取有限差分，补出网格铺不出来的细波纹 —— 这是
           海面"活起来"的关键，因为顶点波长受网格密度限制（岸侧列间距 9 单位），
           而法线扰动不受。

           **关键是采样频率必须随距离下降，而不是靠"淡出"硬撑。**
           噪声特征尺度约 1.8 单位：在 200 单位外只占 4 个像素、400 外 2 个像素，
           继续按原频率采，屏幕上就出现一层层摩尔纹横带（改前海面那几条横纹就是
           它，跟网格、跟顶点浪都无关）。所以把噪声坐标乘一个随距离衰减的 lod ——
           远处自动变成更大的起伏，世界空间里的斜率也随之降到 0，既不会闪，
           也不用再额外写一段 fade。两层用不同的衰减速率：细纹退得快，
           粗纹留得久，中远景的海面才有明暗起伏而不是一块纯色。 */
        float lodF = 1.0 / (1.0 + dist * 0.016);
        float lodC = 1.0 / (1.0 + dist * 0.0035);

        vec2 q = vWorldPos.xz * 0.55 * lodF;
        float e = 0.35;
        vec2 f1 = vec2(0.30, 0.5) * uTime;
        vec2 f2 = vec2(-0.42, 0.22) * uTime;
        float h0 = vnoise(q + f1) + 0.5 * vnoise(q * 2.7 + f2);
        float hx = vnoise(q + vec2(e, 0.0) + f1) + 0.5 * vnoise((q + vec2(e, 0.0)) * 2.7 + f2);
        float hz = vnoise(q + vec2(0.0, e) + f1) + 0.5 * vnoise((q + vec2(0.0, e)) * 2.7 + f2);

        vec2 qc = vWorldPos.xz * 0.045 * lodC;  // 特征尺度 ≈ 22 单位
        float ec = 2.2;
        vec2 fc = vec2(0.9, -0.6) * uTime;
        float c0 = vnoise(qc + fc) + 0.45 * vnoise(qc * 2.3 - fc);
        float cx = vnoise(qc + vec2(ec, 0.0) + fc) + 0.45 * vnoise((qc + vec2(ec, 0.0)) * 2.3 - fc);
        float cz = vnoise(qc + vec2(0.0, ec) + fc) + 0.45 * vnoise((qc + vec2(0.0, ec)) * 2.3 - fc);

        N = normalize(N
          + vec3(h0 - hx, 0.0, h0 - hz) * 0.85
          + vec3(c0 - cx, 0.0, c0 - cz) * 0.90);

        vec3 V = normalize(cameraPosition - vWorldPos);
        float ndv = max(dot(N, V), 0.0);
        /* Schlick 菲涅尔，F0 = 0.02 是水的物理值：
           掠射看过去几乎全反射（看见的是天），垂直俯视才看得见水体本色。
           这一步就是过去"海面不像水"的根因 —— 原先根本没有反射项。 */
        float fres = 0.02 + 0.98 * pow(clamp(1.0 - ndv, 0.0, 1.0), 5.0);
        vec3 R = reflect(-V, N);
        R.y = abs(R.y) + 0.02;   // 细节扰动可能把反射压到地平线以下，抬回来免出黑斑
        R = normalize(R);
        vec3 refl = skyColor(R);

        /* 水体本色：用「离岸距离」做近岸浅、远海深 —— 这份依据是改成带状水面
           之后才拿得到的（原先是块偏置平面，无从判断深浅，只能拿菲涅尔硬凑）。
           浪尖透光（SSS）另加，逆着阳光看波峰会透亮。 */
        float sunDot = max(dot(N, uSunDir), 0.0);
        /* 渐变跨度原来写的是 +420，而整条可见海面也就 40~400：结果全区都还停在
           浅海青，海像游泳池。收到 +150 —— 近岸十几米的透亮浅滩，200 开外就是
           深海蓝，色彩层次一下就出来了。 */
        float depthF = smoothstep(0.0, 150.0, vDepth);
        vec3 water = mix(uShallow, uDeep, depthF) * (0.78 + 0.30 * sunDot);
        float sss = pow(max(dot(V, -uSunDir), 0.0), 3.0) * clamp(vHeight + 0.35, 0.0, 1.2);
        water += uShallow * uSunColor * sss * 0.16;  // 浪尖透光别太绿，0.28 会把整片海染上绿味

        vec3 col = mix(water, refl, fres);

        /* 海面上的太阳：尖锐笔芯 + 宽散光晕双瓣，才有阳光洒在海面那条光路 */
        float rs = max(dot(R, uSunDir), 0.0);
        col += uSunColor * (pow(rs, 420.0) * 8.0 + pow(rs, 60.0) * 0.45) * uSunStrength * 0.5;

        /* 泡沫分两类：
           ① 浪尖——按浪高出现，用噪声打碎避免规则感
           ② 岸边碎浪——只在近岸带出现并随时间涌动，形成拍岸的白浪线。
              地形高于水面的地方水面本来就不可见，所以这条白带只会画在
              真正的水线上，不会糊到岸上去。 */
        // 泡沫的噪声同样按距离降频：原来 4.0 那一层特征尺度只有 0.25 单位，
        // 几十米外就是亚像素级的噪声，会直接在浪花里叠出一层摩尔纹
        float lodN = 1.0 / (1.0 + dist * 0.006);
        float fn = vnoise(vWorldPos.xz * 0.9 * lodN + uTime * 0.4) * 0.65
                 + vnoise(vWorldPos.xz * 2.6 * lodN - uTime * 0.3) * 0.35;
        // 浪尖泡沫同样随距离淡出：远环的 vHeight 是被欠采样的，留着就会在海上
        // 画出一圈圈的白色条纹（环状 moiré），比没有泡沫难看得多。
        /* 阈值必须高：0.55 起跳意味着约 20% 的水面都在出泡沫，而泡沫色是米黄、
           混进蓝水就是一层绿莹莹的网状纹 —— 那正是"海面发绿"的真凶（不是反射、
           不是浅海色）。真实海面只有破碎浪才起白沫，0.80 起跳才稀疏得像样。
           steep 同理：2.6 的斜率系数会让轻微起伏也起沫，收到 9.0 并加 0.45 死区。 */
        float crest = smoothstep(0.80, 1.05, vHeight + fn * 0.22)
                    * (1.0 - smoothstep(120.0, 480.0, dist));
        float steep = clamp((1.0 - N.y) * 9.0 - 0.45, 0.0, 1.0)
                    * (1.0 - smoothstep(300.0, 900.0, dist));

        // 岸边碎浪：基准是「距水线的距离」，所以这条白带永远焊在真实水线上。
        float nearBand = 1.0 - smoothstep(0.0, 26.0, vDepth);
        float surge = 0.55
                    + 0.45 * sin(uTime * 0.7 + vDepth * 0.05
                              + vWorldPos.x * 0.012 + vWorldPos.z * 0.012);
        float shoreFoam = smoothstep(0.18, 0.72, nearBand * (0.5 + 0.5 * fn) * surge);

        // 岸边碎浪要"实"、浪尖泡沫要"虚"：前者是辨识海岸线的关键，后者只做点缀
        float foam = clamp(max(max(crest * 0.34, steep * 0.20), shoreFoam * 0.80), 0.0, 1.0);
        col = mix(col, uFoam, foam * 0.62);

        /* 远处融进天空本身（而不是一块平台雾色）→ 地平线无缝 */
        float fogF = 1.0 - exp(-pow(dist * uFogDensity, 1.35));
        vec3 fd = normalize(vWorldPos - cameraPosition);
        vec3 fogCol = skyColor(vec3(fd.x, max(fd.y * 0.02, 0.0) + 0.004, fd.z));
        col = mix(col, fogCol, clamp(fogF, 0.0, 1.0));

        gl_FragColor = vec4(col, 1.0);
      }`,
  });

  // 顶点已是世界坐标，网格只需平移到水面高度。原来写的是 level+4（一个没有
  // 来历的偏移），现在 level 本身就是绝对海平面，直接对齐，避免两处高度打架。
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = w.level;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  mesh.name = "ocean";
  return mesh;
}

/** 远山：带棱线的低多边形山体环（锥体顶点按方位角扰动出山脊），靠雾气融进地平线 */
function buildMountains(THREE, layout, rng) {
  const cfg = layout.mountain;
  const geo = new THREE.ConeGeometry(1, 1, 7, 2);
  geo.translate(0, 0.5, 0);
  // 方位角驱动的棱线扰动：不同实例旋转后各不相同，避免"每个都是标准圆锥"
  {
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i),
        y = p.getY(i),
        z = p.getZ(i);
      const a = Math.atan2(z, x);
      const ridge =
        1 +
        0.16 * Math.sin(a * 5 + 1.3) +
        0.1 * Math.sin(a * 9 + 4.1) +
        0.05 * Math.sin(y * 7.7 + x * 3.1);
      p.setX(i, x * ridge);
      p.setZ(i, z * ridge);
      // 山顶往下压一点、腰线随机鼓包，剪掉"针尖"感
      if (y > 0.9) p.setY(i, 0.92 + (y - 1) * 0.6);
    }
    geo.computeVertexNormals();
  }
  const mesh = new THREE.InstancedMesh(
    geo,
    new THREE.MeshStandardMaterial({
      flatShading: true,
      roughness: 1,
      metalness: 0,
    }),
    cfg.count,
  );
  const m = new THREE.Matrix4(),
    q = new THREE.Quaternion();
  const pos = new THREE.Vector3(),
    scl = new THREE.Vector3();
  const col = new THREE.Color();
  const axis = new THREE.Vector3(0, 1, 0);
  /* 山脚高度：有海的赛道必须把山脚埋到水面以下，否则山体会悬在水上（远处一眼假）。
     这些山位于 r≈720~960 的环上，在有海的赛道里全在环线外侧 —— 即整圈都在海里，
     于是它们天然成了「对岸的群岛 / 远岸山影」，雾一罩就很像真实的海岸远景。 */
  for (let i = 0; i < cfg.count; i++) {
    const a = (2 * Math.PI * i) / cfg.count + rng() * 0.06;
    const r = 720 + rng() * 240;
    pos.set(
      Math.cos(a) * r,
      layout.water ? layout.water.level - 22 + rng() * 12 : -18 + rng() * 26,
      Math.sin(a) * r,
    );
    q.setFromAxisAngle(axis, rng() * Math.PI);
    scl.set(120 + rng() * 160, 70 + rng() * 130, 120 + rng() * 160); // 更矮胖
    m.compose(pos, q, scl);
    mesh.setMatrixAt(i, m);
    col.setHSL(
      cfg.hue + rng() * 0.06,
      cfg.sat + rng() * 0.12,
      cfg.light + rng() * 0.12,
    );
    mesh.setColorAt(i, col);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.userData.baseCount = cfg.count;
  return mesh;
}

/** 程序化建筑立面：墙面 + 玻璃窗格（diffuse），部分亮窗（emissive）+ 粗糙度贴图。
 *  粗糙度贴图让玻璃窗低粗糙（反光）、墙体高粗糙（哑光），配合环境贴图夜景楼群玻璃会反光。 */
function makeBuildingTextures(THREE) {
  const W = 128,
    H = 256,
    COLS = 6,
    ROWS = 14;
  const cd = document.createElement("canvas");
  cd.width = W;
  cd.height = H;
  const ce = document.createElement("canvas");
  ce.width = W;
  ce.height = H;
  const cr = document.createElement("canvas");
  cr.width = W;
  cr.height = H;
  const dd = cd.getContext("2d"),
    de = ce.getContext("2d"),
    dr = cr.getContext("2d");
  dd.fillStyle = "#d8d8dc";
  dd.fillRect(0, 0, W, H); // 白墙基色，实例色再乘
  de.fillStyle = "#000";
  de.fillRect(0, 0, W, H);
  dr.fillStyle = "#d8d8d8";
  dr.fillRect(0, 0, W, H); // 墙体：高粗糙（哑光）
  const cw = W / COLS,
    rh = H / ROWS;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const x = c * cw + cw * 0.22,
        y = r * rh + rh * 0.24;
      const w = cw * 0.56,
        h = rh * 0.5;
      // 玻璃：偏蓝灰，带随机明暗模拟反光
      const g = 118 + Math.floor(Math.sin(r * 7.3 + c * 11.1) * 26);
      dd.fillStyle = `rgb(${g - 30},${g},${g + 18})`;
      dd.fillRect(x, y, w, h);
      dr.fillStyle = "#2a2a30";
      dr.fillRect(x, y, w, h); // 玻璃：低粗糙（反光）
      if (Math.sin(r * 13.7 + c * 5.9) > 0.62) {
        // ~1/4 窗亮灯
        de.fillStyle = Math.sin(r * 3.1 + c) > 0 ? "#ffd9a0" : "#ffb46a";
        de.fillRect(x, y, w, h);
      }
    }
  }
  const map = new THREE.CanvasTexture(cd);
  map.colorSpace = THREE.SRGBColorSpace;
  const lit = new THREE.CanvasTexture(ce);
  const rough = new THREE.CanvasTexture(cr); // 数据贴图，保持线性
  return [map, lit, rough];
}

/** 程序化环境贴图（IBL）：画一张 equirectangular 天空渐变 + 地面 + 太阳光斑，
 *  经 PMREMGenerator 预滤波后作为 scene.environment，让所有 PBR 材质获得真实反射。
 *  零外链贴图、零 HDR 文件，一次生成随赛道色板变化。 */
function makeEnvironment(THREE, renderer, layout) {
  const W = 256,
    H = 128;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d");
  const skyTop = new THREE.Color(layout.sky.top);
  const skyMid = new THREE.Color(layout.sky.mid);
  const skyBot = new THREE.Color(layout.sky.bot);
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "#" + skyTop.getHexString());
  grad.addColorStop(0.55, "#" + skyMid.getHexString());
  grad.addColorStop(1, "#" + skyBot.getHexString());
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  // 地面（下 1/4）：用半球地面色模拟地面对光的反弹
  ctx.fillStyle = "#" + new THREE.Color(layout.hemi.ground).getHexString();
  ctx.fillRect(0, H * 0.74, W, H * 0.26);
  // 太阳光斑：把太阳方向投影到球面，形成高光反射源
  const sunDir = new THREE.Vector3(...layout.sun.dir).normalize();
  const u = 0.5 + Math.atan2(sunDir.x, sunDir.z) / (2 * Math.PI);
  const v = 0.5 - Math.asin(clamp(sunDir.y, -1, 1)) / Math.PI;
  const sx = u * W,
    sy = v * H;
  // 太阳光斑：颜色取自色板的 sun.color，强度按 sun.intensity 归一。
  // 原先这里硬编码成暖白 rgba(255,246,220)，导致夜之城/雪山的环境反射颜色不对。
  const sunCol = new THREE.Color(layout.sun.color);
  const to255 = (v) => Math.round(clamp(v, 0, 1) * 255);
  const sr = to255(sunCol.r),
    sg = to255(sunCol.g),
    sb = to255(sunCol.b);
  const k = clamp(layout.sun.intensity / 3, 0.35, 1);
  const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, W * 0.2);
  glow.addColorStop(0, `rgba(255,255,255,${k.toFixed(3)})`);
  glow.addColorStop(0.12, `rgba(${sr},${sg},${sb},${(0.55 * k).toFixed(3)})`);
  glow.addColorStop(0.45, `rgba(${sr},${sg},${sb},${(0.14 * k).toFixed(3)})`);
  glow.addColorStop(1, `rgba(${sr},${sg},${sb},0)`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  const tex = new THREE.CanvasTexture(cv);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(tex);
  tex.dispose();
  pmrem.dispose();
  return env.texture;
}

/** 植被与建筑：沿赛道法向带状生成 + 回头校验净距（大平面随机撒点命中率太低） */
function buildScatter(THREE, track, layout, rng, coastSign) {
  const group = new THREE.Group();
  const need = CFG.HALF_W + CFG.SHOULDER + 7.5;
  const n = track.n;
  const coastSide = coastSign ?? layout.coastSide ?? 0;

  const trees = [];
  let guard = 0;
  while (trees.length < layout.tree.count && guard++ < layout.tree.count * 7) {
    const i = Math.floor(rng() * n);
    const sgn = rng() > 0.5 ? 1 : -1;
    const lat = (need + rng() * 62) * sgn;
    const x = track.cx[i] + track.sx[i] * lat;
    const z = track.cz[i] + track.sz[i] * lat;
    if (coastSide !== 0) {
      const side =
        (x - track.cx[i]) * track.sx[i] + (z - track.cz[i]) * track.sz[i];
      if (side * coastSide > 0) continue;
    }
    if (track.nearestBrute(x, z, 4).dist < need) continue; // 可能贴近另一条分支
    trees.push({ x, z, y: terrainHeight(track, x, z) });
  }

  const builds = [];
  guard = 0;
  const bSpan =
    Math.max(
      track.bounds.maxX - track.bounds.minX,
      track.bounds.maxZ - track.bounds.minZ,
    ) + 700;
  while (
    builds.length < layout.building.count &&
    guard++ < layout.building.count * 25
  ) {
    const x = (rng() - 0.5) * bSpan,
      z = (rng() - 0.5) * bSpan;
    if (coastSide !== 0) {
      const near = track.nearestBrute(x, z, 6);
      const side =
        (x - track.cx[near.index]) * track.sx[near.index] +
        (z - track.cz[near.index]) * track.sz[near.index];
      if (side * coastSide > 0) continue;
    }
    if (track.nearestBrute(x, z, 6).dist < need + 26) continue;
    builds.push({ x, z });
  }

  /* --- 树：针阔混交 —— 阔叶=干+扰动的团状冠，针叶=三层收分锥（比例参考真松） --- */
  const tCfg = layout.tree;
  const trunkGeo = new THREE.CylinderGeometry(0.13, 0.24, 2.0, 5);
  trunkGeo.translate(0, 1.0, 0);
  const coneGeo = new THREE.ConeGeometry(1, 1, 7);
  coneGeo.translate(0, 0.5, 0);
  const blobGeo = new THREE.IcosahedronGeometry(1, 1);
  blobGeo.translate(0, 0.5, 0);
  {
    // 团冠顶点各向扰动：圆滚滚的树冠而不是标准球/锥
    const p = blobGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i),
        y = p.getY(i),
        z = p.getZ(i);
      const j =
        1 +
        0.22 * Math.sin(x * 4.9 + 1.7) * Math.sin(z * 3.8 + 0.6) +
        0.14 * Math.sin(y * 6.3 + x * 2.2);
      p.setXYZ(i, x * j, y * j * 0.82, z * j); // 略压扁更像树冠
    }
    blobGeo.computeVertexNormals();
  }
  const trunkMesh = new THREE.InstancedMesh(
    trunkGeo,
    new THREE.MeshStandardMaterial({
      color: 0x5a4634,
      roughness: 0.9,
      metalness: 0,
    }),
    trees.length,
  );
  const coneMesh = new THREE.InstancedMesh(
    coneGeo,
    new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0 }),
    trees.length * 3,
  );
  const blobMesh = new THREE.InstancedMesh(
    blobGeo,
    new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 }),
    trees.length * 3,
  );
  const m = new THREE.Matrix4(),
    q = new THREE.Quaternion();
  const pos = new THREE.Vector3(),
    scl = new THREE.Vector3(),
    col = new THREE.Color();
  const axis = new THREE.Vector3(0, 1, 0);
  const [sMin, sMax] = tCfg.size;
  let ci = 0,
    bi = 0;
  const put = (mesh, idx, x, y, z, sx, sy, sz, hueJ) => {
    q.setFromAxisAngle(axis, hueJ);
    pos.set(x, y, z);
    scl.set(sx, sy, sz);
    m.compose(pos, q, scl);
    mesh.setMatrixAt(idx, m);
  };
  trees.forEach((t, i) => {
    const sc = sMin + rng() * (sMax - sMin);
    const rot = rng() * Math.PI * 2;
    const conifer = rng() < 0.5;
    if (conifer) {
      put(trunkMesh, i, t.x, t.y, t.z, sc, sc * 0.9, sc, rot);
      for (let l = 0; l < 3; l++) {
        const rr = [1.55, 1.12, 0.72][l];
        const hh = [2.6, 2.3, 1.9][l];
        const yy = t.y + [1.0, 2.3, 3.5][l] * sc;
        put(
          coneMesh,
          ci,
          t.x,
          yy,
          t.z,
          rr * sc,
          hh * sc,
          rr * sc,
          rot + l * 0.5,
        );
        col.setHSL(
          tCfg.hue + rng() * 0.06,
          tCfg.sat + rng() * 0.16,
          tCfg.light + rng() * 0.1 + l * 0.035,
        ); // 上层更亮，模拟受光
        coneMesh.setColorAt(ci, col);
        ci++;
      }
    } else {
      put(trunkMesh, i, t.x, t.y, t.z, sc * 0.9, sc * 1.35, sc * 0.9, rot); // 阔叶树干更高
      const nb = 2 + (rng() > 0.45 ? 1 : 0);
      for (let b = 0; b < nb; b++) {
        const br = (b === 0 ? 1.9 : 1.15 + rng() * 0.5) * sc;
        const bx = t.x + (b === 0 ? 0 : (rng() - 0.5) * 2.2 * sc);
        const bz = t.z + (b === 0 ? 0 : (rng() - 0.5) * 2.2 * sc);
        const by = t.y + (b === 0 ? 2.75 : 2.4 + rng() * 1.3) * sc;
        put(
          blobMesh,
          bi,
          bx,
          by,
          bz,
          br,
          br * (0.8 + rng() * 0.25),
          br,
          rng() * Math.PI * 2,
        );
        col.setHSL(
          tCfg.hue + rng() * 0.08,
          tCfg.sat + rng() * 0.18,
          tCfg.light + rng() * 0.13 + (b === 0 ? 0.04 : 0),
        );
        blobMesh.setColorAt(bi, col);
        bi++;
      }
    }
  });
  coneMesh.count = ci;
  blobMesh.count = bi;
  trunkMesh.instanceMatrix.needsUpdate = true;
  coneMesh.instanceMatrix.needsUpdate = true;
  blobMesh.instanceMatrix.needsUpdate = true;
  if (coneMesh.instanceColor) coneMesh.instanceColor.needsUpdate = true;
  if (blobMesh.instanceColor) blobMesh.instanceColor.needsUpdate = true;
  trunkMesh.castShadow = coneMesh.castShadow = blobMesh.castShadow = true;
  group.add(trunkMesh, coneMesh, blobMesh);

  /* --- 建筑：窗格 Canvas 纹理 + 屋顶材质，底面加宽、矮层为主，摆脱"细尖柱" --- */
  const bCfg = layout.building;
  const bGeo = new THREE.BoxGeometry(1, 1, 1);
  bGeo.translate(0, 0.5, 0);
  const [wallTex, litTex, roughTex] = makeBuildingTextures(THREE);
  const wallMat = new THREE.MeshStandardMaterial({
    map: wallTex,
    roughnessMap: roughTex,
    roughness: 0.85,
    metalness: 0.15,
    emissive: 0xffffff,
    emissiveMap: litTex,
    emissiveIntensity: 0.85,
  });
  const roofMat = new THREE.MeshStandardMaterial({
    color: 0x3c4048,
    roughness: 0.9,
    metalness: 0.05,
  });
  // BoxGeometry 材质组顺序：+x, -x, +y(顶), -y(底), +z, -z
  const bMesh = new THREE.InstancedMesh(
    bGeo,
    [wallMat, wallMat, roofMat, roofMat, wallMat, wallMat],
    builds.length * 4,
  );
  bi = 0;
  for (const b of builds) {
    for (let c = 0; c < 4; c++) {
      const ox = b.x + (rng() - 0.5) * 34,
        oz = b.z + (rng() - 0.5) * 34;
      q.setFromAxisAngle(axis, Math.round(rng() * 4) * (Math.PI / 2));
      pos.set(ox, terrainHeight(track, ox, oz) - 1.0, oz);
      const fp = 11 + rng() * 12; // 底面 11~23，不再是细柱
      const tall = rng() < 0.72 ? 7 + rng() * 9 : 16 + rng() * bCfg.tall; // 矮层为主
      scl.set(fp, tall, fp * (0.75 + rng() * 0.5));
      m.compose(pos, q, scl);
      bMesh.setMatrixAt(bi, m);
      const warm = rng() > 0.45;
      col.setHSL(
        warm ? bCfg.hueWarm : bCfg.hueCool,
        warm ? 0.22 : 0.06,
        0.5 + rng() * 0.22,
      );
      bMesh.setColorAt(bi, col); // 实例色乘在白墙基色上做外立面色调
      bi++;
    }
  }
  bMesh.count = bi;
  bMesh.instanceMatrix.needsUpdate = true;
  if (bMesh.instanceColor) bMesh.instanceColor.needsUpdate = true;
  bMesh.castShadow = true;
  group.add(bMesh);

  // 画质自适应：记录每个 InstancedMesh 的满编实例数，setDetail() 只是缩放 .count
  group.userData.detailMeshes = [trunkMesh, coneMesh, blobMesh, bMesh];
  group.userData.baseCounts = [
    trunkMesh.count,
    coneMesh.count,
    blobMesh.count,
    bMesh.count,
  ];

  return group;
}

/**
 * 构建整个世界的可视部分（不含车辆）。
 * 返回的对象里 sun/hemi 已加入场景，换赛道时整体 dispose 后重建。
 */
export function buildWorld(THREE, scene, track, renderer) {
  const layout = track.layout;
  const rng = makeRng(CFG.SEED + track.layout.polar.base * 7);
  const group = new THREE.Group();
  const created = [];

  /* --- 光照 --- */
  const sun = new THREE.DirectionalLight(
    layout.sun.color,
    layout.sun.intensity,
  );
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 280;
  sun.shadow.camera.left = -54;
  sun.shadow.camera.right = 54;
  sun.shadow.camera.top = 54;
  sun.shadow.camera.bottom = -54;
  sun.shadow.bias = -0.0012;
  sun.shadow.normalBias = 0.035;
  // 正交阴影相机改过边界必须手动刷投影矩阵，否则改动不生效
  sun.shadow.camera.updateProjectionMatrix();
  group.add(sun, sun.target);
  created.push(sun);

  const hemi = new THREE.HemisphereLight(
    layout.hemi.sky,
    layout.hemi.ground,
    layout.hemi.intensity,
  );
  const amb = new THREE.AmbientLight(
    layout.ambient.color,
    layout.ambient.intensity,
  );
  group.add(hemi, amb);
  created.push(hemi, amb);

  /* --- 天空 / 雾 ---
     skyUniforms 里每个 uniform 都是独立对象引用：天空球直接持有它，海面则用
     Object.assign 浅拷贝后仍指向同一批对象 —— 所以两者永远同步，换赛道亦然。
     scene.fog 只留给 PBR 物体（地形/建筑）做远距离衰减；海面不用它，
     而是自行融进 skyColor()，这样水天线才不会断成一条色带。 */
  const skyUniforms = makeSkyUniforms(THREE, layout);
  const sky = buildSkyMesh(THREE, skyUniforms);
  group.add(sky);
  created.push(sky);
  scene.fog = new THREE.Fog(layout.fog.color, layout.fog.near, layout.fog.far);

  /* --- 环境贴图（IBL）：PBR 反射的光源来源，随赛道色板重建 --- */
  scene.environment = makeEnvironment(THREE, renderer, layout);
  scene.environmentIntensity = 0.5;
  if (typeof window !== "undefined") window.__DR_SCENE__ = scene; // 验收/调试钩子

  /* --- 地形 / 远山 / 植被 / 海面（仅海岸类赛道） ---
     海岸统一取环线「外侧」：内侧是内场，最多几百单位就到对向路段，水铺不开、
     也出不来海平线。coastSide 退化为「外/内」的语义开关（1=外，-1=内），
     真正的朝向由 outwardSign() 从几何算出，绕向怎么改都不会翻车。 */
  const coastSign = layout.coastSide ? outwardSign(track) * Math.sign(layout.coastSide) : 0;
  const terrain = buildTerrain(THREE, track, layout, coastSign);
  const mountains = buildMountains(THREE, layout, rng);
  const scatter = buildScatter(THREE, track, layout, rng, coastSign);
  const ocean = layout.water
    ? buildOcean(THREE, track, layout, skyUniforms, coastSign)
    : null;
  group.add(terrain, mountains, scatter);
  if (ocean) group.add(ocean);

  scene.add(group);

  /** 画质自适应：level∈[0,1] 缩放远景实例数量（树/建筑/远山），不影响赛道本身 */
  function setDetail(factor) {
    factor = clamp(factor, 0.25, 1);
    if (mountains.userData.baseCount) {
      mountains.count = Math.max(
        1,
        Math.round(mountains.userData.baseCount * factor),
      );
    }
    const meshes = scatter.userData.detailMeshes,
      bases = scatter.userData.baseCounts;
    if (meshes)
      meshes.forEach((m, i) => {
        m.count = Math.max(0, Math.round(bases[i] * factor));
      });
  }

  return {
    group,
    sky,
    sun,
    terrain,
    mountains,
    scatter,
    ocean,
    setDetail,
    sunDir: new THREE.Vector3(...layout.sun.dir).normalize(),
    dispose() {
      scene.remove(group);
      group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        const mats = Array.isArray(o.material)
          ? o.material
          : o.material
            ? [o.material]
            : [];
        for (const mat of mats) {
          if (mat.map) mat.map.dispose();
          if (mat.emissiveMap) mat.emissiveMap.dispose();
          if (mat.roughnessMap) mat.roughnessMap.dispose();
          mat.dispose();
        }
      });
      scene.fog = null;
      if (scene.environment) {
        scene.environment.dispose();
        scene.environment = null;
      }
    },
  };
}
