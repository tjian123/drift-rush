/* ===========================================================================
 * server/index.js — DRIFT RUSH 联机房间服务器
 *
 * 设计取舍：
 *  1) 零运行时依赖：WebSocket 按 RFC6455 手写握手与帧编解码，
 *     避免在部署沙箱里装 npm 包（少一个会失败的环节）。
 *  2) 双通道：WebSocket 为主；若反向代理不转发 Upgrade 头导致握手失败，
 *     客户端自动降级为 HTTP 轮询（POST /api/poll），联机依然可用。
 *  3) 半权威：服务器不跑车辆物理（各客户端自算，手感零延迟），
 *     只负责房间、快照中继、圈数与完赛时间的权威记录。
 *
 * 环境变量：PORT（部署平台注入），默认 3000
 * =========================================================================*/

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);
const MAX_PLAYERS = 8;
const SNAP_HZ = 20;
const POLL_TIMEOUT_MS = 15000;      // 轮询客户端超过这个时间没动静就踢
const ROOM_TTL_MS = 120000;         // 空房间保留时间

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/* ============================ 工具 ====================================== */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x81;                 // FIN + text frame
  return Buffer.concat([header, payload]);
}

function encodeClose(code = 1000) {
  const b = Buffer.alloc(4);
  b[0] = 0x88;                      // FIN + close
  b[1] = 2;
  b.writeUInt16BE(code, 2);
  return b;
}

/**
 * 从累积缓冲区里解码所有完整帧。
 * 支持 7/16/64 位长度、掩码、分片（continuation）与 ping/pong/close。
 */
function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const b0 = buf[off], b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (p + 2 > buf.length) break;
      len = buf.readUInt16BE(p); p += 2;
    } else if (len === 127) {
      if (p + 8 > buf.length) break;
      len = Number(buf.readBigUInt64BE(p)); p += 8;
    }
    if (masked) {
      if (p + 4 > buf.length) break;
      p += 4;
    }
    if (p + len > buf.length) break;
    let payload = buf.subarray(p, p + len);
    if (masked) {
      const maskKey = buf.subarray(p - 4, p);
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
      payload = out;
    }
    frames.push({ fin, opcode, payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return s;
}

/* ============================ 房间 ====================================== */
/** rooms: code -> Room */
const rooms = new Map();
let nextClientId = 1;

/**
 * Room.client: {
 *   id, name, paint, ws|null, queue[], lastSeen, alive,
 *   state: {p,h,v,lap,idx,drift,fin}, finished, finishTime, lapsDone
 * }
 */
function createRoom(track, laps, level) {
  let code = makeCode();
  while (rooms.has(code)) code = makeCode();
  const room = {
    code, track, laps, level,
    hostId: null,
    clients: new Map(),
    started: false,
    beginAt: 0,
    createdAt: Date.now(),
    emptyAt: 0,
    results: [],
  };
  rooms.set(code, room);
  console.log(`[room] 创建 ${code} track=${track} laps=${laps} level=${level}`);
  return room;
}

function roomRoster(room) {
  return [...room.clients.values()].map((c) => ({
    id: c.id, name: c.name, paint: c.paint,
    finished: !!c.finished, finishTime: c.finishTime || 0,
    lap: c.state ? c.state.lap : 1,
    rank: c.rank || 0,
  }));
}

function send(client, obj) {
  const text = JSON.stringify(obj);
  if (client.ws && client.ws.writable) {
    try { client.ws.write(encodeFrame(text)); return true; } catch (e) { return false; }
  }
  // 轮询客户端：进队列，等下一次 poll 取走
  client.queue.push(text);
  if (client.queue.length > 240) client.queue.splice(0, client.queue.length - 240);
  return true;
}

function broadcast(room, obj, exceptId = null) {
  const text = JSON.stringify(obj);
  for (const c of room.clients.values()) {
    if (c.id === exceptId) continue;
    if (c.ws && c.ws.writable) {
      try { c.ws.write(encodeFrame(text)); } catch (e) { /* 下一轮心跳会清理 */ }
    } else {
      c.queue.push(text);
      if (c.queue.length > 240) c.queue.splice(0, c.queue.length - 240);
    }
  }
}

function leaveRoom(room, client, reason) {
  if (!room.clients.has(client.id)) return;
  room.clients.delete(client.id);
  console.log(`[room] ${room.code} ${client.name} 离开 (${reason})，剩余 ${room.clients.size}`);
  if (room.clients.size === 0) {
    room.emptyAt = Date.now();
  } else {
    if (room.hostId === client.id) {
      room.hostId = [...room.clients.keys()][0];
    }
    broadcast(room, { t: 'roster', players: roomRoster(room), hostId: room.hostId });
    broadcast(room, { t: 'event', kind: 'leave', id: client.id, name: client.name });
  }
}

/** 把名次算出来（按 圈数 → 进度 → 完赛时间） */
function updateRanks(room) {
  const list = [...room.clients.values()];
  list.forEach((c) => {
    c._key = c.finished
      ? 1e12 - c.finishTime          // 已完赛排最前，用时短者更前
      : (c.state ? c.state.lap * 100000 + c.state.idx : 0);
  });
  list.sort((a, b) => b._key - a._key);
  list.forEach((c, i) => { c.rank = i + 1; });
}

/* ============================ 消息处理 ================================== */
function handleMessage(room, client, msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'hello': {
      client.name = String(msg.name || '车手').slice(0, 12);
      client.paint = Number(msg.paint) || 0;
      send(client, {
        t: 'welcome',
        id: client.id,
        room: room.code,
        track: room.track,
        laps: room.laps,
        level: room.level,
        hostId: room.hostId,
        self: { name: client.name, paint: client.paint },
      });
      broadcast(room, { t: 'roster', players: roomRoster(room), hostId: room.hostId });
      broadcast(room, { t: 'event', kind: 'join', id: client.id, name: client.name }, client.id);
      break;
    }

    case 'state': {
      client.state = {
        p: msg.p, h: msg.h, v: msg.v, lap: msg.lap || 1,
        idx: msg.idx || 0, drift: msg.drift ? 1 : 0, off: msg.off || 0,
      };
      client.lastSeen = Date.now();
      if (msg.lap && msg.lap > (client.lapsDone || 1)) {
        client.lapsDone = msg.lap;
        broadcast(room, { t: 'event', kind: 'lap', id: client.id, name: client.name, lap: msg.lap },
          client.id);
      }
      break;
    }

    case 'start': {
      if (client.id !== room.hostId) {
        send(client, { t: 'error', msg: '只有房主可以开始比赛' });
        return;
      }
      room.started = true;
      room.beginAt = Date.now() + 4200;     // 给客户端留出倒计时时间
      for (const c of room.clients.values()) { c.finished = false; c.finishTime = 0; c.state = null; }
      room.results = [];
      broadcast(room, { t: 'begin', at: room.beginAt, laps: room.laps, track: room.track });
      console.log(`[room] ${room.code} 开始比赛，${room.clients.size} 位车手`);
      break;
    }

    case 'finish': {
      if (client.finished) return;
      client.finished = true;
      client.finishTime = Number(msg.time) || 0;
      client.timeOffset = Date.now() - room.beginAt;
      broadcast(room, {
        t: 'event', kind: 'finish', id: client.id, name: client.name, time: client.finishTime,
      });
      updateRanks(room);
      broadcast(room, { t: 'roster', players: roomRoster(room), hostId: room.hostId });
      const allDone = [...room.clients.values()].every((c) => c.finished);
      if (allDone) endRace(room);
      else if (!room.endTimer) room.endTimer = setTimeout(() => endRace(room), 60000);
      break;
    }

    case 'ping':
      send(client, { t: 'pong', ts: msg.ts });
      client.lastSeen = Date.now();
      break;

    default:
      break;
  }
}

function endRace(room) {
  if (room.endTimer) { clearTimeout(room.endTimer); room.endTimer = null; }
  if (!room.started) return;
  updateRanks(room);
  const results = [...room.clients.values()]
    .sort((a, b) => a.rank - b.rank)
    .map((c) => ({
      id: c.id, name: c.name, paint: c.paint, rank: c.rank,
      finished: !!c.finished, finishTime: c.finishTime || 0,
    }));
  room.results = results;
  room.started = false;
  broadcast(room, { t: 'results', results });
  console.log(`[room] ${room.code} 比赛结束：${results.map((r) => r.name).join(' / ')}`);
}

/* ============================ 快照广播 ================================== */
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    // 清理僵尸客户端
    for (const c of [...room.clients.values()]) {
      const silent = now - (c.lastSeen || now);
      const dead = (!c.ws && silent > POLL_TIMEOUT_MS) || (c.ws && c.ws.destroyed);
      if (dead) leaveRoom(room, c, '超时/断开');
    }
    if (room.clients.size === 0) {
      if (room.emptyAt && now - room.emptyAt > ROOM_TTL_MS) {
        rooms.delete(room.code);
        console.log(`[room] 回收空房间 ${room.code}`);
      }
      continue;
    }
    if (!room.clients.size) continue;
    updateRanks(room);
    const cars = [];
    for (const c of room.clients.values()) {
      if (!c.state) continue;
      cars.push({
        id: c.id, p: c.state.p, h: c.state.h, v: c.state.v,
        lap: c.state.lap, idx: c.state.idx, drift: c.state.drift,
        off: c.state.off, fin: c.finished ? 1 : 0, rank: c.rank,
      });
    }
    if (cars.length) broadcast(room, { t: 'snap', ts: now, cars });
  }
}, Math.round(1000 / SNAP_HZ));

// 超时未开始的房间也回收
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (!room.started && room.clients.size > 0 && now - room.createdAt > 30 * 60 * 1000) {
      for (const c of room.clients.values()) send(c, { t: 'error', msg: '房间超时，已关闭' });
      rooms.delete(room.code);
    }
  }
}, 60000);

/* ============================ HTTP ====================================== */
function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  // 只允许访问白名单目录，避免路径穿越
  const allowed = ['/src/', '/vendor/', '/index.html', '/favicon.svg', '/favicon.ico'];
  const okPath = allowed.some((a) => urlPath === a || urlPath.startsWith(a));
  if (!okPath) { res.writeHead(404); res.end('not found'); return; }

  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, rooms: rooms.size,
      players: [...rooms.values()].reduce((a, r) => a + r.clients.size, 0),
      uptime: Math.round(process.uptime()),
    }));
    return;
  }

  /* ---- 轮询通道：一次请求同时完成"取消息"和"发消息" ---- */
  if (url === '/api/poll' && req.method === 'POST') {
    const body = await readBody(req);
    // create 请求还没有房间码，允许 room 缺省
    if (!body || (!body.room && !body.create)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad request' }));
      return;
    }
    const room = body.create
      ? createRoom(body.track || 'coast', body.laps || 3, body.level || 'normal')
      : rooms.get(String(body.room).toUpperCase());

    if (!room) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'room_not_found' }));
      return;
    }

    let client = body.id ? room.clients.get(body.id) : null;
    if (body.create) {
      client = {
        id: 'p' + (nextClientId++), name: '车主', paint: 0, ws: null,
        queue: [], lastSeen: Date.now(), state: null, rank: 1,
      };
      room.clients.set(client.id, client);
      room.hostId = client.id;
    } else if (!client) {
      if (room.clients.size >= MAX_PLAYERS) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'room_full' }));
        return;
      }
      client = {
        id: 'p' + (nextClientId++), name: '车手', paint: 0, ws: null,
        queue: [], lastSeen: Date.now(), state: null, rank: 1,
      };
      room.clients.set(client.id, client);
    }
    client.lastSeen = Date.now();

    if (body.msg) handleMessage(room, client, body.msg);

    const msgs = client.queue.map((t) => JSON.parse(t));
    client.queue.length = 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: client.id, room: room.code, msgs }));
    return;
  }

  if (url.startsWith('/api/room/')) {
    const room = rooms.get(url.slice('/api/room/'.length).toUpperCase());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(room
      ? { exists: true, players: room.clients.size, started: room.started, track: room.track }
      : { exists: false }));
    return;
  }

  if (req.method === 'GET') { serveStatic(req, res); return; }
  res.writeHead(405); res.end('method not allowed');
});

/* ============================ WebSocket 升级 ============================= */
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`
  );
  socket.setNoDelay(true);

  let client = null;
  let room = null;
  let buf = Buffer.alloc(0);
  let fragOpcode = 0;
  let fragParts = [];

  const ctx = {
    id: 'p' + (nextClientId++),
    name: '车手', paint: 0, ws: socket,
    queue: [], lastSeen: Date.now(), state: null, rank: 1,
  };
  client = ctx;
  client.lastSeen = Date.now();

  // 先挂一个"未入房"状态：等 hello 消息决定 create/join
  const pending = { create: false, track: 'coast', laps: 3, level: 'normal', joinCode: null, helloed: false };

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const { frames, rest } = decodeFrames(buf);
    buf = rest;

    for (const f of frames) {
      if (f.opcode === 0x8) {                       // close
        try { socket.write(encodeClose()); } catch (e) { }
        socket.end();
        return;
      }
      if (f.opcode === 0x9) {                       // ping → pong
        const pong = Buffer.concat([Buffer.from([0x8a, f.payload.length]), f.payload]);
        try { socket.write(pong); } catch (e) { }
        continue;
      }
      if (f.opcode === 0xa) continue;               // pong

      // 分片重组
      if (f.opcode === 0x0) fragParts.push(f.payload);
      else { fragOpcode = f.opcode; fragParts = [f.payload]; }
      if (!f.fin) continue;

      const text = Buffer.concat(fragParts).toString('utf8');
      fragParts = [];
      if (fragOpcode !== 0x1) continue;             // 只处理文本帧

      let msg;
      try { msg = JSON.parse(text); } catch (e) { continue; }
      client.lastSeen = Date.now();

      /* --- 入房握手 --- */
      if (!pending.helloed && msg.t === 'hello') {
        pending.helloed = true;
        pending.create = msg.mode === 'create';
        pending.track = msg.track || 'coast';
        pending.laps = msg.laps || 3;
        pending.level = msg.level || 'normal';
        pending.joinCode = msg.room ? String(msg.room).toUpperCase() : null;

        if (pending.create) {
          room = createRoom(pending.track, pending.laps, pending.level);
          room.hostId = client.id;
          room.clients.set(client.id, client);
          console.log(`[ws] ${client.id} 创建房间 ${room.code}`);
        } else {
          room = rooms.get(pending.joinCode);
          if (!room) { send(client, { t: 'error', msg: 'room_not_found' }); socket.end(); return; }
          if (room.clients.size >= MAX_PLAYERS) {
            send(client, { t: 'error', msg: 'room_full' }); socket.end(); return;
          }
          if (room.started) { send(client, { t: 'error', msg: 'race_started' }); socket.end(); return; }
          room.clients.set(client.id, client);
          console.log(`[ws] ${client.id} 加入房间 ${room.code}`);
        }
        handleMessage(room, client, msg);
        continue;
      }

      if (!room) { send(client, { t: 'error', msg: 'not_in_room' }); continue; }
      handleMessage(room, client, msg);
    }
  });

  socket.on('close', () => { if (room) leaveRoom(room, client, 'ws close'); });
  socket.on('error', () => { if (room) leaveRoom(room, client, 'ws error'); });
  socket.on('end', () => { if (room) leaveRoom(room, client, 'ws end'); });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`DRIFT RUSH 服务器已启动: http://0.0.0.0:${PORT}`);
  console.log(`静态目录: ${ROOT}`);
});
