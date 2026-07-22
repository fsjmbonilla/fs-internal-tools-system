# Phase 1: Auth, Admin & Departments — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Email+password auth (JWT access + rotating refresh tokens), domain-restricted self-registration, admin/member roles, admin UI (allowed domains, users, departments), department CRUD with channel auto-join, and authenticated sockets.

**Architecture:** jose-signed HS256 access JWTs (15 min, in-memory client-side) + opaque sha256-hashed refresh tokens (30 d, rotation with family reuse-detection) persisted via a storage abstraction (Capacitor Preferences native / localStorage web). Services own logic; routes are thin; every DB-touching service gets integration tests against a dedicated `fs_internal_system_test` database in the fs-mysql container.

**Tech Stack:** Express 5, Drizzle 0.45 (mysql2), jose, argon2, express-rate-limit, zod 4, Vitest+supertest; React 19, react-router v8, TanStack Query 5, zustand 5, shadcn.

## Global Constraints

- JWT via `jose` (NOT jsonwebtoken); passwords via `argon2` (alpine prebuilds verified)
- `multer` not needed this phase; `express-rate-limit` on /api/auth/login + /register
- Error envelope: `{ error: { code, message } }`; privacy rule: unknown/forbidden resources → 404
- Registration allowed only for domains in `settings.allowed_domains` (default seed: flowerstore.ph, potico.ph, potico.co.th); new users are always `member`; admins come from the seed script or admin PATCH
- Refresh reuse ⇒ revoke whole family; access TTL 900 s; refresh TTL 30 d
- Sockets: JWT in `handshake.auth.token`; `message:send` takes userId ONLY from `socket.data.userId`
- Commits: small, conventional (`feat(server): …`), end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Every task ends with `npm test` green in `server/` (and `npm run build` where frontend files change)

---

### Task 1: Test database + config extensions + deps

**Files:**
- Modify: `server/src/config.ts`
- Create: `server/src/db/testSetup.ts`
- Create: `server/vitest.config.ts`
- Modify: `server/package.json` (deps)

**Interfaces:**
- Produces: `config.JWT_SECRET: string`, `config.ACCESS_TTL_SEC: number` (900), `config.REFRESH_TTL_DAYS: number` (30)
- Produces: `resetDb(): Promise<void>` from testSetup (truncates all tables between tests)
- Test DB: `fs_internal_system_test` in the fs-mysql container, migrations applied by vitest globalSetup

- [ ] **Step 1: Install deps**

```bash
cd /usr/share/nginx/html/fs-internal-system/server
npm install jose argon2 express-rate-limit
```

- [ ] **Step 2: Create the test database (idempotent)**

```bash
docker exec fs-mysql mysql -uroot -pfs_root_dev -e "CREATE DATABASE IF NOT EXISTS fs_internal_system_test CHARACTER SET utf8mb4; GRANT ALL PRIVILEGES ON fs_internal_system_test.* TO 'fs_app'@'%'; FLUSH PRIVILEGES;"
```

- [ ] **Step 3: Extend config** — add to the zod schema in `server/src/config.ts`:

```ts
  JWT_SECRET: z.string().min(16).default('dev-secret-change-me-not-for-prod'),
  ACCESS_TTL_SEC: z.coerce.number().int().positive().default(900),
  REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
```

And after the parse, fail hard on the default secret outside dev/test:

```ts
if (parsed.data.NODE_ENV === 'production' && parsed.data.JWT_SECRET === 'dev-secret-change-me-not-for-prod') {
  console.error('JWT_SECRET must be set in production');
  process.exit(1);
}
```

- [ ] **Step 4: vitest config + global setup** — `server/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: './src/db/testSetup.ts',
    fileParallelism: false, // all suites share one MySQL test DB
    env: { DB_NAME: 'fs_internal_system_test', NODE_ENV: 'test' },
  },
});
```

`server/src/db/testSetup.ts` (globalSetup — runs migrations once):

```ts
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';

export default async function setup(): Promise<void> {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3307),
    user: process.env.DB_USER ?? 'fs_app',
    password: process.env.DB_PASSWORD ?? 'fs_app_dev',
    database: 'fs_internal_system_test',
    multipleStatements: true,
  });
  await migrate(drizzle(conn), { migrationsFolder: './drizzle' });
  await conn.end();
}
```

- [ ] **Step 5: per-test truncation helper** — `server/src/db/testUtils.ts`:

```ts
import { pool } from './index.js';

const TABLES = [
  'refresh_tokens', 'department_members', 'departments', 'channel_members',
  'messages', 'channels', 'settings', 'users',
];

export async function resetDb(): Promise<void> {
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of TABLES) await pool.query(`TRUNCATE TABLE \`${t}\``);
  await pool.query('SET FOREIGN_KEY_CHECKS = 1');
}
```

(Note: table list includes Task 2's tables — testUtils lands with Task 2's commit if TRUNCATE of missing tables errors before then; simplest: commit testUtils in Task 2.)

- [ ] **Step 6: Run tests** — `npm test` → existing 5 tests still pass (now against the test DB).

- [ ] **Step 7: Commit** — `chore(server): test database harness, jwt/argon2/rate-limit deps, auth config`

### Task 2: Migrations 001+006 — users/auth + departments schema

**Files:**
- Modify: `server/src/db/schema/auth.ts`
- Create: `server/src/db/schema/departments.ts`
- Modify: `server/src/db/schema/chat.ts` (channels.departmentId)
- Modify: `server/src/db/schema/index.ts`
- Create: `server/src/db/testUtils.ts` (from Task 1 Step 5)

**Interfaces:**
- Produces tables: users(+passwordHash,role,avatarUrl,isActive,updatedAt), settings(key,value json), refreshTokens(tokenHash,familyId,expiresAt,revokedAt), departments, departmentMembers, channels.departmentId
- Drizzle exports: `users, settings, refreshTokens, departments, departmentMembers` + existing

- [ ] **Step 1: Extend `auth.ts`**

```ts
import { sql } from 'drizzle-orm';
import {
  bigint, boolean, char, datetime, index, json, mysqlEnum, mysqlTable, timestamp, varchar,
} from 'drizzle-orm/mysql-core';

export const users = mysqlTable('users', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  displayName: varchar('display_name', { length: 100 }).notNull(),
  role: mysqlEnum('role', ['admin', 'member']).notNull().default('member'),
  avatarUrl: varchar('avatar_url', { length: 500 }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
});

export const settings = mysqlTable('settings', {
  key: varchar('key', { length: 64 }).primaryKey(),
  value: json('value').notNull(),
  updatedBy: bigint('updated_by', { mode: 'number', unsigned: true }),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
});

export const refreshTokens = mysqlTable(
  'refresh_tokens',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    userId: bigint('user_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: char('token_hash', { length: 64 }).notNull().unique(),
    familyId: char('family_id', { length: 36 }).notNull(),
    expiresAt: datetime('expires_at').notNull(),
    revokedAt: datetime('revoked_at'),
    userAgent: varchar('user_agent', { length: 255 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('idx_rt_user').on(t.userId), index('idx_rt_family').on(t.familyId)],
);
```

- [ ] **Step 2: `departments.ts`**

```ts
import {
  bigint, mysqlEnum, mysqlTable, primaryKey, text, timestamp, varchar,
} from 'drizzle-orm/mysql-core';
import { users } from './auth.js';

export const departments = mysqlTable('departments', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  name: varchar('name', { length: 80 }).notNull().unique(),
  description: text('description'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const departmentMembers = mysqlTable(
  'department_members',
  {
    departmentId: bigint('department_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => departments.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: mysqlEnum('role', ['lead', 'member']).notNull().default('member'),
    joinedAt: timestamp('joined_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.departmentId, t.userId] })],
);
```

- [ ] **Step 3: channels.departmentId in `chat.ts`** — add to channels columns:

```ts
    departmentId: bigint('department_id', { mode: 'number', unsigned: true })
      .references(() => departments.id, { onDelete: 'set null' }),
```

with `import { departments } from './departments.js';` and export `./departments.js` from `schema/index.ts`.

- [ ] **Step 4: generate + apply + verify**

```bash
npx drizzle-kit generate --name auth_departments   # → drizzle/0001_auth_departments.sql; review SQL
npm run db:migrate                                  # dev DB
docker exec fs-mysql mysql -ufs_app -pfs_app_dev fs_internal_system -e "SHOW COLUMNS FROM users; SHOW TABLES;"
```

Expected: users has password_hash/role/avatar_url/is_active/updated_at; tables include settings, refresh_tokens, departments, department_members.

- [ ] **Step 5: `npm test`** (global setup migrates test DB) → green.

- [ ] **Step 6: Commit** — `feat(server): auth + departments schema (migrations 0001)`

### Task 3: passwords.ts (argon2) — TDD

**Files:**
- Create: `server/src/services/passwords.ts`
- Test: `server/src/services/passwords.test.ts`

**Interfaces:**
- Produces: `hashPassword(plain: string): Promise<string>`, `verifyPassword(hash: string, plain: string): Promise<boolean>`

- [ ] **Step 1: failing test**

```ts
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './passwords.js';

describe('passwords', () => {
  it('hashes and verifies round-trip', async () => {
    const hash = await hashPassword('s3cret-pw');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, 's3cret-pw')).toBe(true);
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
  });
});
```

- [ ] **Step 2: run** `npm test -- passwords` → FAIL (module not found)
- [ ] **Step 3: implement**

```ts
import argon2 from 'argon2';

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return argon2.verify(hash, plain).catch(() => false);
}
```

- [ ] **Step 4: run** → PASS. **Step 5: Commit** — `feat(server): argon2 password hashing`

### Task 4: tokenService (jose access + rotating refresh) — TDD

**Files:**
- Create: `server/src/services/tokenService.ts`
- Test: `server/src/services/tokenService.test.ts`

**Interfaces:**
- Produces:
  - `signAccessToken(user: { id: number; role: 'admin' | 'member' }): Promise<string>`
  - `verifyAccessToken(token: string): Promise<{ userId: number; role: 'admin' | 'member' } | null>`
  - `createSession(user: { id: number; role: Role }, userAgent?: string): Promise<{ accessToken: string; refreshToken: string }>`
  - `refreshSession(refreshPlain: string, userAgent?: string): Promise<{ accessToken: string; refreshToken: string; userId: number } | null>` — rotation; on reuse of a revoked token revokes the family and returns null
  - `revokeRefreshToken(refreshPlain: string): Promise<void>`

- [ ] **Step 1: failing tests**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import {
  createSession, refreshSession, revokeRefreshToken, signAccessToken, verifyAccessToken,
} from './tokenService.js';

async function seedUser() {
  const [{ id }] = await db.insert(users)
    .values({ email: 'a@flowerstore.ph', passwordHash: 'x', displayName: 'A' })
    .$returningId();
  return { id, role: 'member' as const };
}

describe('tokenService', () => {
  beforeEach(resetDb);

  it('access token round-trips claims', async () => {
    const token = await signAccessToken({ id: 7, role: 'admin' });
    expect(await verifyAccessToken(token)).toEqual({ userId: 7, role: 'admin' });
    expect(await verifyAccessToken('garbage')).toBeNull();
  });

  it('refresh rotation: old token invalid, new token works', async () => {
    const user = await seedUser();
    const s1 = await createSession(user);
    const s2 = await refreshSession(s1.refreshToken);
    expect(s2).not.toBeNull();
    expect(s2!.userId).toBe(user.id);
    // rotated: same plaintext cannot be used again normally…
    const s3 = await refreshSession(s2!.refreshToken);
    expect(s3).not.toBeNull();
  });

  it('reuse of a rotated token revokes the whole family', async () => {
    const user = await seedUser();
    const s1 = await createSession(user);
    const s2 = await refreshSession(s1.refreshToken);
    // replay the OLD token → reuse detected
    expect(await refreshSession(s1.refreshToken)).toBeNull();
    // and the newest token in the family is dead too
    expect(await refreshSession(s2!.refreshToken)).toBeNull();
  });

  it('logout revokes the token', async () => {
    const user = await seedUser();
    const s1 = await createSession(user);
    await revokeRefreshToken(s1.refreshToken);
    expect(await refreshSession(s1.refreshToken)).toBeNull();
  });
});
```

- [ ] **Step 2: run** → FAIL. **Step 3: implement**

```ts
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

export async function verifyAccessToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, secret);
    return { userId: Number(payload.sub), role: payload.role as Role };
  } catch {
    return null;
  }
}

function expiry(): Date {
  return new Date(Date.now() + config.REFRESH_TTL_DAYS * 86_400_000);
}

async function insertRefresh(userId: number, familyId: string, userAgent?: string) {
  const plain = `rt_${randomBytes(32).toString('hex')}`;
  await db.insert(refreshTokens).values({
    userId, tokenHash: sha256(plain), familyId, expiresAt: expiry(), userAgent,
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
    // reuse (or expiry) → kill the family
    await db.update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
    return null;
  }
  await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, row.id));
  const [user] = await db.select({ id: users.id, role: users.role, isActive: users.isActive })
    .from(users).where(eq(users.id, row.userId));
  if (!user || !user.isActive) return null;
  return {
    accessToken: await signAccessToken(user),
    refreshToken: await insertRefresh(user.id, row.familyId, userAgent),
    userId: user.id,
  };
}

export async function revokeRefreshToken(refreshPlain: string): Promise<void> {
  await db.update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(eq(refreshTokens.tokenHash, sha256(refreshPlain)));
}
```

- [ ] **Step 4: run** → PASS. **Step 5: Commit** — `feat(server): jose access tokens + rotating refresh tokens with family reuse detection`

### Task 5: settingsService (allowed domains) — TDD

**Files:**
- Create: `server/src/services/settingsService.ts`
- Test: `server/src/services/settingsService.test.ts`

**Interfaces:**
- Produces: `getAllowedDomains(): Promise<string[]>` (defaults `['flowerstore.ph','potico.ph','potico.co.th']` when unset), `setAllowedDomains(domains: string[], updatedBy: number): Promise<void>`, `isEmailAllowed(email: string): Promise<boolean>` (case-insensitive, exact domain match)

- [ ] **Step 1: failing tests**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../db/testUtils.js';
import { getAllowedDomains, isEmailAllowed, setAllowedDomains } from './settingsService.js';

describe('settingsService', () => {
  beforeEach(resetDb);

  it('returns defaults when unset', async () => {
    expect(await getAllowedDomains()).toEqual(['flowerstore.ph', 'potico.ph', 'potico.co.th']);
  });

  it('persists updates and checks emails case-insensitively', async () => {
    await setAllowedDomains(['example.com'], 1);
    expect(await getAllowedDomains()).toEqual(['example.com']);
    expect(await isEmailAllowed('Person@Example.COM')).toBe(true);
    expect(await isEmailAllowed('person@flowerstore.ph')).toBe(false);
    expect(await isEmailAllowed('person@evil-example.com')).toBe(false);
  });
});
```

- [ ] **Step 2: run** → FAIL. **Step 3: implement**

```ts
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { settings } from '../db/schema/index.js';

const KEY = 'allowed_domains';
const DEFAULTS = ['flowerstore.ph', 'potico.ph', 'potico.co.th'];

export async function getAllowedDomains(): Promise<string[]> {
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY));
  return row ? (row.value as string[]) : DEFAULTS;
}

export async function setAllowedDomains(domains: string[], updatedBy: number): Promise<void> {
  const value = domains.map((d) => d.trim().toLowerCase()).filter(Boolean);
  await db.insert(settings).values({ key: KEY, value, updatedBy })
    .onDuplicateKeyUpdate({ set: { value, updatedBy } });
}

export async function isEmailAllowed(email: string): Promise<boolean> {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  return (await getAllowedDomains()).includes(domain);
}
```

- [ ] **Step 4: run** → PASS. **Step 5: Commit** — `feat(server): allowed-domains setting service`

### Task 6: authService (register/login) — TDD

**Files:**
- Create: `server/src/services/authService.ts`
- Test: `server/src/services/authService.test.ts`

**Interfaces:**
- Produces: `register(input: { email; password; displayName }, userAgent?)` → `{ user: PublicUser; accessToken; refreshToken }`; throws `AppError(403,'domain_not_allowed')`, `AppError(409,'email_taken')`
- `login(email, password, userAgent?)` → same shape; throws `AppError(401,'invalid_credentials')` (also for inactive users)
- `PublicUser = { id, email, displayName, role, avatarUrl }`
- `toPublicUser(row)` exported for reuse

- [ ] **Step 1: failing tests**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../db/testUtils.js';
import { AppError } from '../middleware/errorHandler.js';
import { login, register } from './authService.js';

const cred = { email: 'jm@flowerstore.ph', password: 'hunter2hunter2', displayName: 'JM' };

describe('authService', () => {
  beforeEach(resetDb);

  it('registers an allowed-domain user as member and logs in', async () => {
    const r = await register(cred);
    expect(r.user).toMatchObject({ email: cred.email, role: 'member', displayName: 'JM' });
    expect(r.accessToken).toBeTruthy();
    const l = await login(cred.email, cred.password);
    expect(l.user.id).toBe(r.user.id);
  });

  it('rejects disallowed domains with 403', async () => {
    await expect(register({ ...cred, email: 'x@gmail.com' }))
      .rejects.toMatchObject({ status: 403, code: 'domain_not_allowed' });
  });

  it('rejects duplicate email with 409', async () => {
    await register(cred);
    await expect(register(cred)).rejects.toMatchObject({ status: 409, code: 'email_taken' });
  });

  it('rejects wrong password with 401', async () => {
    await register(cred);
    await expect(login(cred.email, 'nope-nope-nope'))
      .rejects.toMatchObject({ status: 401, code: 'invalid_credentials' });
  });
});
```

- [ ] **Step 2: run** → FAIL. **Step 3: implement**

```ts
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { AppError } from '../middleware/errorHandler.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { isEmailAllowed } from './settingsService.js';
import { createSession } from './tokenService.js';

export interface PublicUser {
  id: number; email: string; displayName: string;
  role: 'admin' | 'member'; avatarUrl: string | null;
}

type UserRow = typeof users.$inferSelect;

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id, email: row.email, displayName: row.displayName,
    role: row.role, avatarUrl: row.avatarUrl,
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
  const [{ id }] = await db.insert(users)
    .values({ email, passwordHash, displayName: input.displayName.trim() })
    .$returningId();
  const [row] = await db.select().from(users).where(eq(users.id, id));
  const tokens = await createSession({ id: row.id, role: row.role }, userAgent);
  return { user: toPublicUser(row), ...tokens };
}

export async function login(email: string, password: string, userAgent?: string) {
  const [row] = await db.select().from(users)
    .where(eq(users.email, email.trim().toLowerCase()));
  if (!row || !row.isActive || !(await verifyPassword(row.passwordHash, password))) {
    throw new AppError(401, 'invalid_credentials', 'Invalid email or password');
  }
  const tokens = await createSession({ id: row.id, role: row.role }, userAgent);
  return { user: toPublicUser(row), ...tokens };
}
```

- [ ] **Step 4: run** → PASS. **Step 5: Commit** — `feat(server): register/login with domain gate`

### Task 7: auth middleware + auth routes — TDD (supertest)

**Files:**
- Create: `server/src/middleware/auth.ts`
- Create: `server/src/middleware/rateLimit.ts`
- Create: `server/src/routes/auth.ts`
- Modify: `server/src/app.ts` (mount)
- Test: `server/src/routes/auth.test.ts`

**Interfaces:**
- `requireAuth`: reads `Authorization: Bearer <jwt>` → sets `req.auth = { kind: 'user', userId, role }` or 401 `unauthenticated`
- `requireAdmin`: after requireAuth; 404 `not_found` for non-admins (privacy rule: don't reveal admin surface)
- Routes: POST `/api/auth/register` {email,password≥12,displayName}; POST `/api/auth/login`; POST `/api/auth/refresh` {refreshToken}; POST `/api/auth/logout` {refreshToken}; GET `/api/auth/me` (requireAuth)
- Rate limit: `authLimiter` — 20 req / 15 min per IP on register+login (1000 in test env)

- [ ] **Step 1: failing tests**

```ts
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { resetDb } from '../db/testUtils.js';

const app = createApp();
const cred = { email: 'jm@flowerstore.ph', password: 'hunter2hunter2', displayName: 'JM' };

describe('auth routes', () => {
  beforeEach(resetDb);

  it('register → login → me round-trip', async () => {
    const reg = await request(app).post('/api/auth/register').send(cred);
    expect(reg.status).toBe(201);
    expect(reg.body.user.role).toBe('member');
    expect(reg.body.refreshToken).toMatch(/^rt_/);

    const me = await request(app).get('/api/auth/me')
      .set('Authorization', `Bearer ${reg.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(cred.email);
  });

  it('refresh rotates and reuse kills the family', async () => {
    const reg = await request(app).post('/api/auth/register').send(cred);
    const r1 = await request(app).post('/api/auth/refresh').send({ refreshToken: reg.body.refreshToken });
    expect(r1.status).toBe(200);
    const replay = await request(app).post('/api/auth/refresh').send({ refreshToken: reg.body.refreshToken });
    expect(replay.status).toBe(401);
    const r2 = await request(app).post('/api/auth/refresh').send({ refreshToken: r1.body.refreshToken });
    expect(r2.status).toBe(401); // family dead
  });

  it('rejects short passwords, bad domains, and anonymous /me', async () => {
    expect((await request(app).post('/api/auth/register').send({ ...cred, password: 'short' })).status).toBe(400);
    expect((await request(app).post('/api/auth/register').send({ ...cred, email: 'a@gmail.com' })).status).toBe(403);
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
  });
});
```

- [ ] **Step 2: run** → FAIL. **Step 3: implement**

`middleware/auth.ts`:

```ts
import type { NextFunction, Request, Response } from 'express';
import { AppError } from './errorHandler.js';
import { verifyAccessToken } from '../services/tokenService.js';

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
```

`middleware/rateLimit.ts`:

```ts
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.NODE_ENV === 'test' ? 1000 : 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many attempts, try again later' } },
});
```

`routes/auth.ts`:

```ts
import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import { login, register, toPublicUser } from '../services/authService.js';
import { refreshSession, revokeRefreshToken } from '../services/tokenService.js';

export const authRouter = Router();

const registerBody = z.object({
  email: z.email(),
  password: z.string().min(12).max(200),
  displayName: z.string().min(1).max(100),
});
const loginBody = z.object({ email: z.email(), password: z.string().min(1) });
const refreshBody = z.object({ refreshToken: z.string().min(10) });

authRouter.post('/register', authLimiter, validate(registerBody), async (req, res) => {
  const input = req.valid as z.infer<typeof registerBody>;
  res.status(201).json(await register(input, req.headers['user-agent']));
});

authRouter.post('/login', authLimiter, validate(loginBody), async (req, res) => {
  const { email, password } = req.valid as z.infer<typeof loginBody>;
  res.json(await login(email, password, req.headers['user-agent']));
});

authRouter.post('/refresh', validate(refreshBody), async (req, res) => {
  const { refreshToken } = req.valid as z.infer<typeof refreshBody>;
  const session = await refreshSession(refreshToken, req.headers['user-agent']);
  if (!session) throw new AppError(401, 'invalid_refresh', 'Refresh token is invalid or reused');
  const [row] = await db.select().from(users).where(eq(users.id, session.userId));
  res.json({ user: toPublicUser(row), accessToken: session.accessToken, refreshToken: session.refreshToken });
});

authRouter.post('/logout', validate(refreshBody), async (req, res) => {
  await revokeRefreshToken((req.valid as z.infer<typeof refreshBody>).refreshToken);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const [row] = await db.select().from(users).where(eq(users.id, req.auth!.userId));
  if (!row) throw new AppError(401, 'unauthenticated', 'User no longer exists');
  res.json({ user: toPublicUser(row) });
});
```

In `app.ts` mount before channels: `app.use('/api/auth', authRouter);`

- [ ] **Step 4: run** → PASS (all suites). **Step 5: Commit** — `feat(server): auth routes with refresh rotation + rate limiting`

### Task 8: users routes (directory, me-patch) + admin users/settings routes

**Files:**
- Create: `server/src/routes/users.ts`, `server/src/routes/admin.ts`
- Modify: `server/src/app.ts`
- Test: `server/src/routes/admin.test.ts`

**Interfaces:**
- GET `/api/users` (requireAuth) → `PublicUser[]` of active users; PATCH `/api/users/me` {displayName?, avatarUrl?}
- Admin (requireAuth+requireAdmin): GET `/api/admin/settings/allowed-domains` → {domains}; PUT same {domains: string[]}; GET `/api/admin/users` (incl. inactive, role, createdAt); PATCH `/api/admin/users/:id` {role?, isActive?} — an admin cannot demote/deactivate themself (400 `cannot_modify_self`)
- Test helper produced: `server/src/testHelpers.ts` → `makeUser(app, { email?, admin? })` → registers (+promotes via db) and returns `{ token, userId }`

- [ ] **Step 1: failing tests** — `admin.test.ts`:

```ts
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { resetDb } from '../db/testUtils.js';
import { makeUser } from '../testHelpers.js';

const app = createApp();

describe('admin routes', () => {
  beforeEach(resetDb);

  it('is invisible (404) to members, usable by admins', async () => {
    const member = await makeUser(app, { email: 'm@flowerstore.ph' });
    const admin = await makeUser(app, { email: 'a@flowerstore.ph', admin: true });

    expect((await request(app).get('/api/admin/users')
      .set('Authorization', `Bearer ${member.token}`)).status).toBe(404);

    const list = await request(app).get('/api/admin/users')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(list.status).toBe(200);
    expect(list.body.users).toHaveLength(2);
  });

  it('updates allowed domains and enforces them on register', async () => {
    const admin = await makeUser(app, { email: 'a@flowerstore.ph', admin: true });
    await request(app).put('/api/admin/settings/allowed-domains')
      .set('Authorization', `Bearer ${admin.token}`).send({ domains: ['potico.ph'] })
      .expect(200);
    expect((await request(app).post('/api/auth/register')
      .send({ email: 'x@flowerstore.ph', password: 'hunter2hunter2', displayName: 'X' })).status).toBe(403);
  });

  it('role change works; self-demotion blocked', async () => {
    const admin = await makeUser(app, { email: 'a@flowerstore.ph', admin: true });
    const member = await makeUser(app, { email: 'm@flowerstore.ph' });
    await request(app).patch(`/api/admin/users/${member.userId}`)
      .set('Authorization', `Bearer ${admin.token}`).send({ role: 'admin' }).expect(200);
    expect((await request(app).patch(`/api/admin/users/${admin.userId}`)
      .set('Authorization', `Bearer ${admin.token}`).send({ role: 'member' })).status).toBe(400);
  });
});
```

`testHelpers.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { Express } from 'express';
import request from 'supertest';
import { db } from './db/index.js';
import { users } from './db/schema/index.js';

export async function makeUser(
  app: Express,
  opts: { email?: string; admin?: boolean } = {},
): Promise<{ token: string; userId: number }> {
  const email = opts.email ?? `u${Date.now()}@flowerstore.ph`;
  const reg = await request(app).post('/api/auth/register')
    .send({ email, password: 'hunter2hunter2', displayName: email.split('@')[0] });
  const userId: number = reg.body.user.id;
  if (opts.admin) {
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, userId));
    const login = await request(app).post('/api/auth/login')
      .send({ email, password: 'hunter2hunter2' });
    return { token: login.body.accessToken, userId };
  }
  return { token: reg.body.accessToken, userId };
}
```

- [ ] **Step 2: run** → FAIL. **Step 3: implement**

`routes/users.ts`:

```ts
import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { toPublicUser } from '../services/authService.js';

export const usersRouter = Router();
usersRouter.use(requireAuth);

usersRouter.get('/', async (_req, res) => {
  const rows = await db.select().from(users).where(eq(users.isActive, true)).orderBy(users.displayName);
  res.json({ users: rows.map(toPublicUser) });
});

const mePatch = z.object({
  displayName: z.string().min(1).max(100).optional(),
  avatarUrl: z.url().max(500).nullable().optional(),
});

usersRouter.patch('/me', validate(mePatch), async (req, res) => {
  const patch = req.valid as z.infer<typeof mePatch>;
  await db.update(users).set(patch).where(eq(users.id, req.auth!.userId));
  const [row] = await db.select().from(users).where(eq(users.id, req.auth!.userId));
  res.json({ user: toPublicUser(row) });
});
```

`routes/admin.ts`:

```ts
import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { getAllowedDomains, setAllowedDomains } from '../services/settingsService.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

adminRouter.get('/settings/allowed-domains', async (_req, res) => {
  res.json({ domains: await getAllowedDomains() });
});

const domainsBody = z.object({
  domains: z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i)).min(1).max(50),
});

adminRouter.put('/settings/allowed-domains', validate(domainsBody), async (req, res) => {
  const { domains } = req.valid as z.infer<typeof domainsBody>;
  await setAllowedDomains(domains, req.auth!.userId);
  res.json({ domains: await getAllowedDomains() });
});

adminRouter.get('/users', async (_req, res) => {
  const rows = await db.select({
    id: users.id, email: users.email, displayName: users.displayName,
    role: users.role, isActive: users.isActive, createdAt: users.createdAt,
  }).from(users).orderBy(users.displayName);
  res.json({ users: rows });
});

const userPatch = z.object({
  role: z.enum(['admin', 'member']).optional(),
  isActive: z.boolean().optional(),
});

adminRouter.patch('/users/:id', validate(userPatch), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new AppError(400, 'validation_error', 'Bad user id');
  if (id === req.auth!.userId) {
    throw new AppError(400, 'cannot_modify_self', 'Admins cannot change their own role or status');
  }
  const patch = req.valid as z.infer<typeof userPatch>;
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, id));
  if (!row) throw new AppError(404, 'not_found', 'Not found');
  await db.update(users).set(patch).where(eq(users.id, id));
  res.json({ ok: true });
});
```

Mount in `app.ts`: `app.use('/api/users', usersRouter); app.use('/api/admin', adminRouter);`

- [ ] **Step 4: run** → PASS. **Step 5: Commit** — `feat(server): user directory + admin users/settings routes`

### Task 9: departmentService + admin department routes

**Files:**
- Create: `server/src/services/departmentService.ts`
- Create: `server/src/routes/departments.ts`
- Modify: `server/src/app.ts`
- Test: `server/src/services/departmentService.test.ts`

**Interfaces:**
- Service: `addMember(departmentId, userId, role?)` — inserts membership AND auto-joins the user to every channel with that departmentId (ignore duplicates); `removeMember(departmentId, userId)`; `createDepartment/updateDepartment/deleteDepartment/listDepartments(withCounts)` thin CRUD
- Routes: GET `/api/departments` (requireAuth — org structure is visible to all staff); POST/PATCH/DELETE `/api/departments/:id` (admin); POST `/api/departments/:id/members` {userId, role?} + DELETE `/api/departments/:id/members/:userId` (admin OR that department's lead)

- [ ] **Step 1: failing tests**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { channelMembers, channels, departments, users } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { addMember, createDepartment } from './departmentService.js';

describe('departmentService', () => {
  beforeEach(resetDb);

  it('auto-joins new department members to department channels', async () => {
    const dept = await createDepartment({ name: 'Marketing' });
    const [{ id: userId }] = await db.insert(users)
      .values({ email: 'm@flowerstore.ph', passwordHash: 'x', displayName: 'M' }).$returningId();
    const [{ id: chanId }] = await db.insert(channels)
      .values({ name: 'mkt-general', departmentId: dept.id }).$returningId();
    await db.insert(channels).values({ name: 'unrelated' });

    await addMember(dept.id, userId);

    const memberships = await db.select().from(channelMembers)
      .where(eq(channelMembers.userId, userId));
    expect(memberships).toHaveLength(1);
    expect(memberships[0].channelId).toBe(chanId);
    // idempotent
    await addMember(dept.id, userId);
  });
});
```

- [ ] **Step 2: run** → FAIL. **Step 3: implement**

```ts
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { channelMembers, channels, departmentMembers, departments } from '../db/schema/index.js';

export async function createDepartment(input: { name: string; description?: string }) {
  const [{ id }] = await db.insert(departments).values(input).$returningId();
  const [row] = await db.select().from(departments).where(eq(departments.id, id));
  return row;
}

export async function addMember(
  departmentId: number,
  userId: number,
  role: 'lead' | 'member' = 'member',
): Promise<void> {
  await db.insert(departmentMembers).values({ departmentId, userId, role })
    .onDuplicateKeyUpdate({ set: { role } });
  const deptChannels = await db.select({ id: channels.id }).from(channels)
    .where(eq(channels.departmentId, departmentId));
  for (const ch of deptChannels) {
    await db.insert(channelMembers).values({ channelId: ch.id, userId })
      .onDuplicateKeyUpdate({ set: { userId } }); // no-op update = ignore duplicate
  }
}

export async function removeMember(departmentId: number, userId: number): Promise<void> {
  await db.delete(departmentMembers).where(
    eq(departmentMembers.departmentId, departmentId) && eq(departmentMembers.userId, userId),
  );
}

export async function isDepartmentLead(departmentId: number, userId: number): Promise<boolean> {
  const rows = await db.select().from(departmentMembers)
    .where(eq(departmentMembers.departmentId, departmentId));
  return rows.some((r) => r.userId === userId && r.role === 'lead');
}
```

(NOTE for implementer: the `&&` in removeMember is a bug trap — use `and(eq(...), eq(...))` from drizzle-orm. Written correctly in the real implementation; test it.)

Routes (`routes/departments.ts`) follow the users/admin route pattern exactly: zod bodies `{ name: z.string().min(1).max(80), description: z.string().max(1000).optional() }`, `{ userId: z.number().int().positive(), role: z.enum(['lead','member']).optional() }`; member-management guard = `req.auth.role === 'admin' || await isDepartmentLead(deptId, req.auth.userId)` else 404. GET list includes member counts via `db.select(...).from(departmentMembers)` grouped in JS (small org — no need for SQL GROUP BY yet). Mount: `app.use('/api/departments', departmentsRouter);`

- [ ] **Step 4: run** → PASS. **Step 5: Commit** — `feat(server): departments with channel auto-join`

### Task 10: Socket auth middleware — remove client-trusted userId

**Files:**
- Create: `server/src/sockets/authMiddleware.ts`
- Modify: `server/src/sockets/index.ts`, `server/src/sockets/chatHandlers.ts`
- Test: `server/src/sockets/socketAuth.test.ts` (uses `socket.io-client` — `npm i -D socket.io-client` in server)

**Interfaces:**
- `io.use(socketAuth)` — verifies `handshake.auth.token` (access JWT), sets `socket.data.userId`/`socket.data.role`, joins `user:<id>`; connection REFUSED (`connect_error` 'unauthenticated') without valid token
- `message:send` payload loses `userId` — `{ channelId, body }`; author = `socket.data.userId`

- [ ] **Step 1: failing test**

```ts
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../db/testUtils.js';
import { db } from '../db/index.js';
import { channels, users } from '../db/schema/index.js';
import { signAccessToken } from '../services/tokenService.js';
import { registerSocketHandlers } from './index.js';

let httpServer: ReturnType<typeof createServer>;
let url = '';

beforeAll(async () => {
  httpServer = createServer();
  const io = new Server(httpServer);
  registerSocketHandlers(io);
  await new Promise<void>((r) => httpServer.listen(0, r));
  url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => httpServer.close(() => r())));

function connect(token?: string): ClientSocket {
  return ioc(url, { auth: token ? { token } : {}, reconnection: false, timeout: 2000 });
}

describe('socket auth', () => {
  beforeEach(resetDb);

  it('rejects connections without a valid token', async () => {
    const err = await new Promise<Error>((resolve) => {
      const s = connect();
      s.on('connect_error', resolve);
    });
    expect(err.message).toBe('unauthenticated');
  });

  it('accepts a valid token and stamps message author from socket identity', async () => {
    const [{ id: userId }] = await db.insert(users)
      .values({ email: 's@flowerstore.ph', passwordHash: 'x', displayName: 'S' }).$returningId();
    const [{ id: channelId }] = await db.insert(channels).values({ name: 'g' }).$returningId();
    const token = await signAccessToken({ id: userId, role: 'member' });
    const s = connect(token);
    await new Promise<void>((r) => s.on('connect', () => r()));
    const ack = await s.emitWithAck('message:send', { channelId, body: 'hi', userId: 999_999 });
    expect(ack.ok).toBe(true);
    const rows = await db.select().from((await import('../db/schema/index.js')).messages);
    expect(rows[0].userId).toBe(userId); // NOT 999999
    s.disconnect();
  });
});
```

- [ ] **Step 2: run** → FAIL. **Step 3: implement**

`sockets/authMiddleware.ts`:

```ts
import type { Socket } from 'socket.io';
import { verifyAccessToken } from '../services/tokenService.js';

export async function socketAuth(socket: Socket, next: (err?: Error) => void): Promise<void> {
  const token = socket.handshake.auth?.token as string | undefined;
  const claims = token ? await verifyAccessToken(token) : null;
  if (!claims) return next(new Error('unauthenticated'));
  socket.data.userId = claims.userId;
  socket.data.role = claims.role;
  await socket.join(`user:${claims.userId}`);
  next();
}
```

`sockets/index.ts`: `io.use(socketAuth);` before `io.on('connection', …)`.
`chatHandlers.ts`: `SendPayload` becomes `{ channelId: number; body: string }`; insert uses `socket.data.userId as number`; remove the TODO comment.

- [ ] **Step 4: run** → PASS. **Step 5: Commit** — `feat(server): authenticated sockets; author from socket identity`

### Task 11: seed-admin script

**Files:**
- Create: `server/src/scripts/seedAdmin.ts`
- Modify: `server/package.json` (script `seed:admin`)

**Interfaces:** `npm run seed:admin -- <email> <password> [displayName]` — creates or promotes+repasswords the user as active admin; bypasses the domain gate (bootstrap tool).

- [ ] **Step 1: implement**

```ts
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { hashPassword } from '../services/passwords.js';

const [email, password, displayName = 'Admin'] = process.argv.slice(2);
if (!email || !password || password.length < 12) {
  console.error('usage: npm run seed:admin -- <email> <password≥12 chars> [displayName]');
  process.exit(1);
}

const passwordHash = await hashPassword(password);
const [existing] = await db.select({ id: users.id }).from(users)
  .where(eq(users.email, email.toLowerCase()));
if (existing) {
  await db.update(users).set({ passwordHash, role: 'admin', isActive: true })
    .where(eq(users.id, existing.id));
  console.log(`promoted existing user ${email} to admin`);
} else {
  await db.insert(users).values({
    email: email.toLowerCase(), passwordHash, displayName, role: 'admin',
  });
  console.log(`created admin ${email}`);
}
await pool.end();
```

package.json: `"seed:admin": "tsx src/scripts/seedAdmin.ts"`

- [ ] **Step 2: verify** — `npm run seed:admin -- admin@flowerstore.ph 'admin-dev-password' 'JM'` → "created admin"; run again → "promoted existing user". `npm test` still green.
- [ ] **Step 3: Commit** — `feat(server): seed-admin script`

### Task 12: Frontend auth core — storage, api wrapper, auth store, bootstrap

**Files:**
- Create: `src/lib/storage.ts`, `src/lib/api.ts`, `src/features/auth/authStore.ts`, `src/features/auth/api.ts`
- Modify: `src/lib/socket.ts` (auth callback), `package.json` (`@capacitor/preferences`)

**Interfaces:**
- `storage.get(key): Promise<string|null>` / `set` / `remove` (Preferences native, localStorage web)
- `api<T>(path, opts?)` — JSON fetch to `VITE_SERVER_URL ?? http://localhost:4000`, bearer from authStore, single-flight 401→refresh→retry-once; throws `ApiError { status, code, message }`
- `useAuthStore`: `{ user: PublicUser|null, accessToken: string|null, status: 'loading'|'authed'|'guest', setSession, clearSession }` + `bootstrapAuth()`, `loginUser()`, `registerUser()`, `logoutUser()` in `features/auth/api.ts`
- Refresh token storage key: `fs_refresh_token`

- [ ] **Step 1: install** — `npm install @capacitor/preferences && npx cap sync` (root)

- [ ] **Step 2: `src/lib/storage.ts`**

```ts
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

const native = Capacitor.isNativePlatform();

export const storage = {
  async get(key: string): Promise<string | null> {
    if (native) return (await Preferences.get({ key })).value;
    return localStorage.getItem(key);
  },
  async set(key: string, value: string): Promise<void> {
    if (native) await Preferences.set({ key, value });
    else localStorage.setItem(key, value);
  },
  async remove(key: string): Promise<void> {
    if (native) await Preferences.remove({ key });
    else localStorage.removeItem(key);
  },
};

export const REFRESH_TOKEN_KEY = 'fs_refresh_token';
```

- [ ] **Step 3: `src/features/auth/authStore.ts`**

```ts
import { create } from 'zustand';

export interface PublicUser {
  id: number; email: string; displayName: string;
  role: 'admin' | 'member'; avatarUrl: string | null;
}

interface AuthState {
  user: PublicUser | null;
  accessToken: string | null;
  status: 'loading' | 'authed' | 'guest';
  setSession: (user: PublicUser, accessToken: string) => void;
  setAccessToken: (accessToken: string) => void;
  clearSession: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  accessToken: null,
  status: 'loading',
  setSession: (user, accessToken) => set({ user, accessToken, status: 'authed' }),
  setAccessToken: (accessToken) => set({ accessToken }),
  clearSession: () => set({ user: null, accessToken: null, status: 'guest' }),
}));
```

- [ ] **Step 4: `src/lib/api.ts`**

```ts
import { useAuthStore } from '@/features/auth/authStore';
import { REFRESH_TOKEN_KEY, storage } from './storage';

const BASE = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

let refreshInFlight: Promise<boolean> | null = null;

async function doRefresh(): Promise<boolean> {
  const refreshToken = await storage.get(REFRESH_TOKEN_KEY);
  if (!refreshToken) return false;
  const res = await fetch(`${BASE}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) {
    await storage.remove(REFRESH_TOKEN_KEY);
    useAuthStore.getState().clearSession();
    return false;
  }
  const data = await res.json();
  await storage.set(REFRESH_TOKEN_KEY, data.refreshToken);
  useAuthStore.getState().setSession(data.user, data.accessToken);
  return true;
}

export function refreshOnce(): Promise<boolean> {
  refreshInFlight ??= doRefresh().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const { method = 'GET', body, auth = true } = opts;
  const exec = async (): Promise<Response> => {
    const token = useAuthStore.getState().accessToken;
    return fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  };
  let res = await exec();
  if (res.status === 401 && auth && (await refreshOnce())) res = await exec();
  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    throw new ApiError(res.status, payload?.error?.code ?? 'unknown', payload?.error?.message ?? res.statusText);
  }
  return res.json() as Promise<T>;
}
```

- [ ] **Step 5: `src/features/auth/api.ts`**

```ts
import { api, refreshOnce } from '@/lib/api';
import { REFRESH_TOKEN_KEY, storage } from '@/lib/storage';
import { type PublicUser, useAuthStore } from './authStore';

interface SessionResponse { user: PublicUser; accessToken: string; refreshToken: string }

async function adopt(session: SessionResponse): Promise<void> {
  await storage.set(REFRESH_TOKEN_KEY, session.refreshToken);
  useAuthStore.getState().setSession(session.user, session.accessToken);
}

export async function loginUser(email: string, password: string): Promise<void> {
  await adopt(await api<SessionResponse>('/api/auth/login', { method: 'POST', body: { email, password }, auth: false }));
}

export async function registerUser(email: string, password: string, displayName: string): Promise<void> {
  await adopt(await api<SessionResponse>('/api/auth/register', { method: 'POST', body: { email, password, displayName }, auth: false }));
}

export async function logoutUser(): Promise<void> {
  const refreshToken = await storage.get(REFRESH_TOKEN_KEY);
  if (refreshToken) {
    await api('/api/auth/logout', { method: 'POST', body: { refreshToken }, auth: false }).catch(() => {});
  }
  await storage.remove(REFRESH_TOKEN_KEY);
  useAuthStore.getState().clearSession();
}

export async function bootstrapAuth(): Promise<void> {
  const ok = await refreshOnce();
  if (!ok) useAuthStore.getState().clearSession();
}
```

- [ ] **Step 6: socket auth callback** — in `src/lib/socket.ts` replace `io(SERVER_URL, { autoConnect: true })` with:

```ts
    socket = io(SERVER_URL, {
      autoConnect: false,
      auth: (cb) => cb({ token: useAuthStore.getState().accessToken }),
    });
```

(add import; `autoConnect: false` — chat connects it after login in Phase 2)

- [ ] **Step 7:** `npm run build` (root) → clean. **Commit** — `feat(web): auth core — storage abstraction, api wrapper with refresh, auth store`

### Task 13: Login/Register pages + route guards

**Files:**
- Create: `src/features/auth/LoginPage.tsx`, `src/features/auth/RegisterPage.tsx`, `src/app/guards.tsx`
- Modify: `src/app/router.tsx`, `src/main.tsx` (bootstrapAuth on start)
- shadcn: `npx shadcn@latest add input label card`

**Interfaces:**
- Routes: `/login`, `/register` public; everything under AppLayout requires auth; `/admin` requires admin (else redirect `/`)
- `RequireAuth` renders `<Outlet/>` when `status==='authed'`, spinner when `'loading'`, `<Navigate to="/login"/>` when `'guest'`

- [ ] **Step 1:** `npx shadcn@latest add input label card`

- [ ] **Step 2: `src/app/guards.tsx`**

```tsx
import { Navigate, Outlet } from 'react-router';
import { useAuthStore } from '@/features/auth/authStore';

export function RequireAuth() {
  const status = useAuthStore((s) => s.status);
  if (status === 'loading') {
    return <div className="flex min-h-dvh items-center justify-center text-muted-foreground">Loading…</div>;
  }
  return status === 'authed' ? <Outlet /> : <Navigate to="/login" replace />;
}

export function RequireAdmin() {
  const user = useAuthStore((s) => s.user);
  return user?.role === 'admin' ? <Outlet /> : <Navigate to="/" replace />;
}
```

- [ ] **Step 3: LoginPage** (RegisterPage is the same card with displayName field + register call + link to /login):

```tsx
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api';
import { loginUser } from './api';

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await loginUser(email, password);
      navigate('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader><CardTitle>FS Internal System</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
            <p className="text-center text-sm text-muted-foreground">
              No account? <Link className="underline" to="/register">Register</Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
```

- [ ] **Step 4: router wiring** — `src/app/router.tsx`:

```tsx
import { createBrowserRouter } from 'react-router';
import { AppLayout } from './AppLayout';
import { RequireAdmin, RequireAuth } from './guards';
import { LoginPage } from '@/features/auth/LoginPage';
import { RegisterPage } from '@/features/auth/RegisterPage';
import { AdminPage } from '@/features/admin/AdminPage';
import { HomePage } from '@/features/home/HomePage';

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { path: '/', element: <HomePage /> },
          { element: <RequireAdmin />, children: [{ path: '/admin', element: <AdminPage /> }] },
        ],
      },
    ],
  },
]);
```

`src/main.tsx`: call `bootstrapAuth()` (fire-and-forget) before render.

- [ ] **Step 5:** build clean; manual check with dev servers (register with allowed domain succeeds; gmail.com rejected with message; reload keeps session via refresh). **Commit** — `feat(web): login/register pages with guarded routes`

### Task 14: Admin UI — allowed domains, users, departments

**Files:**
- Create: `src/features/admin/AdminPage.tsx`, `AllowedDomainsTab.tsx`, `UsersTab.tsx`, `DepartmentsTab.tsx`
- Modify: `src/features/home/HomePage.tsx` (nav links + logout)
- shadcn: `npx shadcn@latest add tabs table switch badge select dialog`

**Interfaces:** consumes GET/PUT `/api/admin/settings/allowed-domains`, GET/PATCH `/api/admin/users(:id)`, `/api/departments` CRUD + members; TanStack Query keys: `['admin','domains']`, `['admin','users']`, `['departments']`, `['users']`.

- [ ] **Step 1:** add shadcn components. **Step 2:** AdminPage = `<Tabs>` with the three tabs. Each tab is a `useQuery` + mutations with `queryClient.invalidateQueries` on success; forms are controlled inputs (no form lib). AllowedDomainsTab: textarea-less chip input — an Input + "Add" button appending to a local list rendered as Badges with × buttons, Save → PUT. UsersTab: Table of users; role Select (admin/member) + isActive Switch per row (disabled on own row); mutations PATCH. DepartmentsTab: list with create Dialog (name, description), per-department member management Dialog — user Select (from `/api/users`) + role Select + Add button; member list with remove buttons; delete department button with confirm. Complete code follows the LoginPage patterns (imports from `@/components/ui/*`, `api()` calls, busy/error states).
- [ ] **Step 3:** HomePage gains: signed-in user name, Logout button (`logoutUser()` then navigate('/login')), link to /admin when `user.role==='admin'`.
- [ ] **Step 4:** build + lint clean; manual verify per checklist below. **Commit** — `feat(web): admin UI (domains, users, departments)`

### Task 15: Phase gate — full verification + push

- [ ] `cd server && npm test` → all suites green (auth, tokens, settings, departments, sockets, app)
- [ ] `npm run build` in server and root → clean
- [ ] `docker build server/` → succeeds (argon2 alpine prebuild proof)
- [ ] Manual (dev servers via `npm run dev` root + `npm run dev` server):
  - register `x@gmail.com` → inline "domain not allowed" error; register `x@flowerstore.ph` → lands on Home
  - reload → still signed in (refresh flow); DevTools → replay an old refresh token against /api/auth/refresh → 401 and session dies everywhere
  - member visits /admin → redirected; admin sees all three tabs and can: change domains (then a new register obeys), toggle a user inactive (that user's login now 401s), create department + add member with lead role
  - `docker exec fs-mysql mysql … -e "SELECT role FROM users"` sanity check
- [ ] Android webview login check: **deferred** — no Android SDK on this machine (tracked in plan risks; verify when SDK lands)
- [ ] Update memory + `git push`

## Deviations / notes for the implementer

- zod 4: `z.email()` / `z.url()` are top-level (not `z.string().email()`)
- Drizzle `onDuplicateKeyUpdate` is the MySQL upsert; there is no `.onConflictDoNothing()` for mysql
- Express 5 + async handlers: throwing `AppError` inside async routes reaches `errorHandler` without wrappers
- `supertest` + Express 5: pass the app directly, no `.listen()` needed
- Socket tests: keep `reconnection: false` or vitest hangs on open handles
