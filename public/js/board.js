// Renders the board from a FEN and handles drag/drop + click-to-move.
// Pure view layer: it asks the host (app.js) for legal moves and reports
// attempted moves back. The server stays authoritative.

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

export class BoardView {
  /**
   * @param {HTMLElement} el
   * @param {{
   *   legalMovesFrom: (sq: string) => string[],   // target squares
   *   canMove: () => boolean,                      // is it my turn & am I a player
   *   onMove: (from: string, to: string) => void,
   * }} host
   */
  constructor(el, host) {
    this.el = el;
    this.host = host;
    this.orientation = 'w';
    this.selected = null;
    this.position = {}; // square -> { color, type }
    this.lastMove = null;
    this.checkSquare = null;
    this.buildGrid();
  }

  buildGrid() {
    this.el.innerHTML = '';
    this.squares = {};
    for (let rank = 8; rank >= 1; rank--) {
      for (let f = 0; f < 8; f++) {
        const sq = FILES[f] + rank;
        const cell = document.createElement('div');
        cell.className = 'square ' + ((f + rank) % 2 === 0 ? 'dark' : 'light');
        cell.dataset.square = sq;
        // Coordinate labels on the edges.
        if (f === 0) cell.appendChild(coord('rank', rank));
        if (rank === 1) cell.appendChild(coord('file', FILES[f]));
        cell.addEventListener('click', () => this.onSquareClick(sq));
        this.el.appendChild(cell);
        this.squares[sq] = cell;
      }
    }
  }

  setOrientation(color) {
    this.orientation = color;
    this.el.classList.toggle('flipped', color === 'b');
  }

  /** @param {object} pos square->{color,type} @param {{from,to}|null} lastMove */
  render(pos, lastMove, checkSquare) {
    this.position = pos;
    this.lastMove = lastMove;
    this.checkSquare = checkSquare;
    this.clearSelection(false);
    for (const sq of Object.keys(this.squares)) {
      const cell = this.squares[sq];
      cell.classList.toggle('last-move', !!lastMove && (lastMove.from === sq || lastMove.to === sq));
      cell.classList.toggle('check', checkSquare === sq);
      // Remove existing piece.
      const existing = cell.querySelector('.piece');
      if (existing) existing.remove();
      const p = pos[sq];
      if (p) cell.appendChild(this.makePiece(sq, p));
    }
  }

  makePiece(sq, p) {
    const div = document.createElement('div');
    div.className = 'piece';
    const code = (p.color === 'w' ? 'w' : 'b') + p.type.toUpperCase();
    div.style.backgroundImage = `url(/assets/pieces/${code}.png)`;
    div.dataset.square = sq;
    div.addEventListener('pointerdown', (e) => this.onPointerDown(e, sq));
    return div;
  }

  onSquareClick(sq) {
    if (this.dragging) return; // click is part of a drag release
    if (this.selected) {
      if (sq === this.selected) { this.clearSelection(); return; }
      if (this.legalTargets.includes(sq)) {
        const from = this.selected;
        this.clearSelection();
        this.host.onMove(from, sq);
        return;
      }
    }
    // Select a friendly piece that can move.
    if (this.position[sq] && this.host.canMove()) {
      this.select(sq);
    } else {
      this.clearSelection();
    }
  }

  select(sq) {
    this.clearSelection(false);
    const targets = this.host.legalMovesFrom(sq);
    if (!targets.length) return;
    this.selected = sq;
    this.legalTargets = targets;
    this.squares[sq].classList.add('selected');
    for (const t of targets) {
      const hint = document.createElement('div');
      const isCapture = !!this.position[t] || this.isEnPassant(sq, t);
      hint.className = 'hint' + (isCapture ? ' capture' : '');
      this.squares[t].appendChild(hint);
    }
  }

  isEnPassant(from, to) {
    const p = this.position[from];
    return p && p.type === 'p' && from[0] !== to[0] && !this.position[to];
  }

  clearSelection(rerenderHints = true) {
    if (this.selected) this.squares[this.selected]?.classList.remove('selected');
    this.selected = null;
    this.legalTargets = [];
    if (rerenderHints) this.el.querySelectorAll('.hint').forEach((h) => h.remove());
    else this.el.querySelectorAll('.hint').forEach((h) => h.remove());
  }

  // --- Drag and drop ---------------------------------------------------
  onPointerDown(e, sq) {
    // Clicking/grabbing a legal target (e.g. an enemy piece) completes a
    // capture instead of selecting that piece.
    if (this.selected && this.legalTargets.includes(sq)) {
      e.preventDefault();
      const from = this.selected;
      this.clearSelection();
      this.host.onMove(from, sq);
      return;
    }
    if (!this.host.canMove() || !this.position[sq]) return;
    e.preventDefault();
    this.select(sq);
    const piece = e.currentTarget;
    const boardRect = this.el.getBoundingClientRect();
    const size = boardRect.width / 8;
    this.dragging = { piece, from: sq, size, boardRect };
    piece.classList.add('dragging');
    piece.style.position = 'fixed';
    piece.style.width = size * 0.86 + 'px';
    piece.style.height = size * 0.86 + 'px';
    this.moveDragged(e);

    const move = (ev) => this.moveDragged(ev);
    const up = (ev) => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      this.onPointerUp(ev);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  moveDragged(e) {
    if (!this.dragging) return;
    const { piece, size } = this.dragging;
    piece.style.left = e.clientX - (size * 0.86) / 2 + 'px';
    piece.style.top = e.clientY - (size * 0.86) / 2 + 'px';
  }

  onPointerUp(e) {
    if (!this.dragging) return;
    const { piece, from } = this.dragging;
    const target = this.squareFromPoint(e.clientX, e.clientY);
    // Reset inline styles regardless of outcome.
    piece.classList.remove('dragging');
    piece.style.position = '';
    piece.style.left = piece.style.top = '';
    piece.style.width = piece.style.height = '';
    const targets = this.legalTargets;
    this.dragging = null;
    if (target && target !== from && targets.includes(target)) {
      this.clearSelection();
      this.host.onMove(from, target);
    } else {
      // Keep selection so the user still sees hints after a misdrop.
      this.el.querySelectorAll('.hint').forEach((h) => h.remove());
      this.squares[from]?.classList.remove('selected');
      this.selected = null;
      this.legalTargets = [];
    }
  }

  squareFromPoint(x, y) {
    const r = this.el.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
    let col = Math.floor((x - r.left) / (r.width / 8));
    let row = Math.floor((y - r.top) / (r.height / 8));
    col = Math.max(0, Math.min(7, col));
    row = Math.max(0, Math.min(7, row));
    if (this.orientation === 'b') { col = 7 - col; row = 7 - row; }
    const file = FILES[col];
    const rank = 8 - row;
    return file + rank;
  }
}

function coord(kind, value) {
  const span = document.createElement('span');
  span.className = 'coord ' + kind;
  span.textContent = value;
  return span;
}
