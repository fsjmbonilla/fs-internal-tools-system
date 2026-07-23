import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import { pinoHttp } from 'pino-http';
import { config } from './config.js';
import { logger } from './logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { channelsRouter, messagesRouter, searchRouter } from './routes/channels.js';
import { departmentsRouter } from './routes/departments.js';
import { dmsRouter } from './routes/dms.js';
import { healthRouter } from './routes/health.js';
import { notesRouter } from './routes/notes.js';
import { docsRouter, projectsRouter, tasksRouter } from './routes/projects.js';
import { usersRouter } from './routes/users.js';

export function createApp(): express.Express {
  const app = express();

  app.use(cors({ origin: config.corsOrigins }));
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
  app.use('/api/messages', messagesRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/dms', dmsRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api/docs', docsRouter);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/notes', notesRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
