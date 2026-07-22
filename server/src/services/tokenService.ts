import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { refreshTokens, users } from '../db/schema/index.js';

type Role = 'admin' | 'member';

const secret = new TextEncoder().encode(config.JWT_SECRET);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function signAccessToken(user: { id: number; role: Role }): Promise<string> {
  return new SignJWT({ role: user.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(user.id))
    .setIssuedAt()
    .setExpirationTime(`${config.ACCESS_TTL_SEC}s`)
    .sign(secret);
}

export async function verifyAccessToken(
  token: string,
): Promise<{ userId: number; role: Role } | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    return { userId: Number(payload.sub), role: payload.role as Role };
  } catch {
    return null;
  }
}

function refreshExpiry(): Date {
  return new Date(Date.now() + config.REFRESH_TTL_DAYS * 86_400_000);
}

async function insertRefresh(userId: number, familyId: string, userAgent?: string) {
  const plain = `rt_${randomBytes(32).toString('hex')}`;
  await db.insert(refreshTokens).values({
    userId,
    tokenHash: sha256(plain),
    familyId,
    expiresAt: refreshExpiry(),
    userAgent,
  });
  return plain;
}

export async function createSession(user: { id: number; role: Role }, userAgent?: string) {
  return {
    accessToken: await signAccessToken(user),
    refreshToken: await insertRefresh(user.id, randomUUID(), userAgent),
  };
}

export async function refreshSession(refreshPlain: string, userAgent?: string) {
  const hash = sha256(refreshPlain);
  const [row] = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, hash));
  if (!row) return null;
  if (row.revokedAt || row.expiresAt < new Date()) {
    // Reuse of a rotated token (or expiry): stolen-token defense — kill the family.
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
    return null;
  }
  await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, row.id));
  const [user] = await db
    .select({ id: users.id, role: users.role, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, row.userId));
  if (!user || !user.isActive) return null;
  return {
    accessToken: await signAccessToken(user),
    refreshToken: await insertRefresh(user.id, row.familyId, userAgent),
    userId: user.id,
  };
}

export async function revokeRefreshToken(refreshPlain: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(eq(refreshTokens.tokenHash, sha256(refreshPlain)));
}
