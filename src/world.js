/* ===========================================================================
 * world.js — 天空 / 光照 / 地形 / 植被 / 建筑 / 远山
 * 全部按赛道色板程序化生成；换赛道时整体重建。
 * =========================================================================*/

import { CFG } from './config.js';
import { terrainHeight } from './track.js';
import { makeRng, smoothstep, clamp, hexToRgb } from './util.js';

/** 天空：单球体渐变 shader + 日轮与霞光，零贴图 */
function buildSky(THREE, layout) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      uTop: { value: new THREE.Color(layout.sky.top) },
      uMid: { value: new THREE.Color(layout.sky.mid) },
      uBot: { value: new THREE.Color(layout.sky.bot) },
      uSun: { value: new THREE.Vector3(...layout.sun.dir).normalize() },
      uSunStrength: { value: layout.sun.intensity > 2 ? 3.2 : 1.6 },
    },
    vertexShader: `varying vec3 vDir;
      void main(){ vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      varying vec3 vDir;
      uniform vec3 uTop,uMid,uBot,uSun;
      uniform float uSunStrength;
      void main(){
        float h = clamp(vDir.y*0.5+0.5, 0.0, 1.0);
        vec3 col = mix(uBot, uMid, smoothstep(0.42,0.60,h));
        col = mix(col, uTop, smoothstep(0.58,0.92,h));
        float sd = max(dot(normalize(vDir), normalize(uSun)), 0.0);
        col += vec3(1.0,0.72,0.42) * pow(sd, 240.0) * uSunStrength;
        col += vec3(1.0,0.55,0.28) * pow(sd, 14.0) * 0.42;
        col += vec3(1.0,0.45,0.30) * pow(sd, 3.0) * 0.08;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(1800, 36, 20), mat);
}

/** 地形：顶点色 + PBR 平滑着色，贴赛道起伏（地面是大面积视觉主体，平滑+微粗糙最出质感） */
function buildTerrain(THREE, track, layout) {
  // 尺寸随赛道包围盒缩放，保证能盖住整条赛道
  const b = track.bounds;
  const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
  const SIZE = Math.round((span * 2.6 + 600) / 4) * 4;
  const SEG = 104;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  const colors = new Float32Array(p.count * 3);
  const g = layout.ground;
  const cA = new THREE.Color(g.grass), cB = new THREE.Color(g.dry);
  const cC = new THREE.Color(g.rock), cD = new THREE.Color(g.sand);
  const tmp = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    const h = terrainHeight(track, x, z);
    p.setY(i, h);
    tmp.copy(cB).lerp(cA, clamp(g.mix + 0.4 * Math.sin(x * 0.011 + z * 0.009), 0, 1));
    tmp.lerp(cC, smoothstep(6, 14, h) * 0.55);
    tmp.lerp(cD, smoothstep(0.4, 0.9, Math.abs(Math.sin(x * 0.004) * Math.cos(z * 0.0037))) * 0.25);
    tmp.multiplyScalar(0.82 + 0.36 * clamp((h + 6) / 20, 0, 1));
    colors[i * 3] = tmp.r; colors[i * 3 + 1] = tmp.g; colors[i * 3 + 2] = tmp.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.95, metalness: 0.02,
  }));
  mesh.receiveShadow = true;
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
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const a = Math.atan2(z, x);
      const ridge = 1 + 0.16 * Math.sin(a * 5 + 1.3) + 0.10 * Math.sin(a * 9 + 4.1)
        + 0.05 * Math.sin(y * 7.7 + x * 3.1);
      p.setX(i, x * ridge);
      p.setZ(i, z * ridge);
      // 山顶往下压一点、腰线随机鼓包，剪掉"针尖"感
      if (y > 0.9) p.setY(i, 0.92 + (y - 1) * 0.6);
    }
    geo.computeVertexNormals();
  }
  const mesh = new THREE.InstancedMesh(
    geo, new THREE.MeshStandardMaterial({ flatShading: true, roughness: 1, metalness: 0 }), cfg.count
  );
  const m = new THREE.Matrix4(), q = new THREE.Quaternion();
  const pos = new THREE.Vector3(), scl = new THREE.Vector3();
  const col = new THREE.Color();
  const axis = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < cfg.count; i++) {
    const a = (2 * Math.PI * i) / cfg.count + rng() * 0.06;
    const r = 720 + rng() * 240;
    pos.set(Math.cos(a) * r, -18 + rng() * 26, Math.sin(a) * r);
    q.setFromAxisAngle(axis, rng() * Math.PI);
    scl.set(120 + rng() * 160, 70 + rng() * 130, 120 + rng() * 160);  // 更矮胖
    m.compose(pos, q, scl);
    mesh.setMatrixAt(i, m);
    col.setHSL(cfg.hue + rng() * 0.06, cfg.sat + rng() * 0.12, cfg.light + rng() * 0.12);
    mesh.setColorAt(i, col);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

/** 程序化建筑立面：墙面 + 玻璃窗格（diffuse），部分亮窗（emissive）+ 粗糙度贴图。
 *  粗糙度贴图让玻璃窗低粗糙（反光）、墙体高粗糙（哑光），配合环境贴图夜景楼群玻璃会反光。 */
function makeBuildingTextures(THREE) {
  const W = 128, H = 256, COLS = 6, ROWS = 14;
  const cd = document.createElement('canvas'); cd.width = W; cd.height = H;
  const ce = document.createElement('canvas'); ce.width = W; ce.height = H;
  const cr = document.createElement('canvas'); cr.width = W; cr.height = H;
  const dd = cd.getContext('2d'), de = ce.getContext('2d'), dr = cr.getContext('2d');
  dd.fillStyle = '#d8d8dc'; dd.fillRect(0, 0, W, H);   // 白墙基色，实例色再乘
  de.fillStyle = '#000'; de.fillRect(0, 0, W, H);
  dr.fillStyle = '#d8d8d8'; dr.fillRect(0, 0, W, H);   // 墙体：高粗糙（哑光）
  const cw = W / COLS, rh = H / ROWS;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const x = c * cw + cw * 0.22, y = r * rh + rh * 0.24;
      const w = cw * 0.56, h = rh * 0.5;
      // 玻璃：偏蓝灰，带随机明暗模拟反光
      const g = 118 + Math.floor(Math.sin(r * 7.3 + c * 11.1) * 26);
      dd.fillStyle = `rgb(${g - 30},${g},${g + 18})`;
      dd.fillRect(x, y, w, h);
      dr.fillStyle = '#2a2a30'; dr.fillRect(x, y, w, h);   // 玻璃：低粗糙（反光）
      if (Math.sin(r * 13.7 + c * 5.9) > 0.62) {        // ~1/4 窗亮灯
        de.fillStyle = Math.sin(r * 3.1 + c) > 0 ? '#ffd9a0' : '#ffb46a';
        de.fillRect(x, y, w, h);
      }
    }
  }
  const map = new THREE.CanvasTexture(cd);
  map.colorSpace = THREE.SRGBColorSpace;
  const lit = new THREE.CanvasTexture(ce);
  const rough = new THREE.CanvasTexture(cr);   // 数据贴图，保持线性
  return [map, lit, rough];
}

/** 程序化环境贴图（IBL）：画一张 equirectangular 天空渐变 + 地面 + 太阳光斑，
 *  经 PMREMGenerator 预滤波后作为 scene.environment，让所有 PBR 材质获得真实反射。
 *  零外链贴图、零 HDR 文件，一次生成随赛道色板变化。 */
function makeEnvironment(THREE, renderer, layout) {
  const W = 256, H = 128;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const skyTop = new THREE.Color(layout.sky.top);
  const skyMid = new THREE.Color(layout.sky.mid);
  const skyBot = new THREE.Color(layout.sky.bot);
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#' + skyTop.getHexString());
  grad.addColorStop(0.55, '#' + skyMid.getHexString());
  grad.addColorStop(1, '#' + skyBot.getHexString());
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  // 地面（下 1/4）：用半球地面色模拟地面对光的反弹
  ctx.fillStyle = '#' + new THREE.Color(layout.hemi.ground).getHexString();
  ctx.fillRect(0, H * 0.74, W, H * 0.26);
  // 太阳光斑：把太阳方向投影到球面，形成高光反射源
  const sunDir = new THREE.Vector3(...layout.sun.dir).normalize();
  const u = 0.5 + Math.atan2(sunDir.x, sunDir.z) / (2 * Math.PI);
  const v = 0.5 - Math.asin(clamp(sunDir.y, -1, 1)) / Math.PI;
  const sx = u * W, sy = v * H;
  const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, W * 0.2);
  glow.addColorStop(0, 'rgba(255,246,220,1)');
  glow.addColorStop(0.12, 'rgba(255,220,160,0.55)');
  glow.addColorStop(0.45, 'rgba(255,200,120,0.14)');
  glow.addColorStop(1, 'rgba(255,200,120,0)');
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
function buildScatter(THREE, track, layout, rng) {
  const group = new THREE.Group();
  const need = CFG.HALF_W + CFG.SHOULDER + 7.5;
  const n = track.n;

  const trees = [];
  let guard = 0;
  while (trees.length < layout.tree.count && guard++ < layout.tree.count * 7) {
    const i = Math.floor(rng() * n);
    const sgn = rng() > 0.5 ? 1 : -1;
    const lat = (need + rng() * 62) * sgn;
    const x = track.cx[i] + track.sx[i] * lat;
    const z = track.cz[i] + track.sz[i] * lat;
    if (track.nearestBrute(x, z, 4).dist < need) continue;  // 可能贴近另一条分支
    trees.push({ x, z, y: terrainHeight(track, x, z) });
  }

  const builds = [];
  guard = 0;
  const bSpan = Math.max(track.bounds.maxX - track.bounds.minX, track.bounds.maxZ - track.bounds.minZ) + 700;
  while (builds.length < layout.building.count && guard++ < layout.building.count * 25) {
    const x = (rng() - 0.5) * bSpan, z = (rng() - 0.5) * bSpan;
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
  { // 团冠顶点各向扰动：圆滚滚的树冠而不是标准球/锥
    const p = blobGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const j = 1 + 0.22 * Math.sin(x * 4.9 + 1.7) * Math.sin(z * 3.8 + 0.6)
        + 0.14 * Math.sin(y * 6.3 + x * 2.2);
      p.setXYZ(i, x * j, y * j * 0.82, z * j);   // 略压扁更像树冠
    }
    blobGeo.computeVertexNormals();
  }
  const trunkMesh = new THREE.InstancedMesh(trunkGeo,
    new THREE.MeshStandardMaterial({ color: 0x5a4634, roughness: 0.9, metalness: 0 }), trees.length);
  const coneMesh = new THREE.InstancedMesh(coneGeo,
    new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0 }), trees.length * 3);
  const blobMesh = new THREE.InstancedMesh(blobGeo,
    new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 }), trees.length * 3);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion();
  const pos = new THREE.Vector3(), scl = new THREE.Vector3(), col = new THREE.Color();
  const axis = new THREE.Vector3(0, 1, 0);
  const [sMin, sMax] = tCfg.size;
  let ci = 0, bi = 0;
  const put = (mesh, idx, x, y, z, sx, sy, sz, hueJ) => {
    q.setFromAxisAngle(axis, hueJ);
    pos.set(x, y, z); scl.set(sx, sy, sz);
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
        put(coneMesh, ci, t.x, yy, t.z, rr * sc, hh * sc, rr * sc, rot + l * 0.5);
        col.setHSL(tCfg.hue + rng() * 0.06, tCfg.sat + rng() * 0.16,
          tCfg.light + rng() * 0.10 + l * 0.035);   // 上层更亮，模拟受光
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
        put(blobMesh, bi, bx, by, bz, br, br * (0.8 + rng() * 0.25), br, rng() * Math.PI * 2);
        col.setHSL(tCfg.hue + rng() * 0.08, tCfg.sat + rng() * 0.18,
          tCfg.light + rng() * 0.13 + (b === 0 ? 0.04 : 0));
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
    map: wallTex, roughnessMap: roughTex, roughness: 0.85, metalness: 0.15,
    emissive: 0xffffff, emissiveMap: litTex, emissiveIntensity: 0.85,
  });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x3c4048, roughness: 0.9, metalness: 0.05 });
  // BoxGeometry 材质组顺序：+x, -x, +y(顶), -y(底), +z, -z
  const bMesh = new THREE.InstancedMesh(bGeo,
    [wallMat, wallMat, roofMat, roofMat, wallMat, wallMat], builds.length * 4);
  bi = 0;
  for (const b of builds) {
    for (let c = 0; c < 4; c++) {
      const ox = b.x + (rng() - 0.5) * 34, oz = b.z + (rng() - 0.5) * 34;
      q.setFromAxisAngle(axis, Math.round(rng() * 4) * (Math.PI / 2));
      pos.set(ox, terrainHeight(track, ox, oz) - 1.0, oz);
      const fp = 11 + rng() * 12;                              // 底面 11~23，不再是细柱
      const tall = rng() < 0.72 ? 7 + rng() * 9 : 16 + rng() * bCfg.tall;  // 矮层为主
      scl.set(fp, tall, fp * (0.75 + rng() * 0.5));
      m.compose(pos, q, scl);
      bMesh.setMatrixAt(bi, m);
      const warm = rng() > 0.45;
      col.setHSL(warm ? bCfg.hueWarm : bCfg.hueCool, warm ? 0.22 : 0.06, 0.5 + rng() * 0.22);
      bMesh.setColorAt(bi, col);   // 实例色乘在白墙基色上做外立面色调
      bi++;
    }
  }
  bMesh.count = bi;
  bMesh.instanceMatrix.needsUpdate = true;
  if (bMesh.instanceColor) bMesh.instanceColor.needsUpdate = true;
  bMesh.castShadow = true;
  group.add(bMesh);

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
  const sun = new THREE.DirectionalLight(layout.sun.color, layout.sun.intensity);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 280;
  sun.shadow.camera.left = -54; sun.shadow.camera.right = 54;
  sun.shadow.camera.top = 54; sun.shadow.camera.bottom = -54;
  sun.shadow.bias = -0.0012;
  sun.shadow.normalBias = 0.035;
  // 正交阴影相机改过边界必须手动刷投影矩阵，否则改动不生效
  sun.shadow.camera.updateProjectionMatrix();
  group.add(sun, sun.target);
  created.push(sun);

  const hemi = new THREE.HemisphereLight(layout.hemi.sky, layout.hemi.ground, layout.hemi.intensity);
  const amb = new THREE.AmbientLight(layout.ambient.color, layout.ambient.intensity);
  group.add(hemi, amb);
  created.push(hemi, amb);

  /* --- 天空 / 雾 --- */
  const sky = buildSky(THREE, layout);
  group.add(sky);
  created.push(sky);
  scene.fog = new THREE.Fog(layout.fog.color, layout.fog.near, layout.fog.far);

  /* --- 环境贴图（IBL）：PBR 反射的光源来源，随赛道色板重建 --- */
  scene.environment = makeEnvironment(THREE, renderer, layout);
  scene.environmentIntensity = 0.5;
  if (typeof window !== 'undefined') window.__DR_SCENE__ = scene;   // 验收/调试钩子

  /* --- 地形 / 远山 / 植被 --- */
  const terrain = buildTerrain(THREE, track, layout);
  const mountains = buildMountains(THREE, layout, rng);
  const scatter = buildScatter(THREE, track, layout, rng);
  group.add(terrain, mountains, scatter);

  scene.add(group);

  return {
    group, sky, sun, terrain, mountains, scatter,
    sunDir: new THREE.Vector3(...layout.sun.dir).normalize(),
    dispose() {
      scene.remove(group);
      group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
        for (const mat of mats) {
          if (mat.map) mat.map.dispose();
          if (mat.emissiveMap) mat.emissiveMap.dispose();
          if (mat.roughnessMap) mat.roughnessMap.dispose();
          mat.dispose();
        }
      });
      scene.fog = null;
      if (scene.environment) { scene.environment.dispose(); scene.environment = null; }
    },
  };
}
