/* ===========================================================================
 * effects.js — 漂移烟雾 / 草地尘土 / 胎印
 * 全部程序化：Points 里画圆 + InstancedMesh 自定义 shader，零贴图文件
 * =========================================================================*/

/* ---------------------------------------------------------------------------
 * 烟雾 / 尘土粒子
 * -------------------------------------------------------------------------*/
const SMOKE_MAX = 560;

export function createSmokeSystem(THREE, scene) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(SMOKE_MAX * 3);
  const aSize = new Float32Array(SMOKE_MAX);
  const aAlpha = new Float32Array(SMOKE_MAX);
  const aTint = new Float32Array(SMOKE_MAX);
  for (let i = 0; i < SMOKE_MAX; i++) pos[i * 3 + 1] = -9999;
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(aAlpha, 1));
  geo.setAttribute('aTint', new THREE.BufferAttribute(aTint, 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]),
    vertexShader: `
      attribute float aSize; attribute float aAlpha; attribute float aTint;
      varying float vAlpha; varying float vTint;
      #include <fog_pars_vertex>
      void main(){
        vAlpha = aAlpha; vTint = aTint;
        // 变量必须叫 mvPosition：fog_vertex 代码块依赖这个名字
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * (420.0 / max(1.0, -mvPosition.z));
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      varying float vAlpha; varying float vTint;
      #include <fog_pars_fragment>
      void main(){
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c);
        float a = smoothstep(0.5, 0.06, d) * vAlpha;
        if (a < 0.004) discard;
        vec3 col = mix(vec3(0.90,0.88,0.86), vec3(0.62,0.55,0.48), clamp(vTint,0.0,1.0));
        gl_FragColor = vec4(col, a);
        #include <fog_fragment>
      }`,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  scene.add(points);

  const parts = new Array(SMOKE_MAX).fill(null);
  let cursor = 0;

  return {
    points,
    spawn(x, y, z, strength, tint) {
      const i = cursor;
      cursor = (cursor + 1) % SMOKE_MAX;
      parts[i] = {
        life: 0, ttl: 1.0 + Math.random() * 0.9,
        vx: (Math.random() - 0.5) * 2.1,
        vy: 0.9 + Math.random() * 1.5,
        vz: (Math.random() - 0.5) * 2.1,
        size: 0.7 + Math.random() * 1.1,
        growth: 1.6 + Math.random() * 2.2,
        tint: tint, strength: strength,
      };
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      aTint[i] = tint;
    },
    update(dt) {
      let any = false;
      for (let i = 0; i < SMOKE_MAX; i++) {
        const p = parts[i];
        if (!p) { aAlpha[i] = 0; continue; }
        p.life += dt;
        const t = p.life / p.ttl;
        if (t >= 1) {
          parts[i] = null; aAlpha[i] = 0; pos[i * 3 + 1] = -9999;
          continue;
        }
        any = true;
        pos[i * 3] += p.vx * dt;
        pos[i * 3 + 1] += p.vy * dt;
        pos[i * 3 + 2] += p.vz * dt;
        p.vy *= 1 - 1.1 * dt;
        aSize[i] = p.size + p.growth * t;
        aAlpha[i] = (1 - t) * (1 - t) * 0.55 * p.strength;
      }
      if (any) {
        geo.attributes.position.needsUpdate = true;
        geo.attributes.aSize.needsUpdate = true;
        geo.attributes.aAlpha.needsUpdate = true;
        geo.attributes.aTint.needsUpdate = true;
      }
    },
    clear() {
      for (let i = 0; i < SMOKE_MAX; i++) {
        parts[i] = null; aAlpha[i] = 0; pos[i * 3 + 1] = -9999;
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aAlpha.needsUpdate = true;
    },
  };
}

/* ---------------------------------------------------------------------------
 * 胎印：InstancedMesh + 逐实例透明度，按时间淡出
 * -------------------------------------------------------------------------*/
const SKID_MAX = 900;

export function createSkidSystem(THREE, scene) {
  const geo = new THREE.PlaneGeometry(0.34, 0.62);
  geo.rotateX(-Math.PI / 2);
  const aAlpha = new THREE.InstancedBufferAttribute(new Float32Array(SKID_MAX), 1);
  geo.setAttribute('aAlpha', aAlpha);

  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, polygonOffset: true,
    polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    vertexShader: `
      attribute float aAlpha;
      varying float vA; varying vec2 vUv;
      void main(){
        vA = aAlpha; vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying float vA; varying vec2 vUv;
      void main(){
        float e = smoothstep(0.0, 0.32, vUv.x) * smoothstep(1.0, 0.68, vUv.x);
        float a = vA * 0.72 * e;
        if (a < 0.004) discard;
        gl_FragColor = vec4(vec3(0.035, 0.033, 0.038), a);
      }`,
  });

  const mesh = new THREE.InstancedMesh(geo, mat, SKID_MAX);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < SKID_MAX; i++) mesh.setMatrixAt(i, zero);
  scene.add(mesh);

  const life = new Float32Array(SKID_MAX);
  const active = new Uint8Array(SKID_MAX);
  let cursor = 0;
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion();
  const _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
  const UP = new THREE.Vector3(0, 1, 0);

  return {
    mesh,
    add(x, y, z, heading, alpha) {
      const i = cursor;
      cursor = (cursor + 1) % SKID_MAX;
      _p.set(x, y + 0.022, z);
      _q.setFromAxisAngle(UP, heading);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(i, _m);
      aAlpha.array[i] = alpha;
      life[i] = 0;
      active[i] = 1;
      mesh.instanceMatrix.needsUpdate = true;
      aAlpha.needsUpdate = true;
    },
    update(dt) {
      let changed = false;
      for (let i = 0; i < SKID_MAX; i++) {
        if (!active[i]) continue;
        life[i] += dt;
        const a = aAlpha.array[i];
        if (a > 0.02) { aAlpha.array[i] = Math.max(0, a - dt * 0.05); changed = true; }
        else { aAlpha.array[i] = 0; active[i] = 0; }
      }
      if (changed) aAlpha.needsUpdate = true;
    },
    clear() {
      for (let i = 0; i < SKID_MAX; i++) {
        active[i] = 0; aAlpha.array[i] = 0; mesh.setMatrixAt(i, zero);
      }
      aAlpha.needsUpdate = true;
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}

/**
 * 根据赛车状态吐出烟雾 / 胎印。玩家、AI、分屏玩家共用这一套。
 * 只在真正打滑（侧滑量够大）或出界时产生，避免出现"全程冒烟"的廉价感。
 */
let _v3 = null;

export function emitRacerEffects(racer, smoke, skid, track, quality, THREE) {
  if (!racer.meshData) return;
  if (!_v3) _v3 = new THREE.Vector3();

  const speedAbs = Math.abs(racer.vF);
  const slip = Math.abs(racer.vL);
  const wheels = racer.meshData.wheels;

  const smoking = (slip > 3.2 && speedAbs > 10) || racer.offroad > 0.45;
  if (smoking) {
    const strength = clampRange(slip / 22 + racer.offroad * 0.8, 0.18, 1);
    const perSide = quality.level >= 2 ? 2 : 1;
    const tint = racer.offroad > 0.45 ? 1 : 0.25;   // 草地上是土黄，路上是白烟
    for (let k = 0; k < perSide; k++) {
      for (const w of wheels) {
        if (w.front) continue;                        // 只从后轮冒烟
        _v3.setFromMatrixPosition(w.pivot.matrixWorld);
        smoke.spawn(
          _v3.x + (Math.random() - 0.5) * 0.4,
          _v3.y + 0.12,
          _v3.z + (Math.random() - 0.5) * 0.4,
          strength, tint
        );
      }
    }
  }

  if (slip > 2.6 && speedAbs > 9) {
    const alpha = clampRange(slip / 16, 0.15, 1) * 0.85;
    for (const w of wheels) {
      _v3.setFromMatrixPosition(w.pivot.matrixWorld);
      skid.add(_v3.x, track.cy[racer.idx], _v3.z, racer.heading, alpha);
    }
  }
}

function clampRange(v, a, b) { return v < a ? a : v > b ? b : v; }
