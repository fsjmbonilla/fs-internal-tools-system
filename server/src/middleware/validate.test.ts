import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppError } from './errorHandler.js';
import { validate } from './validate.js';

const schema = z.object({ name: z.string().min(1) });

function fakeReq(body: unknown) {
  return { body } as Parameters<ReturnType<typeof validate>>[0];
}

describe('validate middleware', () => {
  it('passes a valid body through and stores the parsed value on req.valid', () => {
    const req = fakeReq({ name: 'general', extra: 'stripped' });
    const next = vi.fn();

    validate(schema)(req, {} as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.valid).toEqual({ name: 'general' });
  });

  it('throws a 400 AppError with field detail for an invalid body', () => {
    const req = fakeReq({ name: '' });

    expect(() => validate(schema)(req, {} as never, vi.fn())).toThrowError(AppError);
    try {
      validate(schema)(req, {} as never, vi.fn());
    } catch (err) {
      const appErr = err as AppError;
      expect(appErr.status).toBe(400);
      expect(appErr.code).toBe('validation_error');
      expect(appErr.message).toContain('name');
    }
  });
});
