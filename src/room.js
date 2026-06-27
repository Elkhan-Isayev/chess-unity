import { Chess } from 'chess.js';
import { randomUUID } from 'node:crypto';

/**
 * A single game session. Holds the authoritative chess state, the two seated
 * players (white / black) and any number of spectators. All move validation
 * happens here — clients are never trusted.
 */
export class Room {
  constructor(id) {
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
    try {
      const result = this.chess.move({ from, to, promotion: promotion || 'q' });
      if (!result) return { ok: false, error: 'Illegal move.' };
      this.lastMove = { from: result.from, to: result.to };
      this.drawOffer = null; // any move cancels a pending draw offer
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
      this.chess.isGameOver()
    );
  }

  /** Human-readable status + winner. */
  outcome() {
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
