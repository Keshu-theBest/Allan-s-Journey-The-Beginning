import http from 'node:http';
import { randomBytes, randomUUID, randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUITS, VALUES, RULES_VERSION, TOTAL_ROUNDS, ROUND_SECONDS, REVEAL_SECONDS, MAX_PLAYERS, MISSED_ROUND_PENALTY, scoreRound } from './rules.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(ROOT, 'public');
const COLORS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function body(req) {
  return new Promise((resolveBody, reject) => {
    let text = '', size = 0, done = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (done) return;
      if (size > 8192) { done = true; reject(new HttpError(413, 'Request is too large.')); return; }
      text += chunk;
    });
    req.on('end', () => {
      if (done) return;
      try {
        const parsed = JSON.parse(text || '{}');
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error();
        resolveBody(parsed);
      } catch { reject(new HttpError(400, 'Send a valid JSON object.')); }
    });
    req.on('error', () => reject(new HttpError(400, 'Could not read the request.')));
  });
}

function validatePlayer(data) {
  if (data.acceptedRules !== RULES_VERSION) throw new HttpError(400, 'Read and accept the current rules before joining.');
  if (typeof data.name !== 'string') throw new HttpError(400, 'Enter a player name.');
  const name = data.name.trim();
  if (!name || [...name].length > 24 || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) throw new HttpError(400, 'Use a name of 1–24 characters without control characters.');
  return name;
}

/** One authoritative in-memory game process. Options shorten clocks for integration tests. */
export function createGameServer({ roundMs = ROUND_SECONDS * 1000, revealMs = REVEAL_SECONDS * 1000, roomTtlMs = 60 * 60 * 1000, maxRooms = 200, hostGraceMs = 15_000, rateLimit = true } = {}) {
  const rooms = new Map();
  const rates = new Map();
  const streams = new Set();

  function limit(key, maximum, duration = 60_000) {
    if (!rateLimit) return;
    const now = Date.now();
    let bucket = rates.get(key);
    if (!bucket || bucket.until <= now) { bucket = { count: 0, until: now + duration }; rates.set(key, bucket); }
    if (++bucket.count > maximum) throw new HttpError(429, 'Too many requests. Please wait a moment and try again.');
  }

  function newPlayer(name, isBot = false) {
    return { id: randomUUID(), token: randomBytes(32).toString('hex'), name, isBot, score: 0, usedValues: [], choice: null, connections: new Set(), active: true };
  }

  function connected(p) { return p.isBot || p.connections.size > 0; }

  function publicPlayers(room) {
    return room.players.map(p => ({ id: p.id, name: p.name, score: p.score, connected: connected(p), isBot: p.isBot, submitted: !!p.choice, active: p.active }));
  }

  function state(room, viewer) {
    return {
      code: room.code, phase: room.phase, round: room.round, totalRounds: TOTAL_ROUNDS,
      deadline: room.deadline, serverNow: Date.now(), hostId: room.hostId, practice: room.practice,
      players: publicPlayers(room),
      you: { id: viewer.id, usedValues: [...viewer.usedValues], choice: viewer.choice ? { ...viewer.choice } : null },
      results: room.results, history: room.history,
    };
  }

  function writeState(res, room, player) {
    // Slow readers must reconnect rather than build an unbounded write buffer.
    if (res.writableLength > 256 * 1024) { res.destroy(); return; }
    res.write(`event: state\ndata: ${JSON.stringify(state(room, player))}\n\n`);
  }

  function broadcast(room) {
    clearTimeout(room.playersTimer);
    room.playersTimer = null;
    for (const player of room.players) for (const res of player.connections) writeState(res, room, player);
  }

  function broadcastPlayers(room) {
    if (room.playersTimer) return;
    room.playersTimer = setTimeout(() => {
      room.playersTimer = null;
      if (!rooms.has(room.code)) return;
      const message = `event: players\ndata: ${JSON.stringify({ players: publicPlayers(room), hostId: room.hostId, serverNow: Date.now() })}\n\n`;
      for (const player of room.players) for (const res of player.connections) {
        if (res.writableLength > 256 * 1024) res.destroy();
        else res.write(message);
      }
    }, 75);
    room.playersTimer.unref();
  }

  function considerHostTransfer(room, player) {
    if (room.phase !== 'lobby' || room.hostId !== player.id || connected(player)) return;
    if (room.hostTimer) return;
    room.hostTimer = setTimeout(() => {
      room.hostTimer = null;
      if (!rooms.has(room.code) || room.phase !== 'lobby' || room.hostId !== player.id || connected(player)) return;
      const successor = room.players.find(p => p.active && !p.isBot && connected(p));
      if (successor) { room.hostId = successor.id; broadcastPlayers(room); }
    }, hostGraceMs);
    room.hostTimer.unref();
  }

  function schedule(room, delay, callback) {
    clearTimeout(room.timer);
    room.deadline = Date.now() + delay;
    room.timer = setTimeout(() => { if (rooms.has(room.code)) callback(); }, delay);
    room.timer.unref();
  }

  function chooseBot(room, player) {
    const available = VALUES.filter(value => !player.usedValues.includes(value));
    const previous = room.history.at(-1);
    let value;
    if (randomInt(4) === 0 || !previous?.target) value = available[randomInt(available.length)];
    else {
      const aim = previous.target + randomInt(5) - 2;
      value = [...available].sort((a, b) => Math.abs(a - aim) - Math.abs(b - aim))[0];
    }
    const suit = previous?.modes?.length && randomInt(3) !== 0 ? previous.modes[randomInt(previous.modes.length)] : SUITS[randomInt(SUITS.length)];
    player.choice = { value, suit };
    player.usedValues.push(value);
  }

  function beginRound(room) {
    room.phase = 'choosing';
    room.round++;
    room.results = null;
    for (const player of room.players) {
      player.choice = null;
      if (player.isBot && player.active) chooseBot(room, player);
    }
    schedule(room, roundMs, () => finishRound(room));
    broadcast(room);
    if (room.players.filter(p => p.active).every(p => p.choice)) finishRound(room);
  }

  function finishRound(room) {
    if (room.phase !== 'choosing') return;
    clearTimeout(room.timer);
    const selected = room.players.filter(p => p.choice).map(p => ({ playerId: p.id, ...p.choice }));
    const scored = selected.length ? scoreRound(selected) : { average: null, target: null, counts: Object.fromEntries(SUITS.map(s => [s, 0])), modes: [], scores: [] };
    const byId = new Map(scored.scores.map(row => [row.playerId, row]));
    const scores = room.players.map(player => {
      const row = byId.get(player.id) ?? { playerId: player.id, value: null, suit: null, valuePoints: 0, suitPoints: 0, crowdingPenalty: 0, points: MISSED_ROUND_PENALTY, missed: true };
      player.score = Math.round((player.score + row.points) * 100) / 100;
      return { ...row, missed: row.missed ?? false, name: player.name, totalScore: player.score };
    });
    room.results = { round: room.round, ...scored, scores };
    room.history.push(room.results);
    room.phase = room.round >= TOTAL_ROUNDS ? 'finished' : 'reveal';
    room.lastActivity = Date.now();
    if (room.phase === 'finished') room.deadline = null;
    else schedule(room, revealMs, () => beginRound(room));
    broadcast(room);
  }

  function expireRoom(room) {
    clearTimeout(room.timer);
    clearTimeout(room.hostTimer);
    clearTimeout(room.playersTimer);
    rooms.delete(room.code);
    for (const p of room.players) for (const res of p.connections) {
      res.write('event: expired\ndata: {}\n\n');
      res.end();
    }
  }

  const upkeep = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      if (now - room.lastActivity > roomTtlMs && !room.players.some(p => p.connections.size)) expireRoom(room);
      else for (const p of room.players) for (const res of p.connections) res.write(': heartbeat\n\n');
    }
    for (const [key, bucket] of rates) if (bucket.until <= now) rates.delete(key);
  }, 15_000);
  upkeep.unref();

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    function json(status, value) {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    }
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      const ip = req.socket.remoteAddress || 'unknown';
      if (req.method === 'GET' && path === '/health') { json(200, { ok: true }); return; }
      if (path.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store');
        limit(`ip:${ip}`, 6000);
        if (req.headers.origin) {
          let origin;
          try { origin = new URL(req.headers.origin); } catch { throw new HttpError(403, 'Invalid request origin.'); }
          if (origin.host !== req.headers.host) throw new HttpError(403, 'Cross-origin requests are not allowed.');
        }
        if (req.method === 'POST' && path === '/api/rooms') {
          limit(`create:${ip}`, 20, 300_000);
          const data = await body(req);
          const name = validatePlayer(data);
          if (data.practice !== undefined && typeof data.practice !== 'boolean') throw new HttpError(400, 'Practice must be true or false.');
          if (rooms.size >= maxRooms) throw new HttpError(503, 'All tables are occupied. Please try again later.');
          let code;
          do { code = Array.from({ length: 6 }, () => COLORS[randomInt(COLORS.length)]).join(''); } while (rooms.has(code));
          const host = newPlayer(name);
          const room = { code, hostId: host.id, phase: 'lobby', round: 0, deadline: null, players: [host], results: null, history: [], timer: null, lastActivity: Date.now(), practice: data.practice === true };
          if (room.practice) for (const name of ['Ada', 'Nash', 'Emmy', 'Turing', 'Schelling', 'Noether', 'Pascal']) room.players.push(newPlayer(`${name} Bot`, true));
          rooms.set(code, room);
          json(201, { token: host.token, roomCode: code, playerId: host.id }); return;
        }
        const match = path.match(/^\/api\/rooms\/([A-Za-z0-9]{6})\/(join|state|events|start|choose|leave)$/);
        if (!match) throw new HttpError(404, 'Endpoint not found.');
        const [, rawCode, action] = match;
        const room = rooms.get(rawCode.toUpperCase());
        if (!room) throw new HttpError(404, 'Room not found. It may have expired.');
        if (action === 'join' && req.method === 'POST') {
          limit(`join:${ip}`, 1000);
          const data = await body(req);
          if (rooms.get(room.code) !== room) throw new HttpError(404, 'This room has expired.');
          const name = validatePlayer(data);
          if (room.practice) throw new HttpError(403, 'Practice tables are private. Create a multiplayer table to invite friends.');
          if (room.phase !== 'lobby') throw new HttpError(409, 'This match has already started.');
          if (room.players.length >= MAX_PLAYERS) throw new HttpError(409, `This room is full (${MAX_PLAYERS} players).`);
          if (room.players.some(p => p.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new HttpError(409, 'That name is already at this table.');
          const player = newPlayer(name);
          room.players.push(player);
          room.lastActivity = Date.now();
          json(201, { token: player.token, roomCode: room.code, playerId: player.id });
          broadcastPlayers(room); return;
        }
        const token = action === 'events' ? url.searchParams.get('token') : req.headers.authorization?.replace(/^Bearer /, '');
        const player = room.players.find(p => p.token === token && p.active);
        if (!player) throw new HttpError(401, 'Your seat could not be verified. Rejoin the table.');
        limit(`player:${player.id}`, 180);
        room.lastActivity = Date.now();
        if (action === 'state' && req.method === 'GET') { json(200, state(room, player)); return; }
        if (action === 'events' && req.method === 'GET') {
          if (player.connections.size >= 3) throw new HttpError(429, 'This seat already has three open connections. Close an extra tab.');
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.write('retry: 2000\n\n');
          streams.add(res);
          player.connections.add(res);
          if (player.id === room.hostId) { clearTimeout(room.hostTimer); room.hostTimer = null; }
          else {
            const host = room.players.find(p => p.id === room.hostId);
            if (host) considerHostTransfer(room, host);
          }
          writeState(res, room, player);
          broadcastPlayers(room);
          res.on('close', () => {
            streams.delete(res);
            player.connections.delete(res);
            if (rooms.has(room.code)) { considerHostTransfer(room, player); broadcastPlayers(room); }
          });
          return;
        }
        if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
        if (action === 'start') {
          await body(req);
          if (!player.active || rooms.get(room.code) !== room) throw new HttpError(401, 'Your seat is no longer active.');
          if (player.id !== room.hostId) throw new HttpError(403, 'Only the host can start this table.');
          if (room.phase !== 'lobby') throw new HttpError(409, 'This match has already started.');
          if (room.players.length < 2) throw new HttpError(409, 'At least two players are required. Invite a friend or play practice.');
          beginRound(room);
          json(200, state(room, player)); return;
        }
        if (action === 'choose') {
          const requestRound = room.round;
          const data = await body(req);
          if (!player.active || rooms.get(room.code) !== room) throw new HttpError(401, 'Your seat is no longer active.');
          if (room.round !== requestRound || (data.round !== undefined && data.round !== room.round)) throw new HttpError(409, 'That round has ended. Choose a card for the current round.');
          if (room.phase !== 'choosing' || Date.now() >= room.deadline) throw new HttpError(409, 'Card selection is closed for this round.');
          if (player.choice) throw new HttpError(409, 'Your card is already locked in.');
          if (!Number.isInteger(data.value) || !VALUES.includes(data.value) || !SUITS.includes(data.suit)) throw new HttpError(400, 'Choose a number from 2 to 10 and a valid suit.');
          if (player.usedValues.includes(data.value)) throw new HttpError(409, 'That value has already been used this match.');
          player.choice = { value: data.value, suit: data.suit };
          player.usedValues.push(data.value);
          if (room.players.filter(p => p.active).every(p => p.choice)) finishRound(room);
          else {
            for (const stream of player.connections) writeState(stream, room, player);
            broadcastPlayers(room);
          }
          json(200, state(room, player)); return;
        }
        if (action === 'leave') {
          await body(req);
          if (!player.active || rooms.get(room.code) !== room) throw new HttpError(401, 'Your seat is no longer active.');
          player.active = false;
          for (const stream of player.connections) stream.end();
          if (room.phase === 'lobby') room.players = room.players.filter(p => p !== player);
          if (room.hostId === player.id) room.hostId = room.players.find(p => p.active && !p.isBot)?.id ?? null;
          if (!room.players.some(p => p.active && !p.isBot)) expireRoom(room);
          else if (room.phase === 'choosing' && room.players.filter(p => p.active).every(p => p.choice)) finishRound(room);
          else broadcastPlayers(room);
          json(200, { ok: true }); return;
        }
        throw new HttpError(405, 'Method not allowed.');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
      let decoded;
      try { decoded = decodeURIComponent(path); } catch { throw new HttpError(400, 'Invalid path.'); }
      const target = decoded === '/rules.js' ? resolve(ROOT, 'rules.js') : resolve(PUBLIC, decoded === '/' ? 'index.html' : `.${decoded}`);
      if (target !== resolve(ROOT, 'rules.js') && !target.startsWith(PUBLIC + sep)) throw new HttpError(404, 'File not found.');
      let content;
      try { content = await readFile(target); } catch { throw new HttpError(404, 'File not found.'); }
      res.writeHead(200, { 'Content-Type': MIME[extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      if (!(error instanceof HttpError)) console.error('Request failed:', error.message);
      json(error.status || 500, { error: error instanceof HttpError ? error.message : 'Something went wrong. Please try again.' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  // close() must also release live event streams and timers, including in tests.
  const close = server.close.bind(server);
  server.close = callback => {
    clearInterval(upkeep);
    for (const room of rooms.values()) { clearTimeout(room.timer); clearTimeout(room.hostTimer); clearTimeout(room.playersTimer); }
    rooms.clear();
    for (const stream of streams) stream.end();
    return close(callback);
  };
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
  const server = createGameServer();
  server.listen(port, '0.0.0.0', () => console.log(`Common Suit is listening on port ${port}.`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
