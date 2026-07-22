import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { AppError } from '../middleware/errorHandler.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { isEmailAllowed } from './settingsService.js';
import { createSession } from './tokenService.js';

export interface PublicUser {
  id: number;
  email: string;
  displayName: string;
  role: 'admin' | 'member';
  avatarUrl: string | null;
}

type UserRow = typeof users.$inferSelect;

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    avatarUrl: row.avatarUrl,
  };
}

export async function register(
  input: { email: string; password: string; displayName: string },
  userAgent?: string,
) {
  const email = input.email.trim().toLowerCase();
  if (!(await isEmailAllowed(email))) {
    throw new AppError(403, 'domain_not_allowed', 'Email domain is not allowed to register');
  }
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) throw new AppError(409, 'email_taken', 'An account with this email already exists');
  const passwordHash = await hashPassword(input.password);
  const [{ id }] = await db
    .insert(users)
    .values({ email, passwordHash, displayName: input.displayName.trim() })
    .$returningId();
  const [row] = await db.select().from(users).where(eq(users.id, id));
  const tokens = await createSession({ id: row.id, role: row.role }, userAgent);
  return { user: toPublicUser(row), ...tokens };
}

export async function login(email: string, password: string, userAgent?: string) {
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()));
  if (!row || !row.isActive || !(await verifyPassword(row.passwordHash, password))) {
    throw new AppError(401, 'invalid_credentials', 'Invalid email or password');
  }
  const tokens = await createSession({ id: row.id, role: row.role }, userAgent);
  return { user: toPublicUser(row), ...tokens };
}
