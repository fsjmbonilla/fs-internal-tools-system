import type { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from '../services/tokenService.js';
import { AppError } from './errorHandler.js';

export interface AuthContext {
  kind: 'user';
  userId: number;
  role: 'admin' | 'member';
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer /, '');
  const claims = token ? await verifyAccessToken(token) : null;
  if (!claims) throw new AppError(401, 'unauthenticated', 'Valid access token required');
  req.auth = { kind: 'user', userId: claims.userId, role: claims.role };
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  // 404, not 403 — the admin surface is invisible to non-admins (privacy rule)
  if (req.auth?.role !== 'admin') throw new AppError(404, 'not_found', 'Not found');
  next();
}
