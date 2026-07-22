import { pino } from 'pino';
import { config } from './config.js';

export const logger = pino(
  config.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : config.NODE_ENV === 'test'
      ? { level: 'silent' }
      : {},
);
