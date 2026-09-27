/* ===========================================================================
 * audio.js — 全部实时合成（零音频文件）
 *   引擎声：两个锯齿 + 一个次谐波方波 → 低通，频率随转速变化
 *   胎噪：  程序生成白噪声 → 带通，增益随侧滑量变化
 *   碰撞：  噪声爆音 + 低通冲击
 *   近车掠过：邻近车辆的带通噪声，音量随距离衰减
 *   音乐：  按赛道调式排程的琶音 + 低音 + 底鼓，速度随车速变化
 * AudioContext 必须由用户手势创建（浏览器自动播放策略）。
 * =========================================================================*/

import { clamp } from "./util.js";

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.engines = new Map();
    this.noiseBuf = null;
    this.musicTimer = 0;
    this.beat = 0;
    this.volume = 0.3;
  }

  get ready() {
    return !!this.ctx;
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(ctx.destination);

    // 程序化白噪声（胎噪与碰撞共用）
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let s = 99551;
    for (let i = 0; i < len; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      d[i] = (s / 4294967296) * 2 - 1;
    }
    this.noiseBuf = buf;

    // 音乐总线（单独一路，便于压低音量）
    this.musicBus = ctx.createGain();
    // 略提高默认音乐音量以获得更动感的背景声
    this.musicBus.gain.value = 0.44;
    this.musicBus.connect(this.master);
  }

  setMuted(m) {
    this.muted = m;
    if (this.master)
      this.master.gain.setTargetAtTime(
        m ? 0 : this.volume,
        this.ctx.currentTime,
        0.08,
      );
  }

  /* ---------------------------------------------------------------- 引擎 */
  addEngine(id) {
    if (!this.ctx || this.engines.has(id)) return;
    const ctx = this.ctx;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 900;
    filter.Q.value = 3.2;
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    filter.connect(gain).connect(this.master);

    const oscs = [];
    const mk = (type, detune, g) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = 60;
      o.detune.value = detune;
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og).connect(filter);
      o.start();
      oscs.push(o);
    };
    mk("sawtooth", 0, 0.5);
    mk("sawtooth", 12, 0.34);
    mk("square", -1200, 0.22);

    // 轮胎尖叫：侧滑 / 漂移 / 越野都会增强
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2050;
    bp.Q.value = 1.1;
    const scGain = ctx.createGain();
    scGain.gain.value = 0.0001;
    src.connect(bp).connect(scGain).connect(this.master);
    src.start();

    // 额外强化层：氮气加速、刹车摩擦、漂移风声、失控打滑。
    const boostOsc = ctx.createOscillator();
    boostOsc.type = "sawtooth";
    boostOsc.frequency.value = 90;
    const boostFilter = ctx.createBiquadFilter();
    boostFilter.type = "bandpass";
    boostFilter.frequency.value = 900;
    boostFilter.Q.value = 0.8;
    const boostGain = ctx.createGain();
    boostGain.gain.value = 0.0001;
    boostOsc.connect(boostFilter).connect(boostGain).connect(this.master);
    boostOsc.start();

    const driftSrc = ctx.createBufferSource();
    driftSrc.buffer = this.noiseBuf;
    driftSrc.loop = true;
    const driftFilter = ctx.createBiquadFilter();
    driftFilter.type = "bandpass";
    driftFilter.frequency.value = 1200;
    driftFilter.Q.value = 1.4;
    const driftGain = ctx.createGain();
    driftGain.gain.value = 0.0001;
    driftSrc.connect(driftFilter).connect(driftGain).connect(this.master);
    driftSrc.start();

    const brakeSrc = ctx.createBufferSource();
    brakeSrc.buffer = this.noiseBuf;
    brakeSrc.loop = true;
    const brakeFilter = ctx.createBiquadFilter();
    brakeFilter.type = "bandpass";
    brakeFilter.frequency.value = 1600;
    brakeFilter.Q.value = 1.8;
    const brakeGain = ctx.createGain();
    brakeGain.gain.value = 0.0001;
    brakeSrc.connect(brakeFilter).connect(brakeGain).connect(this.master);
    brakeSrc.start();

    this.engines.set(id, {
      oscs,
      filter,
      gain,
      scGain,
      boostOsc,
      boostGain,
      boostFilter,
      driftSrc,
      driftGain,
      driftFilter,
      brakeSrc,
      brakeGain,
      brakeFilter,
    });
  }

  removeEngine(id) {
    const e = this.engines.get(id);
    if (!e) return;
    for (const o of e.oscs) {
      try {
        o.stop();
      } catch (err) {}
    }
    try {
      e.boostOsc.stop();
    } catch (err) {}
    try {
      e.driftSrc.stop();
      e.brakeSrc.stop();
    } catch (err) {}
    try {
      e.gain.disconnect();
      e.scGain.disconnect();
      e.boostGain.disconnect();
      e.driftGain.disconnect();
      e.brakeGain.disconnect();
    } catch (err) {}
    this.engines.delete(id);
  }

  /** @param list [{id, rpm, throttle, slip, drifting, offroad, boost, brake, spin, speed}] */
  updateEngines(list) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const item of list) {
      const e = this.engines.get(item.id);
      if (!e) continue;
      const rpm = clamp(item.rpm ?? 0, 0, 1);
      const throttle = clamp(item.throttle ?? 0, 0, 1);
      const boost = clamp(item.boost ?? 0, 0, 1);
      const brake = clamp(item.brake ?? 0, 0, 1);
      const spin = clamp(item.spin ?? 0, 0, 1);
      const speed = Math.abs(item.speed ?? 0);

      const f = 52 + rpm * 168;
      for (const o of e.oscs) o.frequency.setTargetAtTime(f, t, 0.045);
      const load = 0.55 + 0.45 * throttle;
      e.gain.gain.setTargetAtTime(
        0.045 + 0.06 * load * (0.5 + rpm * 0.5),
        t,
        0.08,
      );
      e.filter.frequency.setTargetAtTime(
        600 + rpm * 2100 + throttle * 380,
        t,
        0.07,
      );

      const slipN = clamp((item.slip ?? 0) / 18, 0, 1);
      const driftLevel =
        clamp(slipN * 1.55, 0, 1) * (item.drifting ? 1.25 : 0.35) +
        (item.offroad ?? 0) * 0.6;
      const sc = clamp(driftLevel, 0, 1);
      e.scGain.gain.setTargetAtTime(0.0001 + sc * 0.075, t, 0.06);
      if (e.driftFilter)
        e.driftFilter.frequency.setTargetAtTime(
          900 + slipN * 2500 + (item.drifting ? 600 : 0),
          t,
          0.08,
        );
      if (e.driftGain)
        e.driftGain.gain.setTargetAtTime(0.0001 + sc * 0.12, t, 0.07);

      const boostLevel = boost * (0.7 + throttle * 0.5 + speed / 60);
      if (e.boostGain)
        e.boostGain.gain.setTargetAtTime(
          0.0001 + clamp(boostLevel, 0, 1) * 0.11,
          t,
          0.08,
        );
      if (e.boostFilter)
        e.boostFilter.frequency.setTargetAtTime(
          680 + boost * 1200 + rpm * 1400,
          t,
          0.08,
        );
      if (e.boostOsc)
        e.boostOsc.frequency.setTargetAtTime(
          90 + boost * 200 + rpm * 450,
          t,
          0.08,
        );

      const brakeLevel = brake * (0.5 + speed / 50) + spin * 0.25;
      if (e.brakeGain)
        e.brakeGain.gain.setTargetAtTime(
          0.0001 + clamp(brakeLevel, 0, 1) * 0.1,
          t,
          0.08,
        );
      if (e.brakeFilter)
        e.brakeFilter.frequency.setTargetAtTime(
          1000 + brake * 1800 + spin * 500,
          t,
          0.08,
        );
    }
  }

  /* ------------------------------------------------------------ 近车掠过 */
  ensurePass() {
    if (this.pass || !this.ctx) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 320;
    bp.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    src.connect(bp).connect(g).connect(this.master);
    src.start();
    this.pass = { src, bp, g };
  }

  /** 邻近车辆造成的风声：距离越近、速度越快越响 */
  updatePass(list, speedRef) {
    if (!this.ctx) return;
    this.ensurePass();
    if (!this.pass) return;
    let loud = 0,
      freq = 320;
    for (const c of list) {
      if (c.dist > 22) continue;
      const f = clamp(1 - c.dist / 22, 0, 1);
      loud = Math.max(loud, f * f * clamp(c.speed / 40, 0, 1));
      freq = 260 + c.speed * 9;
    }
    this.pass.g.gain.setTargetAtTime(
      0.0001 + loud * 0.09,
      this.ctx.currentTime,
      0.08,
    );
    this.pass.bp.frequency.setTargetAtTime(freq, this.ctx.currentTime, 0.1);
  }

  /* ---------------------------------------------------------------- 音效 */
  hit(strength) {
    if (!this.ctx) return;
    const ctx = this.ctx,
      t = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 260 + strength * 700;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.min(0.5, 0.08 + strength * 0.4), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    s.connect(f).connect(g).connect(this.master);
    s.start(t);
    s.stop(t + 0.28);
  }

  /** 简单提示音：kind = count | go | lap | best | ach | click */
  chime(kind) {
    if (!this.ctx) return;
    const ctx = this.ctx,
      t = ctx.currentTime;
    const mk = (freq, dur, type = "triangle", gain = 0.18, delay = 0) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + delay);
      g.gain.exponentialRampToValueAtTime(gain, t + delay + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + delay + dur);
      o.connect(g).connect(this.master);
      o.start(t + delay);
      o.stop(t + delay + dur + 0.02);
    };
    if (kind === "count") mk(520, 0.16, "square", 0.14);
    else if (kind === "go") {
      mk(780, 0.3, "square", 0.18);
      mk(1170, 0.34, "triangle", 0.13, 0.05);
    } else if (kind === "lap") {
      mk(880, 0.22);
      mk(1320, 0.3, "triangle", 0.14, 0.09);
    } else if (kind === "best") {
      mk(660, 0.22);
      mk(990, 0.22, "triangle", 0.15, 0.1);
      mk(1320, 0.4, "triangle", 0.15, 0.2);
    } else if (kind === "ach") {
      mk(1046, 0.18, "sine", 0.17);
      mk(1568, 0.3, "sine", 0.15, 0.09);
    } else if (kind === "click") mk(420, 0.07, "square", 0.1);
  }

  /* ---------------------------------------------------------------- 音乐 */
  /**
   * 程序化配乐：按赛道调式排程琶音 + 低音 + 底鼓，
   * 速度 (intensity 0..1) 同时驱动 BPM 与滤波截止频率。
   */
  updateMusic(layout, intensity, dt) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const bpm = 82 + intensity * 58;
    const spb = 60 / bpm;
    this.musicTimer -= dt;
    if (this.musicTimer > 0) return;
    this.musicTimer += spb / 2; // 每半拍一次事件
    if (this.musicTimer < 0) this.musicTimer = spb / 2;

    const t = ctx.currentTime + 0.02;
    const root = layout.music.root;
    const mode = layout.music.mode;
    const b = this.beat++;

    const mk = (freq, dur, type, gain, delay = 0) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = 700 + intensity * 2600;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + delay);
      g.gain.exponentialRampToValueAtTime(gain, t + delay + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + delay + dur);
      o.connect(f).connect(g).connect(this.musicBus);
      o.start(t + delay);
      o.stop(t + delay + dur + 0.05);
    };

    // 底鼓（每 4 个半拍 = 每 2 拍）
    if (b % 4 === 0) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(120, t);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.13);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.26, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      o.connect(g).connect(this.musicBus);
      o.start(t);
      o.stop(t + 0.24);
    }
    // Hi-hat（每半拍） - 使用白噪声的高通短包络
    {
      const hhGain = 0.035 + intensity * 0.05;
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 6000 + intensity * 3000;
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.0001, t);
      g2.gain.exponentialRampToValueAtTime(Math.max(0.002, hhGain), t + 0.004);
      g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      src.connect(hp).connect(g2).connect(this.musicBus);
      src.start(t);
      src.stop(t + 0.12);
    }

    // 低音（每拍）
    if (b % 2 === 0) {
      const deg = mode[(b / 2) % mode.length];
      mk(root * Math.pow(2, deg / 12), spb * 1.2, "triangle", 0.16);
    }
    // 琶音（每个半拍，上行循环）
    const deg = mode[(b * 2) % mode.length];
    mk(root * 4 * Math.pow(2, deg / 12), spb * 0.5, "sawtooth", 0.045);

    // Pad（每 4 拍，长释）
    if (b % 8 === 0) {
      const padFreq = root * 2 * Math.pow(2, mode[0] / 12);
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(padFreq, t);
      const fg = ctx.createBiquadFilter();
      fg.type = "lowpass";
      fg.frequency.value = 900 + intensity * 1600;
      const pg = ctx.createGain();
      pg.gain.setValueAtTime(0.0001, t);
      pg.gain.linearRampToValueAtTime(
        0.12 * Math.min(1, intensity + 0.3),
        t + 0.12,
      );
      pg.gain.linearRampToValueAtTime(0.0001, t + spb * 2.2);
      o.connect(fg).connect(pg).connect(this.musicBus);
      o.start(t);
      o.stop(t + spb * 2.3 + 0.05);
    }

    // 能量大时加入短促的 lead 提升动感
    if (intensity > 0.6 && b % 2 === 1) {
      const leadDeg = mode[(b * 3) % mode.length];
      mk(
        root * 8 * Math.pow(2, leadDeg / 12),
        spb * 0.28,
        "square",
        0.072,
        0.02,
      );
    }
  }
}
