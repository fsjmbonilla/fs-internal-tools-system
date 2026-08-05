import http from 'node:http';
import { Server } from 'socket.io';
import { createApp } from './app.js';
import { registerAutomations } from './automations/index.js';
import { config } from './config.js';
import { pool } from './db/index.js';
import { logger } from './logger.js';
import { runAttachmentGc } from './services/attachmentService.js';
import { registerSocketHandlers } from './sockets/index.js';

const app = createApp();
const server = http.createServer(app);

const io = new Server(server, { cors: { origin: config.corsOrigins } });
registerSocketHandlers(io);
registerAutomations();

const GC_INTERVAL_MS = 60 * 60 * 1000;
const gcTimer = setInterval(() => {
  // Holds an advisory lock internally, so running this in every process is safe.
  runAttachmentGc(24).catch((err) => logger.error({ err }, 'attachment GC failed'));
}, GC_INTERVAL_MS);

server.listen(config.PORT, () => {
  logger.info(`fs-internal-system server listening on :${config.PORT}`);
});

/**
 * Shut down in order, with a deadline.
 *
 * ECS and PM2 both stop a process with SIGTERM. Without handling it the process
 * died mid-request, dropped every socket without a close frame, and left the
 * pool's connections for the database to time out.
 */
const SHUTDOWN_DEADLINE_MS = 10_000;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return; // a second Ctrl-C must not start this twice
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  // If a hung connection keeps us past the deadline, exit anyway: the
  // orchestrator would SIGKILL us regardless, and this way the reason is logged.
  const deadline = setTimeout(() => {
    logger.warn('shutdown deadline reached, exiting anyway');
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS);
  deadline.unref();

  clearInterval(gcTimer);
  try {
    // Sockets first: they are long-lived by design, so closing the HTTP server
    // while they are still attached would always run out the clock.
    //
    // io.close() also closes the HTTP server it is attached to, so the guard
    // below is not belt-and-braces — calling server.close() unconditionally
    // throws ERR_SERVER_NOT_RUNNING, which sent this whole function down the
    // error path and skipped pool.end().
    await io.close();
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
    await pool.end();
    logger.info('shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'shutdown failed');
    process.exit(1);
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void shutdown(signal));
}
