import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Room } from './room.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

const app = express();
const publicDir = join(__dirname, '..', 'public');

// Serve the client and the chess.js browser build (so the app is fully offline).
app.use(express.static(publicDir));
app.use(
  '/vendor/chess.js',
  express.static(join(__dirname, '..', 'node_modules', 'chess.js', 'dist', 'esm', 'chess.js')),
);

const server = createServer(app);
const wss = new WebSocketServer({ server });

/** @type {Map<string, Room>} */
const rooms = new Map();

function getRoom(id) {
  const roomId = (id || 'main').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32) || 'main';
  if (!rooms.has(roomId)) rooms.set(roomId, new Room(roomId));
  return rooms.get(roomId);
}

function broadcast(room) {
  const base = room.state();
  for (const client of wss.clients) {
    if (client.readyState !== 1 || client.roomId !== room.id) continue;
    const member = room.members.get(client.token);
    const role = member ? member.role : 'spectator';
    const color = role === 'white' ? 'w' : role === 'black' ? 'b' : null;
    client.send(JSON.stringify({ ...base, you: { role, color } }));
  }
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const room = getRoom(msg.room);
      const member = room.join({
        token: msg.token,
        name: msg.name,
        preferredRole: msg.preferredRole,
      });
      ws.roomId = room.id;
      ws.token = member.token;
      send(ws, { type: 'joined', token: member.token, role: member.role, roomId: room.id });
      broadcast(room);
      return;
    }

    const room = rooms.get(ws.roomId);
    if (!room || !ws.token) return;

    let result = { ok: true };
    switch (msg.type) {
      case 'move':
        result = room.move(ws.token, msg);
        break;
      case 'sit':
        result = room.sit(ws.token, msg.color);
        break;
      case 'resign':
        result = room.resign(ws.token);
        break;
      case 'draw':
        result = room.offerDraw(ws.token);
        break;
      case 'rematch':
        room.rematch(true);
        break;
      case 'chat': {
        const entry = room.addChat(ws.token, msg.text);
        if (entry) broadcast(room);
        return;
      }
      default:
        return;
    }

    if (!result.ok) {
      send(ws, { type: 'error', message: result.error });
      return;
    }
    broadcast(room);
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomId);
    if (!room) return;
    const member = room.members.get(ws.token);
    if (member) member.connected = false;
    broadcast(room);
  });
});

// Drop dead connections so spectator/player lists stay accurate.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

function lanAddresses() {
  const addrs = [];
  for (const iface of Object.values(networkInterfaces())) {
    for (const net of iface || []) {
      if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
    }
  }
  return addrs;
}

server.listen(PORT, HOST, () => {
  const lines = [
    '',
    '  ♚  Chess LAN is running',
    '  ─────────────────────────────────────────',
    `  On this machine : http://localhost:${PORT}`,
  ];
  for (const ip of lanAddresses()) {
    lines.push(`  Share on LAN    : http://${ip}:${PORT}`);
  }
  lines.push(
    '  ─────────────────────────────────────────',
    '  Send a LAN link to anyone on the same Wi-Fi / network.',
    '  First two to join play; everyone else spectates.',
    '',
  );
  console.log(lines.join('\n'));
});
