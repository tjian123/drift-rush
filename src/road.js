/* ===========================================================================
 * road.js — 路面 / 路肩 / 护栏 / 起点线（程序化生成，零贴图文件）
 * =========================================================================*/

import { CFG } from './config.js';

/** 程序化沥青贴图：路肩 → 白边线 → 沥青颗粒 → 中央虚线 */
export function makeRoadTexture(THREE, renderer) {
  const W = 128, H = 256;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');

  g.fillStyle = '#2c2c33';
  g.fillRect(0, 0, W, H);
  // 沥青颗粒（固定种子，保证每次刷新纹理一致）
  let s = 7788;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < 5200; i++) {
    const v = 34 + Math.floor(rnd() * 44);
    g.fillStyle = `rgba(${v},${v},${v + 5},${0.35 + rnd() * 0.5})`;
    g.fillRect(Math.floor(rnd() * W), Math.floor(rnd() * H), 1, 1);
  }
  // 中央虚线：v 方向 0~45% 实线，其余留空（贴图 v 周期 = DASH_PERIOD）
  g.fillStyle = '#efe6c4';
  g.fillRect(Math.floor(W * 0.487), 0, Math.max(2, Math.floor(W * 0.026)), H * 0.45);
  // 两侧路肩
  g.fillStyle = '#6a6153';
  g.fillRect(0, 0, Math.floor(W * 0.045), H);
  g.fillRect(Math.floor(W * 0.955), 0, W, H);
  // 两侧白边线
  g.fillStyle = '#e9e9e0';
  g.fillRect(Math.floor(W * 0.055), 0, Math.max(2, Math.floor(W * 0.02)), H);
  g.fillRect(Math.floor(W * 0.925), 0, Math.max(2, Math.floor(W * 0.02)), H);

  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return tex;
}

/** 棋盘格起点线贴图 */
function makeCheckerTexture(THREE) {
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 32;
  const g = cv.getContext('2d');
  const C = 16;
  for (let y = 0; y < 32 / C; y++) {
    for (let x = 0; x < 128 / C; x++) {
      g.fillStyle = ((x + y) % 2) ? '#f2f2f2' : '#1a1c22';
      g.fillRect(x * C, y * C, C, C);
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * 构建整条赛道的静态几何：路面、护栏立柱、起点线。
 */
export function buildRoad(THREE, track, renderer) {
  const group = new THREE.Group();
  const n = track.n, HW = CFG.HALF_W, SH = CFG.SHOULDER;

  /* ---------- 路面（每个断面 4 顶点：路肩L / 路L / 路R / 路肩R） ---------- */
  const cols = 4;
  const pos = new Float32Array(n * cols * 3);
  const uv = new Float32Array(n * cols * 2);
  const idx = [];
  const uu = [0, 0.06, 0.94, 1];
  const off = [HW + SH, HW, -HW, -(HW + SH)];
  const dropY = [0.22, 0, 0, 0.22];
  for (let i = 0; i < n; i++) {
    const p = i * cols;
    const ox = track.cx[i], oy = track.cy[i], oz = track.cz[i];
    const sX = track.sx[i], sZ = track.sz[i];
    const v = track.dist[i] / CFG.DASH_PERIOD;
    for (let c = 0; c < cols; c++) {
      const k = (p + c) * 3;
      pos[k] = ox + sX * off[c];
      pos[k + 1] = oy - dropY[c];
      pos[k + 2] = oz + sZ * off[c];
      uv[(p + c) * 2] = uu[c];
      uv[(p + c) * 2 + 1] = v;
    }
    const j = (i + 1) % n;
    const a = p, b = j * cols;
    for (let c = 0; c < cols - 1; c++) {
      idx.push(a + c, b + c, a + c + 1);
      idx.push(a + c + 1, b + c, b + c + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const road = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    map: makeRoadTexture(THREE, renderer), roughness: 0.95, metalness: 0.0,
    side: THREE.DoubleSide,
  }));
  road.receiveShadow = true;
  road.renderOrder = 1;
  road.name = 'road';
  group.add(road);

  /* ---------- 护栏立柱：红白交替，InstancedMesh ---------- */
  const gap = 8;
  const postGeo = new THREE.BoxGeometry(0.22, 1.0, 0.22);
  postGeo.translate(0, 0.5, 0);
  const postMesh = new THREE.InstancedMesh(
    postGeo,
    new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.05 }),
    Math.floor(n / gap) * 2
  );
  const m = new THREE.Matrix4();
  const cRed = new THREE.Color(0xd94f4f), cWhite = new THREE.Color(0xe8e8e2);
  const railX = HW + SH - 0.3;
  let k = 0;
  for (let i = 0; i < n; i += gap) {
    for (const sgn of [1, -1]) {
      m.makeTranslation(
        track.cx[i] + track.sx[i] * railX * sgn,
        track.cy[i] - 0.75,
        track.cz[i] + track.sz[i] * railX * sgn
      );
      postMesh.setMatrixAt(k, m);
      postMesh.setColorAt(k, (k % 2 === 0) ? cRed : cWhite);
      k++;
    }
  }
  postMesh.count = k;
  postMesh.instanceMatrix.needsUpdate = true;
  if (postMesh.instanceColor) postMesh.instanceColor.needsUpdate = true;
  group.add(postMesh);

  /* ---------- 起点/终点线：棋盘格横跨路面 ---------- */
  const I = 0;
  const lineGeo = new THREE.PlaneGeometry(HW * 2, 1.6);
  lineGeo.rotateX(-Math.PI / 2);
  const line = new THREE.Mesh(lineGeo, new THREE.MeshStandardMaterial({
    map: makeCheckerTexture(THREE), roughness: 0.7,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }));
  line.position.set(track.cx[I], track.cy[I] + 0.02, track.cz[I]);
  line.rotation.y = Math.atan2(track.tx[I], track.tz[I]);
  line.receiveShadow = true;
  group.add(line);

  return { group, road, postMesh, startLine: line };
}
