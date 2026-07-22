import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import { pinoHttp } from 'pino-http';
import { config } from './config.js';
import { logger } from './logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { channelsRouter } from './routes/channels.js';
import { healthRouter } from './routes/health.js';

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
  app.use('/api/channels', channelsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
