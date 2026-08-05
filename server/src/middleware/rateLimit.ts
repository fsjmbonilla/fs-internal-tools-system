import rateLimit from 'express-rate-limit';
import { config } from '../config.js';

const WINDOW_MS = 15 * 60 * 1000;

// Suites exercise these paths in tight loops; a real limit would make them
// flaky rather than safe.
const forTest = config.NODE_ENV === 'test';

function limiter(limit: number, message = 'Too many attempts, try again later') {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit: forTest ? 1000 : limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: { code: 'rate_limited', message } },
  });
}

/** Login and register: the brute-force surface. */
export const authLimiter = limiter(20);

/**
 * Refresh and logout. Generous, because a legitimate client refreshes about
 * every 15 minutes per device — but not unbounded, which is what it was: each
 * call costs a token lookup plus the family-revocation write path.
 */
export const refreshLimiter = limiter(60);

/**
 * Uploads. One request may carry 10 files of 20 MB, so no limit at all is a
 * disk-fill primitive; 30 per window caps a single client near 6 GB instead of
 * infinity.
 */
export const uploadLimiter = limiter(30, 'Too many uploads, try again later');
