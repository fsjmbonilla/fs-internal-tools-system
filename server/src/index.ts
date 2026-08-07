import http from 'node:http';
import { Server } from 'socket.io';
import { createApp } from './app.js';
import { registerAutomations } from './automations/index.js';
import { armMailboxPoller } from './automations/mailboxPoller.js';
import { config } from './config.js';
import { pool } from './db/index.js';
import { logger } from './logger.js';
import { runAttachmentGc } from './services/attachmentService.js';
import { ensureBotUser } from './services/botService.js';
import { setGooglePort } from './services/google/port.js';
import { loadIntegrations } from './services/integrationsService.js';
import { realGooglePort } from './services/google/real.js';
import { startScheduler } from './services/routineScheduler.js';
import { registerSocketHandlers } from './sockets/index.js';
import { setIo } from './sockets/registry.js';

// The real Google implementation is installed only here: the app factory stays
// network-free so every test suite decides for itself what "Google" answers.
setGooglePort(realGooglePort);

const app = createApp();
const server = http.createServer(app);

const io = new Server(server, { cors: { origin: config.corsOrigins } });
app.set('io', io);
// Also reachable from the service layer, so sendMessage can broadcast.
setIo(io);
registerSocketHandlers(io);
registerAutomations();

/**
 * The assistant's identity, guaranteed at boot rather than by a deploy step.
 *
 * `npm run seed:bot` existed but nothing in the deploy path ran it, and the only
 * symptom of forgetting was one warning per triage — support intake silently did
 * nothing while chat looked healthy. ensureBotUser() is an idempotent upsert, so
 * running it every boot costs one query and removes the failure mode.
 *
 * Deliberately non-fatal: on a first deploy the migrations may not have run yet,
 * and refusing to start would take chat down over a feature that degrades fine.
 */
ensureBotUser()
  .then((id) => logger.info({ botUserId: id }, 'assistant bot user ready'))
  .catch((err) => logger.warn({ err }, 'could not ensure the bot user — support intake will no-op'));

/**
 * Arm the routine schedules from the database.
 *
 * Rebuilt at boot rather than remembered in the process, which is what makes a
 * restart safe: croner computes the next occurrence from the clock, so nothing
 * double-fires because the server came back up.
 */
startScheduler().catch((err) => logger.error({ err }, 'could not start the routine scheduler'));

// Same boot-time rebuild for the support-mailbox poller: armed only when a
// mailbox connection and a channel binding both exist in the database.
armMailboxPoller().catch((err) => logger.error({ err }, 'could not arm the mailbox poller'));

// Admin-set integration config (AI provider/model, keys, Firebase) lives in the
// settings table; load it into the in-memory cache consumers read. Non-fatal:
// until it loads — or if it cannot — everything falls back to the env vars.
loadIntegrations().catch((err) =>
  logger.warn({ err }, 'could not load integration settings — using env vars'),
);

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
