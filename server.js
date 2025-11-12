// server.js - Avanzado (auth simple + SQLite + WebSocket)
/*
Instrucciones:
1) npm init -y
2) npm install express ws uuid sqlite3 body-parser
3) node server.js
4) Abre http://localhost:8080/
*/

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const sqlite3 = require('sqlite3');
const bodyParser = require('body-parser');
const path = require('path');

// DB (archivo local)
const DB_FILE = path.join(__dirname, 'ubicacion.db');
const db = new sqlite3.Database(DB_FILE);

// Inicializar tablas
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT,
    token TEXT UNIQUE,
    created_at INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    lat REAL,
    lng REAL,
    accuracy REAL,
    ts INTEGER
  )`);
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(bodyParser.json());
app.use(express.static('.'));

// Endpoint para registrar usuario y obtener token
app.post('/register', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const id = uuidv4();
  const token = uuidv4();
  const now = Date.now();
  db.run('INSERT INTO users (id,name,token,created_at) VALUES (?,?,?,?)',
    [id, name, token, now], function(err) {
      if (err) return res.status(500).json({ error: 'DB error' });
      res.json({ id, name, token });
    });
});

// Endpoint para descargar historial (del usuario identificado por token)
app.get('/history', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).json({ error: 'Token requerido' });
  db.get('SELECT id,name FROM users WHERE token = ?', [token], (err, user) => {
    if (err || !user) return res.status(403).json({ error: 'Token inválido' });
    db.all('SELECT lat,lng,accuracy,ts FROM locations WHERE user_id = ? ORDER BY ts ASC', [user.id], (err, rows) => {
      if (err) return res.status(500).json({ error: 'DB error' });
      res.setHeader('Content-disposition', 'attachment; filename=history_' + (user.name || user.id) + '.json');
      res.json({ user: { id: user.id, name: user.name }, locations: rows });
    });
  });
});

// Simple lookup for token -> user
function findUserByToken(token, cb) {
  db.get('SELECT id,name FROM users WHERE token = ?', [token], (err, row) => {
    if (err || !row) return cb(null);
    cb(row);
  });
}

// Rooms and sockets
const rooms = new Map(); // room -> Set(ws)
const socketMeta = new Map(); // ws -> {id, userId, name, room}

wss.on('connection', (ws) => {
  const connId = uuidv4();
  socketMeta.set(ws, { connId, userId: null, name: null, room: null });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'auth') {
        // msg: { type:'auth', token, room }
        const token = msg.token;
        const room = msg.room || 'sala1';
        findUserByToken(token, (user) => {
          if (!user) return ws.send(JSON.stringify({ type:'error', error:'Token inválido' }));
          socketMeta.set(ws, { connId, userId: user.id, name: user.name, room });
          if (!rooms.has(room)) rooms.set(room, new Set());
          rooms.get(room).add(ws);
          // send welcome with assigned clientId (user id)
          ws.send(JSON.stringify({ type:'welcome', clientId: user.id }));
          broadcastMeta(room);
        });
      } else if (msg.type === 'location') {
        const meta = socketMeta.get(ws) || {};
        const userId = meta.userId;
        const name = meta.name;
        const room = meta.room;
        if (!userId) return ws.send(JSON.stringify({ type:'error', error:'No autenticado' }));
        const lat = Number(msg.lat), lng = Number(msg.lng), ts = Number(msg.ts) || Date.now(), acc = Number(msg.accuracy || 0);
        // Guardar en DB
        db.run('INSERT INTO locations (user_id,lat,lng,accuracy,ts) VALUES (?,?,?,?,?)', [userId,lat,lng,acc,ts], (err) => {
          if (err) console.error('DB insert error', err);
        });
        // Reenviar a todos en la room
        const payload = { type:'location', clientId: userId, name, lat, lng, ts, accuracy: acc };
        if (room && rooms.has(room)) {
          for (const s of rooms.get(room)) {
            if (s.readyState === WebSocket.OPEN) s.send(JSON.stringify(payload));
          }
        }
      }
    } catch (e) { console.error('msg parse error', e); }
  });

  ws.on('close', () => {
    const meta = socketMeta.get(ws) || {};
    const room = meta.room;
    if (room && rooms.has(room)) rooms.get(room).delete(ws);
    socketMeta.delete(ws);
    if (room) broadcastMeta(room);
  });
});

function broadcastMeta(room) {
  if (!rooms.has(room)) return;
  const users = [];
  for (const s of rooms.get(room)) {
    const m = socketMeta.get(s);
    if (m && m.userId) users.push({ id: m.userId, name: m.name });
  }
  const payload = { type:'meta', users };
  for (const s of rooms.get(room)) {
    if (s.readyState === WebSocket.OPEN) s.send(JSON.stringify(payload));
  }
}

const PORT = 8080;
server.listen(PORT, () => console.log('Servidor avanzado escuchando en http://localhost:' + PORT));
