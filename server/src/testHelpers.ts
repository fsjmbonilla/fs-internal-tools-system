import { eq } from 'drizzle-orm';
import type { Express } from 'express';
import request from 'supertest';
import { db } from './db/index.js';
import { users } from './db/schema/index.js';

export async function makeUser(
  app: Express,
  opts: { email?: string; admin?: boolean } = {},
): Promise<{ token: string; userId: number }> {
  const email = opts.email ?? `u${Date.now()}${Math.floor(Math.random() * 1e6)}@flowerstore.ph`;
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'hunter2hunter2', displayName: email.split('@')[0] });
  if (reg.status !== 201) throw new Error(`makeUser register failed: ${reg.status}`);
  const userId: number = reg.body.user.id;
  if (opts.admin) {
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, userId));
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'hunter2hunter2' });
    return { token: login.body.accessToken, userId };
  }
  return { token: reg.body.accessToken, userId };
}
