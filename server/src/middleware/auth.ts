import type { NextFunction, Request, Response } from 'express';
import {
  looksLikeServiceToken,
  verifyApiToken,
  type Scope,
} from '../services/apiTokenService.js';
import { verifyAccessToken } from '../services/tokenService.js';
import { AppError } from './errorHandler.js';

/**
 * Two kinds of caller, one auth surface.
 *
 * A person presents a short-lived JWT; an agent presents a service token
 * (`fsk_…`) and acts as a bot user. Both land in `req.auth`, and every downstream
 * query keeps filtering by `userId` — so a token sees exactly what its bot user
 * is a member of, and the platform's visibility rules are not relaxed for
 * automation. The one asymmetry is `scopes`: a person is not scope-limited, a
 * token holds only what it was granted.
 */
export interface AuthContext {
  kind: 'user' | 'token';
  userId: number;
  role: 'admin' | 'member';
  /** Present only for token auth. A user satisfies any scope check. */
  scopes?: Scope[];
  tokenId?: number;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer /, '');
  if (!token) throw new AppError(401, 'unauthenticated', 'Valid access token required');

  if (looksLikeServiceToken(token)) {
    const context = await verifyApiToken(token);
    if (!context) throw new AppError(401, 'unauthenticated', 'Valid access token required');
    req.auth = {
      kind: 'token',
      userId: context.userId,
      role: context.role,
      scopes: context.scopes,
      tokenId: context.tokenId,
    };
    next();
    return;
  }

  const claims = await verifyAccessToken(token);
  if (!claims) throw new AppError(401, 'unauthenticated', 'Valid access token required');
  req.auth = { kind: 'user', userId: claims.userId, role: claims.role };
  next();
}

/**
 * Routes only a person may reach.
 *
 * Notes are the case this exists for: they are private to their owner and
 * deliberately outside AI reach, so a service token is refused there whatever
 * scopes it holds. 401 rather than 403 — the token is not a valid credential for
 * this route at all, so there is no scope an operator could grant to fix it.
 */
export function requireUserAuth(req: Request, _res: Response, next: NextFunction) {
  if (req.auth?.kind !== 'user') {
    throw new AppError(401, 'unauthenticated', 'This endpoint is not available to service tokens');
  }
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  // 404, not 403 — the admin surface is invisible to non-admins (privacy rule)
  if (req.auth?.role !== 'admin') throw new AppError(404, 'not_found', 'Not found');
  next();
}

/**
 * Require a scope, for token callers only.
 *
 * A person is never scope-limited — scopes bound what an agent may do, they do
 * not re-implement roles. 403 rather than 404 here: the caller is authenticated
 * and holds a token for this platform, so naming the missing scope tells an
 * operator how to fix it without revealing anything a 404 was hiding.
 */
export function requireScope(scope: Scope) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) throw new AppError(401, 'unauthenticated', 'Valid access token required');
    if (req.auth.kind === 'user') {
      next();
      return;
    }
    if (!req.auth.scopes?.includes(scope)) {
      throw new AppError(403, 'insufficient_scope', `This token lacks the ${scope} scope`);
    }
    next();
  };
}
