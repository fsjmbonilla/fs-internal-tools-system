import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import { pinoHttp } from 'pino-http';
import { config } from './config.js';
import { logger } from './logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { channelsRouter } from './routes/channels.js';
import { departmentsRouter } from './routes/departments.js';
import { healthRouter } from './routes/health.js';
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

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
