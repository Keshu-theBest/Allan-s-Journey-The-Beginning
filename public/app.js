const app = document.querySelector('#app');
const dialog = document.querySelector('#rules-dialog');
const symbols = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' };
const suits = Object.keys(symbols);
const values = Array.from({ length: 9 }, (_, i) => i + 2);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const storage = { get(key) { try { return localStorage.getItem(key); } catch { return null; } }, set(key, value) { try { localStorage.setItem(key, value); } catch { /* Private storage is optional. */ } }, remove(key) { try { localStorage.removeItem(key); } catch { /* No stored session. */ } } };
const fmt = value => Number(value ?? 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const signed = value => `${value > 0 ? '+' : ''}${fmt(value)}`;
let session = null;
let state = null;
let stream = null;
let selectedValue = 6;
let selectedSuit = 'hearts';
let accepted = false;
let requestPending = false;
let online = true;
let clockOffset = 0;
let toastTimeout;
let lastPhase = '';
let lastRound = 0;
let lastFullTime = 0;
let lastPlayersTime = 0;
let previousFocus;

function toast(message) {
  const el = document.querySelector('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { el.hidden = true; }, 6500);
}

function openRules() {
  previousFocus = document.activeElement;
  if (!dialog.open) dialog.showModal();
}
function closeRules() {
  dialog.close();
  if (previousFocus?.isConnected) previousFocus.focus();
}
document.querySelector('#rules-nav').addEventListener('click', openRules);
document.querySelector('#close-rules').addEventListener('click', closeRules);
document.querySelector('#accept-rules').addEventListener('click', () => {
  accepted = true;
  const checkbox = document.querySelector('#rules-accepted');
  if (checkbox) checkbox.checked = true;
  closeRules();
  if (!session) toast('You’re ready. Choose how you’d like to play.');
});

function card(value, suit, extra = '') {
  const red = suit === 'hearts' || suit === 'diamonds';
  return `<div class="playing-card ${red ? 'red-card' : ''} ${extra}" aria-label="${escape(value)} of ${escape(suit)}"><span class="card-corner">${escape(value)}<small>${symbols[suit]}</small></span><span class="card-symbol" aria-hidden="true">${symbols[suit]}</span><span class="card-corner card-corner-bottom" aria-hidden="true">${escape(value)}<small>${symbols[suit]}</small></span></div>`;
}

function landing() {
  document.title = 'Common Suit — Read the room.';
  const code = new URL(location.href).searchParams.get('room') || '';
  app.innerHTML = `<section class="landing-hero">
    <div class="hero-copy"><div class="eyebrow"><span class="small-line"></span> A SOCIAL GAME OF STRATEGY</div><h1>Read the room.<br><em>Play your hand.</em></h1><p class="hero-description">One card. A room full of minds.<br>Guess what everyone else will do.<br>Then think one step further.</p><div class="hero-meta"><span><i aria-hidden="true">●</i> 2–160 players</span><span>6 rounds</span><span>Free to play</span></div></div>
    <div class="hero-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><span class="art-note">THE CROWD HAS A TELL.</span><div class="card-fan">${card(7, 'spades', 'fan-left')}${card(5, 'diamonds', 'fan-middle')}${card(3, 'clubs', 'fan-right')}</div><div class="art-seal"><span>THINK<br>TOGETHER.<br>PLAY APART.</span></div><span class="art-caption">Nº 001 — THE COMMON SUIT</span></div>
  </section>
  <section class="entry-section" aria-labelledby="entry-title"><div class="entry-intro"><div class="eyebrow">GOOD INSTINCTS WELCOME</div><h2 id="entry-title">Your seat at<br>the table.</h2><p>Bring your friends or test your instincts against seven bots. No account needed.</p><div class="entry-decoration" aria-hidden="true">♠ <span>♥ ♦</span> ♣</div></div>
  <form id="entry-form" class="entry-form"><label class="field-label" for="player-name">WHAT SHOULD WE CALL YOU?</label><input id="player-name" name="name" type="text" autocomplete="nickname" minlength="1" maxlength="24" placeholder="Your display name" value="${escape(storage.get('common-suit-name') || '')}" required><div class="consent"><input type="checkbox" id="rules-accepted" ${accepted ? 'checked' : ''}><label for="rules-accepted">I’ve read the <button class="inline-button" id="read-rules" type="button">rules & scoring</button> and understand how to play.</label></div><div class="entry-actions"><button class="button cream" id="create-room" type="submit">Create a room <span aria-hidden="true">→</span></button><button class="button outline-light" id="practice" type="button">Practice with bots</button></div><div class="join-divider"><span>OR JOIN YOUR PEOPLE</span></div><div class="join-fields"><label class="sr-only" for="room-code">Room code</label><input id="room-code" name="code" type="text" maxlength="8" autocomplete="off" spellcheck="false" placeholder="ROOM CODE" value="${escape(code)}"><button class="button outline-light" id="join-room" type="button">Join room <span aria-hidden="true">→</span></button></div><p class="form-note">Private rooms. Shared decisions. Unexpected results.</p></form></section>
  <section class="principles" aria-label="Game at a glance"><div class="principle"><span class="principle-number">01 /</span><h3>Choose in secret.</h3><p>Pick a number from 2 to 10 and a suit. Once locked, your choice is yours to live with.</p></div><div class="principle"><span class="principle-number">02 /</span><h3>Think below the average.</h3><p>Aim for two-thirds of the way from 2 to the table’s average. Save your best numbers for later.</p></div><div class="principle"><span class="principle-number">03 /</span><h3>Follow. Don’t crowd.</h3><p>The popular suit pays more. But a crowded suit costs points. Read the room, find your edge.</p></div></section>`;
  document.querySelector('#read-rules').addEventListener('click', openRules);
  document.querySelector('#rules-accepted').addEventListener('change', event => {
    if (event.target.checked && !accepted) { event.target.checked = false; openRules(); }
    else accepted = event.target.checked;
  });
  document.querySelector('#entry-form').addEventListener('submit', event => { event.preventDefault(); enter('create'); });
  document.querySelector('#practice').addEventListener('click', () => enter('practice'));
  document.querySelector('#join-room').addEventListener('click', () => enter('join'));
  document.querySelector('#room-code').addEventListener('input', event => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
}

async function api(path, body, method = 'POST') {
  const response = await fetch(path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(session ? { Authorization: `Bearer ${session.token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  // A hosting proxy can return HTML during an outage. Keep the HTTP status so
  // a temporary failure never looks like a corrupt saved browser session.
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Something went wrong. Please try again.');
    error.status = response.status;
    throw error;
  }
  return data;
}

async function enter(mode) {
  if (requestPending) return;
  const nameInput = document.querySelector('#player-name');
  if (!nameInput.reportValidity()) return;
  const name = nameInput.value.trim();
  if (!name) { toast('Enter a display name to take your seat.'); nameInput.focus(); return; }
  if (!accepted) { openRules(); return; }
  const code = document.querySelector('#room-code').value.trim().toUpperCase();
  if (mode === 'join' && !code) { toast('Enter the room code your host shared.'); document.querySelector('#room-code').focus(); return; }
  requestPending = true;
  document.querySelectorAll('.entry-form button').forEach(button => { button.disabled = true; });
  try {
    const credentials = await api(mode === 'join' ? `/api/rooms/${encodeURIComponent(code)}/join` : '/api/rooms', { name, acceptedRules: '1', ...(mode === 'practice' ? { practice: true } : {}) });
    session = credentials;
    storage.set('common-suit-name', name);
    storage.set(`common-suit-session-${session.roomCode}`, JSON.stringify(session));
    storage.set('common-suit-active', session.roomCode);
    history.replaceState(null, '', `/?room=${encodeURIComponent(session.roomCode)}`);
    await connect();
  } catch (error) { toast(error.message); if (session && !state) recoveryScreen(); }
  finally { requestPending = false; document.querySelectorAll('.entry-form button').forEach(button => { button.disabled = false; }); if (state) renderRoom(); }
}

function updateState(next) {
  const phaseOrder = { lobby: 0, choosing: 1, reveal: 2, finished: 3 };
  if (state && (next.round < state.round || (next.round === state.round && phaseOrder[next.phase] < phaseOrder[state.phase]))) return;
  if (next.serverNow < lastFullTime) return;
  lastFullTime = next.serverNow;
  if (state && next.serverNow < lastPlayersTime) next = { ...next, players: state.players, hostId: state.hostId };
  else lastPlayersTime = next.serverNow;
  if (state && next.round === state.round && next.phase === 'choosing' && state.you.choice && !next.you.choice) next = { ...next, you: state.you };
  clockOffset = next.serverNow - Date.now();
  if (lastRound !== next.round) {
    selectedValue = values.find(value => !next.you.usedValues.includes(value)) ?? 2;
    selectedSuit = 'hearts';
  }
  const phaseChanged = lastPhase !== next.phase;
  lastRound = next.round;
  lastPhase = next.phase;
  state = next;
  online = true;
  renderRoom();
  if (phaseChanged) document.querySelector('#phase-title')?.focus({ preventScroll: true });
}

async function connect() {
  stream?.close();
  const next = await api(`/api/rooms/${encodeURIComponent(session.roomCode)}/state`, undefined, 'GET');
  updateState(next);
  stream = new EventSource(`/api/rooms/${encodeURIComponent(session.roomCode)}/events?token=${encodeURIComponent(session.token)}`);
  const receive = event => { try { updateState(JSON.parse(event.data)); } catch { toast('A room update could not be read. Reconnecting…'); } };
  stream.addEventListener('state', receive);
  stream.addEventListener('message', receive);
  stream.addEventListener('players', event => {
    try {
      const update = JSON.parse(event.data);
      if (!state || update.serverNow < lastPlayersTime) return;
      lastPlayersTime = update.serverNow;
      state = { ...state, players: update.players, hostId: update.hostId, serverNow: update.serverNow };
      clockOffset = update.serverNow - Date.now();
      renderRoom();
    } catch { toast('A table update could not be read. Reconnecting…'); }
  });
  stream.addEventListener('open', () => { online = true; connectionDisplay(); });
  let checkingSeat = false;
  const connectedSession = session;
  stream.addEventListener('error', async () => {
    online = false; connectionDisplay();
    if (checkingSeat || session !== connectedSession) return;
    checkingSeat = true;
    try { await api(`/api/rooms/${connectedSession.roomCode}/state`, undefined, 'GET'); }
    catch (error) {
      if (session === connectedSession && (error.status === 401 || error.status === 404)) {
        clearSession(); landing(); toast('Your table is no longer available. Start a fresh game.');
      }
    } finally { checkingSeat = false; }
  });
  stream.addEventListener('expired', () => { clearSession(); landing(); toast('This room has expired. Create a new table to play again.'); });
}

function connectionDisplay() {
  const element = document.querySelector('#connection');
  if (element) { element.textContent = online ? 'LIVE TABLE' : 'RECONNECTING…'; element.classList.toggle('offline', !online); }
}

function clearSession() {
  stream?.close(); stream = null;
  if (session) storage.remove(`common-suit-session-${session.roomCode}`);
  storage.remove('common-suit-active');
  session = null; state = null; lastRound = 0; lastPhase = ''; lastFullTime = 0; lastPlayersTime = 0;
  history.replaceState(null, '', '/');
}

async function leave() {
  if (requestPending) return;
  if (state.phase === 'choosing' || state.phase === 'reveal') {
    if (!confirm('Leave this match? Unplayed rounds will count as missed (−15 points).')) return;
  }
  requestPending = true;
  try { await api(`/api/rooms/${state.code}/leave`, {}); clearSession(); landing(); }
  catch (error) {
    if (error.status === 401 || error.status === 404) { clearSession(); landing(); }
    else toast(error.message);
  }
  finally { requestPending = false; }
}

function rankedPlayers() {
  const sorted = [...state.players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  let rank = 1;
  return sorted.map((player, index) => { if (index === 0 || player.score !== sorted[index - 1].score) rank = index + 1; return { ...player, rank }; });
}

function leaderboard(full = false) {
  return `<section class="leaderboard ${full ? 'leaderboard-full' : ''}" aria-label="Leaderboard"><div class="panel-heading"><h3>${full ? 'The final standings' : 'The table'}</h3><span>${state.players.length} PLAYERS</span></div><div class="leaderboard-scroll"><table><thead><tr><th scope="col">Rank</th><th scope="col">Player</th><th scope="col">${state.phase === 'choosing' ? 'Status' : 'Round'}</th><th scope="col">Points</th></tr></thead><tbody>${rankedPlayers().map(player => {
    const score = state.results?.scores.find(row => row.playerId === player.id);
    const status = state.phase === 'choosing' ? (player.submitted ? '<span class="locked-dot">Locked</span>' : player.active === false ? 'Left' : 'Choosing') : score ? `<span class="${score.points < 0 ? 'negative' : 'positive'}">${signed(score.points)}</span>` : player.connected ? 'Ready' : 'Away';
    return `<tr class="${player.id === state.you.id ? 'your-row' : ''}"><td class="rank">${player.rank.toString().padStart(2, '0')}</td><th scope="row">${escape(player.name)}${player.id === state.you.id ? '<span class="you-tag">YOU</span>' : ''}${player.isBot ? '<span class="bot-tag">BOT</span>' : ''}${player.id === state.hostId ? '<span class="host-tag" aria-label="Host">♔</span>' : ''}</th><td class="player-status">${status}</td><td class="score-cell">${fmt(player.score)}</td></tr>`;
  }).join('')}</tbody></table></div></section>`;
}

function renderRoom() {
  const focusId = document.activeElement?.id;
  document.title = `${state.phase === 'finished' ? 'Final scores' : `Room ${state.code}`} — Common Suit`;
  const isHost = state.you.id === state.hostId;
  app.innerHTML = `<section class="room-shell"><div class="room-topbar"><div class="room-breadcrumb"><span id="connection" class="connection">LIVE TABLE</span><span class="separator">/</span><button id="copy-code" class="code-button" aria-label="Copy invite link for room ${escape(state.code)}">${escape(state.code)} <span aria-hidden="true"><svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="6" y="6" width="11" height="11" rx="1"/><path d="M13 6V3H3v10h3"/></svg></span></button>${state.practice ? '<span class="practice-label">PRACTICE</span>' : ''}</div><button class="text-button leave-button" id="leave-room">Leave table <span aria-hidden="true">→</span></button></div>${state.phase === 'lobby' ? lobby(isHost) : state.phase === 'choosing' ? choosing() : reveal()}${state.history.length && state.phase !== 'choosing' ? historyPanel() : ''}</section>`;
  document.querySelector('#leave-room').addEventListener('click', leave);
  document.querySelector('#copy-code').addEventListener('click', copyInvite);
  document.querySelector('#copy-invite')?.addEventListener('click', copyInvite);
  document.querySelector('#start-match')?.addEventListener('click', start);
  document.querySelector('#lock-card')?.addEventListener('click', choose);
  document.querySelector('#play-again')?.addEventListener('click', leave);
  document.querySelectorAll('[data-value]').forEach(button => button.addEventListener('click', () => { selectedValue = Number(button.dataset.value); renderRoom(); }));
  document.querySelectorAll('[data-suit]').forEach(button => button.addEventListener('click', () => { selectedSuit = button.dataset.suit; renderRoom(); }));
  document.querySelectorAll('.room-rules').forEach(button => button.addEventListener('click', openRules));
  connectionDisplay();
  updateTimer();
  if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
}

function lobby(isHost) {
  return `<div class="phase-heading"><div><span class="eyebrow">${state.practice ? 'THE PRACTICE TABLE' : 'MAKE YOURSELF AT HOME'}</span><h1 id="phase-title" tabindex="-1">The room is yours.</h1><p>${state.practice ? 'Seven different minds. One safe place to sharpen yours.' : 'Share the code. Gather your people. Let the mind games begin.'}</p></div><span class="round-marker">LOBBY <span>♣</span></span></div><div class="lobby-layout"><section class="lobby-invite"><div class="eyebrow">YOUR INVITATION</div><div class="large-code">${escape(state.code)}</div><button class="button primary" id="copy-invite">Copy invite link <span aria-hidden="true"><svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="6" y="6" width="11" height="11" rx="1"/><path d="M13 6V3H3v10h3"/></svg></span></button><div class="lobby-detail"><span>PLAYERS AT THE TABLE</span><strong>${state.players.length}<small> / 160</small></strong></div><p>${isHost ? 'You’re the host. Start when everyone is here; new players can join until then.' : 'Your host will start the match when everyone is here.'}</p><button class="button ${isHost && state.players.length >= 2 ? 'primary' : 'muted'} start-button" id="start-match" ${!isHost || state.players.length < 2 || requestPending ? 'disabled' : ''}>${isHost ? state.players.length < 2 ? 'Waiting for another player…' : 'Let’s play' : 'Waiting for the host…'} <span aria-hidden="true">→</span></button><button class="text-button room-rules">Review the rules</button></section>${leaderboard()}</div><div class="table-note"><span aria-hidden="true">✦</span><p><strong>A thought before we begin.</strong> Choosing what everyone chooses isn’t always your best move.</p></div>`;
}

function choosing() {
  const locked = Boolean(state.you.choice);
  const value = locked ? state.you.choice.value : selectedValue;
  const suit = locked ? state.you.choice.suit : selectedSuit;
  const count = state.players.filter(player => player.submitted).length;
  return `<div class="phase-heading"><div><span class="eyebrow">ROUND ${state.round} OF ${state.totalRounds} · CHOOSE IN SECRET</span><h1 id="phase-title" tabindex="-1">${locked ? 'Your move is made.' : 'What’s your read?'}</h1><p>${locked ? 'Sit tight. The table reveals when everyone locks in or time runs out.' : 'Think below the average. Find the suit. Keep your edge.'}</p></div><div class="timer" aria-label="Time remaining"><strong id="countdown">30</strong><span>SECONDS LEFT</span></div></div><div class="play-layout"><section class="selection-panel" aria-label="Choose your card"><div class="selection-main"><div class="card-preview">${card(value, suit)}<span class="preview-caption">${locked ? '✓ LOCKED IN' : 'YOUR NEXT MOVE'}</span></div><div class="card-controls"><div class="control-heading"><h2>Pick your number.</h2><span>USE EACH ONCE</span></div><div class="number-grid" role="group" aria-label="Card value">${values.map(v => `<button id="value-${v}" class="number-button ${value === v ? 'selected' : ''}" type="button" data-value="${v}" aria-label="${v}${state.you.usedValues.includes(v) && !(locked && value === v) ? ', already used' : ''}" aria-pressed="${value === v}" ${locked || state.you.usedValues.includes(v) ? 'disabled' : ''}>${v}${state.you.usedValues.includes(v) && !(locked && value === v) ? '<span class="used-mark" aria-hidden="true">/</span>' : ''}</button>`).join('')}</div><div class="control-heading suit-heading"><h2>Find your suit.</h2><span>READ THE ROOM</span></div><div class="suit-grid" role="group" aria-label="Card suit">${suits.map(s => `<button id="suit-${s}" type="button" data-suit="${s}" class="suit-button ${s === suit ? 'selected' : ''} ${s === 'hearts' || s === 'diamonds' ? 'red-suit' : ''}" aria-label="${s}" aria-pressed="${s === suit}" ${locked ? 'disabled' : ''}><span aria-hidden="true">${symbols[s]}</span><small>${s}</small></button>`).join('')}</div><button id="lock-card" class="button primary lock-button" ${locked || requestPending ? 'disabled' : ''}>${locked ? '✓ Card locked' : `Lock in ${value}${symbols[suit]}`}<span aria-hidden="true">${locked ? '' : '→'}</span></button><p class="lock-note">${locked ? 'Your choice stays secret until the reveal.' : 'A locked card can’t be changed. Trust your instinct.'}</p></div></div><div class="submission-bar"><span><strong>${count}</strong> / ${state.players.length} cards locked</span><div class="progress-track" role="progressbar" aria-label="Cards locked" aria-valuemin="0" aria-valuemax="${state.players.length}" aria-valuenow="${count}"><span style="width:${count / state.players.length * 100}%"></span></div></div></section>${leaderboard()}</div><div class="round-tip"><span>THE TARGET</span><strong>2 + ⅔ × (average − 2)</strong><p>Popular suits pay. Crowded suits cost.</p><button class="text-button room-rules">Scoring rules →</button></div>`;
}

function reveal() {
  const result = state.results;
  const own = result?.scores.find(score => score.playerId === state.you.id);
  const finished = state.phase === 'finished';
  const winners = rankedPlayers().filter(player => player.rank === 1);
  const title = finished ? winners.some(player => player.id === state.you.id) ? 'You read the room.' : 'The table has spoken.' : 'Here’s how it played.';
  return `<div class="phase-heading"><div><span class="eyebrow">${finished ? 'SIX ROUNDS. EVERY MIND COUNTED.' : `ROUND ${state.round} OF ${state.totalRounds} · THE REVEAL`}</span><h1 id="phase-title" tabindex="-1">${title}</h1><p>${finished ? `${winners.map(player => escape(player.name)).join(' & ')} ${winners.length > 1 ? 'share the win' : 'wins'} with ${fmt(winners[0]?.score)} points.` : 'The choices are in. Every prediction has a price.'}</p></div>${finished ? '<div class="finish-symbol" aria-hidden="true">♔</div>' : '<div class="timer reveal-timer"><strong id="countdown">8</strong><span>NEXT ROUND IN</span></div>'}</div>
    <div class="result-stats"><div><span>TABLE AVERAGE</span><strong>${result?.average == null ? '—' : fmt(result.average)}</strong></div><div class="target-stat"><span>THE TARGET</span><strong>${result?.target == null ? '—' : fmt(result.target)}</strong></div><div><span>${result?.modes.length > 1 ? 'TIED COMMON SUITS' : 'THE COMMON SUIT'}</span><strong class="result-suits">${result?.modes.length ? result.modes.map(suit => `<span class="${suit === 'hearts' || suit === 'diamonds' ? 'red-suit' : ''}" aria-label="${suit}">${symbols[suit]}</span>`).join(' ') : '—'}</strong></div><div class="your-round"><span>YOUR ROUND ${state.round}</span><strong class="${own?.points < 0 ? 'negative' : ''}">${signed(own?.points ?? 0)}</strong></div></div>
    <div class="results-layout"><section class="score-breakdown"><div class="panel-heading"><h3>Your card, explained.</h3><span>ROUND ${state.round}</span></div><div class="breakdown-card">${own?.value != null ? card(own.value, own.suit, 'small-card') : '<div class="missed-card">—<span>NO CARD</span></div>'}<div><h4>${own?.value != null ? `${own.value} of ${own.suit}` : 'Missed the deadline'}</h4><p>${own?.value != null ? 'Every part of your score, out in the open.' : 'No number spent. Your score is −15 this round.'}</p></div></div><dl class="breakdown-list"><div><dt>Number points</dt><dd>${fmt(own?.valuePoints ?? 0)}</dd></div><div><dt>Suit bonus</dt><dd>+${fmt(own?.suitPoints ?? 0)}</dd></div><div><dt>${own?.value == null ? 'Missed round' : 'Crowding penalty'}</dt><dd>−${own?.value == null ? '15' : fmt(own?.crowdingPenalty ?? 0)}</dd></div><div class="breakdown-total"><dt>Round score</dt><dd>${signed(own?.points ?? 0)}</dd></div></dl><button class="text-button room-rules">How the math works →</button><div class="suit-distribution"><span class="eyebrow">THE TABLE’S SUITS</span>${suits.map(suit => `<div><span class="${suit === 'hearts' || suit === 'diamonds' ? 'red-suit' : ''}">${symbols[suit]} <small>${suit}</small></span><strong>${result?.counts[suit] ?? 0}</strong></div>`).join('')}</div></section>${leaderboard(finished)}</div>${finished ? '<div class="finish-actions"><p>Same rules. A different room. A whole new game.</p><button class="button primary" id="play-again">Find your next table <span aria-hidden="true">→</span></button></div>' : ''}`;
}

function historyPanel() {
  return `<details class="history-panel"><summary>Round history <span>${state.history.length} / ${state.totalRounds} <span aria-hidden="true">+</span></span></summary><div class="history-rounds">${state.history.map(round => `<details><summary>Round ${round.round}<span>Target ${round.target == null ? '—' : fmt(round.target)}</span></summary><div class="history-scroll"><table><thead><tr><th scope="col">Player</th><th scope="col">Card</th><th scope="col">Round points</th></tr></thead><tbody>${round.scores.map(score => `<tr><th scope="row">${escape(score.name)}</th><td>${score.value == null ? 'Missed' : `${score.value} <span class="${['hearts', 'diamonds'].includes(score.suit) ? 'red-suit' : ''}">${symbols[score.suit]}</span>`}</td><td>${signed(score.points)}</td></tr>`).join('')}</tbody></table></div></details>`).join('')}</div></details>`;
}

async function copyInvite() {
  const link = `${location.origin}/?room=${state.code}`;
  try { await navigator.clipboard.writeText(link); toast('Invite link copied. Send it to your people.'); }
  catch { toast(`Share room code ${state.code} or copy the page address.`); }
}

async function start() {
  if (requestPending) return;
  requestPending = true;
  renderRoom();
  try { updateState(await api(`/api/rooms/${state.code}/start`, {})); }
  catch (error) { toast(error.message); }
  finally { requestPending = false; if (state) renderRoom(); }
}

async function choose() {
  if (requestPending || state.you.choice) return;
  requestPending = true;
  renderRoom();
  try { updateState(await api(`/api/rooms/${state.code}/choose`, { value: selectedValue, suit: selectedSuit, round: state.round })); }
  catch (error) { toast(error.message); }
  finally { requestPending = false; if (state) renderRoom(); }
}

function updateTimer() {
  const timer = document.querySelector('#countdown');
  if (!timer || !state?.deadline) return;
  const remaining = Math.max(0, Math.ceil((state.deadline - Date.now() - clockOffset) / 1000));
  timer.textContent = remaining.toString().padStart(2, '0');
  timer.parentElement.classList.toggle('urgent', remaining <= 5 && state.phase === 'choosing');
}
setInterval(updateTimer, 250);

function recoveryScreen() {
  app.innerHTML = '<div class="loading-state"><span class="brand-mark">♣</span><p>Your seat is saved.</p><p class="fine-print">We couldn’t reach the table. Check your connection and try again.</p><button class="button primary" id="retry-connection">Reconnect to my table →</button></div>';
  document.querySelector('#retry-connection').addEventListener('click', async event => {
    event.target.disabled = true;
    try { await connect(); }
    catch (error) {
      if (error.status === 401 || error.status === 404) { clearSession(); landing(); toast('Your previous table is no longer available.'); }
      else { recoveryScreen(); toast(error.message); }
    }
  });
}

async function init() {
  const requested = new URL(location.href).searchParams.get('room');
  const code = requested?.toUpperCase() || storage.get('common-suit-active');
  if (code) {
    try {
      const saved = storage.get(`common-suit-session-${code}`);
      if (saved) {
        session = JSON.parse(saved);
        if (!session.token || session.roomCode !== code) throw new Error('Invalid saved session');
        app.innerHTML = '<div class="loading-state"><span class="brand-mark">♣</span><p>Finding your seat…</p></div>';
        accepted = true;
        await connect();
        return;
      }
    } catch (error) {
      if (session && error.status !== 401 && error.status !== 404 && !(error instanceof SyntaxError) && error.message !== 'Invalid saved session') {
        recoveryScreen();
        return;
      }
      storage.remove(`common-suit-session-${code}`);
      storage.remove('common-suit-active');
      session = null;
      toast('Your previous table is unavailable. Start a fresh game.');
    }
  }
  landing();
}
init();
