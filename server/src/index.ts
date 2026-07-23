import http from 'node:http';
import { Server } from 'socket.io';
import { registerAutomations } from './automations/index.js';
import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { registerSocketHandlers } from './sockets/index.js';

const app = createApp();
const server = http.createServer(app);

const io = new Server(server, { cors: { origin: config.corsOrigins } });
registerSocketHandlers(io);
registerAutomations();

server.listen(config.PORT, () => {
  logger.info(`fs-internal-system server listening on :${config.PORT}`);
});
