// server/index.js   (V1.2)
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, '..', 'client')));
app.use(express.json());

// -------- REST --------
app.get('/api/wordbanks', (_, res) => {
  const dir = path.join(__dirname, '..', 'client', 'wordbanks');
  res.json(fs.readdirSync(dir).filter(f => f.endsWith('.json')));
});
app.get('/api/wordbank/:name', (req, res) => {
  const file = path.join(__dirname, '..', 'client', 'wordbanks', req.params.name);
  fs.existsSync(file) ? res.sendFile(file) : res.status(404).json({ error: 'not found' });
});

// ── Socket.IO ───────────────────────────────────────────
const httpServer = createServer(app);
const io = new Server(httpServer);
const rooms = new Map();            // roomId → { cfg, players, finish: [], scores: {} }

io.on('connection', socket => {
  /* ① 加入房间 */
  socket.on('join-room', ({ roomId, bank, batch }) => {
    socket.join(roomId);
    const room = rooms.get(roomId) || { cfg: { bank, batch }, players: [], finish: [], scores: {} };

    if (room.players.length &&
        (room.cfg.bank !== bank || room.cfg.batch !== batch)) {
      socket.emit('join-error', '房间配置不一致');
      socket.leave(roomId);
      return;
    }
    room.players.push(socket.id);
    rooms.set(roomId, room);

    if (room.players.length === 1) {
      socket.emit('waiting');
    }
    if (room.players.length === 2) {
      io.to(roomId).emit('start', room.cfg);   // 同步开始
    }
  });

  /* ② 广播每题进度 */
  socket.on('progress', ({ roomId, idx, score }) => {
    socket.to(roomId).emit('progress', { id: socket.id, idx, score });
    const room = rooms.get(roomId);
    if (room) room.scores[socket.id] = score;
  });

  /* ③ 完成后结算 */
  socket.on('finish', ({ roomId, score, time, correct }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.finish.push({ id: socket.id, score, time, correct });

    if (room.finish.length === 2) {           // 两人都完成
      const [a, b] = room.finish;
      let winner = 'draw';
      if (a.score !== b.score) winner = a.score > b.score ? a.id : b.id;
      else if (a.time !== b.time) winner = a.time < b.time ? a.id : b.id;

      io.to(roomId).emit('result', { winner, detail: room.finish });
      rooms.delete(roomId);
    }
  });

  /* ④ 退出房间 / 断线 */
  socket.on('leave-room', roomId => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.players = room.players.filter(id => id !== socket.id);
    socket.leave(roomId);
    io.to(roomId).emit('opponent-left');
    if (room.players.length === 0) rooms.delete(roomId);
  });
  socket.on('disconnect', () => {
    rooms.forEach((room, id) => {
      if (room.players.includes(socket.id)) {
        io.to(id).emit('opponent-left');
        rooms.delete(id);
      }
    });
  });
});

httpServer.listen(process.env.PORT || 3000,
  () => console.log('✅  server: http://localhost:3000'));