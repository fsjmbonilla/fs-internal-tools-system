import { pino } from 'pino';
import { config } from './config.js';

/**
 * Credentials must never reach the log stream.
 *
 * pino-http serializes req.headers wholesale, so before this every
 * authenticated request wrote its `Authorization: Bearer <token>` into the
 * logs. Access tokens live 15 minutes; log files live far longer, and they get
 * shipped, tailed and pasted into tickets.
 */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  // Socket handshakes and refresh bodies carry their own credentials.
  'handshake.auth.token',
  'refreshToken',
  'password',
];

const redact = { paths: REDACTED_PATHS, censor: '[redacted]', remove: false };

export const logger = pino(
  config.NODE_ENV === 'development'
    ? { redact, transport: { target: 'pino-pretty', options: { colorize: true } } }
    : config.NODE_ENV === 'test'
      ? { level: 'silent', redact }
      : { redact },
);
