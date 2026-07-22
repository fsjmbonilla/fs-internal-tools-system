import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';
import { AppError } from './errorHandler.js';

type Source = 'body' | 'query' | 'params';

// Parsed values land on req.valid — Express 5 makes req.query a read-only getter,
// so mutating the originals is not an option.
declare module 'express-serve-static-core' {
  interface Request {
    valid?: unknown;
  }
}

export function validate(schema: ZodType, source: Source = 'body') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const detail = result.error.issues
        .map((i) => `${i.path.join('.') || source}: ${i.message}`)
        .join('; ');
      throw new AppError(400, 'validation_error', detail);
    }
    req.valid = result.data;
    next();
  };
}
