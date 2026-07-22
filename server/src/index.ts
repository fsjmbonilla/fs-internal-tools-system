import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import { pool } from './db.js';

const PORT = Number(process.env.PORT ?? 4000);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:5173';

const app = express();
app.use(cors({ origin: CORS_ORIGIN.split(',') }));
app.use(express.json());

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'up' });
  } catch {
    res.status(503).json({ status: 'degraded', db: 'down' });
  }
});

app.get('/api/channels', async (_req, res) => {
  const [rows] = await pool.query('SELECT id, name, created_at FROM channels ORDER BY name');
  res.json(rows);
});

app.get('/api/channels/:id/messages', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT m.id, m.body, m.created_at, u.id AS user_id, u.display_name
     FROM messages m JOIN users u ON u.id = m.user_id
     WHERE m.channel_id = ? ORDER BY m.created_at DESC LIMIT 50`,
    [req.params.id],
  );
  res.json(rows);
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: CORS_ORIGIN.split(',') } });

io.on('connection', (socket) => {
  socket.on('channel:join', (channelId: string) => {
    socket.join(`channel:${channelId}`);
  });

  socket.on('channel:leave', (channelId: string) => {
    socket.leave(`channel:${channelId}`);
  });

  socket.on(
    'message:send',
    async (
      payload: { channelId: number; userId: number; body: string },
      ack?: (result: { ok: boolean; id?: number; error?: string }) => void,
    ) => {
      try {
        const [result] = await pool.execute(
          'INSERT INTO messages (channel_id, user_id, body) VALUES (?, ?, ?)',
          [payload.channelId, payload.userId, payload.body],
        );
        const id = (result as { insertId: number }).insertId;
        io.to(`channel:${payload.channelId}`).emit('message:new', {
          id,
          channelId: payload.channelId,
          userId: payload.userId,
          body: payload.body,
          createdAt: new Date().toISOString(),
        });
        ack?.({ ok: true, id });
      } catch (err) {
        ack?.({ ok: false, error: err instanceof Error ? err.message : 'insert failed' });
      }
    },
  );
});

server.listen(PORT, () => {
  console.log(`fs-internal-system server listening on :${PORT}`);
});
