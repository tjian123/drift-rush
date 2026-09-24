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

/** 地形：顶点色 + flatShading，贴赛道起伏 */
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
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
    vertexColors: true, flatShading: true,
  }));
  mesh.receiveShadow = true;
  return mesh;
}

/** 远山：低多边形锥体环，靠雾气融进地平线 */
function buildMountains(THREE, layout, rng) {
  const cfg = layout.mountain;
  const geo = new THREE.ConeGeometry(1, 1, 5, 1);
  geo.translate(0, 0.5, 0);
  const mesh = new THREE.InstancedMesh(
    geo, new THREE.MeshLambertMaterial({ flatShading: true }), cfg.count
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
    scl.set(95 + rng() * 140, 95 + rng() * 210, 95 + rng() * 140);
    m.compose(pos, q, scl);
    mesh.setMatrixAt(i, m);
    col.setHSL(cfg.hue + rng() * 0.06, cfg.sat + rng() * 0.12, cfg.light + rng() * 0.12);
    mesh.setColorAt(i, col);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
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

  /* --- 树：树干 + 双层树冠 --- */
  const tCfg = layout.tree;
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.24, 2.0, 5);
  trunkGeo.translate(0, 1.0, 0);
  const leafGeo = new THREE.ConeGeometry(1, 1, 6);
  leafGeo.translate(0, 0.5, 0);
  const trunkMesh = new THREE.InstancedMesh(trunkGeo,
    new THREE.MeshLambertMaterial({ color: 0x5a4634, flatShading: true }), trees.length);
  const leafMesh = new THREE.InstancedMesh(leafGeo,
    new THREE.MeshLambertMaterial({ flatShading: true }), trees.length * 2);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion();
  const pos = new THREE.Vector3(), scl = new THREE.Vector3(), col = new THREE.Color();
  const axis = new THREE.Vector3(0, 1, 0);
  const [sMin, sMax] = tCfg.size;
  let li = 0;
  trees.forEach((t, i) => {
    const sc = sMin + rng() * (sMax - sMin);
    q.setFromAxisAngle(axis, rng() * Math.PI * 2);
    pos.set(t.x, t.y, t.z); scl.set(sc, sc, sc);
    m.compose(pos, q, scl);
    trunkMesh.setMatrixAt(i, m);
    for (let layer = 0; layer < 2; layer++) {
      const ls = sc * (1 - layer * 0.34);
      pos.set(t.x, t.y + 1.55 * sc + layer * 1.5 * sc, t.z);
      scl.set(1.7 * ls, (4.2 - layer * 1.2) * sc, 1.7 * ls);
      m.compose(pos, q, scl);
      leafMesh.setMatrixAt(li, m);
      col.setHSL(tCfg.hue + rng() * 0.08, tCfg.sat + rng() * 0.18, tCfg.light + rng() * 0.13);
      leafMesh.setColorAt(li, col);
      li++;
    }
  });
  leafMesh.count = li;
  trunkMesh.instanceMatrix.needsUpdate = true;
  leafMesh.instanceMatrix.needsUpdate = true;
  if (leafMesh.instanceColor) leafMesh.instanceColor.needsUpdate = true;
  trunkMesh.castShadow = leafMesh.castShadow = true;
  group.add(trunkMesh, leafMesh);

  /* --- 建筑：成簇低多边形盒子，夜景有窗光 --- */
  const bCfg = layout.building;
  const bGeo = new THREE.BoxGeometry(1, 1, 1);
  bGeo.translate(0, 0.5, 0);
  const bMesh = new THREE.InstancedMesh(bGeo, new THREE.MeshLambertMaterial({
    flatShading: true, emissive: bCfg.emissive, emissiveIntensity: 1,
  }), builds.length * 4);
  let bi = 0;
  for (const b of builds) {
    for (let c = 0; c < 4; c++) {
      const ox = b.x + (rng() - 0.5) * 30, oz = b.z + (rng() - 0.5) * 30;
      q.setFromAxisAngle(axis, Math.round(rng() * 4) * (Math.PI / 2));
      pos.set(ox, terrainHeight(track, ox, oz) - 1.0, oz);
      scl.set(6 + rng() * 10, 9 + rng() * bCfg.tall, 6 + rng() * 10);
      m.compose(pos, q, scl);
      bMesh.setMatrixAt(bi, m);
      const warm = rng() > 0.45;
      col.setHSL(warm ? bCfg.hueWarm : bCfg.hueCool, warm ? 0.30 : 0.10, 0.26 + rng() * 0.16);
      bMesh.setColorAt(bi, col);
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
        if (o.material) {
          if (o.material.map) o.material.map.dispose();
          o.material.dispose();
        }
      });
      scene.fog = null;
    },
  };
}
