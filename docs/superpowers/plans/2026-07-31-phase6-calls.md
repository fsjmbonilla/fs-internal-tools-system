# Phase 6: Teleconference (Self-Hosted LiveKit) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any channel (or an ad-hoc room) start a video/audio call — mint a LiveKit access token behind the same channel-visibility check every other resource uses, broadcast `call:started`/`call:ended` over the existing socket infra, and render the call full-screen via `@livekit/components-react`.

**Architecture:** A `calls` table records one row per call session (channel-scoped or ad-hoc, `room_name` always unique — a new call after a previous one ended always gets a fresh room name, never reuses an ended call's name). `POST /api/calls` reuses an in-progress call for a channel if one exists, otherwise creates a new row and mints a LiveKit JWT via `livekit-server-sdk`'s `AccessToken`. Membership is checked with the exact same `getVisibleChannel`/`isChannelMember` functions every other channel-scoped route already uses — no new visibility logic. The route then broadcasts `call:started`/`call:ended` to the channel's existing Socket.IO room (`channel:${id}`, which clients already join via the pre-existing `channel:join` handler) — this requires exposing the `io` instance to Express routes for the first time in this codebase, done via `app.set('io', io)`/`req.app.get('io')`, not a new socket handler. The frontend calls page (`/call/:roomName`) is a full-screen route (no sidebar) wrapping LiveKit's drop-in `VideoConference` component.

**Tech Stack:** `livekit-server-sdk` (server only — token minting, `AccessToken`/`addGrant`/`toJwt`, verified against official docs.livekit.io 2026-07-31), `livekit-client` + `@livekit/components-react` + `@livekit/components-styles` (frontend only — `LiveKitRoom`/`VideoConference`, all three packages required together per the official install docs, verified 2026-07-31).

## Global Constraints

- Migration numbering continues from Phase 5: the next migration is **0008** (`0007` was Phase 5's `device_tokens`). Do not reuse `0007`.
- **Calls do NOT no-op when unconfigured, unlike `pushService.ts`/`cache.ts`.** There is no sensible offline behavior for a video call — when `LIVEKIT_URL`/`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` aren't all set, `POST /api/calls` must respond `503 { error: { code: 'calls_not_configured', ... } }`, a clear error, not a silent no-op. This is a deliberate difference from the Phase 5 precedent, not an inconsistency.
- Reuse `getVisibleChannel(channelId, userId, isAdmin)` and `isChannelMember(channelId, userId)` from `server/src/services/channelService.ts` directly for every channel-scoped call check — do not duplicate visibility logic.
- `room_name` is permanently unique across all calls, ended or not — a channel's second call (after the first ended) must get a brand-new room name, never reuse the first call's name.
- No new server-side socket `.on()` handlers are needed. `call:started`/`call:ended` are emitted from the HTTP routes via `req.app.get('io') as SocketIOServer | undefined` — always guard for `undefined` (it will be, in route tests that call `createApp()` directly without a real `io`) and skip emitting rather than throwing.
- Package split mirrors the existing `socket.io` (server) / `socket.io-client` (frontend) precedent: `livekit-server-sdk` goes in `server/package.json` only; `livekit-client` + `@livekit/components-react` + `@livekit/components-styles` go in the root `package.json` only.
- No automated frontend test framework exists — frontend tasks are verified via `npm run build` (tsc) + `npm run lint` (oxlint) clean, exactly like every prior phase.
- **Before trusting any third-party SDK's example code, verify it against the actually-installed package's real exports** (e.g. `node -e "console.log(Object.keys(require('livekit-server-sdk')))"`) — this project has twice shipped a plan with a wrong third-party API assumption (firebase-admin's legacy vs. modular API, a Vitest mock-hoisting bug) that only surfaced this way. If a real discrepancy is found, fix it with the verified-correct API and document the discrepancy in the task report — don't silently deviate without explanation, and don't leave a broken `tsc` build.
- Commits end with the **exact literal line** `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` — not a model's own name/self-attribution. This was gotten wrong twice in Phase 5 and had to be fixed via `git commit --amend`; get it right the first time.
- Never pipe `tsc`/`npm test` through `tail` inside a `&&` chain — redirect to a log file and check `$?` explicitly.
- Continue the `parseId()` path-param helper convention; never chain two `validate()` calls on one route; 404 (never 403) for any resource the requester can't see.

---

### Task 1: Migration 0008 — `calls` schema

**Files:**
- Create: `server/src/db/schema/calls.ts`
- Modify: `server/src/db/schema/index.ts`, `server/src/db/testUtils.ts`

**Interfaces:** `calls` table — `id, channelId (nullable, FK → channels.id cascade), roomName (unique), startedBy (FK → users.id), startedAt, endedAt (nullable)`.

- [ ] **Step 1: `server/src/db/schema/calls.ts`**

```ts
import { bigint, index, mysqlTable, timestamp, varchar } from 'drizzle-orm/mysql-core';
import { users } from './auth.js';
import { channels } from './chat.js';

export const calls = mysqlTable(
  'calls',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    channelId: bigint('channel_id', { mode: 'number', unsigned: true }).references(() => channels.id, {
      onDelete: 'cascade',
    }),
    roomName: varchar('room_name', { length: 100 }).notNull().unique(),
    startedBy: bigint('started_by', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => users.id),
    startedAt: timestamp('started_at').notNull().defaultNow(),
    endedAt: timestamp('ended_at'),
  },
  (t) => [index('idx_calls_channel').on(t.channelId)],
);
```

- [ ] **Step 2: register the schema.** In `server/src/db/schema/index.ts`, insert alphabetically between `auth.js` and `chat.js`:

```ts
export * from './auth.js';
export * from './calls.js';
export * from './chat.js';
export * from './departments.js';
export * from './files.js';
export * from './notes.js';
export * from './projects.js';
export * from './push.js';
export * from './reactions.js';
```

- [ ] **Step 3: truncation order.** In `server/src/db/testUtils.ts`, add `'calls'` right before `'channel_members'` (calls references channels, same child-before-parent grouping as the rest of the chat cluster):

```ts
const TABLES = [
  'refresh_tokens',
  'department_members',
  'departments',
  'attachments',
  'device_tokens',
  'message_reactions',
  'message_mentions',
  'calls',
  'channel_members',
  'messages',
  'channels',
  'task_comments',
  'tasks',
  'task_columns',
  'docs',
  'project_members',
  'projects',
  'notes',
  'settings',
  'users',
];
```

- [ ] **Step 4: generate and apply the migration.**

Run: `cd server && npx drizzle-kit generate --name calls`
Expected: creates `server/drizzle/0008_calls.sql` (seven migrations already exist, `0000`–`0007`) containing a `CREATE TABLE \`calls\`` statement with the FK to `channels`/`users` and a unique constraint on `room_name`.

Run: `npm run db:migrate`
Expected: applies cleanly against the local MariaDB dev database, no errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/db/schema/calls.ts server/src/db/schema/index.ts server/src/db/testUtils.ts server/drizzle/
git commit -m "feat(server): calls schema (migration 0008)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `callService.ts`

**Files:**
- Create: `server/src/services/callService.ts`
- Test: `server/src/services/callService.test.ts`

**Interfaces:**
- `CallRow` (Drizzle-inferred type of the `calls` table)
- `getActiveCallForChannel(channelId: number): Promise<CallRow | null>`
- `startCall(channelId: number | null, userId: number): Promise<CallRow>`
- `endCall(callId: number): Promise<CallRow | null>` (returns `null` if the call doesn't exist or is already ended)
- `getCallById(callId: number): Promise<CallRow | null>`

- [ ] **Step 1: failing test — `server/src/services/callService.test.ts`**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { createChannel } from './channelService.js';
import { endCall, getActiveCallForChannel, getCallById, startCall } from './callService.js';

async function seedUser(email: string) {
  const [{ id }] = await db
    .insert(users)
    .values({ email, passwordHash: 'x', displayName: email.split('@')[0] })
    .$returningId();
  return id;
}

describe('callService', () => {
  beforeEach(resetDb);

  it('starts a call for a channel and reuses it while still active', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const chan = await createChannel({ name: 'g', isPrivate: false, createdBy: owner });

    const first = await startCall(chan.id, owner);
    expect(first.channelId).toBe(chan.id);
    expect(first.startedBy).toBe(owner);
    expect(first.endedAt).toBeNull();

    const second = await startCall(chan.id, owner);
    expect(second.id).toBe(first.id); // reused, not a new row
    expect(second.roomName).toBe(first.roomName);
  });

  it('starts a brand-new call with a different room name after the previous one ended', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const chan = await createChannel({ name: 'g2', isPrivate: false, createdBy: owner });

    const first = await startCall(chan.id, owner);
    await endCall(first.id);
    const second = await startCall(chan.id, owner);

    expect(second.id).not.toBe(first.id);
    expect(second.roomName).not.toBe(first.roomName);
  });

  it('creates ad-hoc calls (no channel) with a unique room name each time', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const a = await startCall(null, owner);
    const b = await startCall(null, owner);
    expect(a.channelId).toBeNull();
    expect(b.channelId).toBeNull();
    expect(a.roomName).not.toBe(b.roomName);
  });

  it('getActiveCallForChannel returns null when there is no in-progress call', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const chan = await createChannel({ name: 'g3', isPrivate: false, createdBy: owner });
    expect(await getActiveCallForChannel(chan.id)).toBeNull();

    const call = await startCall(chan.id, owner);
    expect((await getActiveCallForChannel(chan.id))?.id).toBe(call.id);
    await endCall(call.id);
    expect(await getActiveCallForChannel(chan.id)).toBeNull();
  });

  it('endCall is idempotent-safe: ending an already-ended or nonexistent call returns null', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const chan = await createChannel({ name: 'g4', isPrivate: false, createdBy: owner });
    const call = await startCall(chan.id, owner);
    expect(await endCall(call.id)).not.toBeNull();
    expect(await endCall(call.id)).toBeNull(); // already ended
    expect(await endCall(999999)).toBeNull(); // doesn't exist
  });

  it('getCallById returns the row or null', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const chan = await createChannel({ name: 'g5', isPrivate: false, createdBy: owner });
    const call = await startCall(chan.id, owner);
    expect((await getCallById(call.id))?.id).toBe(call.id);
    expect(await getCallById(999999)).toBeNull();
  });
});
```

- [ ] **Step 2: run to verify it fails**

Run: `cd server && npx vitest run src/services/callService.test.ts`
Expected: FAIL — `Cannot find module './callService.js'`

- [ ] **Step 3: implement — `server/src/services/callService.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { calls } from '../db/schema/index.js';

export type CallRow = typeof calls.$inferSelect;

export async function getActiveCallForChannel(channelId: number): Promise<CallRow | null> {
  const [row] = await db
    .select()
    .from(calls)
    .where(and(eq(calls.channelId, channelId), isNull(calls.endedAt)))
    .orderBy(desc(calls.id))
    .limit(1);
  return row ?? null;
}

export async function startCall(channelId: number | null, userId: number): Promise<CallRow> {
  if (channelId !== null) {
    const existing = await getActiveCallForChannel(channelId);
    if (existing) return existing;
  }

  const roomName =
    channelId !== null ? `channel-${channelId}-${randomUUID().slice(0, 8)}` : `adhoc-${randomUUID()}`;

  const values: { channelId?: number; roomName: string; startedBy: number } = {
    roomName,
    startedBy: userId,
  };
  if (channelId !== null) values.channelId = channelId;

  const [{ id }] = await db.insert(calls).values(values).$returningId();
  const [row] = await db.select().from(calls).where(eq(calls.id, id));
  return row;
}

export async function endCall(callId: number): Promise<CallRow | null> {
  const [row] = await db.select().from(calls).where(eq(calls.id, callId));
  if (!row || row.endedAt !== null) return null;
  await db.update(calls).set({ endedAt: new Date() }).where(eq(calls.id, callId));
  const [updated] = await db.select().from(calls).where(eq(calls.id, callId));
  return updated;
}

export async function getCallById(callId: number): Promise<CallRow | null> {
  const [row] = await db.select().from(calls).where(eq(calls.id, callId));
  return row ?? null;
}
```

- [ ] **Step 4: run to verify it passes**

Run: `cd server && npx vitest run src/services/callService.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/services/callService.ts server/src/services/callService.test.ts
git commit -m "feat(server): callService — start/reuse/end call sessions

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: LiveKit config + `livekitService.ts`

**Files:**
- Modify: `server/src/config.ts`
- Create: `server/src/services/livekitService.ts`
- Test: `server/src/services/livekitService.test.ts`
- Install: `livekit-server-sdk` (server dependency)

**Interfaces:**
- `isLiveKitConfigured(): boolean`
- `mintCallToken(roomName: string, identity: string, name: string): Promise<string>`

- [ ] **Step 1: install the dependency**

Run: `cd server && npm install livekit-server-sdk`
Expected: added to `server/package.json` dependencies.

**Before writing any code**, verify the installed package's real exports match what this task assumes:

Run: `cd server && node -e "console.log(Object.keys(require('livekit-server-sdk')))"`
Expected: includes `AccessToken` among the exports. If `AccessToken` is missing, or its constructor/method shape differs from `new AccessToken(key, secret, { identity, name })` / `.addGrant({...})` / `await .toJwt()`, STOP and adapt Step 3 below to the real API — document the discrepancy and the fix in the task report, the same way Phase 5's `pushService.ts` task had to fix a real firebase-admin API mismatch.

- [ ] **Step 2: add LiveKit env vars — modify `server/src/config.ts`**

Insert these three lines right after the `FIREBASE_PRIVATE_KEY` line, before the closing `});` of `EnvSchema`:

```ts
  // Teleconference: unlike push, there's no sensible offline behavior for a video
  // call — unset means /api/calls responds 503 rather than silently no-opping.
  LIVEKIT_URL: z.string().optional(),
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),
```

- [ ] **Step 3: failing tests — `server/src/services/livekitService.test.ts`**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const addGrant = vi.fn();
const toJwt = vi.fn().mockResolvedValue('mock-jwt-token');
const AccessTokenMock = vi.fn().mockImplementation(() => ({ addGrant, toJwt }));

vi.mock('livekit-server-sdk', () => ({ AccessToken: AccessTokenMock }));

vi.mock('../config.js', () => ({
  config: {
    LIVEKIT_URL: 'ws://localhost:7880',
    LIVEKIT_API_KEY: 'devkey',
    LIVEKIT_API_SECRET: 'secret',
  },
}));

const { isLiveKitConfigured, mintCallToken } = await import('./livekitService.js');

describe('livekitService (configured)', () => {
  beforeEach(() => {
    AccessTokenMock.mockClear();
    addGrant.mockClear();
    toJwt.mockClear();
  });

  it('reports configured when all three env vars are set', () => {
    expect(isLiveKitConfigured()).toBe(true);
  });

  it('mints a token with a room-join grant for the given room/identity/name', async () => {
    const token = await mintCallToken('room-1', '42', 'Jane');

    expect(AccessTokenMock).toHaveBeenCalledWith('devkey', 'secret', { identity: '42', name: 'Jane' });
    expect(addGrant).toHaveBeenCalledWith({
      roomJoin: true,
      room: 'room-1',
      canPublish: true,
      canSubscribe: true,
    });
    expect(token).toBe('mock-jwt-token');
  });
});
```

- [ ] **Step 4: failing test — `server/src/services/livekitService.unconfigured.test.ts`** (separate file: `vi.mock` is file-scoped)

```ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('livekit-server-sdk', () => ({ AccessToken: vi.fn() }));
vi.mock('../config.js', () => ({
  config: { LIVEKIT_URL: undefined, LIVEKIT_API_KEY: undefined, LIVEKIT_API_SECRET: undefined },
}));

const { isLiveKitConfigured } = await import('./livekitService.js');

describe('livekitService (unconfigured)', () => {
  it('reports not configured when any env var is missing', () => {
    expect(isLiveKitConfigured()).toBe(false);
  });
});
```

- [ ] **Step 5: run to verify both fail**

Run: `cd server && npx vitest run src/services/livekitService.test.ts src/services/livekitService.unconfigured.test.ts`
Expected: FAIL — `Cannot find module './livekitService.js'`

- [ ] **Step 6: implement — `server/src/services/livekitService.ts`**

```ts
import { AccessToken } from 'livekit-server-sdk';
import { config } from '../config.js';

export function isLiveKitConfigured(): boolean {
  return Boolean(config.LIVEKIT_URL && config.LIVEKIT_API_KEY && config.LIVEKIT_API_SECRET);
}

export async function mintCallToken(roomName: string, identity: string, name: string): Promise<string> {
  const at = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, { identity, name });
  at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
  return at.toJwt();
}
```

(If Step 1's real-package check found a different API shape, implement this file against the verified-correct shape instead, and note the discrepancy in your report.)

- [ ] **Step 7: run to verify both pass**

Run: `cd server && npx vitest run src/services/livekitService.test.ts src/services/livekitService.unconfigured.test.ts`
Expected: PASS (3 tests total)

- [ ] **Step 8: Commit**

```bash
git add server/package.json server/package-lock.json server/src/config.ts server/src/services/livekitService.ts server/src/services/livekitService.test.ts server/src/services/livekitService.unconfigured.test.ts
git commit -m "feat(server): livekitService — access token minting, config-gated

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Expose `io` to Express routes

**Files:**
- Modify: `server/src/index.ts`

**Interfaces:** `req.app.get('io')` returns the `Server` instance (or `undefined` in contexts where no real server/io was created, e.g. `createApp()` called directly in tests).

- [ ] **Step 1: modify `server/src/index.ts`** — add `app.set('io', io);` immediately after the `io` instance is created:

```ts
import http from 'node:http';
import { Server } from 'socket.io';
import { createApp } from './app.js';
import { registerAutomations } from './automations/index.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { gcUnlinkedAttachments } from './services/attachmentService.js';
import { registerSocketHandlers } from './sockets/index.js';

const app = createApp();
const server = http.createServer(app);

const io = new Server(server, { cors: { origin: config.corsOrigins } });
app.set('io', io);
registerSocketHandlers(io);
registerAutomations();

setInterval(
  () => {
    gcUnlinkedAttachments(24).catch((err) => logger.error({ err }, 'attachment GC failed'));
  },
  60 * 60 * 1000,
);

server.listen(config.PORT, () => {
  logger.info(`fs-internal-system server listening on :${config.PORT}`);
});
```

There is no automated test for this one-line change (it only matters when a real HTTP server + `io` exist, which route-level supertest tests calling `createApp()` directly don't create — that's exactly why Task 5's routes must treat `req.app.get('io')` as possibly `undefined`). Verification is via Task 5's route tests still passing (they call `createApp()` directly, so `io` is `undefined` there and the route must not throw) and Task 7's phase-gate live check (where a real server/io does exist).

- [ ] **Step 2: run the full suite once to confirm nothing else broke**

Run: `cd server && npm test > /tmp/phase6-task4.log 2>&1; echo "EXIT:$?"`
Expected: `EXIT:0` (same pass count as before this change — this is a one-line, no-behavior-change-yet edit)

- [ ] **Step 3: Commit**

```bash
git add server/src/index.ts
git commit -m "feat(server): expose io on app.locals for routes to emit socket events

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `POST /api/calls`, `POST /api/calls/:id/end`, `GET /api/channels/:id/call`

**Files:**
- Create: `server/src/routes/calls.ts`
- Test: `server/src/routes/calls.test.ts`
- Modify: `server/src/app.ts`, `server/src/routes/channels.ts`, `server/src/routes/channels.test.ts`

**Interfaces:**
- `POST /api/calls { channelId?: number }` → 201 `{ call, token, serverUrl }`, or 503 `{ error: { code: 'calls_not_configured', ... } }` if LiveKit isn't configured, or 404 if `channelId` is given and not visible/joinable.
- `POST /api/calls/:id/end` → 200 `{ ok: true }`, 404 if the call doesn't exist or its channel isn't visible to the caller, 400 `{ error: { code: 'already_ended', ... } }` if already ended.
- `GET /api/channels/:id/call` → 200 `{ call: CallRow | null }` (404 if the channel itself isn't visible).

- [ ] **Step 1: failing tests — `server/src/routes/calls.test.ts`**

```ts
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { resetDb } from '../db/testUtils.js';
import { makeUser } from '../testHelpers.js';

vi.mock('../services/livekitService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/livekitService.js')>();
  return {
    ...actual,
    isLiveKitConfigured: vi.fn(() => true),
    mintCallToken: vi.fn(async () => 'mock-jwt-token'),
  };
});

const app = createApp();

describe('calls routes', () => {
  beforeEach(resetDb);

  it('starts a call for a channel the caller is a member of', async () => {
    const owner = await makeUser(app, { email: 'owner@flowerstore.ph' });
    const chan = await request(app)
      .post('/api/channels')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'g', isPrivate: false });

    const res = await request(app)
      .post('/api/calls')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ channelId: chan.body.channel.id });

    expect(res.status).toBe(201);
    expect(res.body.call.channelId).toBe(chan.body.channel.id);
    expect(res.body.token).toBe('mock-jwt-token');
    expect(res.body.serverUrl).toBeDefined();
  });

  it('404s for a channel the caller cannot see', async () => {
    const owner = await makeUser(app, { email: 'owner2@flowerstore.ph' });
    const outsider = await makeUser(app, { email: 'outsider@flowerstore.ph' });
    const chan = await request(app)
      .post('/api/channels')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'secret', isPrivate: true });

    const res = await request(app)
      .post('/api/calls')
      .set('Authorization', `Bearer ${outsider.token}`)
      .send({ channelId: chan.body.channel.id });

    expect(res.status).toBe(404);
  });

  it('supports ad-hoc calls with no channelId', async () => {
    const u = await makeUser(app, { email: 'u@flowerstore.ph' });
    const res = await request(app).post('/api/calls').set('Authorization', `Bearer ${u.token}`).send({});
    expect(res.status).toBe(201);
    expect(res.body.call.channelId).toBeNull();
  });

  it('ends a call and rejects ending it twice', async () => {
    const owner = await makeUser(app, { email: 'owner3@flowerstore.ph' });
    const chan = await request(app)
      .post('/api/channels')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'g2', isPrivate: false });
    const started = await request(app)
      .post('/api/calls')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ channelId: chan.body.channel.id });

    const ended = await request(app)
      .post(`/api/calls/${started.body.call.id}/end`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(ended.status).toBe(200);

    const endedAgain = await request(app)
      .post(`/api/calls/${started.body.call.id}/end`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(endedAgain.status).toBe(400);
  });

  it('GET /api/channels/:id/call returns the active call or null', async () => {
    const owner = await makeUser(app, { email: 'owner4@flowerstore.ph' });
    const chan = await request(app)
      .post('/api/channels')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'g3', isPrivate: false });

    const before = await request(app)
      .get(`/api/channels/${chan.body.channel.id}/call`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(before.body.call).toBeNull();

    await request(app)
      .post('/api/calls')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ channelId: chan.body.channel.id });

    const after = await request(app)
      .get(`/api/channels/${chan.body.channel.id}/call`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(after.body.call).not.toBeNull();
  });

  it('requires auth', async () => {
    const res = await request(app).post('/api/calls').send({});
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: failing test — add to `server/src/routes/channels.test.ts`** (append inside the existing `describe` block; if a mock of `livekitService.js` isn't already active in this file, this test only hits the `GET /:id/call` path which doesn't need LiveKit configured — no mock needed here since starting a call isn't exercised in this file)

```ts
  it('GET /:id/call 404s for a channel the caller cannot see', async () => {
    const owner = await makeUser(app, { email: 'callowner@flowerstore.ph' });
    const outsider = await makeUser(app, { email: 'calloutsider@flowerstore.ph' });
    const chan = await request(app)
      .post('/api/channels')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'call-secret', isPrivate: true });

    const res = await request(app)
      .get(`/api/channels/${chan.body.channel.id}/call`)
      .set('Authorization', `Bearer ${outsider.token}`);
    expect(res.status).toBe(404);
  });
```

- [ ] **Step 3: run to verify both fail**

Run: `cd server && npx vitest run src/routes/calls.test.ts src/routes/channels.test.ts`
Expected: FAIL — `/api/calls` 404s (route not mounted), and the new channels test fails (no `/:id/call` route yet)

- [ ] **Step 4: implement — `server/src/routes/calls.ts`**

```ts
import { eq } from 'drizzle-orm';
import { Router } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { endCall, getCallById, startCall } from '../services/callService.js';
import { getVisibleChannel, isChannelMember } from '../services/channelService.js';
import { isLiveKitConfigured, mintCallToken } from '../services/livekitService.js';

export const callsRouter = Router();
callsRouter.use(requireAuth);

function parseId(raw: string | string[]): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'validation_error', 'Bad id');
  return id;
}

async function requireCallerCanUseChannel(channelId: number, userId: number, isAdmin: boolean) {
  const channel = await getVisibleChannel(channelId, userId, isAdmin);
  if (!channel || (!isAdmin && !(await isChannelMember(channelId, userId)))) {
    throw new AppError(404, 'not_found', 'Not found');
  }
}

const startBody = z.object({ channelId: z.number().int().positive().optional() });

callsRouter.post('/', validate(startBody), async (req, res) => {
  if (!isLiveKitConfigured()) {
    throw new AppError(503, 'calls_not_configured', 'Teleconference is not configured');
  }
  const { channelId } = req.valid as z.infer<typeof startBody>;
  const userId = req.auth!.userId;
  const isAdmin = req.auth!.role === 'admin';

  if (channelId !== undefined) {
    await requireCallerCanUseChannel(channelId, userId, isAdmin);
  }

  const call = await startCall(channelId ?? null, userId);
  const [user] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, userId));
  const token = await mintCallToken(call.roomName, String(userId), user?.displayName ?? String(userId));

  if (channelId !== undefined) {
    const io = req.app.get('io') as SocketIOServer | undefined;
    io?.to(`channel:${channelId}`).emit('call:started', { channelId, callId: call.id, roomName: call.roomName });
  }

  res.status(201).json({ call, token, serverUrl: config.LIVEKIT_URL });
});

callsRouter.post('/:id/end', async (req, res) => {
  const id = parseId(req.params.id);
  const existing = await getCallById(id);
  if (!existing) throw new AppError(404, 'not_found', 'Not found');

  const userId = req.auth!.userId;
  const isAdmin = req.auth!.role === 'admin';
  if (existing.channelId !== null) {
    await requireCallerCanUseChannel(existing.channelId, userId, isAdmin);
  } else if (existing.startedBy !== userId && !isAdmin) {
    throw new AppError(404, 'not_found', 'Not found');
  }

  const updated = await endCall(id);
  if (!updated) throw new AppError(400, 'already_ended', 'Call already ended');

  if (updated.channelId !== null) {
    const io = req.app.get('io') as SocketIOServer | undefined;
    io?.to(`channel:${updated.channelId}`).emit('call:ended', {
      channelId: updated.channelId,
      callId: updated.id,
    });
  }

  res.json({ ok: true });
});
```

- [ ] **Step 5: mount it — modify `server/src/app.ts`**

Add the import alongside the other route imports:

```ts
import { callsRouter } from './routes/calls.js';
```

Add the mount line alongside the other `app.use('/api/...')` lines (after `/api/channels`, grouping with the chat-related routes):

```ts
app.use('/api/calls', callsRouter);
```

- [ ] **Step 6: add `GET /api/channels/:id/call` — modify `server/src/routes/channels.ts`**

Add `getActiveCallForChannel` to the existing import from `../services/callService.js` (new import line), then add this route to `channelsRouter` (anywhere after the existing route definitions, before `export const messagesRouter = Router();`):

```ts
channelsRouter.get('/:id/call', async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleChannel(id, req.auth!.userId, req.auth!.role === 'admin');
  const call = await getActiveCallForChannel(id);
  res.json({ call });
});
```

The full new import line to add near the top of `channels.ts`:

```ts
import { getActiveCallForChannel } from '../services/callService.js';
```

- [ ] **Step 7: run to verify both pass**

Run: `cd server && npx vitest run src/routes/calls.test.ts src/routes/channels.test.ts`
Expected: PASS (6 new `calls.test.ts` tests + 1 new `channels.test.ts` test + all pre-existing `channels.test.ts` tests)

- [ ] **Step 8: full server suite sanity check**

Run: `cd server && npm test > /tmp/phase6-task5.log 2>&1; echo "EXIT:$?"`
Expected: `EXIT:0` (or the one pre-existing unrelated `settingsService.test.ts` failure from before this branch, if it hasn't been fixed on `main` yet — check `git log main` for a settings fix merge; if present, expect a fully clean `EXIT:0`)

- [ ] **Step 9: Commit**

```bash
git add server/src/routes/calls.ts server/src/routes/calls.test.ts server/src/app.ts server/src/routes/channels.ts server/src/routes/channels.test.ts
git commit -m "feat(server): POST /api/calls, POST /api/calls/:id/end, GET /api/channels/:id/call

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Frontend — call sockets, calls feature, full-screen call page

**Files:**
- Modify: `src/lib/socket.ts`, `src/app/router.tsx`, `src/features/chat/ChannelPage.tsx`, `package.json`
- Create: `src/features/calls/types.ts`, `src/features/calls/api.ts`, `src/features/calls/useActiveCall.ts`, `src/features/calls/CallBanner.tsx`, `src/features/calls/CallPage.tsx`
- Install: `livekit-client`, `@livekit/components-react`, `@livekit/components-styles` (frontend dependencies)

**Interfaces:**
- `onCallStarted(handler: (e: { channelId: number; callId: number; roomName: string }) => void): () => void`
- `onCallEnded(handler: (e: { channelId: number; callId: number }) => void): () => void`
- `Call { id: number; channelId: number | null; roomName: string; startedBy: number; startedAt: string; endedAt: string | null }`
- `startCall(channelId?: number): Promise<{ call: Call; token: string; serverUrl: string }>`
- `endCall(callId: number): Promise<unknown>`
- `getActiveCall(channelId: number): Promise<{ call: Call | null }>`
- `useActiveCall(channelId: number): Call | null`

- [ ] **Step 1: install dependencies**

Run: `npm install livekit-client @livekit/components-react @livekit/components-styles`
Expected: added to root `package.json` dependencies.

- [ ] **Step 2: append call socket events — modify `src/lib/socket.ts`**

Add these two exported functions at the end of the file, mirroring the existing `onReaction`/`onTyping` pattern exactly:

```ts
export function onCallStarted(
  handler: (e: { channelId: number; callId: number; roomName: string }) => void,
): () => void {
  const s = getSocket();
  s.on('call:started', handler);
  return () => s.off('call:started', handler);
}

export function onCallEnded(handler: (e: { channelId: number; callId: number }) => void): () => void {
  const s = getSocket();
  s.on('call:ended', handler);
  return () => s.off('call:ended', handler);
}
```

- [ ] **Step 3: `src/features/calls/types.ts`**

```ts
export interface Call {
  id: number;
  channelId: number | null;
  roomName: string;
  startedBy: number;
  startedAt: string;
  endedAt: string | null;
}

export interface StartCallResponse {
  call: Call;
  token: string;
  serverUrl: string;
}
```

- [ ] **Step 4: `src/features/calls/api.ts`**

```ts
import { api } from '@/lib/api';
import type { Call, StartCallResponse } from './types';

export const startCall = (channelId?: number) =>
  api<StartCallResponse>('/api/calls', { method: 'POST', body: { channelId } });

export const endCall = (callId: number) => api(`/api/calls/${callId}/end`, { method: 'POST' });

export const getActiveCall = (channelId: number) =>
  api<{ call: Call | null }>(`/api/channels/${channelId}/call`);
```

- [ ] **Step 5: `src/features/calls/useActiveCall.ts`**

```tsx
import { useEffect, useState } from 'react';
import { onCallEnded, onCallStarted } from '@/lib/socket';
import { getActiveCall } from './api';
import type { Call } from './types';

export function useActiveCall(channelId: number): Call | null {
  const [call, setCall] = useState<Call | null>(null);

  useEffect(() => {
    let cancelled = false;
    getActiveCall(channelId).then((res) => {
      if (!cancelled) setCall(res.call);
    });

    const offStarted = onCallStarted((e) => {
      if (e.channelId !== channelId) return;
      setCall((current) =>
        current ?? {
          id: e.callId,
          channelId,
          roomName: e.roomName,
          startedBy: 0,
          startedAt: new Date().toISOString(),
          endedAt: null,
        },
      );
    });
    const offEnded = onCallEnded((e) => {
      if (e.channelId !== channelId) return;
      setCall((current) => (current?.id === e.callId ? null : current));
    });

    return () => {
      cancelled = true;
      offStarted();
      offEnded();
    };
  }, [channelId]);

  return call;
}
```

- [ ] **Step 6: `src/features/calls/CallBanner.tsx`**

```tsx
import { useNavigate } from 'react-router';
import { startCall } from './api';
import type { Call } from './types';

export function CallBanner({ channelId, activeCall }: { channelId: number; activeCall: Call | null }) {
  const navigate = useNavigate();

  async function handleClick() {
    const res = await startCall(channelId);
    navigate(`/call/${res.call.roomName}`, {
      state: { token: res.token, serverUrl: res.serverUrl, callId: res.call.id, channelId },
    });
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="flex w-full items-center justify-center gap-2 border-b bg-accent px-4 py-2 text-sm font-medium hover:bg-accent/80"
    >
      {activeCall ? 'Join call' : 'Start call'}
    </button>
  );
}
```

- [ ] **Step 7: `src/features/calls/CallPage.tsx`**

```tsx
import '@livekit/components-styles';
import { LiveKitRoom, VideoConference } from '@livekit/components-react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { endCall } from './api';

interface CallLocationState {
  token: string;
  serverUrl: string;
  callId: number;
  channelId: number | null;
}

export function CallPage() {
  const { roomName } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as CallLocationState | null;

  if (!state || !roomName) {
    return (
      <div className="flex h-dvh items-center justify-center text-muted-foreground">
        No active call session — start the call again from the channel.
      </div>
    );
  }

  async function handleDisconnected() {
    await endCall(state.callId).catch(() => {});
    navigate(state.channelId ? `/chat/${state.channelId}` : '/chat');
  }

  return (
    <LiveKitRoom
      token={state.token}
      serverUrl={state.serverUrl}
      connect
      video
      audio
      onDisconnected={handleDisconnected}
      className="h-dvh"
    >
      <VideoConference />
    </LiveKitRoom>
  );
}
```

- [ ] **Step 8: full-screen route — modify `src/app/router.tsx`**

Add the import:

```ts
import { CallPage } from '@/features/calls/CallPage';
```

Restructure the `RequireAuth` children so `/call/:roomName` is a sibling of the `AppLayout` branch (not nested inside it — this keeps the call view full-screen, no sidebar):

```tsx
export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
  {
    element: <RequireAuth />,
    children: [
      { path: '/call/:roomName', element: <CallPage /> },
      {
        element: <AppLayout />,
        children: [
          { path: '/', element: <Navigate to="/chat" replace /> },
          {
            path: '/chat',
            element: (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                Select a channel
              </div>
            ),
          },
          { path: '/chat/:channelId', element: <ChannelPage /> },
          { path: '/projects', element: <ProjectListPage /> },
          { path: '/projects/:projectId', element: <ProjectBoardPage /> },
          { path: '/projects/:projectId/docs', element: <DocListPage /> },
          { path: '/projects/:projectId/docs/:docId', element: <DocPage /> },
          { path: '/notes', element: <NotesPage /> },
          {
            element: <RequireAdmin />,
            children: [{ path: '/admin', element: <AdminPage /> }],
          },
        ],
      },
    ],
  },
]);
```

- [ ] **Step 9: wire the banner into the channel header — modify `src/features/chat/ChannelPage.tsx`**

Add these two imports:

```ts
import { CallBanner } from '@/features/calls/CallBanner';
import { useActiveCall } from '@/features/calls/useActiveCall';
```

Add the hook call inside the `ChannelPage` component body (alongside the existing `useQuery`/`useState` calls):

```ts
  const activeCall = useActiveCall(id);
```

Add `<CallBanner channelId={id} activeCall={activeCall} />` immediately after the closing `</header>` tag, before the `<div className="min-h-0 flex-1">` message list wrapper — i.e. the return block becomes:

```tsx
  return (
    <div className="flex h-full flex-col">
      <header className="border-b px-4 py-3">
        <h2 className="font-semibold"># {data?.channel.name ?? '…'}</h2>
        {data?.channel.topic && <p className="text-xs text-muted-foreground">{data.channel.topic}</p>}
      </header>
      <CallBanner channelId={id} activeCall={activeCall} />
      <div className="min-h-0 flex-1">
        <MessageList channelId={id} />
      </div>
      <TypingIndicator names={Object.values(typingUsers)} />
      <MessageInput channelId={id} onSent={() => {}} />
    </div>
  );
```

(`useActiveCall(id)` is safe to call unconditionally here — `id` is already guarded by the `if (!Number.isFinite(id)) return null;` line above it in the existing component, and hooks execute before that early return per React's rules, exactly like the pre-existing `useQuery`/`useState` calls already do.)

- [ ] **Step 10: build check**

Run: `npm run build > /tmp/phase6-web-build.log 2>&1; echo "EXIT:$?"`
Expected: `EXIT:0`

Run: `npm run lint`
Expected: clean (aside from pre-existing shadcn-ui warnings unrelated to this change)

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json src/lib/socket.ts src/app/router.tsx src/features/chat/ChannelPage.tsx src/features/calls/
git commit -m "feat(web): call banner, full-screen LiveKit call page, call socket events

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Phase gate — full verification + finish

- [ ] `cd server && npm test > /tmp/phase6-gate.log 2>&1; echo "EXIT:$?"` → `EXIT:0` (all suites green — pre-existing count plus this phase's new `callService`/`livekitService`/`calls` route tests)
- [ ] `cd server && npm run build > /tmp/phase6-server-build.log 2>&1; echo "EXIT:$?"` → `EXIT:0`
- [ ] `npm run build > /tmp/phase6-web-build2.log 2>&1; echo "EXIT:$?"` (root) → `EXIT:0`; `npm run lint` clean
- [ ] `docker build .` (from `server/` as context) → succeeds with `livekit-server-sdk` now in the image
- [ ] **Attempt a real local LiveKit dev server** for live verification:
  - `curl -sSL https://get.livekit.io | bash` then `livekit-server --dev` (binds `127.0.0.1:7880` by default, uses `devkey`/`secret` as API key/secret per the official docs)
  - If this succeeds: set `LIVEKIT_URL=ws://localhost:7880`, `LIVEKIT_API_KEY=devkey`, `LIVEKIT_API_SECRET=secret` in `server/.env`, restart the PM2 server process, and do a real end-to-end check — `POST /api/calls` with a real channel, confirm a real signed JWT comes back (not just structurally, decode it and check the `video.room`/`video.roomJoin` claims match), confirm `GET /api/channels/:id/call` reflects it, confirm `POST /api/calls/:id/end` works and the call disappears from that endpoint. If two browser profiles/tabs are available (Claude_Browser tools), log in as two different users who are both members of the same channel, have one start the call, confirm the other sees the "Join call" banner flip via the `call:started` socket event (poll the DOM / check network for the socket event, since actual media (camera/mic) likely isn't available in this sandboxed browser — note that limitation explicitly rather than claiming full audio/video was verified)
  - If binary install or port binding is blocked by the sandbox: **note this as deferred, not silently skipped** — record exactly what failed (network restriction, permission denied, etc.)
- [ ] Confirm the 503 path: with `LIVEKIT_*` unset (or if the local server attempt failed), `POST /api/calls` returns `503 calls_not_configured` — the platform must remain otherwise fully functional (chat, kanban, etc. all still work) when calls are unconfigured
- [ ] Confirm non-member 404: as a user who is NOT a member of a private channel, `POST /api/calls { channelId: <private channel id> }` → 404, and `GET /api/channels/:id/call` for that channel → 404 (never a leaked 403/200)
- [ ] Mobile (Capacitor camera/mic permissions, physical Android/iOS device call test, webview WebRTC quirks) — **deferred**: no Xcode/Android Studio/physical devices available in this environment, same standing limitation as every prior phase's mobile-specific items. `AndroidManifest`/`Info.plist` permission entries and the "keep default `capacitor://localhost` hostname" guidance are documented here for whoever picks up mobile testing, but no native project changes are made this phase (this repo's `android/`/`ios/` platforms were never added via `npx cap add`, so there's nothing to edit yet regardless)
- [ ] Prod deploy (EC2 VM cloud-init + Caddy, ports 7880/7881/UDP mux 7882, embedded TURN, CA-signed cert) — **deferred, ops-only**, not part of this implementation phase; flag it as a prerequisite for whenever this phase actually needs to serve real users
- [ ] Update memory (mark Phase 6 complete; record the LiveKit dev-server live-verification result — done or deferred, and exactly how far it got), then use **superpowers:finishing-a-development-branch**

## Deviations / notes for the implementer

- `startCall`'s ad-hoc room name (`adhoc-${randomUUID()}`) and channel room name (`channel-${channelId}-${randomUUID().slice(0,8)}`) both include a random suffix specifically so a channel's second call (after the first ended) never collides with `room_name`'s permanent UNIQUE constraint — don't simplify this to a bare `channel-${channelId}` even though it reads cleaner, it will break on the second call.
- The `GET /api/channels/:id/call` route lives in `channels.ts`, not `calls.ts` — this matches the master plan's literal API surface (`GET /api/channels/:id/call`, not `GET /api/calls/channel/:id`) and keeps it next to every other `/api/channels/:id/*` route for discoverability.
- `req.app.get('io')` will be `undefined` in every route-level supertest test in this plan (they all call `createApp()` directly, never creating a real `http.createServer`/`Server` pair) — this is expected and already handled by the `io?.to(...)` optional-chaining in Task 5's routes. Don't try to "fix" this by wiring up a real socket server in the route tests; that's out of scope and unnecessary — the emit's correctness is a live-verification concern (Task 7), not a unit-test concern.
- `useActiveCall`'s optimistic `call:started` handler fills in placeholder values (`startedBy: 0`, `startedAt: new Date().toISOString()`) for fields the socket payload doesn't carry — this is fine because `useActiveCall`'s only consumer (`CallBanner`) only reads `activeCall !== null` to decide "Start" vs "Join" wording, never those placeholder fields. If a later feature needs the real `startedBy`/`startedAt` reactively (not just via the initial `GET` fetch), broaden the socket payload then — don't do it speculatively now.
- **Scope trim vs. the master plan's literal wording**: the master plan says "sidebar + channel-header call indicators," but this plan only implements the channel-header `CallBanner` (Task 6). A sidebar-wide indicator would need every channel list item to know its own active-call status (either a new bulk endpoint like `GET /api/channels?withActiveCalls=true`, or N `useActiveCall`-style subscriptions, one per visible channel) — that's a meaningfully bigger feature than "one more banner," and the channel-header banner already covers the core discoverability need (open the channel, see whether a call is running). Deferred as a follow-up, not silently dropped.
