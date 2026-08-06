import { randomUUID } from 'node:crypto';
import compression from 'compression';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { config } from './config.js';
import { logger } from './logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { mcpRouter } from './mcp/server.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { callsRouter } from './routes/calls.js';
import { channelsRouter, messagesRouter, searchRouter } from './routes/channels.js';
import { departmentsRouter } from './routes/departments.js';
import { dmsRouter } from './routes/dms.js';
import { filesRouter } from './routes/files.js';
import { healthRouter } from './routes/health.js';
import { notesRouter } from './routes/notes.js';
import { docsRouter, projectsRouter, tasksRouter } from './routes/projects.js';
import { pushRouter } from './routes/push.js';
import { routinesRouter } from './routes/routines.js';
import { runnerRouter } from './routes/runner.js';
import { scriptRunsRouter, scriptsRouter } from './routes/scripts.js';
import { projectSheetsRouter, sheetsRouter } from './routes/sheets.js';
import { uploadsRouter } from './routes/uploads.js';
import { usersRouter } from './routes/users.js';

export function createApp(): express.Express {
  const app = express();

  // Reduce fingerprinting: nothing needs to know this is Express.
  app.disable('x-powered-by');

  // Behind the load balancer, req.ip has to come from X-Forwarded-For or every
  // client shares one rate-limit bucket (the balancer's address) and the logs
  // record the wrong origin. One hop only — trusting the whole chain would let a
  // client forge its own address.
  if (config.TRUST_PROXY) app.set('trust proxy', 1);

  app.use(
    helmet({
      // This process serves JSON and file downloads, never HTML documents, so a
      // document CSP has nothing to apply to. The file route sets its own
      // sandbox CSP, which is where inline content actually gets served.
      contentSecurityPolicy: false,
      // Downloads are same-origin-ish reads by design (the SPA fetches them
      // cross-origin in dev), so the strict default would break attachments.
      crossOriginResourcePolicy: false,
      // HSTS only where TLS actually terminates; sending it from a plain-HTTP
      // dev server would pin localhost to HTTPS in the developer's browser.
      hsts: config.NODE_ENV === 'production',
    }),
  );

  // Compress in-process rather than assuming something upstream does it: an ALB
  // does not gzip, and message history is the payload that actually benefits.
  // Static assets are a separate concern and belong to nginx/CloudFront, which
  // can also serve brotli — `pm2 serve` is not a production asset server.
  app.use(
    compression({
      filter: (req, res) => {
        // Auth responses carry tokens. Compressing a response that mixes a
        // secret with attacker-influenced input is the BREACH shape, and these
        // are small enough that compression buys nothing anyway.
        if (req.path.startsWith('/api/auth')) return false;
        return compression.filter(req, res);
      },
    }),
  );

  app.use(cors({ origin: config.corsOrigins }));
  /**
   * A workbook snapshot is orders of magnitude larger than any other body this
   * API accepts, so the sheet routes get their own limit rather than raising it
   * for everything — a 25 MB ceiling on /api/messages would be an easy way to
   * exhaust memory. Registered before the global parser so it wins for these paths.
   */
  const sheetJson = express.json({ limit: '25mb' });
  app.use('/api/sheets', sheetJson);
  app.use('/api/projects/:id/sheets', sheetJson);
  app.use(express.json({ limit: '1mb' }));
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req.headers['x-request-id'] as string) ?? randomUUID(),
      autoLogging: { ignore: (req) => req.url === '/health' },
    }),
  );

  app.use('/health', healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/departments', departmentsRouter);
  app.use('/api/channels', channelsRouter);
  app.use('/api/calls', callsRouter);
  app.use('/api/messages', messagesRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/dms', dmsRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api/docs', docsRouter);
  app.use('/api/sheets', sheetsRouter);
  app.use('/api/routines', routinesRouter);
  app.use('/api/scripts', scriptsRouter);
  app.use('/api/script-runs', scriptRunsRouter);
  app.use('/api/runner', runnerRouter);
  app.use('/api/projects/:id/sheets', projectSheetsRouter);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/notes', notesRouter);
  app.use('/api/push', pushRouter);
  app.use('/api/uploads', uploadsRouter);
  app.use('/api/files', filesRouter);
  // Not under /api: an MCP endpoint is addressed by client config, not by the SPA.
  app.use('/mcp', mcpRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
