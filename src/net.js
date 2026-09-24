/* ===========================================================================
 * net.js — 联机客户端
 *
 * 双通道：
 *   WebSocket  首选，20Hz 双向，延迟最低
 *   轮询降级   若 Upgrade 握手失败（反向代理不转发 Upgrade 头时会这样），
 *              自动切到 POST /api/poll，单请求同时完成"上报状态 + 取回消息"
 *
 * 远端车辆：服务器快照 20Hz，客户端用「最新快照 + 速度外推 + 指数平滑」
 * 还原，兼顾平滑与低延迟；不做回滚（朋友间竞速够用，且手感零牺牲）。
 * =========================================================================*/

import { clamp, damp, wrapAngle } from './util.js';

const STATE_HZ = 20;
const POLL_MS = 80;
const INTERP_LAMBDA = 14;
const EXTRAP_MAX = 0.25;      // 速度外推最多 250ms，防止瞬移

export class NetClient {
  constructor() {
    this.transport = null;          // 'ws' | 'poll' | null
    this.ws = null;
    this.connected = false;
    this.myId = null;
    this.room = null;
    this.track = 'coast';
    this.laps = 3;
    this.level = 'normal';
    this.hostId = null;
    this.isHost = false;
    this.players = [];
    this.remotes = new Map();
    this.outbox = null;             // 最新待发状态（只保留最新一份）
    this.controlQueue = [];         // 控制类消息（hello/start/finish）必须先发
    this.stateTimer = 0;
    this.pollTimer = 0;
    this.polling = false;
    this.pendingCreate = null;
    this.status = 'idle';           // idle | connecting | online | error | closed

    /* 回调 */
    this.onWelcome = null;
    this.onRoster = null;
    this.onBegin = null;
    this.onEvent = null;
    this.onResults = null;
    this.onError = null;
    this.onStatus = null;
  }

  get others() { return [...this.remotes.values()]; }

  /* ------------------------------------------------------------ 连接 */
  open(opts) {
    this.close(true);
    this.pendingCreate = opts;
    this.status = 'connecting';
    this._emitStatus();

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws`;
    let settled = false;

    const fallback = (why) => {
      if (settled) return;
      settled = true;
      console.warn('[net] WebSocket 不可用（' + why + '）→ 降级为 HTTP 轮询');
      this._startPolling(opts);
    };

    // 验收脚本可强制走轮询通道，用来验证"反向代理不转发 Upgrade 头"时的降级路径
    if (window.__DR_FORCE_POLL__) { fallback('测试强制轮询'); return; }

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      fallback('构造失败');
      return;
    }
    this.ws = ws;
    const timer = setTimeout(() => fallback('握手超时'), 2600);

    ws.addEventListener('open', () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      this.transport = 'ws';
      this.connected = true;
      this.status = 'online';
      this._emitStatus();
      this._sendRaw(this._helloMsg(opts));
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      this._handle(msg);
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      fallback('error 事件');
    });
    ws.addEventListener('close', () => {
      clearTimeout(timer);
      if (!settled) { fallback('提前关闭'); return; }
      if (this.transport === 'ws') {
        this.connected = false;
        this.status = 'closed';
        this._emitStatus();
        // WS 掉线后尝试用轮询续命
        if (this.myId && this.room) {
          this.transport = null;
          console.warn('[net] WebSocket 断开 → 尝试轮询续连');
          this._startPolling({ ...this.pendingCreate, mode: 'join', room: this.room, id: this.myId });
        }
      }
    });
  }

  _helloMsg(opts) {
    return {
      t: 'hello',
      mode: opts.mode,
      room: opts.room,
      name: opts.name,
      paint: opts.paint,
      track: opts.track,
      laps: opts.laps,
      level: opts.level,
    };
  }

  _sendRaw(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    if (this.transport === 'poll') {
      this.controlQueue.push(obj);
      return true;
    }
    return false;
  }

  /* -------------------------------------------------- 轮询降级实现 */
  _startPolling(opts) {
    this.transport = 'poll';
    this.polling = true;
    this.pollOpts = opts;
    this.controlQueue = [this._helloMsg(opts)];
    this._pollLoop();
  }

  async _pollLoop() {
    let backoff = 0;
    while (this.polling) {
      const control = this.controlQueue.shift() || null;
      const state = this.outbox;
      this.outbox = null;
      const msg = control || state;

      try {
        const res = await fetch('/api/poll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            room: this.room || this.pollOpts.room,
            id: this.myId,
            create: !this.myId && this.pollOpts.mode === 'create',
            track: this.pollOpts.track,
            laps: this.pollOpts.laps,
            level: this.pollOpts.level,
            msg,
          }),
        });
        const data = await res.json();
        backoff = 0;
        if (data.error) {
          this.status = 'error';
          this._emitStatus();
          if (this.onError) this.onError(data.error);
          this.polling = false;
          break;
        }
        if (!this.myId && data.id) {
          this.myId = data.id;
          this.room = data.room;
          this.connected = true;
          this.status = 'online';
          this._emitStatus();
        }
        if (data.msgs) for (const m of data.msgs) this._handle(m);
      } catch (e) {
        backoff = Math.min(2000, backoff ? backoff * 2 : 250);
      }
      await new Promise((r) => setTimeout(r, POLL_MS + backoff));
    }
  }

  /* ---------------------------------------------------------- 收消息 */
  _handle(msg) {
    switch (msg.t) {
      case 'welcome': {
        this.myId = msg.id;
        this.room = msg.room;
        this.track = msg.track;
        this.laps = msg.laps;
        this.level = msg.level;
        this.hostId = msg.hostId;
        this.isHost = msg.hostId === msg.id;
        this.connected = true;
        if (this.onWelcome) this.onWelcome(msg);
        break;
      }
      case 'roster': {
        this.players = msg.players || [];
        this.hostId = msg.hostId;
        this.isHost = this.hostId === this.myId;
        this._syncRemotes();
        if (this.onRoster) this.onRoster(this.players, this.isHost);
        break;
      }
      case 'begin':
        if (this.onBegin) this.onBegin(msg);
        break;
      case 'snap':
        this._applySnapshot(msg);
        break;
      case 'event':
        if (this.onEvent) this.onEvent(msg);
        break;
      case 'results':
        if (this.onResults) this.onResults(msg.results);
        break;
      case 'error':
        if (this.onError) this.onError(msg.msg);
        break;
      default:
        break;
    }
  }

  _syncRemotes() {
    const seen = new Set();
    for (const p of this.players) {
      if (p.id === this.myId) continue;
      seen.add(p.id);
      if (!this.remotes.has(p.id)) {
        this.remotes.set(p.id, {
          id: p.id, name: p.name, paint: p.paint,
          x: 0, y: 0, z: 0, heading: 0, v: 0,
          tx: 0, ty: 0, tz: 0, th: 0, tv: 0,
          lap: 1, idx: 0, drift: 0, off: 0, fin: 0, rank: p.rank || 99,
          hasData: false, lastSnap: 0,
        });
      } else {
        const r = this.remotes.get(p.id);
        r.name = p.name; r.paint = p.paint; r.rank = p.rank || r.rank;
      }
    }
    for (const id of [...this.remotes.keys()]) {
      if (!seen.has(id)) this.remotes.delete(id);
    }
  }

  _applySnapshot(msg) {
    for (const c of msg.cars) {
      if (c.id === this.myId) continue;
      let r = this.remotes.get(c.id);
      if (!r) {
        r = {
          id: c.id, name: '车手', paint: 0,
          x: c.p[0], y: c.p[1], z: c.p[2], heading: c.h, v: c.v,
          tx: c.p[0], ty: c.p[1], tz: c.p[2], th: c.h, tv: c.v,
          lap: c.lap, idx: c.idx, drift: c.drift, off: c.off, fin: c.fin, rank: c.rank,
          hasData: true, lastSnap: performance.now(),
        };
        this.remotes.set(c.id, r);
        continue;
      }
      r.tx = c.p[0]; r.ty = c.p[1]; r.tz = c.p[2];
      r.th = c.h; r.tv = c.v;
      r.lap = c.lap; r.idx = c.idx; r.drift = c.drift; r.off = c.off;
      r.fin = c.fin; r.rank = c.rank;
      if (!r.hasData) {
        r.x = r.tx; r.y = r.ty; r.z = r.tz; r.heading = r.th;
        r.hasData = true;
      }
      // 注意：这里必须用本地时钟 performance.now()。
      // msg.ts 是服务器的 Date.now()（约 1.7e12），和 performance.now()（约 1e4）
      // 完全不是一个量级——混用会让速度外推量变成十几亿秒，远端车直接飞出坐标系。
      r.lastSnap = performance.now();
    }
  }

  /* ------------------------------------------------------------ 发送 */
  sendState(s) {
    if (!this.connected) return;
    const msg = {
      t: 'state', p: [round2(s.x), round2(s.y), round2(s.z)],
      h: round3(s.heading), v: round2(s.vF),
      lap: s.lap, idx: s.idx, drift: s.drifting ? 1 : 0, off: round2(s.offroad),
    };
    if (this.transport === 'ws') {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    } else {
      this.outbox = msg;      // 轮询：只保留最新一份
    }
  }

  start() { this._sendRaw({ t: 'start' }); }
  finish(time) { this._sendRaw({ t: 'finish', time: Math.round(time) }); }

  /** 每帧调用：把远端车从快照平滑到当前位置 */
  update(dt) {
    const now = performance.now();
    for (const r of this.remotes.values()) {
      if (!r.hasData) continue;
      // 速度外推：补偿快照间隔（上限 250ms，避免丢包后瞬移；负值直接视为 0）
      const since = clamp((now - r.lastSnap) / 1000, 0, EXTRAP_MAX);
      const sh = Math.sin(r.th), ch = Math.cos(r.th);
      const ex = r.tx + sh * r.tv * since;
      const ez = r.tz + ch * r.tv * since;
      const k = r.fin ? 6 : INTERP_LAMBDA;
      r.x = damp(r.x, ex, k, dt);
      r.y = damp(r.y, r.ty, k, dt);
      r.z = damp(r.z, ez, k, dt);
      r.heading += wrapAngle(r.th - r.heading) * (1 - Math.exp(-k * dt));
      r.v = damp(r.v, r.tv, 10, dt);
    }
  }

  /** 本地玩家是否已跑完（用于通知服务器） */
  notifyFinish(time) { this.finish(time); }

  close(silent = false) {
    this.polling = false;
    if (this.ws) {
      try { this.ws.close(); } catch (e) { }
      this.ws = null;
    }
    this.transport = null;
    this.connected = false;
    this.remotes.clear();
    this.players = [];
    this.myId = null;
    this.room = null;
    this.outbox = null;
    this.controlQueue = [];
    if (!silent) {
      this.status = 'closed';
      this._emitStatus();
    }
  }

  _emitStatus() { if (this.onStatus) this.onStatus(this.status, this.transport); }
}

const round2 = (v) => Math.round(v * 100) / 100;
const round3 = (v) => Math.round(v * 1000) / 1000;

/** 校验房间是否存在（加入前预检，给出更好的错误提示） */
export async function probeRoom(code) {
  try {
    const res = await fetch('/api/room/' + encodeURIComponent(code.toUpperCase()));
    return await res.json();
  } catch (e) {
    return { exists: false, error: 'network' };
  }
}
