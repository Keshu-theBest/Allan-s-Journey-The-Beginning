import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createGameServer } from '../server.mjs';
import { SUITS, TOTAL_ROUNDS, MAX_PLAYERS, RULES_VERSION } from '../rules.js';

async function fixture(t, options = {}) {
  const server = createGameServer({ roundMs: 3000, revealMs: 25, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const controllers = [];
  t.after(async () => {
    for (const controller of controllers) controller.abort();
    await new Promise(resolve => server.close(resolve));
  });
  async function request(path, { method = 'GET', data, token, status = 200 } = {}) {
    const response = await fetch(base + path, {
      method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  const create = (name = 'Host', practice = false) => request('/api/rooms', { method: 'POST', status: 201, data: { name, practice, acceptedRules: RULES_VERSION } });
  const join = (room, name) => request(`/api/rooms/${room.roomCode}/join`, { method: 'POST', status: 201, data: { name, acceptedRules: RULES_VERSION } });
  const action = (player, action, data = {}, status = 200) => request(`/api/rooms/${player.roomCode}/${action}`, { method: 'POST', token: player.token, data, status });
  const state = player => request(`/api/rooms/${player.roomCode}/state`, { token: player.token });
  async function events(player) {
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(`${base}/api/rooms/${player.roomCode}/events?token=${player.token}`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const messages = [];
    const done = (async () => {
      let buffer = '';
      try {
        for await (const chunk of response.body) {
          buffer += new TextDecoder().decode(chunk);
          let at;
          while ((at = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            const event = frame.match(/^event: (.+)$/m)?.[1];
            const data = frame.match(/^data: (.+)$/m)?.[1];
            if (event && data) messages.push({ event, data: JSON.parse(data) });
          }
        }
      } catch (error) { if (error.name !== 'AbortError') throw error; }
    })();
    return { messages, close: () => controller.abort(), done };
  }
  return { base, request, create, join, action, state, events };
}

async function until(get, predicate, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await get();
    if (predicate(value)) return value;
    await delay(10);
  }
  throw new Error('Timed out waiting for game state.');
}

test('rules acceptance, authentication, host authority, and card validation are enforced', async t => {
  const api = await fixture(t);
  await api.request('/api/rooms', { method: 'POST', data: { name: 'No consent' }, status: 400 });
  await api.request('/api/rooms', { method: 'POST', data: { name: 'x'.repeat(25), acceptedRules: RULES_VERSION }, status: 400 });
  const host = await api.create();
  await api.action(host, 'start', {}, 409);
  await api.request(`/api/rooms/${host.roomCode}/state`, { token: 'wrong', status: 401 });
  await api.request(`/api/rooms/${host.roomCode}/join`, { method: 'POST', data: { name: 'Guest' }, status: 400 });
  const guest = await api.join(host, 'Guest');
  await api.request(`/api/rooms/${host.roomCode}/join`, { method: 'POST', data: { name: 'guest', acceptedRules: RULES_VERSION }, status: 409 });
  await api.action(guest, 'start', {}, 403);
  await api.action(host, 'start');
  await api.request(`/api/rooms/${host.roomCode}/join`, { method: 'POST', data: { name: 'Late', acceptedRules: RULES_VERSION }, status: 409 });
  for (const data of [{ value: 1, suit: 'hearts' }, { value: 11, suit: 'hearts' }, { value: 2.5, suit: 'hearts' }, { value: '2', suit: 'hearts' }, { value: 2, suit: 'fake' }]) await api.action(host, 'choose', data, 400);
  await api.action(host, 'choose', { value: 3, suit: 'hearts' });
  await api.action(host, 'choose', { value: 4, suit: 'diamonds' }, 409);
  const hidden = await api.state(guest);
  assert.equal(hidden.results, null);
  assert.equal(hidden.you.choice, null);
  assert.equal(hidden.players.find(p => p.id === host.playerId).submitted, true);
  assert.equal('choice' in hidden.players[0], false);
  assert.equal('usedValues' in hidden.players[0], false);
  assert.equal(JSON.stringify(hidden).includes(host.token), false);
  await api.action(guest, 'choose', { value: 9, suit: 'diamonds' });
  const reveal = await api.state(host);
  assert.equal(reveal.phase, 'reveal');
  assert.equal(reveal.results.average, 6);
  assert.equal(reveal.results.target, 2 + (2 / 3) * 4);
  assert.equal(reveal.results.scores.length, 2);
  assert.deepEqual(reveal.results.modes, ['hearts', 'diamonds']);
  await until(() => api.state(host), s => s.round === 2 && s.phase === 'choosing');
  await api.action(host, 'choose', { value: 3, suit: 'clubs' }, 409);
  await api.action(host, 'choose', { value: 4, suit: 'clubs', round: 1 }, 409);
});

test('six rounds complete with a cumulative leaderboard and no value reuse', async t => {
  const api = await fixture(t);
  const host = await api.create();
  const guest = await api.join(host, 'Guest');
  await api.action(host, 'start');
  let last;
  for (let round = 1; round <= TOTAL_ROUNDS; round++) {
    await until(() => api.state(host), s => s.round === round && s.phase === 'choosing');
    await api.action(host, 'choose', { value: round + 1, suit: 'hearts' });
    last = await api.action(guest, 'choose', { value: round + 1, suit: 'hearts' });
    assert.equal(last.phase, round === TOTAL_ROUNDS ? 'finished' : 'reveal');
    assert.equal(last.history.length, round);
  }
  assert.equal(last.deadline, null);
  assert.equal(last.you.usedValues.length, 6);
  const expected = Math.round(last.history.reduce((sum, result) => sum + result.scores.find(row => row.playerId === host.playerId).points, 0) * 100) / 100;
  assert.equal(last.players.find(p => p.id === host.playerId).score, expected);
  await api.action(host, 'choose', { value: 10, suit: 'clubs' }, 409);
});

test('timeouts penalize missing players, exclude them from averages, and advance without a host action', async t => {
  const api = await fixture(t, { roundMs: 120, revealMs: 40 });
  const host = await api.create();
  const guest = await api.join(host, 'Absent');
  await api.action(host, 'start');
  await api.action(host, 'choose', { value: 8, suit: 'spades' });
  const result = await until(() => api.state(host), s => s.history.length >= 1);
  assert.equal(result.history[0].average, 8);
  const absent = result.history[0].scores.find(s => s.playerId === guest.playerId);
  assert.equal(absent.points, -15);
  assert.equal(absent.missed, true);
  assert.equal(absent.value, null);
  const finished = await until(() => api.state(guest), s => s.phase === 'finished');
  assert.equal(finished.history.length, 6);
  assert.equal(finished.history[1].average, null);
  assert.deepEqual(finished.history[1].modes, []);
  assert.equal(finished.players.find(p => p.id === guest.playerId).score, -90);
  assert.deepEqual(finished.you.usedValues, []);
});

test('SSE keeps cards private, supports reconnects, and transfers abandoned lobby hosts', async t => {
  const api = await fixture(t, { hostGraceMs: 50, revealMs: 100 });
  const host = await api.create();
  const guest = await api.join(host, 'Guest');
  const hostStream = await api.events(host);
  const guestStream = await api.events(guest);
  await until(() => hostStream.messages, messages => messages.some(m => m.event === 'state'));
  hostStream.close();
  await until(() => api.state(guest), s => s.hostId === guest.playerId);
  await api.action(host, 'start', {}, 403);
  const reconnected = await api.events(host);
  const secondTab = await api.events(host);
  await api.action(guest, 'start');
  await api.action(host, 'choose', { value: 10, suit: 'clubs' });
  await until(() => guestStream.messages, messages => messages.some(m => m.event === 'players' && m.data.players.find(p => p.id === host.playerId)?.submitted));
  const snapshots = guestStream.messages.filter(m => m.event === 'state');
  assert(snapshots.every(m => !m.data.players.some(p => 'choice' in p || 'token' in p || 'usedValues' in p)));
  await until(() => secondTab.messages, messages => messages.some(m => m.event === 'state' && m.data.you.choice?.value === 10));
  assert.equal((await api.state(host)).you.choice.value, 10);
  secondTab.close();
  reconnected.close();
  const again = await api.events(host);
  const latest = await until(() => again.messages, messages => messages.find(m => m.event === 'state')?.data.you.choice?.value === 10);
  assert.equal(latest.find(m => m.event === 'state').data.you.id, host.playerId);
});

test('practice adds seven bots, hides their cards, and scores a full table', async t => {
  const api = await fixture(t);
  const host = await api.create('Practice Player', true);
  await api.request(`/api/rooms/${host.roomCode}/join`, { method: 'POST', status: 403, data: { name: 'Intruder', acceptedRules: RULES_VERSION } });
  const started = await api.action(host, 'start');
  assert.equal(started.players.length, 8);
  assert.equal(started.players.filter(p => p.isBot && p.submitted).length, 7);
  assert.equal(started.results, null);
  const result = await api.action(host, 'choose', { value: 5, suit: 'diamonds' });
  assert.equal(result.phase, 'reveal');
  assert.equal(result.results.scores.length, 8);
});

test('160 simultaneous SSE seats complete all six rounds and the 161st seat is rejected', { timeout: 30_000 }, async t => {
  const api = await fixture(t, { roundMs: 10_000, revealMs: 80 });
  const host = await api.create('Player 0');
  const players = [host, ...await Promise.all(Array.from({ length: MAX_PLAYERS - 1 }, (_, i) => api.join(host, `Player ${i + 1}`)))];
  await api.request(`/api/rooms/${host.roomCode}/join`, { method: 'POST', status: 409, data: { name: 'Player 160', acceptedRules: RULES_VERSION } });
  const streams = await Promise.all(players.map(p => api.events(p)));
  await api.action(host, 'start');
  for (let round = 1; round <= TOTAL_ROUNDS; round++) {
    await until(() => api.state(host), s => s.phase === 'choosing' && s.round === round);
    await Promise.all(players.map((player, i) => api.action(player, 'choose', { value: 2 + ((i + round - 1) % 9), suit: SUITS[i % 4] })));
    const state = await api.state(host);
    assert.equal(state.history.length, round);
    assert.equal(state.history.at(-1).scores.length, MAX_PLAYERS);
    assert(state.history.at(-1).scores.every(row => !row.missed && Number.isFinite(row.totalScore)));
  }
  const finished = await until(() => api.state(host), s => s.phase === 'finished');
  assert.equal(finished.players.length, MAX_PLAYERS);
  await until(() => streams, list => list.every(stream => stream.messages.some(m => m.event === 'state' && m.data.phase === 'finished')));
  assert.equal(finished.history.length, TOTAL_ROUNDS);
});

test('leaving a lobby transfers the host and leaving the last seat removes the room', async t => {
  const api = await fixture(t);
  const host = await api.create();
  const guest = await api.join(host, 'Guest');
  await api.action(host, 'leave');
  assert.equal((await api.state(guest)).hostId, guest.playerId);
  await api.request(`/api/rooms/${host.roomCode}/state`, { token: host.token, status: 401 });
  await api.action(guest, 'leave');
  await api.request(`/api/rooms/${guest.roomCode}/state`, { token: guest.token, status: 404 });
});

test('static source boundaries, request size and origin restrictions protect the server', async t => {
  const api = await fixture(t);
  const response = await fetch(api.base + '/rules.js');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /javascript/);
  for (const path of ['/server.mjs', '/.git/config', '/%2e%2e%2fserver.mjs', '/%2f..%2fserver.mjs']) {
    const denied = await fetch(api.base + path);
    assert.equal(denied.status, 404);
  }
  const large = await fetch(api.base + '/api/rooms', { method: 'POST', body: JSON.stringify({ name: 'x'.repeat(9000) }) });
  assert.equal(large.status, 413);
  const foreign = await fetch(api.base + '/api/rooms', { method: 'POST', headers: { Origin: 'https://elsewhere.example' }, body: '{}' });
  assert.equal(foreign.status, 403);
});


test('a guest can inherit a lobby whose host never connected to events', async t => {
  const api = await fixture(t, { hostGraceMs: 30 });
  const host = await api.create();
  const guest = await api.join(host, 'Guest');
  await api.events(guest);
  await until(() => api.state(guest), s => s.hostId === guest.playerId);
  const started = await api.action(guest, 'start');
  assert.equal(started.phase, 'choosing');
});

test('a slow card request cannot act after its seat has left', async t => {
  const api = await fixture(t);
  const host = await api.create();
  await api.join(host, 'Guest');
  await api.action(host, 'start');
  let writer;
  const body = new ReadableStream({ start(controller) { writer = controller; } });
  const pending = fetch(`${api.base}/api/rooms/${host.roomCode}/choose`, {
    method: 'POST', headers: { Authorization: `Bearer ${host.token}`, 'Content-Type': 'application/json' }, body, duplex: 'half',
  });
  writer.enqueue(new TextEncoder().encode('{"value":'));
  await delay(30);
  await api.action(host, 'leave');
  writer.enqueue(new TextEncoder().encode('3,"suit":"hearts"}'));
  writer.close();
  assert.equal((await pending).status, 401);
});
