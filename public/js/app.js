import { Chess } from '/vendor/chess.js';
import { BoardView } from '/js/board.js';

// ---------- Element refs ----------
const $ = (id) => document.getElementById(id);
const joinScreen = $('join-screen');
const gameScreen = $('game-screen');

// ---------- Local state ----------
const chess = new Chess();          // mirror of server state, used for legal-move UI
let ws = null;
let myRole = 'spectator';           // white | black | spectator
let myColor = null;                 // 'w' | 'b' | null
let lastState = null;
let pendingPromotion = null;        // { from, to }

const params = new URLSearchParams(location.search);
const storedToken = () => localStorage.getItem('chess-token');

// ---------- Board ----------
const board = new BoardView($('board'), {
  legalMovesFrom: (sq) => chess.moves({ square: sq, verbose: true }).map((m) => m.to),
  canMove: () =>
    !!myColor &&
    !lastState?.gameOver &&
    chess.turn() === myColor,
  onMove: attemptMove,
});

// ---------- Join screen ----------
let chosenRole = 'player';
document.querySelectorAll('.role-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.role-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    chosenRole = btn.dataset.role;
  });
});

// Prefill from URL (?room=) and last name.
$('room-input').value = params.get('room') || 'main';
$('name-input').value = localStorage.getItem('chess-name') || '';

$('enter-btn').addEventListener('click', enterGame);
$('name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') enterGame(); });

function enterGame() {
  const name = $('name-input').value.trim();
  if (!name) { $('join-error').textContent = 'Please enter a name.'; return; }
  const room = ($('room-input').value.trim() || 'main').toLowerCase();
  localStorage.setItem('chess-name', name);
  connect({ name, room, preferredRole: chosenRole });
}

// ---------- WebSocket ----------
function connect({ name, room, preferredRole }) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({
      type: 'join',
      room,
      name,
      preferredRole,
      token: storedToken(),
    }));
  });

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'joined') {
      localStorage.setItem('chess-token', msg.token);
      myRole = msg.role;
      myColor = msg.role === 'white' ? 'w' : msg.role === 'black' ? 'b' : null;
      board.setOrientation(myColor === 'b' ? 'b' : 'w');
      $('room-name').textContent = msg.roomId;
      joinScreen.classList.add('hidden');
      gameScreen.classList.remove('hidden');
      updateRoleBadge();
    } else if (msg.type === 'state') {
      applyState(msg);
    } else if (msg.type === 'error') {
      toast(msg.message, true);
    }
  });

  ws.addEventListener('close', () => {
    toast('Disconnected — reconnecting…', true);
    setTimeout(() => connect({ name, room, preferredRole }), 1500);
  });
}

function attemptMove(from, to) {
  // Detect promotion locally so we can show the picker.
  const piece = chess.get(from);
  const isPromotion =
    piece && piece.type === 'p' &&
    ((piece.color === 'w' && to[1] === '8') || (piece.color === 'b' && to[1] === '1'));
  if (isPromotion) {
    pendingPromotion = { from, to };
    showPromotion(piece.color);
    return;
  }
  sendMove(from, to);
}

function sendMove(from, to, promotion) {
  ws?.send(JSON.stringify({ type: 'move', from, to, promotion }));
}

// ---------- Render from server state ----------
function applyState(state) {
  lastState = state;
  chess.load(state.fen);

  // Keep my seat/color in sync (e.g. after rematch swap or sitting down).
  syncMyColor(state);
  board.setOrientation(myColor === 'b' ? 'b' : 'w');

  const pos = positionMap();
  const checkSquare = chess.inCheck() ? kingSquare(chess.turn()) : null;
  board.render(pos, state.lastMove, checkSquare);

  renderPlayers(state);
  renderTurn(state);
  renderMoves(state);
  renderSpectators(state);
  renderChat(state);
  renderControls(state);
  renderBanner(state);
}

function syncMyColor(state) {
  // The server tells each client its own role/color in every state update,
  // which keeps things correct across rematch swaps and sitting down.
  if (state.you) {
    myRole = state.you.role;
    myColor = state.you.color;
  }
  updateRoleBadge();
}

function positionMap() {
  const map = {};
  const boardArr = chess.board(); // rank 8..1, file a..h
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const cell = boardArr[r][f];
      if (cell) map['abcdefgh'[f] + (8 - r)] = { color: cell.color, type: cell.type };
    }
  }
  return map;
}

function kingSquare(color) {
  for (const [sq, p] of Object.entries(positionMap())) {
    if (p.type === 'k' && p.color === color) return sq;
  }
  return null;
}

function renderPlayers(state) {
  // White at the bottom unless I'm black (then flip perspective).
  const flip = myColor === 'b';
  const top = flip ? state.players.white : state.players.black;
  const bottom = flip ? state.players.black : state.players.white;
  const topColor = flip ? 'w' : 'b';
  const bottomColor = flip ? 'b' : 'w';

  fillStrip('top', top, topColor, state);
  fillStrip('bottom', bottom, bottomColor, state);

  // Sit buttons for spectators on empty seats.
  const canSit = myRole === 'spectator' && !state.gameOver;
  toggleSit('sit-white', canSit && !state.players.white);
  toggleSit('sit-black', canSit && !state.players.black);
}

function fillStrip(pos, player, color, state) {
  const name = player ? player.name : 'Waiting for a player…';
  $(`name-${pos}`).textContent = name;
  const avatar = $(`avatar-${pos}`);
  avatar.textContent = player ? player.name[0].toUpperCase() : '?';
  avatar.classList.toggle('light', color === 'w');
  renderCaptured(pos, color);
}

function toggleSit(id, show) {
  $(id).classList.toggle('hidden', !show);
}

// Captured material = starting count minus what's on the board.
const START_COUNT = { p: 8, n: 2, b: 2, r: 2, q: 1 };
function renderCaptured(pos, color) {
  const counts = { p: 0, n: 0, b: 0, r: 0, q: 0 };
  for (const p of Object.values(positionMap())) {
    if (p.color === color && counts[p.type] !== undefined) counts[p.type]++;
  }
  const container = $(`captured-${pos}`);
  container.innerHTML = '';
  // Pieces captured FROM this color are shown next to the opponent who took them.
  // We display the pieces this player has lost.
  for (const type of ['q', 'r', 'b', 'n', 'p']) {
    const lost = START_COUNT[type] - counts[type];
    for (let i = 0; i < lost; i++) {
      const cap = document.createElement('div');
      cap.className = 'cap';
      cap.style.backgroundImage = `url(/assets/pieces/${color}${type.toUpperCase()}.png)`;
      container.appendChild(cap);
    }
  }
}

function renderTurn(state) {
  const ind = $('turn-indicator');
  const txt = $('turn-text');
  ind.classList.toggle('black', state.turn === 'b');
  if (state.gameOver) {
    txt.textContent = 'Game over';
  } else {
    const who = state.turn === 'w' ? 'White' : 'Black';
    txt.textContent = `${who} to move${state.status === 'check' ? ' — check!' : ''}`;
  }
}

function renderMoves(state) {
  const list = $('move-list');
  list.innerHTML = '';
  const moves = state.history;
  for (let i = 0; i < moves.length; i += 2) {
    const li = document.createElement('li');
    li.innerHTML =
      `<span class="num">${i / 2 + 1}.</span>` +
      `<span class="san">${moves[i].san}</span>` +
      `<span class="san">${moves[i + 1] ? moves[i + 1].san : ''}</span>`;
    list.appendChild(li);
  }
  list.scrollTop = list.scrollHeight;
}

function renderSpectators(state) {
  $('spec-count').textContent = state.spectators.length;
  const el = $('spectator-list');
  if (!state.spectators.length) { el.innerHTML = '<span class="muted">No spectators yet.</span>'; return; }
  el.innerHTML = state.spectators.map((s) => `<span class="spec">${escapeHtml(s)}</span>`).join('');
}

function renderChat(state) {
  const log = $('chat-log');
  log.innerHTML = state.chat
    .map((m) => `<div class="msg"><span class="who">${escapeHtml(m.from)}:</span> ${escapeHtml(m.text)}</div>`)
    .join('');
  log.scrollTop = log.scrollHeight;
}

function renderControls(state) {
  const isPlayer = myColor !== null;
  const playable = isPlayer && !state.gameOver;
  $('btn-resign').disabled = !playable;
  $('btn-draw').disabled = !playable;
  $('btn-rematch').classList.toggle('hidden', !(isPlayer && state.gameOver));

  // Draw offer notice.
  const offer = $('draw-offer');
  if (state.drawOffer && isPlayer && state.drawOffer !== myColor) {
    offer.classList.remove('hidden');
    offer.innerHTML =
      'Opponent offers a draw. <div><button class="ghost" id="accept-draw">Accept</button>' +
      '<button class="ghost" id="decline-draw">Decline</button></div>';
    $('accept-draw').onclick = () => ws.send(JSON.stringify({ type: 'draw' }));
    $('decline-draw').onclick = () => offer.classList.add('hidden');
  } else if (isPlayer && state.drawOffer === myColor) {
    offer.classList.remove('hidden');
    offer.textContent = 'Draw offered. Waiting for opponent…';
  } else {
    offer.classList.add('hidden');
  }
}

function renderBanner(state) {
  const banner = $('board-banner');
  if (!state.gameOver) { banner.classList.add('hidden'); return; }
  let title = 'Game over';
  let sub = '';
  if (state.status === 'checkmate') { title = 'Checkmate'; sub = `${state.winner === 'w' ? 'White' : 'Black'} wins`; }
  else if (state.status === 'resigned') { title = 'Resignation'; sub = `${state.winner === 'w' ? 'White' : 'Black'} wins`; }
  else if (state.status === 'stalemate') { title = 'Stalemate'; sub = 'Draw'; }
  else if (state.status === 'draw') { title = 'Draw'; sub = 'Agreed / 50-move / repetition'; }
  else if (state.status === 'insufficient') { title = 'Draw'; sub = 'Insufficient material'; }
  else if (state.status === 'threefold') { title = 'Draw'; sub = 'Threefold repetition'; }
  banner.innerHTML = `<div><h2>${title}</h2><p>${sub}</p></div>`;
  banner.classList.remove('hidden');
}

// ---------- Role badge ----------
function updateRoleBadge() {
  const badge = $('role-badge');
  badge.classList.remove('white-role', 'black-role');
  if (myRole === 'white') { badge.textContent = '♙ You are White'; badge.classList.add('white-role'); }
  else if (myRole === 'black') { badge.textContent = '♟ You are Black'; badge.classList.add('black-role'); }
  else badge.textContent = '👁 Spectator';
}

// ---------- Promotion ----------
function showPromotion(color) {
  const wrap = $('promotion');
  const opts = $('promo-options');
  opts.innerHTML = '';
  for (const type of ['q', 'r', 'b', 'n']) {
    const div = document.createElement('div');
    div.className = 'promo-piece';
    div.style.backgroundImage = `url(/assets/pieces/${color}${type.toUpperCase()}.png)`;
    div.onclick = () => {
      wrap.classList.add('hidden');
      if (pendingPromotion) {
        sendMove(pendingPromotion.from, pendingPromotion.to, type);
        pendingPromotion = null;
      }
    };
    opts.appendChild(div);
  }
  wrap.classList.remove('hidden');
}

// ---------- Controls wiring ----------
$('btn-resign').onclick = () => { if (confirm('Resign the game?')) ws.send(JSON.stringify({ type: 'resign' })); };
$('btn-draw').onclick = () => ws.send(JSON.stringify({ type: 'draw' }));
$('btn-rematch').onclick = () => ws.send(JSON.stringify({ type: 'rematch' }));
$('sit-white').onclick = () => sit('white');
$('sit-black').onclick = () => sit('black');

function sit(color) {
  ws.send(JSON.stringify({ type: 'sit', color }));
  myColor = color === 'white' ? 'w' : 'b';
  myRole = color;
  board.setOrientation(myColor);
  updateRoleBadge();
}

$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  ws.send(JSON.stringify({ type: 'chat', text }));
  input.value = '';
});

$('copy-link').onclick = async () => {
  const room = $('room-name').textContent;
  const url = `${location.origin}/?room=${encodeURIComponent(room)}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied!');
  } catch {
    prompt('Copy this link:', url);
  }
};

// ---------- Helpers ----------
let toastTimer = null;
function toast(text, isError = false) {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
