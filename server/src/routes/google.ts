import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { requireAuth, requireUserAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { logger } from '../logger.js';
import {
  authUrlFor,
  disconnect,
  getStatus,
  handleCallback,
  isGoogleConfigured,
  type GoogleKind,
} from '../services/googleService.js';

/**
 * Google connection management.
 *
 * Everything here is `requireUserAuth` — a Google connection is personal data
 * and managing one is a human act; service tokens have no business here. The
 * one exception is `/callback`, which cannot carry a bearer token at all: the
 * browser arrives straight from Google's redirect, and the signed `state`
 * parameter is its authentication (verified inside `handleCallback`).
 */
export const googleRouter = Router();

/** Where the browser lands after the dance. The SPA reads the query param. */
function frontendBase(): string {
  return config.corsOrigins[0] ?? 'http://localhost:5173';
}

googleRouter.get('/callback', async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  // A browser is on the other end — always redirect, never answer JSON.
  if (!code || !state) {
    res.redirect(`${frontendBase()}/settings?google=error`);
    return;
  }
  try {
    const { kind } = await handleCallback(code, state);
    res.redirect(`${frontendBase()}/settings?google=connected&kind=${kind}`);
  } catch (err) {
    logger.warn({ err }, 'google oauth callback failed');
    res.redirect(`${frontendBase()}/settings?google=error`);
  }
});

googleRouter.use(requireAuth, requireUserAuth);

const kindQuery = z.object({ kind: z.enum(['user', 'support_mailbox']).default('user') });

function parseKind(req: { query: unknown }, role: string): GoogleKind {
  const parsed = kindQuery.safeParse(req.query);
  if (!parsed.success) throw new AppError(400, 'validation_error', 'Bad kind');
  if (parsed.data.kind === 'support_mailbox' && role !== 'admin') {
    throw new AppError(403, 'forbidden', 'Only admins manage the support mailbox');
  }
  return parsed.data.kind;
}

googleRouter.get('/auth-url', async (req, res) => {
  const kind = parseKind(req, req.auth!.role);
  res.json({ url: await authUrlFor(req.auth!.userId, kind) });
});

googleRouter.get('/status', async (req, res) => {
  if (!isGoogleConfigured()) {
    res.json({ configured: false, user: { connected: false, email: null, broken: false } });
    return;
  }
  res.json(await getStatus(req.auth!.userId, req.auth!.role === 'admin'));
});

googleRouter.delete('/connection', async (req, res) => {
  const kind = parseKind(req, req.auth!.role);
  const removed = await disconnect(kind, req.auth!.userId);
  if (!removed) throw new AppError(404, 'not_found', 'Not found');
  res.json({ ok: true });
});
