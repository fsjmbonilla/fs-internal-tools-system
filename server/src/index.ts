import http from 'node:http';
import { Server } from 'socket.io';
import { createApp } from './app.js';
import { registerAutomations } from './automations/index.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { gcUnlinkedAttachments } from './services/attachmentService.js';
import { registerSocketHandlers } from './sockets/index.js';

const app = createApp();
const server = http.createServer(app);

const io = new Server(server, { cors: { origin: config.corsOrigins } });
registerSocketHandlers(io);
registerAutomations();

setInterval(
  () => {
    gcUnlinkedAttachments(24).catch((err) => logger.error({ err }, 'attachment GC failed'));
  },
  60 * 60 * 1000,
);

server.listen(config.PORT, () => {
  logger.info(`fs-internal-system server listening on :${config.PORT}`);
});
