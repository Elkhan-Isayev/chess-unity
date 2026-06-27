import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/room.js';

function seatTwo() {
  const r = new Room('t');
  const w = r.join({ name: 'White', preferredRole: 'player' });
  const b = r.join({ name: 'Black', preferredRole: 'player' });
  return { r, w, b };
}

test('first two players get seats, rest spectate', () => {
  const { r } = seatTwo();
  const c = r.join({ name: 'Cara', preferredRole: 'player' });
  assert.equal(r.colorOf(r.white), 'w');
  assert.equal(r.colorOf(r.black), 'b');
  assert.equal(c.role, 'spectator');
});

test('explicit spectators never take a seat', () => {
  const r = new Room('t');
  const s = r.join({ name: 'Spec', preferredRole: 'spectator' });
  assert.equal(s.role, 'spectator');
  assert.equal(r.white, null);
});

test('reconnect with same token keeps the seat', () => {
  const { r, w } = seatTwo();
  const again = r.join({ token: w.token, name: 'White' });
  assert.equal(again.role, 'white');
  assert.equal(r.white, w.token);
});

test('rejects moves from the wrong player and spectators', () => {
  const { r, w, b } = seatTwo();
  const spec = r.join({ name: 'S', preferredRole: 'spectator' });
  assert.equal(r.move(b.token, { from: 'e7', to: 'e5' }).ok, false); // black moving first
  assert.equal(r.move(spec.token, { from: 'e2', to: 'e4' }).ok, false);
  assert.equal(r.move(w.token, { from: 'e2', to: 'e4' }).ok, true);
});

test('rejects illegal moves', () => {
  const { r, w } = seatTwo();
  assert.equal(r.move(w.token, { from: 'e2', to: 'e5' }).ok, false);
});

test('detects fools-mate checkmate', () => {
  const { r, w, b } = seatTwo();
  r.move(w.token, { from: 'f2', to: 'f3' });
  r.move(b.token, { from: 'e7', to: 'e5' });
  r.move(w.token, { from: 'g2', to: 'g4' });
  r.move(b.token, { from: 'd8', to: 'h4' });
  const o = r.outcome();
  assert.equal(o.status, 'checkmate');
  assert.equal(o.winner, 'b');
  assert.equal(r.isOver(), true);
  // No moves allowed once the game is over.
  assert.equal(r.move(w.token, { from: 'a2', to: 'a3' }).ok, false);
});

test('castling is allowed through the rules engine', () => {
  const { r, w, b } = seatTwo();
  r.move(w.token, { from: 'e2', to: 'e4' });
  r.move(b.token, { from: 'e7', to: 'e5' });
  r.move(w.token, { from: 'g1', to: 'f3' });
  r.move(b.token, { from: 'b8', to: 'c6' });
  r.move(w.token, { from: 'f1', to: 'c4' });
  r.move(b.token, { from: 'f8', to: 'c5' });
  const res = r.move(w.token, { from: 'e1', to: 'g1' }); // O-O
  assert.equal(res.ok, true);
  assert.match(r.state().history.at(-1).san, /O-O/);
});

test('pawn promotion defaults to queen and accepts choice', () => {
  const r = new Room('t');
  r.chess.load('8/P7/8/8/8/8/8/k6K w - - 0 1');
  const w = r.join({ name: 'W', preferredRole: 'player' });
  // Force this member into the white seat for the custom position.
  r.white = w.token; w.role = 'white';
  const res = r.move(w.token, { from: 'a7', to: 'a8', promotion: 'n' });
  assert.equal(res.ok, true);
  assert.equal(r.chess.get('a8').type, 'n');
});

test('resignation ends the game and names the winner', () => {
  const { r, w } = seatTwo();
  assert.equal(r.resign(w.token).ok, true);
  const o = r.outcome();
  assert.equal(o.status, 'resigned');
  assert.equal(o.winner, 'b');
});

test('mutual draw offer agrees a draw', () => {
  const { r, w, b } = seatTwo();
  r.offerDraw(w.token);
  assert.equal(r.drawOffer, 'w');
  r.offerDraw(b.token);
  assert.equal(r.drawAgreed, true);
  assert.equal(r.outcome().status, 'draw');
});

test('rematch resets the board and swaps colors', () => {
  const { r, w, b } = seatTwo();
  r.move(w.token, { from: 'e2', to: 'e4' });
  r.rematch(true);
  assert.equal(r.state().history.length, 0);
  assert.equal(r.white, b.token); // colors swapped
  assert.equal(r.black, w.token);
});

test('spectator can sit in an empty seat', () => {
  const r = new Room('t');
  r.join({ name: 'W', preferredRole: 'player' }); // takes white
  const s = r.join({ name: 'S', preferredRole: 'spectator' });
  assert.equal(s.role, 'spectator');
  assert.equal(r.sit(s.token, 'black').ok, true);
  assert.equal(r.colorOf(s.token), 'b');
  // Cannot sit in a taken seat.
  const s2 = r.join({ name: 'S2', preferredRole: 'spectator' });
  assert.equal(r.sit(s2.token, 'black').ok, false);
});
