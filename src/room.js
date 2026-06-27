import { Chess } from 'chess.js';
import { randomUUID } from 'node:crypto';

/**
 * A single game session. Holds the authoritative chess state, the two seated
 * players (white / black) and any number of spectators. All move validation
 * happens here — clients are never trusted.
 */
export class Room {
  /** @param {string} id @param {{base:number, inc:number}} [timeControl] */
  constructor(id, timeControl = { base: 300000, inc: 3000 }) {
    this.id = id;
    this.chess = new Chess();
    /** @type {Map<string, Member>} every connected member keyed by token */
    this.members = new Map();
    this.white = null; // member token or null
    this.black = null;
    this.lastMove = null; // { from, to }
    this.resignedBy = null; // 'w' | 'b' | null
    this.drawAgreed = false;
    this.drawOffer = null; // 'w' | 'b' | null — who is offering
    this.chat = []; // { from, text, ts }
    this.createdAt = Date.now();

    // --- Clocks (server-authoritative) ---
    this.timeControl = timeControl;
    this.clock = { w: timeControl.base, b: timeControl.base };
    this.turnStartedAt = null; // ms timestamp the on-move clock started, or null
    this.timedOut = null; // 'w' | 'b' | null
  }

  /** Live remaining time for a side, accounting for the running clock. */
  remaining(color, now = Date.now()) {
    let ms = this.clock[color];
    if (this.turnStartedAt && this.chess.turn() === color && !this.isOver()) {
      ms -= now - this.turnStartedAt;
    }
    return Math.max(0, ms);
  }

  /** Deduct the elapsed thinking time from the mover and add the increment. */
  _settleClock(now, mover) {
    if (!this.turnStartedAt) return; // the very first move is not timed
    this.clock[mover] = Math.max(
      0,
      this.clock[mover] - (now - this.turnStartedAt) + this.timeControl.inc,
    );
  }

  /** Called by the server on a timer; flags a side that has run out of time. */
  checkFlag(now = Date.now()) {
    if (this.isOver() || !this.turnStartedAt) return false;
    const onMove = this.chess.turn();
    if (this.clock[onMove] - (now - this.turnStartedAt) <= 0) {
      this.clock[onMove] = 0;
      this.timedOut = onMove;
      this.turnStartedAt = null;
      return true;
    }
    return false;
  }

  /** Seat a member, reusing their token if they reconnect. */
  join({ token, name, preferredRole }) {
    let member = token && this.members.get(token);
    if (member) {
      member.name = name || member.name;
      member.connected = true;
    } else {
      token = randomUUID();
      member = { token, name: name || 'Guest', role: 'spectator', connected: true };
      this.members.set(token, member);
    }

    // Assign a seat. Players keep their seat across reconnects.
    const wantsPlay = preferredRole !== 'spectator';
    if (this.white === member.token) member.role = 'white';
    else if (this.black === member.token) member.role = 'black';
    else if (wantsPlay && !this.white) { this.white = member.token; member.role = 'white'; }
    else if (wantsPlay && !this.black) { this.black = member.token; member.role = 'black'; }
    else member.role = 'spectator';

    return member;
  }

  /** A spectator claims an empty seat. */
  sit(token, color) {
    const member = this.members.get(token);
    if (!member) return { ok: false, error: 'Unknown member.' };
    if (member.role !== 'spectator') return { ok: false, error: 'You already have a seat.' };
    if (color === 'white' && !this.white) { this.white = token; member.role = 'white'; }
    else if (color === 'black' && !this.black) { this.black = token; member.role = 'black'; }
    else return { ok: false, error: 'That seat is taken.' };
    return { ok: true };
  }

  colorOf(token) {
    if (this.white === token) return 'w';
    if (this.black === token) return 'b';
    return null;
  }

  /** Apply a move on behalf of a player. Server-authoritative. */
  move(token, { from, to, promotion }) {
    if (this.isOver()) return { ok: false, error: 'The game is over.' };
    const color = this.colorOf(token);
    if (!color) return { ok: false, error: 'Spectators cannot move.' };
    if (color !== this.chess.turn()) return { ok: false, error: 'Not your turn.' };
    const now = Date.now();
    // The clock is checked at move time too, so a slow mover can't sneak a move in.
    if (this.checkFlag(now)) return { ok: false, error: 'Your time ran out.' };
    try {
      const result = this.chess.move({ from, to, promotion: promotion || 'q' });
      if (!result) return { ok: false, error: 'Illegal move.' };
      this.lastMove = { from: result.from, to: result.to };
      this.drawOffer = null; // any move cancels a pending draw offer
      // Settle the mover's clock, then start the opponent's.
      this._settleClock(now, color);
      this.turnStartedAt = this.isOver() ? null : now;
      return { ok: true };
    } catch {
      return { ok: false, error: 'Illegal move.' };
    }
  }

  resign(token) {
    const color = this.colorOf(token);
    if (!color) return { ok: false, error: 'Only players can resign.' };
    if (this.isOver()) return { ok: false, error: 'The game is over.' };
    this.resignedBy = color;
    return { ok: true };
  }

  offerDraw(token) {
    const color = this.colorOf(token);
    if (!color) return { ok: false, error: 'Only players can offer a draw.' };
    if (this.isOver()) return { ok: false, error: 'The game is over.' };
    if (this.drawOffer && this.drawOffer !== color) {
      // The opponent had already offered — agreeing seals the draw.
      this.drawAgreed = true;
      this.drawOffer = null;
    } else {
      this.drawOffer = color;
    }
    return { ok: true };
  }

  /** Reset the board, keeping seats. Optionally swap colors for fairness. */
  rematch(swap = true) {
    this.chess = new Chess();
    this.lastMove = null;
    this.resignedBy = null;
    this.drawAgreed = false;
    this.drawOffer = null;
    this.clock = { w: this.timeControl.base, b: this.timeControl.base };
    this.turnStartedAt = null;
    this.timedOut = null;
    if (swap) {
      const w = this.white;
      this.white = this.black;
      this.black = w;
      for (const m of this.members.values()) {
        if (m.token === this.white) m.role = 'white';
        else if (m.token === this.black) m.role = 'black';
      }
    }
  }

  addChat(token, text) {
    const member = this.members.get(token);
    if (!member) return;
    const clean = String(text || '').slice(0, 300).trim();
    if (!clean) return;
    const entry = { from: member.name, text: clean, ts: Date.now() };
    this.chat.push(entry);
    if (this.chat.length > 100) this.chat.shift();
    return entry;
  }

  isOver() {
    return (
      this.resignedBy !== null ||
      this.drawAgreed ||
      this.timedOut !== null ||
      this.chess.isGameOver()
    );
  }

  /** Human-readable status + winner. */
  outcome() {
    if (this.timedOut) {
      return { status: 'timeout', winner: this.timedOut === 'w' ? 'b' : 'w' };
    }
    if (this.resignedBy) {
      return { status: 'resigned', winner: this.resignedBy === 'w' ? 'b' : 'w' };
    }
    if (this.drawAgreed) return { status: 'draw', winner: null };
    if (this.chess.isCheckmate()) {
      return { status: 'checkmate', winner: this.chess.turn() === 'w' ? 'b' : 'w' };
    }
    if (this.chess.isStalemate()) return { status: 'stalemate', winner: null };
    if (this.chess.isInsufficientMaterial()) return { status: 'insufficient', winner: null };
    if (this.chess.isThreefoldRepetition()) return { status: 'threefold', winner: null };
    if (this.chess.isDraw()) return { status: 'draw', winner: null };
    if (this.chess.inCheck()) return { status: 'check', winner: null };
    return { status: 'active', winner: null };
  }

  nameOf(token) {
    const m = token && this.members.get(token);
    return m ? m.name : null;
  }

  /** A snapshot every client renders from. */
  state() {
    const now = Date.now();
    const { status, winner } = this.outcome();
    const spectators = [];
    for (const m of this.members.values()) {
      if (m.role === 'spectator' && m.connected) spectators.push(m.name);
    }
    return {
      type: 'state',
      roomId: this.id,
      fen: this.chess.fen(),
      turn: this.chess.turn(),
      history: this.chess.history({ verbose: true }).map((m) => ({
        san: m.san, from: m.from, to: m.to, color: m.color,
      })),
      lastMove: this.lastMove,
      status,
      winner,
      gameOver: this.isOver(),
      drawOffer: this.drawOffer,
      players: {
        white: this.white ? { name: this.nameOf(this.white) } : null,
        black: this.black ? { name: this.nameOf(this.black) } : null,
      },
      spectators,
      chat: this.chat,
      clock: {
        w: this.remaining('w', now),
        b: this.remaining('b', now),
        running: this.turnStartedAt && !this.isOver() ? this.chess.turn() : null,
        base: this.timeControl.base,
        inc: this.timeControl.inc,
      },
    };
  }
}

/**
 * @typedef {Object} Member
 * @property {string} token
 * @property {string} name
 * @property {'white'|'black'|'spectator'} role
 * @property {boolean} connected
 */
