# Phase 2: Messaging & Slack UI Shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Public/private channels, DMs, real-time messages with reactions and full-text search, unread tracking, department-scoped visibility, a memcached caching layer, an automation-event-bus seam for future bots, and a Slack-replica UI shell to use all of it.

**Architecture:** Centralized visibility SQL fragments in `channelService` are the single source of truth for "can this user see this channel" — every list/get query and every socket join reuses them, so private content is provably invisible (404, not 403) to non-members. Messages persist through `messageService`, which publishes a `message.created` event on an in-process bus after each send; the first (only) subscriber this phase is a no-op logger, proving the seam works without any real automation yet. A thin `cache.ts` wraps `memcache` with graceful no-op behavior when unconfigured, so caching is opportunistic, never load-bearing.

**Tech Stack:** Drizzle 0.45 (mysql2), `memcache` (jaredwray) v1.9, Express 5, Socket.IO 4.8, Vitest+supertest; React 19, react-router v8, TanStack Query v5, zustand v5, shadcn/ui.

## Global Constraints

- Visibility rule (from master plan): a user sees a channel if it is public (`is_private = false`), OR they are a member, OR (department-scoped) they belong to the owning department. Private + non-member → excluded from every list, and the get-by-id/messages/join paths return **404** (`not_found`), never 403 — existence must not leak. Admins bypass for governance.
- `memcache` real API (verified against github.com/jaredwray/memcache README, 2026-07-22): `new Memcache(uri)`; `get(key: string): Promise<string | undefined>`; `set(key, value: string, exptimeSeconds?, flags?): Promise<boolean>`; `delete(key): Promise<boolean>`. Values are strings only — JSON.stringify/parse at the call site. Never let a cache failure break a request — every cache call is wrapped and best-effort.
- No new npm deps beyond `memcache`; `socket.io-client` already present (server devDep, web dep).
- Message author identity is ALWAYS `socket.data.userId` from the Phase 1 socket auth — never trust a client-supplied userId (this rule already holds; do not regress it).
- Commits: small, conventional (`feat(server): …` / `feat(web): …`), end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Every task ends with `npm test` green in `server/` (31 existing + new); `npm run build` wherever files changed on that side.
- Local dev DB is the system MariaDB (port 3306) per prior user directive — do not reintroduce a MySQL 8 container. Keep using only Drizzle's core query builder (`db.select/insert/update/delete`), never `db.query.*` (MariaDB-incompatible relational API).

---

### Task 1: Migration 002 — messaging schema

**Files:**
- Modify: `server/src/db/schema/chat.ts`
- Create: `server/src/db/schema/reactions.ts`
- Modify: `server/src/db/schema/index.ts`

**Interfaces:**
- Produces Drizzle tables: `channels` (+`type`, `topic`, `dmKey`, `createdBy`; `name` nullable; keeps `departmentId`), `channelMembers` (+`role`, `lastReadMessageId`), `messages` (+`editedAt`, `deletedAt`; FULLTEXT index on `body`), `messageMentions`, `messageReactions`.
- Note: existing `isPrivate` boolean stays (simpler + already used); `type` adds `'dm'` as a third state distinct from public/private, so channel-kind checks use `type === 'dm'` while visibility checks keep using `isPrivate`.

- [ ] **Step 1: extend `chat.ts`**

```ts
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  datetime,
  index,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/mysql-core';
import { users } from './auth.js';
import { departments } from './departments.js';

export const channels = mysqlTable('channels', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  name: varchar('name', { length: 80 }),
  type: mysqlEnum('type', ['public', 'private', 'dm']).notNull().default('public'),
  isPrivate: boolean('is_private').notNull().default(false),
  topic: varchar('topic', { length: 255 }),
  dmKey: varchar('dm_key', { length: 50 }).unique(),
  departmentId: bigint('department_id', { mode: 'number', unsigned: true }).references(
    () => departments.id,
    { onDelete: 'set null' },
  ),
  createdBy: bigint('created_by', { mode: 'number', unsigned: true }).references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const channelMembers = mysqlTable(
  'channel_members',
  {
    channelId: bigint('channel_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: mysqlEnum('role', ['owner', 'member']).notNull().default('member'),
    lastReadMessageId: bigint('last_read_message_id', { mode: 'number', unsigned: true })
      .notNull()
      .default(0),
    joinedAt: timestamp('joined_at').notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.channelId, table.userId] })],
);

export const messages = mysqlTable(
  'messages',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    channelId: bigint('channel_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => users.id),
    body: text('body').notNull(),
    editedAt: datetime('edited_at'),
    deletedAt: datetime('deleted_at'),
    createdAt: timestamp('created_at', { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    index('idx_channel_created').on(table.channelId, table.createdAt),
    index('idx_channel_id').on(table.channelId, table.id),
  ],
);

export const messageMentions = mysqlTable(
  'message_mentions',
  {
    messageId: bigint('message_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.userId] }),
    index('idx_mm_user').on(table.userId),
  ],
);
```

- [ ] **Step 2: `reactions.ts`**

```ts
import { bigint, mysqlTable, primaryKey, varchar } from 'drizzle-orm/mysql-core';
import { messages } from './chat.js';
import { users } from './auth.js';

export const messageReactions = mysqlTable(
  'message_reactions',
  {
    messageId: bigint('message_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emoji: varchar('emoji', { length: 32 }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.messageId, table.userId, table.emoji] })],
);
```

- [ ] **Step 3: export from `schema/index.ts`** — add `export * from './reactions.js';`

- [ ] **Step 4: generate + apply + verify**

```bash
cd server
npx drizzle-kit generate --name messaging
npm run db:migrate
mariadb -u fs_app -pfs_app_dev fs_internal_system -e "SHOW COLUMNS FROM channels; SHOW COLUMNS FROM messages; SHOW TABLES LIKE '%message%';"
```

Expected: channels has type/topic/dm_key/created_by, name nullable; messages has edited_at/deleted_at; tables include message_mentions, message_reactions.

- [ ] **Step 5: add a raw FULLTEXT index** (drizzle-kit's mysql dialect doesn't emit FULLTEXT — hand-write it as a follow-up migration file) — create `server/drizzle/0003_message_fulltext.sql`:

```sql
ALTER TABLE `messages` ADD FULLTEXT INDEX `idx_messages_body_fts` (`body`);
```

Register it in `server/drizzle/meta/_journal.json` by re-running `npx drizzle-kit generate --custom --name message_fulltext` first (creates an empty file + journal entry), THEN paste the SQL above into the generated file. Apply with `npm run db:migrate` and confirm:

```bash
mariadb -u fs_app -pfs_app_dev fs_internal_system -e "SHOW INDEX FROM messages WHERE Key_name LIKE '%fts%';"
```

- [ ] **Step 6: `npm test`** → still green (existing 31 tests unaffected by additive columns).
- [ ] **Step 7: Commit** — `feat(server): messaging schema — channel type/topic/dm, reactions, mentions, FULLTEXT search (migration 0002+0003)`

### Task 2: cache.ts — memcached wrapper (opportunistic, no-op safe) — TDD

**Files:**
- Create: `server/src/lib/cache.ts`
- Test: `server/src/lib/cache.test.ts`
- Modify: `server/src/config.ts` (add `MEMCACHED_SERVERS?: string`)
- Modify: `server/package.json` (dep `memcache`)

**Interfaces:**
- `cacheGet<T>(key: string): Promise<T | undefined>`
- `cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void>`
- `cacheDel(key: string): Promise<void>`
- All three are safe no-ops (get resolves `undefined`, set/del resolve immediately) when `config.MEMCACHED_SERVERS` is unset, and never throw even if the real client errors.

- [ ] **Step 1: install + config**

```bash
cd server && npm install memcache
```

Add to `EnvSchema` in `config.ts`: `MEMCACHED_SERVERS: z.string().optional(),`

- [ ] **Step 2: failing test**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('cache (no memcached configured)', () => {
  afterEach(() => vi.resetModules());

  it('get always misses, set/del are no-ops, nothing throws', async () => {
    vi.stubEnv('MEMCACHED_SERVERS', '');
    const { cacheDel, cacheGet, cacheSet } = await import('./cache.js');
    expect(await cacheGet('k')).toBeUndefined();
    await expect(cacheSet('k', { a: 1 }, 60)).resolves.toBeUndefined();
    await expect(cacheDel('k')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: run** → FAIL (module not found). **Step 3: implement**

```ts
import { Memcache } from 'memcache';
import { config } from '../config.js';
import { logger } from '../logger.js';

const client = config.MEMCACHED_SERVERS ? new Memcache(config.MEMCACHED_SERVERS) : null;

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  if (!client) return undefined;
  try {
    const raw = await client.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  } catch (err) {
    logger.warn({ err, key }, 'cache get failed');
    return undefined;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (!client) return;
  try {
    await client.set(key, JSON.stringify(value), ttlSeconds);
  } catch (err) {
    logger.warn({ err, key }, 'cache set failed');
  }
}

export async function cacheDel(key: string): Promise<void> {
  if (!client) return;
  try {
    await client.delete(key);
  } catch (err) {
    logger.warn({ err, key }, 'cache delete failed');
  }
}
```

- [ ] **Step 4: run** → PASS (no `MEMCACHED_SERVERS` set in the test env, so this exercises the real no-op path). **Step 5: Commit** — `feat(server): opportunistic memcached cache wrapper (no-op when unconfigured)`

### Task 3: automation event bus seam — TDD

**Files:**
- Create: `server/src/services/events.ts`
- Test: `server/src/services/events.test.ts`
- Create: `server/src/automations/logAutomation.ts`
- Create: `server/src/automations/index.ts`

**Interfaces:**
- `events: EventEmitter`-like typed bus — `on('message.created', handler)`, `emit('message.created', payload)`.
- `registerAutomations(): void` — wires up all automations (today: just the logger); called once at server bootstrap.
- Payload type: `MessageCreatedEvent = { message: { id: number; channelId: number; userId: number; body: string }; channel: { id: number; isPrivate: boolean } }`.

- [ ] **Step 1: failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { events } from './events.js';

describe('events bus', () => {
  it('delivers message.created to subscribers and isolates handler errors', async () => {
    const good = vi.fn();
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    events.on('message.created', bad);
    events.on('message.created', good);
    const payload = {
      message: { id: 1, channelId: 1, userId: 1, body: 'hi' },
      channel: { id: 1, isPrivate: false },
    };
    // must not throw even though one handler throws
    expect(() => events.emit('message.created', payload)).not.toThrow();
    expect(good).toHaveBeenCalledWith(payload);
    events.off('message.created', bad);
    events.off('message.created', good);
  });
});
```

- [ ] **Step 2: run** → FAIL. **Step 3: implement**

```ts
import { EventEmitter } from 'node:events';
import { logger } from '../logger.js';

export interface MessageCreatedEvent {
  message: { id: number; channelId: number; userId: number; body: string };
  channel: { id: number; isPrivate: boolean };
}

interface EventMap {
  'message.created': MessageCreatedEvent;
}

class TypedBus extends EventEmitter {
  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): boolean {
    // isolate each listener: one automation's bug must never break message send
    for (const listener of this.listeners(event)) {
      try {
        (listener as (p: EventMap[K]) => void)(payload);
      } catch (err) {
        logger.error({ err, event }, 'automation handler failed');
      }
    }
    return true;
  }

  on<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void): this {
    return super.on(event, handler);
  }

  off<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void): this {
    return super.off(event, handler);
  }
}

export const events = new TypedBus();
```

`automations/logAutomation.ts`:

```ts
import { logger } from '../logger.js';
import { events, type MessageCreatedEvent } from '../services/events.js';

export function registerLogAutomation(): void {
  events.on('message.created', (payload: MessageCreatedEvent) => {
    logger.debug({ messageId: payload.message.id, channelId: payload.channel.id }, 'message.created');
  });
}
```

`automations/index.ts`:

```ts
import { registerLogAutomation } from './logAutomation.js';

export function registerAutomations(): void {
  registerLogAutomation();
}
```

- [ ] **Step 4: run** → PASS. **Step 5: Commit** — `feat(server): automation event bus with no-op logger automation (Phase 7 seam)`

### Task 4: channelService — visibility fragments + CRUD + DM find-or-create — TDD

**Files:**
- Create: `server/src/services/channelService.ts`
- Test: `server/src/services/channelService.test.ts`

**Interfaces:**
- `visibilityCondition(userId: number, isAdmin: boolean)` — returns a Drizzle SQL fragment usable in a `WHERE`, expressing: public OR member OR department-member. Exported so `messageService` and routes can reuse it verbatim.
- `listVisibleChannels(userId, isAdmin): Promise<ChannelSummary[]>` (excludes DMs — those list separately)
- `getVisibleChannel(channelId, userId, isAdmin): Promise<ChannelRow | null>` — null (→ route 404s) if not visible
- `createChannel(input: { name, isPrivate, topic?, departmentId?, createdBy }): Promise<ChannelRow>` — creator auto-joins as `owner`; if `departmentId` set, auto-joins all existing department members too (member role)
- `addChannelMember(channelId, userId, role?)`, `removeChannelMember(channelId, userId)`
- `findOrCreateDm(userIdA, userIdB): Promise<ChannelRow>` — `dmKey = 'dm:' + [min,max].join(':')`, both users joined as members
- `isChannelMember(channelId, userId): Promise<boolean>`

- [ ] **Step 1: failing tests**

```ts
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/index.js';
import { channelMembers, departmentMembers, departments, users } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import {
  addChannelMember,
  createChannel,
  findOrCreateDm,
  getVisibleChannel,
  isChannelMember,
  listVisibleChannels,
} from './channelService.js';

async function seedUser(email: string) {
  const [{ id }] = await db
    .insert(users)
    .values({ email, passwordHash: 'x', displayName: email.split('@')[0] })
    .$returningId();
  return id;
}

describe('channelService', () => {
  beforeEach(resetDb);

  it('lists public channels to everyone, hides private channels from non-members', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const outsider = await seedUser('outsider@flowerstore.ph');
    await createChannel({ name: 'general', isPrivate: false, createdBy: owner });
    const priv = await createChannel({ name: 'secret', isPrivate: true, createdBy: owner });

    const outsiderList = await listVisibleChannels(outsider, false);
    expect(outsiderList.map((c) => c.name)).toEqual(['general']);

    expect(await getVisibleChannel(priv.id, outsider, false)).toBeNull();
    expect(await getVisibleChannel(priv.id, owner, false)).not.toBeNull();
    // admin bypass
    expect(await getVisibleChannel(priv.id, outsider, true)).not.toBeNull();
  });

  it('department members can see department-owned private channels', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const deptUser = await seedUser('deptuser@flowerstore.ph');
    const [{ id: deptId }] = await db.insert(departments).values({ name: 'Mkt' }).$returningId();
    await db.insert(departmentMembers).values({ departmentId: deptId, userId: deptUser });
    const chan = await createChannel({
      name: 'mkt-private',
      isPrivate: true,
      departmentId: deptId,
      createdBy: owner,
    });
    expect(await getVisibleChannel(chan.id, deptUser, false)).not.toBeNull();
  });

  it('creating a department channel auto-joins existing department members', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const existingMember = await seedUser('existing@flowerstore.ph');
    const [{ id: deptId }] = await db.insert(departments).values({ name: 'Ops' }).$returningId();
    await db.insert(departmentMembers).values({ departmentId: deptId, userId: existingMember });

    const chan = await createChannel({ name: 'ops-general', isPrivate: false, departmentId: deptId, createdBy: owner });
    expect(await isChannelMember(chan.id, existingMember)).toBe(true);
    expect(await isChannelMember(chan.id, owner)).toBe(true); // creator too
  });

  it('DMs are found-or-created idempotently regardless of argument order', async () => {
    const a = await seedUser('a@flowerstore.ph');
    const b = await seedUser('b@flowerstore.ph');
    const dm1 = await findOrCreateDm(a, b);
    const dm2 = await findOrCreateDm(b, a);
    expect(dm1.id).toBe(dm2.id);
    expect(dm1.type).toBe('dm');
    const rows = await db.select().from(channelMembers).where(eq(channelMembers.channelId, dm1.id));
    expect(rows.map((r) => r.userId).sort()).toEqual([a, b].sort((x, y) => x - y));
  });

  it('member add/remove works', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const u = await seedUser('u@flowerstore.ph');
    const chan = await createChannel({ name: 'g2', isPrivate: false, createdBy: owner });
    await addChannelMember(chan.id, u);
    expect(await isChannelMember(chan.id, u)).toBe(true);
    const { removeChannelMember } = await import('./channelService.js');
    await removeChannelMember(chan.id, u);
    expect(await isChannelMember(chan.id, u)).toBe(false);
  });
});
```

- [ ] **Step 2: run** → FAIL. **Step 3: implement**

```ts
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { channelMembers, channels, departmentMembers } from '../db/schema/index.js';

export type ChannelRow = typeof channels.$inferSelect;

/** Public OR member OR belongs to the owning department. Admins bypass at the call site. */
export function visibilityCondition(userId: number) {
  return or(
    eq(channels.isPrivate, false),
    sql`EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = channels.id AND cm.user_id = ${userId})`,
    and(
      sql`channels.department_id IS NOT NULL`,
      sql`EXISTS (SELECT 1 FROM department_members dm WHERE dm.department_id = channels.department_id AND dm.user_id = ${userId})`,
    ),
  );
}

export async function listVisibleChannels(userId: number, isAdmin: boolean) {
  const notDm = sql`channels.type <> 'dm'`;
  const where = isAdmin ? notDm : and(notDm, visibilityCondition(userId));
  return db.select().from(channels).where(where).orderBy(channels.name);
}

export async function getVisibleChannel(
  channelId: number,
  userId: number,
  isAdmin: boolean,
): Promise<ChannelRow | null> {
  const where = isAdmin
    ? eq(channels.id, channelId)
    : and(eq(channels.id, channelId), visibilityCondition(userId));
  const [row] = await db.select().from(channels).where(where);
  return row ?? null;
}

export async function isChannelMember(channelId: number, userId: number): Promise<boolean> {
  const [row] = await db
    .select()
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)));
  return Boolean(row);
}

export async function addChannelMember(
  channelId: number,
  userId: number,
  role: 'owner' | 'member' = 'member',
): Promise<void> {
  await db
    .insert(channelMembers)
    .values({ channelId, userId, role })
    .onDuplicateKeyUpdate({ set: { role: sql`role` } }); // insert-or-ignore
}

export async function removeChannelMember(channelId: number, userId: number): Promise<void> {
  await db
    .delete(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)));
}

export async function createChannel(input: {
  name: string;
  isPrivate: boolean;
  topic?: string;
  departmentId?: number;
  createdBy: number;
}): Promise<ChannelRow> {
  const [{ id }] = await db
    .insert(channels)
    .values({
      name: input.name,
      isPrivate: input.isPrivate,
      type: input.isPrivate ? 'private' : 'public',
      topic: input.topic,
      departmentId: input.departmentId,
      createdBy: input.createdBy,
    })
    .$returningId();
  await addChannelMember(id, input.createdBy, 'owner');
  if (input.departmentId) {
    const members = await db
      .select({ userId: departmentMembers.userId })
      .from(departmentMembers)
      .where(eq(departmentMembers.departmentId, input.departmentId));
    for (const m of members) await addChannelMember(id, m.userId);
  }
  const [row] = await db.select().from(channels).where(eq(channels.id, id));
  return row;
}

export async function findOrCreateDm(userIdA: number, userIdB: number): Promise<ChannelRow> {
  const [lo, hi] = [userIdA, userIdB].sort((a, b) => a - b);
  const dmKey = `dm:${lo}:${hi}`;
  const [existing] = await db.select().from(channels).where(eq(channels.dmKey, dmKey));
  if (existing) return existing;
  const [{ id }] = await db
    .insert(channels)
    .values({ type: 'dm', isPrivate: true, dmKey, createdBy: userIdA })
    .$returningId();
  await addChannelMember(id, userIdA);
  await addChannelMember(id, userIdB);
  const [row] = await db.select().from(channels).where(eq(channels.id, id));
  return row;
}
```

- [ ] **Step 4: run** → PASS. **Step 5: Commit** — `feat(server): channelService — centralized visibility, department auto-join, DM find-or-create`

### Task 5: messageService — history, send, edit/delete, reactions, search — TDD

**Files:**
- Create: `server/src/services/messageService.ts`
- Test: `server/src/services/messageService.test.ts`

**Interfaces:**
- `sendMessage(channelId, userId, body): Promise<MessageWithAuthor>` — inserts, emits `message.created` on `events`, returns hydrated row
- `getMessagesBefore(channelId, beforeId: number | null, limit: number): Promise<MessageWithAuthor[]>` — cursor pagination, newest-first page, excludes soft-deleted
- `markRead(channelId, userId, messageId): Promise<void>`
- `getUnreadCounts(userId): Promise<Record<number, number>>` — channelId → count of messages with id > lastReadMessageId, only for channels the user belongs to
- `toggleReaction(messageId, userId, emoji): Promise<{ added: boolean }>`
- `searchMessages(userId, isAdmin, query: string, channelId?): Promise<MessageWithAuthor[]>` — FULLTEXT search filtered through channel visibility (join to a visible-channel-ids subquery)
- `softDeleteMessage(messageId, userId): Promise<boolean>` — only the author; sets `deletedAt`
- `editMessage(messageId, userId, body): Promise<boolean>` — only the author; sets `editedAt`
- `MessageWithAuthor = { id, channelId, userId, displayName, body, editedAt, deletedAt, createdAt, reactions: { emoji, userIds: number[] }[] }`

- [ ] **Step 1: failing tests**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { events } from './events.js';
import { createChannel } from './channelService.js';
import {
  editMessage,
  getMessagesBefore,
  getUnreadCounts,
  markRead,
  searchMessages,
  sendMessage,
  softDeleteMessage,
  toggleReaction,
} from './messageService.js';

async function seedUser(email: string) {
  const [{ id }] = await db
    .insert(users)
    .values({ email, passwordHash: 'x', displayName: email.split('@')[0] })
    .$returningId();
  return id;
}

describe('messageService', () => {
  beforeEach(resetDb);

  it('sends a message, emits message.created, and paginates by cursor', async () => {
    const u = await seedUser('u@flowerstore.ph');
    const chan = await createChannel({ name: 'g', isPrivate: false, createdBy: u });
    const handler = vi.fn();
    events.on('message.created', handler);

    const first = await sendMessage(chan.id, u, 'hello');
    expect(first.displayName).toBe('u');
    expect(handler).toHaveBeenCalledOnce();
    events.off('message.created', handler);

    for (let i = 0; i < 3; i++) await sendMessage(chan.id, u, `msg ${i}`);
    const page1 = await getMessagesBefore(chan.id, null, 2);
    expect(page1).toHaveLength(2);
    const page2 = await getMessagesBefore(chan.id, page1[page1.length - 1].id, 2);
    expect(page2.map((m) => m.id)).not.toContain(page1[0].id);
    expect(page2.map((m) => m.id)).not.toContain(page1[1].id);
  });

  it('tracks unread counts per channel membership only', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const reader = await seedUser('reader@flowerstore.ph');
    const chan = await createChannel({ name: 'g2', isPrivate: false, createdBy: owner });
    const { addChannelMember } = await import('./channelService.js');
    await addChannelMember(chan.id, reader);
    const m1 = await sendMessage(chan.id, owner, 'one');
    await sendMessage(chan.id, owner, 'two');

    let counts = await getUnreadCounts(reader);
    expect(counts[chan.id]).toBe(2);
    await markRead(chan.id, reader, m1.id);
    counts = await getUnreadCounts(reader);
    expect(counts[chan.id]).toBe(1);
  });

  it('reactions toggle on/off', async () => {
    const u = await seedUser('u@flowerstore.ph');
    const chan = await createChannel({ name: 'g3', isPrivate: false, createdBy: u });
    const msg = await sendMessage(chan.id, u, 'react to me');
    const r1 = await toggleReaction(msg.id, u, '👍');
    expect(r1.added).toBe(true);
    const r2 = await toggleReaction(msg.id, u, '👍');
    expect(r2.added).toBe(false);
  });

  it('edit/delete are author-only', async () => {
    const author = await seedUser('author@flowerstore.ph');
    const other = await seedUser('other@flowerstore.ph');
    const chan = await createChannel({ name: 'g4', isPrivate: false, createdBy: author });
    const msg = await sendMessage(chan.id, author, 'original');
    expect(await editMessage(msg.id, other, 'hacked')).toBe(false);
    expect(await editMessage(msg.id, author, 'edited')).toBe(true);
    expect(await softDeleteMessage(msg.id, other)).toBe(false);
    expect(await softDeleteMessage(msg.id, author)).toBe(true);
    const [page] = await getMessagesBefore(chan.id, null, 10);
    expect(page).toBeUndefined(); // soft-deleted, excluded from history
  });

  it('search respects channel visibility', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const outsider = await seedUser('outsider@flowerstore.ph');
    const pub = await createChannel({ name: 'pub', isPrivate: false, createdBy: owner });
    const priv = await createChannel({ name: 'priv', isPrivate: true, createdBy: owner });
    await sendMessage(pub.id, owner, 'findable pizza party');
    await sendMessage(priv.id, owner, 'secret pizza party');

    const outsiderResults = await searchMessages(outsider, false, 'pizza');
    expect(outsiderResults.map((m) => m.channelId)).toEqual([pub.id]);

    const ownerResults = await searchMessages(owner, false, 'pizza');
    expect(ownerResults).toHaveLength(2);
  });
});
```

- [ ] **Step 2: run** → FAIL. **Step 3: implement**

```ts
import { and, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { channelMembers, channels, messageReactions, messages, users } from '../db/schema/index.js';
import { visibilityCondition } from './channelService.js';
import { events } from './events.js';

export interface MessageWithAuthor {
  id: number;
  channelId: number;
  userId: number;
  displayName: string;
  body: string;
  editedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  reactions: { emoji: string; userIds: number[] }[];
}

async function hydrateReactions(messageIds: number[]): Promise<Map<number, { emoji: string; userIds: number[] }[]>> {
  const map = new Map<number, { emoji: string; userIds: number[] }[]>();
  if (messageIds.length === 0) return map;
  const rows = await db
    .select()
    .from(messageReactions)
    .where(inArray(messageReactions.messageId, messageIds));
  for (const r of rows) {
    const list = map.get(r.messageId) ?? [];
    const existing = list.find((x) => x.emoji === r.emoji);
    if (existing) existing.userIds.push(r.userId);
    else list.push({ emoji: r.emoji, userIds: [r.userId] });
    map.set(r.messageId, list);
  }
  return map;
}

function toDto(
  row: typeof messages.$inferSelect & { displayName: string },
  reactions: Map<number, { emoji: string; userIds: number[] }[]>,
): MessageWithAuthor {
  return {
    id: row.id,
    channelId: row.channelId,
    userId: row.userId,
    displayName: row.displayName,
    body: row.body,
    editedAt: row.editedAt,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    reactions: reactions.get(row.id) ?? [],
  };
}

export async function sendMessage(channelId: number, userId: number, body: string): Promise<MessageWithAuthor> {
  const [{ id }] = await db.insert(messages).values({ channelId, userId, body }).$returningId();
  const [row] = await db
    .select({
      id: messages.id,
      channelId: messages.channelId,
      userId: messages.userId,
      body: messages.body,
      editedAt: messages.editedAt,
      deletedAt: messages.deletedAt,
      createdAt: messages.createdAt,
      displayName: users.displayName,
    })
    .from(messages)
    .innerJoin(users, eq(users.id, messages.userId))
    .where(eq(messages.id, id));
  const [channel] = await db.select().from(channels).where(eq(channels.id, channelId));
  events.emit('message.created', {
    message: { id: row.id, channelId, userId, body },
    channel: { id: channel.id, isPrivate: channel.isPrivate },
  });
  return toDto(row, new Map());
}

export async function getMessagesBefore(
  channelId: number,
  beforeId: number | null,
  limit: number,
): Promise<MessageWithAuthor[]> {
  const conditions = [eq(messages.channelId, channelId), isNull(messages.deletedAt)];
  if (beforeId !== null) conditions.push(lt(messages.id, beforeId));
  const rows = await db
    .select({
      id: messages.id,
      channelId: messages.channelId,
      userId: messages.userId,
      body: messages.body,
      editedAt: messages.editedAt,
      deletedAt: messages.deletedAt,
      createdAt: messages.createdAt,
      displayName: users.displayName,
    })
    .from(messages)
    .innerJoin(users, eq(users.id, messages.userId))
    .where(and(...conditions))
    .orderBy(desc(messages.id))
    .limit(limit);
  const reactions = await hydrateReactions(rows.map((r) => r.id));
  return rows.map((r) => toDto(r, reactions));
}

export async function markRead(channelId: number, userId: number, messageId: number): Promise<void> {
  await db
    .update(channelMembers)
    .set({ lastReadMessageId: messageId })
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)));
}

export async function getUnreadCounts(userId: number): Promise<Record<number, number>> {
  const memberships = await db
    .select()
    .from(channelMembers)
    .where(eq(channelMembers.userId, userId));
  const result: Record<number, number> = {};
  for (const m of memberships) {
    const [row] = await db
      .select({ count: sql<number>`count(*)` })
      .from(messages)
      .where(
        and(
          eq(messages.channelId, m.channelId),
          gt(messages.id, m.lastReadMessageId),
          isNull(messages.deletedAt),
        ),
      );
    result[m.channelId] = Number(row.count);
  }
  return result;
}

export async function toggleReaction(
  messageId: number,
  userId: number,
  emoji: string,
): Promise<{ added: boolean }> {
  const [existing] = await db
    .select()
    .from(messageReactions)
    .where(
      and(
        eq(messageReactions.messageId, messageId),
        eq(messageReactions.userId, userId),
        eq(messageReactions.emoji, emoji),
      ),
    );
  if (existing) {
    await db
      .delete(messageReactions)
      .where(
        and(
          eq(messageReactions.messageId, messageId),
          eq(messageReactions.userId, userId),
          eq(messageReactions.emoji, emoji),
        ),
      );
    return { added: false };
  }
  await db.insert(messageReactions).values({ messageId, userId, emoji });
  return { added: true };
}

export async function editMessage(messageId: number, userId: number, body: string): Promise<boolean> {
  const [row] = await db.select({ userId: messages.userId }).from(messages).where(eq(messages.id, messageId));
  if (!row || row.userId !== userId) return false;
  await db.update(messages).set({ body, editedAt: new Date() }).where(eq(messages.id, messageId));
  return true;
}

export async function softDeleteMessage(messageId: number, userId: number): Promise<boolean> {
  const [row] = await db.select({ userId: messages.userId }).from(messages).where(eq(messages.id, messageId));
  if (!row || row.userId !== userId) return false;
  await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, messageId));
  return true;
}

export async function searchMessages(
  userId: number,
  isAdmin: boolean,
  query: string,
  channelId?: number,
): Promise<MessageWithAuthor[]> {
  const visWhere = isAdmin ? sql`1=1` : visibilityCondition(userId);
  const conditions = [
    sql`MATCH(${messages.body}) AGAINST(${query} IN NATURAL LANGUAGE MODE)`,
    isNull(messages.deletedAt),
    sql`messages.channel_id IN (SELECT channels.id FROM channels WHERE ${visWhere})`,
  ];
  if (channelId !== undefined) conditions.push(eq(messages.channelId, channelId));
  const rows = await db
    .select({
      id: messages.id,
      channelId: messages.channelId,
      userId: messages.userId,
      body: messages.body,
      editedAt: messages.editedAt,
      deletedAt: messages.deletedAt,
      createdAt: messages.createdAt,
      displayName: users.displayName,
    })
    .from(messages)
    .innerJoin(users, eq(users.id, messages.userId))
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt))
    .limit(50);
  const reactions = await hydrateReactions(rows.map((r) => r.id));
  return rows.map((r) => toDto(r, reactions));
}
```

- [ ] **Step 4: run** → PASS. **Step 5: Commit** — `feat(server): messageService — pagination, reactions, edit/delete, visibility-filtered search, unread counts`

### Task 6: channels/messages/dms routes — TDD (supertest)

**Files:**
- Rewrite: `server/src/routes/channels.ts`
- Create: `server/src/routes/dms.ts`
- Modify: `server/src/app.ts`
- Test: `server/src/routes/channels.test.ts`, `server/src/routes/dms.test.ts`

**Interfaces:**
- GET `/api/channels` (requireAuth) — visible channels + `unreadCount` merged in
- POST `/api/channels` — `{ name, isPrivate, topic?, departmentId? }`, creator = `req.auth.userId`
- GET `/api/channels/:id` — 404 if not visible
- PATCH `/api/channels/:id` — owner or admin; `{ name?, topic? }`
- POST/DELETE `/api/channels/:id/members` — owner or admin
- GET `/api/channels/:id/messages?before&limit` — 404 if not visible, else paginated
- POST `/api/channels/:id/read` — `{ messageId }`
- PATCH/DELETE `/api/messages/:id` — author-only (403 if not — this is an ownership check, not a visibility leak, so 403 is correct here per the "existence doesn't leak but ownership errors can be honest" distinction)
- PUT/DELETE `/api/messages/:id/reactions` — `{ emoji }`
- GET `/api/search/messages?q&channelId?`
- POST `/api/dms` — `{ userId }` → find-or-create

- [ ] **Step 1: failing tests** — `channels.test.ts`:

```ts
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { resetDb } from '../db/testUtils.js';
import { makeUser } from '../testHelpers.js';

const app = createApp();

describe('channel routes', () => {
  beforeEach(resetDb);

  it('creates a channel, lists it, and 404s a private one for outsiders', async () => {
    const owner = await makeUser(app, { email: 'owner@flowerstore.ph' });
    const outsider = await makeUser(app, { email: 'outsider@flowerstore.ph' });

    const create = await request(app)
      .post('/api/channels')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'secret', isPrivate: true });
    expect(create.status).toBe(201);
    const channelId = create.body.channel.id;

    expect(
      (await request(app).get(`/api/channels/${channelId}`).set('Authorization', `Bearer ${outsider.token}`))
        .status,
    ).toBe(404);
    expect(
      (await request(app).get(`/api/channels/${channelId}`).set('Authorization', `Bearer ${owner.token}`))
        .status,
    ).toBe(200);
    expect(
      (await request(app).get('/api/channels').set('Authorization', `Bearer ${outsider.token}`)).body.channels,
    ).toHaveLength(0);
  });

  it('sends via socket then reads history via REST, paginates, tracks unread', async () => {
    const owner = await makeUser(app, { email: 'owner2@flowerstore.ph' });
    const reader = await makeUser(app, { email: 'reader@flowerstore.ph' });
    const create = await request(app)
      .post('/api/channels')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'g', isPrivate: false });
    const channelId = create.body.channel.id;
    await request(app)
      .post(`/api/channels/${channelId}/members`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ userId: reader.userId });

    for (let i = 0; i < 3; i++) {
      await request(app)
        .post(`/api/channels/${channelId}/messages`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ body: `msg ${i}` })
        .expect(201);
    }

    const history = await request(app)
      .get(`/api/channels/${channelId}/messages?limit=2`)
      .set('Authorization', `Bearer ${reader.token}`);
    expect(history.status).toBe(200);
    expect(history.body.messages).toHaveLength(2);

    const list = await request(app).get('/api/channels').set('Authorization', `Bearer ${reader.token}`);
    const entry = list.body.channels.find((c: { id: number }) => c.id === channelId);
    expect(entry.unreadCount).toBe(3);

    const lastId = history.body.messages[0].id;
    await request(app)
      .post(`/api/channels/${channelId}/read`)
      .set('Authorization', `Bearer ${reader.token}`)
      .send({ messageId: lastId })
      .expect(200);
  });

  it('reactions toggle and search is visibility-filtered', async () => {
    const owner = await makeUser(app, { email: 'owner3@flowerstore.ph' });
    const outsider = await makeUser(app, { email: 'outsider3@flowerstore.ph' });
    const pub = await request(app)
      .post('/api/channels')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'pub', isPrivate: false });
    const priv = await request(app)
      .post('/api/channels')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'priv', isPrivate: true });

    const msg = await request(app)
      .post(`/api/channels/${pub.body.channel.id}/messages`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ body: 'unique-search-token here' });

    await request(app)
      .put(`/api/messages/${msg.body.message.id}/reactions`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ emoji: '🎉' })
      .expect(200);

    await request(app)
      .post(`/api/channels/${priv.body.channel.id}/messages`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ body: 'unique-search-token secret' });

    const results = await request(app)
      .get('/api/search/messages?q=unique-search-token')
      .set('Authorization', `Bearer ${outsider.token}`);
    expect(results.body.messages).toHaveLength(1);
    expect(results.body.messages[0].reactions).toEqual([{ emoji: '🎉', userIds: [owner.userId] }]);
  });
});
```

`dms.test.ts`:

```ts
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { resetDb } from '../db/testUtils.js';
import { makeUser } from '../testHelpers.js';

const app = createApp();

describe('dm routes', () => {
  beforeEach(resetDb);

  it('finds-or-creates a DM and is not visible to a third party', async () => {
    const a = await makeUser(app, { email: 'a@flowerstore.ph' });
    const b = await makeUser(app, { email: 'b@flowerstore.ph' });
    const c = await makeUser(app, { email: 'c@flowerstore.ph' });

    const r1 = await request(app).post('/api/dms').set('Authorization', `Bearer ${a.token}`).send({ userId: b.userId });
    const r2 = await request(app).post('/api/dms').set('Authorization', `Bearer ${b.token}`).send({ userId: a.userId });
    expect(r1.body.channel.id).toBe(r2.body.channel.id);

    expect(
      (await request(app).get(`/api/channels/${r1.body.channel.id}`).set('Authorization', `Bearer ${c.token}`))
        .status,
    ).toBe(404);
  });
});
```

- [ ] **Step 2: run** → FAIL. **Step 3: implement**

`routes/channels.ts` (full rewrite):

```ts
import { and, eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { channelMembers, channels } from '../db/schema/index.js';
import {
  addChannelMember,
  createChannel,
  getVisibleChannel,
  isChannelMember,
  listVisibleChannels,
  removeChannelMember,
} from '../services/channelService.js';
import {
  editMessage,
  getMessagesBefore,
  getUnreadCounts,
  markRead,
  searchMessages,
  sendMessage,
  softDeleteMessage,
  toggleReaction,
} from '../services/messageService.js';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';

export const channelsRouter = Router();
channelsRouter.use(requireAuth);

async function requireVisibleChannel(channelId: number, userId: number, isAdmin: boolean) {
  const channel = await getVisibleChannel(channelId, userId, isAdmin);
  if (!channel) throw new AppError(404, 'not_found', 'Not found');
  return channel;
}

async function requireOwnerOrAdmin(channelId: number, userId: number, isAdmin: boolean) {
  if (isAdmin) return;
  const [row] = await db
    .select()
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)));
  if (row?.role !== 'owner') throw new AppError(404, 'not_found', 'Not found');
}

channelsRouter.get('/', async (req, res) => {
  const isAdmin = req.auth!.role === 'admin';
  const [list, unread] = await Promise.all([
    listVisibleChannels(req.auth!.userId, isAdmin),
    getUnreadCounts(req.auth!.userId),
  ]);
  res.json({ channels: list.map((c) => ({ ...c, unreadCount: unread[c.id] ?? 0 })) });
});

const createBody = z.object({
  name: z.string().min(1).max(80),
  isPrivate: z.boolean(),
  topic: z.string().max(255).optional(),
  departmentId: z.number().int().positive().optional(),
});

channelsRouter.post('/', validate(createBody), async (req, res) => {
  const input = req.valid as z.infer<typeof createBody>;
  const channel = await createChannel({ ...input, createdBy: req.auth!.userId });
  res.status(201).json({ channel });
});

const idParams = z.object({ id: z.coerce.number().int().positive() });

channelsRouter.get('/:id', validate(idParams, 'params'), async (req, res) => {
  const { id } = req.valid as z.infer<typeof idParams>;
  const channel = await requireVisibleChannel(id, req.auth!.userId, req.auth!.role === 'admin');
  res.json({ channel });
});

const patchBody = z.object({
  name: z.string().min(1).max(80).optional(),
  topic: z.string().max(255).nullable().optional(),
});

channelsRouter.patch('/:id', validate(idParams, 'params'), validate(patchBody), async (req, res) => {
  const { id } = req.valid as z.infer<typeof idParams>;
  await requireVisibleChannel(id, req.auth!.userId, req.auth!.role === 'admin');
  await requireOwnerOrAdmin(id, req.auth!.userId, req.auth!.role === 'admin');
  await db.update(channels).set(req.body).where(eq(channels.id, id));
  const channel = await getVisibleChannel(id, req.auth!.userId, true);
  res.json({ channel });
});

const memberBody = z.object({ userId: z.number().int().positive() });

channelsRouter.post('/:id/members', validate(idParams, 'params'), validate(memberBody), async (req, res) => {
  const { id } = req.valid as z.infer<typeof idParams>;
  await requireVisibleChannel(id, req.auth!.userId, req.auth!.role === 'admin');
  await requireOwnerOrAdmin(id, req.auth!.userId, req.auth!.role === 'admin');
  await addChannelMember(id, (req.valid as z.infer<typeof memberBody>).userId);
  res.status(201).json({ ok: true });
});

const memberParams = z.object({ id: z.coerce.number().int().positive(), userId: z.coerce.number().int().positive() });

channelsRouter.delete('/:id/members/:userId', validate(memberParams, 'params'), async (req, res) => {
  const { id, userId } = req.valid as z.infer<typeof memberParams>;
  await requireVisibleChannel(id, req.auth!.userId, req.auth!.role === 'admin');
  await requireOwnerOrAdmin(id, req.auth!.userId, req.auth!.role === 'admin');
  await removeChannelMember(id, userId);
  res.json({ ok: true });
});

const historyQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

channelsRouter.get('/:id/messages', validate(idParams, 'params'), validate(historyQuery, 'query'), async (req, res) => {
  const { id } = req.valid as z.infer<typeof idParams>;
  await requireVisibleChannel(id, req.auth!.userId, req.auth!.role === 'admin');
  const { before, limit } = req.valid as z.infer<typeof historyQuery>;
  const list = await getMessagesBefore(id, before ?? null, limit);
  res.json({ messages: list });
});

const sendBody = z.object({ body: z.string().min(1).max(4000) });

channelsRouter.post('/:id/messages', validate(idParams, 'params'), validate(sendBody), async (req, res) => {
  const { id } = req.valid as z.infer<typeof idParams>;
  await requireVisibleChannel(id, req.auth!.userId, req.auth!.role === 'admin');
  if (!(await isChannelMember(id, req.auth!.userId)) && req.auth!.role !== 'admin') {
    throw new AppError(404, 'not_found', 'Not found');
  }
  const message = await sendMessage(id, req.auth!.userId, (req.valid as z.infer<typeof sendBody>).body);
  res.status(201).json({ message });
});

const readBody = z.object({ messageId: z.number().int().positive() });

channelsRouter.post('/:id/read', validate(idParams, 'params'), validate(readBody), async (req, res) => {
  const { id } = req.valid as z.infer<typeof idParams>;
  await requireVisibleChannel(id, req.auth!.userId, req.auth!.role === 'admin');
  await markRead(id, req.auth!.userId, (req.valid as z.infer<typeof readBody>).messageId);
  res.json({ ok: true });
});

export const messagesRouter = Router();
messagesRouter.use(requireAuth);

const msgParams = z.object({ id: z.coerce.number().int().positive() });
const editBody = z.object({ body: z.string().min(1).max(4000) });

messagesRouter.patch('/:id', validate(msgParams, 'params'), validate(editBody), async (req, res) => {
  const { id } = req.valid as z.infer<typeof msgParams>;
  const ok = await editMessage(id, req.auth!.userId, (req.valid as z.infer<typeof editBody>).body);
  if (!ok) throw new AppError(403, 'forbidden', 'Only the author can edit this message');
  res.json({ ok: true });
});

messagesRouter.delete('/:id', validate(msgParams, 'params'), async (req, res) => {
  const { id } = req.valid as z.infer<typeof msgParams>;
  const ok = await softDeleteMessage(id, req.auth!.userId);
  if (!ok) throw new AppError(403, 'forbidden', 'Only the author can delete this message');
  res.json({ ok: true });
});

const reactionBody = z.object({ emoji: z.string().min(1).max(32) });

messagesRouter.put('/:id/reactions', validate(msgParams, 'params'), validate(reactionBody), async (req, res) => {
  const { id } = req.valid as z.infer<typeof msgParams>;
  const result = await toggleReaction(id, req.auth!.userId, (req.valid as z.infer<typeof reactionBody>).emoji);
  res.json(result);
});

export const searchRouter = Router();
searchRouter.use(requireAuth);

const searchQuery = z.object({ q: z.string().min(1).max(200), channelId: z.coerce.number().int().positive().optional() });

searchRouter.get('/messages', validate(searchQuery, 'query'), async (req, res) => {
  const { q, channelId } = req.valid as z.infer<typeof searchQuery>;
  const results = await searchMessages(req.auth!.userId, req.auth!.role === 'admin', q, channelId);
  res.json({ messages: results });
});
```

`routes/dms.ts`:

```ts
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { findOrCreateDm } from '../services/channelService.js';

export const dmsRouter = Router();
dmsRouter.use(requireAuth);

const dmBody = z.object({ userId: z.number().int().positive() });

dmsRouter.post('/', validate(dmBody), async (req, res) => {
  const { userId } = req.valid as z.infer<typeof dmBody>;
  const channel = await findOrCreateDm(req.auth!.userId, userId);
  res.status(201).json({ channel });
});
```

`app.ts`: replace the old `import { channelsRouter } from './routes/channels.js';` mount with:

```ts
import { channelsRouter, messagesRouter, searchRouter } from './routes/channels.js';
import { dmsRouter } from './routes/dms.js';
// ...
app.use('/api/channels', channelsRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/search', searchRouter);
app.use('/api/dms', dmsRouter);
```

- [ ] **Step 4: run** → PASS. **Step 5: Commit** — `feat(server): channel/message/dm/search routes with visibility enforcement and reactions`

### Task 7: socket handlers — membership-gated join, live send/reactions/typing

**Files:**
- Rewrite: `server/src/sockets/chatHandlers.ts`
- Test: extend `server/src/sockets/socketAuth.test.ts` → rename mentally, add cases (same file, new `describe` block)

**Interfaces:**
- `channel:join` — verifies `getVisibleChannel` first; refuses (no-op, emits nothing) if not visible
- `message:send { channelId, body }` + ack — calls `messageService.sendMessage`, broadcasts `message:new` to `channel:<id>`
- `message:reaction { messageId, channelId, emoji }` + ack — calls `toggleReaction`, broadcasts `message:reaction` to `channel:<id>`
- `typing:start` / `typing:stop { channelId }` — broadcast `typing { channelId, userId, isTyping }` to the room, excluding sender

- [ ] **Step 1: add tests to `socketAuth.test.ts`** (append a new `describe`):

```ts
describe('chat socket handlers', () => {
  beforeEach(resetDb);

  it('join is refused for a private channel the user cannot see; send/reactions/typing work for visible ones', async () => {
    const [{ id: memberId }] = await db
      .insert(users)
      .values({ email: 'member@flowerstore.ph', passwordHash: 'x', displayName: 'Member' })
      .$returningId();
    const [{ id: outsiderId }] = await db
      .insert(users)
      .values({ email: 'outsider@flowerstore.ph', passwordHash: 'x', displayName: 'Outsider' })
      .$returningId();
    const { createChannel } = await import('../services/channelService.js');
    const chan = await createChannel({ name: 'priv', isPrivate: true, createdBy: memberId });

    const memberToken = await signAccessToken({ id: memberId, role: 'member' });
    const outsiderToken = await signAccessToken({ id: outsiderId, role: 'member' });
    const memberSocket = connect(memberToken);
    const outsiderSocket = connect(outsiderToken);
    await Promise.all([
      new Promise<void>((r) => memberSocket.on('connect', () => r())),
      new Promise<void>((r) => outsiderSocket.on('connect', () => r())),
    ]);

    memberSocket.emit('channel:join', chan.id);
    outsiderSocket.emit('channel:join', chan.id); // should silently not join the room

    const received: unknown[] = [];
    outsiderSocket.on('message:new', (m) => received.push(m));
    const ack = await memberSocket.emitWithAck('message:send', { channelId: chan.id, body: 'secret msg' });
    expect(ack.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(0); // outsider never joined the room, never receives it

    const reactAck = await memberSocket.emitWithAck('message:reaction', {
      messageId: ack.message.id,
      channelId: chan.id,
      emoji: '👍',
    });
    expect(reactAck.ok).toBe(true);

    memberSocket.disconnect();
    outsiderSocket.disconnect();
  });
});
```

- [ ] **Step 2: run** → FAIL. **Step 3: implement** — `sockets/chatHandlers.ts`:

```ts
import type { Server, Socket } from 'socket.io';
import { getVisibleChannel } from '../services/channelService.js';
import { logger } from '../logger.js';
import { sendMessage, toggleReaction } from '../services/messageService.js';

interface SendPayload {
  channelId: number;
  body: string;
}

interface ReactionPayload {
  messageId: number;
  channelId: number;
  emoji: string;
}

type Ack = (result: { ok: boolean; error?: string; [key: string]: unknown }) => void;

export function registerChatHandlers(io: Server, socket: Socket): void {
  socket.on('channel:join', async (channelId: number) => {
    const isAdmin = socket.data.role === 'admin';
    const channel = await getVisibleChannel(channelId, socket.data.userId, isAdmin);
    if (!channel) return; // silently refuse — no existence leak
    socket.join(`channel:${channelId}`);
  });

  socket.on('channel:leave', (channelId: number) => {
    socket.leave(`channel:${channelId}`);
  });

  socket.on('message:send', async (payload: SendPayload, ack?: Ack) => {
    const userId = socket.data.userId as number;
    try {
      const message = await sendMessage(payload.channelId, userId, payload.body);
      io.to(`channel:${payload.channelId}`).emit('message:new', message);
      ack?.({ ok: true, message });
    } catch (err) {
      logger.error({ err }, 'message:send failed');
      ack?.({ ok: false, error: err instanceof Error ? err.message : 'send failed' });
    }
  });

  socket.on('message:reaction', async (payload: ReactionPayload, ack?: Ack) => {
    const userId = socket.data.userId as number;
    try {
      const result = await toggleReaction(payload.messageId, userId, payload.emoji);
      io.to(`channel:${payload.channelId}`).emit('message:reaction', {
        messageId: payload.messageId,
        userId,
        emoji: payload.emoji,
        added: result.added,
      });
      ack?.({ ok: true, ...result });
    } catch (err) {
      ack?.({ ok: false, error: err instanceof Error ? err.message : 'reaction failed' });
    }
  });

  socket.on('typing:start', (channelId: number) => {
    socket.to(`channel:${channelId}`).emit('typing', { channelId, userId: socket.data.userId, isTyping: true });
  });

  socket.on('typing:stop', (channelId: number) => {
    socket.to(`channel:${channelId}`).emit('typing', { channelId, userId: socket.data.userId, isTyping: false });
  });
}
```

- [ ] **Step 4: run** → PASS. **Step 5: Commit** — `feat(server): socket chat handlers — membership-gated join, reactions, typing indicator`

### Task 8: frontend socket/query wiring for chat

**Files:**
- Modify: `src/lib/socket.ts` (extend event types, add reaction/typing emitters)
- Create: `src/features/chat/api.ts` (REST calls)
- Create: `src/features/chat/types.ts`

**Interfaces:**
- `types.ts`: `Channel { id, name, type, isPrivate, topic, departmentId, unreadCount }`, `Message { id, channelId, userId, displayName, body, editedAt, deletedAt, createdAt, reactions }`
- `api.ts`: `listChannels()`, `createChannel(input)`, `getChannel(id)`, `getMessages(channelId, before?, limit?)`, `markRead(channelId, messageId)`, `createDm(userId)`, `searchMessages(q, channelId?)`, `toggleReactionRest(messageId, emoji)` (REST fallback path, socket is primary), `editMessageRest`, `deleteMessageRest`
- `socket.ts` additions: `joinTyping(channelId)`/`stopTyping(channelId)`, `sendReaction(messageId, channelId, emoji)`, `onReaction(handler)`, `onTyping(handler)`, and connect the socket once authenticated (call `getSocket().connect()` after login/bootstrap succeeds, `disconnect()` on logout)

- [ ] **Step 1: `src/features/chat/types.ts`**

```ts
export interface Channel {
  id: number;
  name: string | null;
  type: 'public' | 'private' | 'dm';
  isPrivate: boolean;
  topic: string | null;
  departmentId: number | null;
  unreadCount: number;
}

export interface Reaction {
  emoji: string;
  userIds: number[];
}

export interface Message {
  id: number;
  channelId: number;
  userId: number;
  displayName: string;
  body: string;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  reactions: Reaction[];
}
```

- [ ] **Step 2: `src/features/chat/api.ts`**

```ts
import { api } from '@/lib/api';
import type { Channel, Message } from './types';

export const listChannels = () => api<{ channels: Channel[] }>('/api/channels');

export const createChannel = (input: { name: string; isPrivate: boolean; topic?: string; departmentId?: number }) =>
  api<{ channel: Channel }>('/api/channels', { method: 'POST', body: input });

export const getChannel = (id: number) => api<{ channel: Channel }>(`/api/channels/${id}`);

export const getMessages = (channelId: number, before?: number, limit = 50) => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before) params.set('before', String(before));
  return api<{ messages: Message[] }>(`/api/channels/${channelId}/messages?${params}`);
};

export const markRead = (channelId: number, messageId: number) =>
  api(`/api/channels/${channelId}/read`, { method: 'POST', body: { messageId } });

export const createDm = (userId: number) => api<{ channel: Channel }>('/api/dms', { method: 'POST', body: { userId } });

export const searchMessages = (q: string, channelId?: number) => {
  const params = new URLSearchParams({ q });
  if (channelId) params.set('channelId', String(channelId));
  return api<{ messages: Message[] }>(`/api/search/messages?${params}`);
};

export const editMessageRest = (id: number, body: string) =>
  api(`/api/messages/${id}`, { method: 'PATCH', body: { body } });

export const deleteMessageRest = (id: number) => api(`/api/messages/${id}`, { method: 'DELETE' });
```

- [ ] **Step 3: extend `src/lib/socket.ts`** — add after the existing exports:

```ts
export function joinChannelRoom(channelId: number): void {
  getSocket().emit('channel:join', channelId);
}

export function startTyping(channelId: number): void {
  getSocket().emit('typing:start', channelId);
}

export function stopTyping(channelId: number): void {
  getSocket().emit('typing:stop', channelId);
}

export function sendReaction(
  messageId: number,
  channelId: number,
  emoji: string,
): Promise<{ ok: boolean; added?: boolean; error?: string }> {
  return getSocket().emitWithAck('message:reaction', { messageId, channelId, emoji });
}

export function onReaction(
  handler: (e: { messageId: number; userId: number; emoji: string; added: boolean }) => void,
): () => void {
  const s = getSocket();
  s.on('message:reaction', handler);
  return () => s.off('message:reaction', handler);
}

export function onTyping(
  handler: (e: { channelId: number; userId: number; isTyping: boolean }) => void,
): () => void {
  const s = getSocket();
  s.on('typing', handler);
  return () => s.off('typing', handler);
}

export function connectSocket(): void {
  getSocket().connect();
}

export function disconnectSocket(): void {
  getSocket().disconnect();
}
```

Note: `joinChannel`/`leaveChannel` already exist from earlier phases and remain unchanged (they call `channel:join`/`channel:leave` — `joinChannelRoom` above is redundant with `joinChannel`; **use the existing `joinChannel` export, do not duplicate it** — skip adding `joinChannelRoom` in the actual implementation).

- [ ] **Step 4: wire connect/disconnect to auth lifecycle** — in `src/features/auth/api.ts`, import `connectSocket, disconnectSocket` from `@/lib/socket`; call `connectSocket()` at the end of `adopt()` and at the end of `bootstrapAuth()` when `ok` is true; call `disconnectSocket()` at the start of `logoutUser()`.

- [ ] **Step 5:** `npm run build` → clean. **Commit** — `feat(web): chat REST client, socket typing/reaction helpers, connect socket on auth`

### Task 9: Slack-replica sidebar shell + quick-switcher

**Files:**
- Rewrite: `src/app/AppLayout.tsx`
- Create: `src/features/chat/Sidebar.tsx`, `src/features/chat/QuickSwitcher.tsx`
- shadcn: `npx shadcn@latest add command scroll-area separator avatar`

**Interfaces:**
- `AppLayout` becomes a flex row: `<Sidebar />` + `<main><Outlet/></main>`; mounts a global `Ctrl+K` / `Cmd+K` listener opening `QuickSwitcher`
- `Sidebar`: TanStack Query on `listChannels()` + `/api/departments` + `/api/users` (for DM target list from Phase 1), grouped sections — Departments (channels grouped by `departmentId`), Channels (no department), Direct Messages (derive from... there's no "list my DMs" endpoint yet: **add one** — see Step 0 below). Unread channels render bold with a badge count.
- `QuickSwitcher`: `Dialog` + `Command` (shadcn cmdk wrapper) — fuzzy-filters channel names + user display names; Enter navigates to `/chat/:id`.

- [ ] **Step 0 (small backend addition, not a separate task): "my DMs" list.** Add to `channelService.ts`:

```ts
export async function listMyDms(userId: number) {
  return db
    .select({ id: channels.id, dmKey: channels.dmKey })
    .from(channels)
    .innerJoin(channelMembers, eq(channelMembers.channelId, channels.id))
    .where(and(eq(channels.type, 'dm'), eq(channelMembers.userId, userId)));
}
```

and in `routes/dms.ts` add:

```ts
dmsRouter.get('/', async (req, res) => {
  const dms = await listMyDms(req.auth!.userId);
  res.json({ dms });
});
```

Add a one-line test in `dms.test.ts` (`GET /api/dms` returns the created DM's id for participant a, empty for a third party) and re-run `npm test` before continuing to the frontend.

- [ ] **Step 1:** `npx shadcn@latest add command scroll-area separator avatar`

- [ ] **Step 2: `src/features/chat/Sidebar.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ScrollArea } from '@/components/ui/scroll-area';
import { api } from '@/lib/api';
import { useAuthStore } from '@/features/auth/authStore';
import type { PublicUser } from '@/features/auth/authStore';
import { listChannels } from './api';

interface Department {
  id: number;
  name: string;
}

export function Sidebar() {
  const user = useAuthStore((s) => s.user);
  const { channelId } = useParams();
  const { data: channelData } = useQuery({ queryKey: ['channels'], queryFn: listChannels, refetchInterval: 15_000 });
  const { data: deptData } = useQuery({
    queryKey: ['departments'],
    queryFn: () => api<{ departments: Department[] }>('/api/departments'),
  });

  const channels = channelData?.channels ?? [];
  const departments = deptData?.departments ?? [];
  const grouped = departments.map((d) => ({ dept: d, channels: channels.filter((c) => c.departmentId === d.id) }));
  const orgWide = channels.filter((c) => c.departmentId === null && c.type !== 'dm');

  return (
    <aside className="flex h-dvh w-64 flex-col bg-[#3f0e40] text-white">
      <div className="border-b border-white/10 p-4 font-semibold">FS Internal System</div>
      <ScrollArea className="flex-1 px-2 py-2">
        <SidebarSection title="Channels">
          {orgWide.map((c) => (
            <ChannelLink key={c.id} channel={c} active={String(c.id) === channelId} />
          ))}
        </SidebarSection>
        {grouped.map(({ dept, channels: deptChannels }) => (
          <SidebarSection key={dept.id} title={dept.name}>
            {deptChannels.map((c) => (
              <ChannelLink key={c.id} channel={c} active={String(c.id) === channelId} />
            ))}
          </SidebarSection>
        ))}
      </ScrollArea>
      <div className="border-t border-white/10 p-3 text-sm">{user?.displayName}</div>
    </aside>
  );
}

function SidebarSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-white/50">{title}</div>
      {children}
    </div>
  );
}

function ChannelLink({
  channel,
  active,
}: {
  channel: { id: number; name: string | null; unreadCount: number };
  active: boolean;
}) {
  const unread = channel.unreadCount > 0;
  return (
    <Link
      to={`/chat/${channel.id}`}
      className={`flex items-center justify-between rounded px-2 py-1 text-sm hover:bg-white/10 ${
        active ? 'bg-white/20' : ''
      } ${unread ? 'font-bold' : 'text-white/80'}`}
    >
      <span># {channel.name}</span>
      {unread && (
        <span className="rounded-full bg-red-500 px-1.5 text-xs font-semibold">{channel.unreadCount}</span>
      )}
    </Link>
  );
}
```

- [ ] **Step 3: `src/features/chat/QuickSwitcher.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import type { PublicUser } from '@/features/auth/authStore';
import { api } from '@/lib/api';
import { createDm, listChannels } from './api';

export function QuickSwitcher({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const navigate = useNavigate();
  const { data: channelData } = useQuery({ queryKey: ['channels'], queryFn: listChannels, enabled: open });
  const { data: userData } = useQuery({
    queryKey: ['users'],
    queryFn: () => api<{ users: PublicUser[] }>('/api/users'),
    enabled: open,
  });

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Jump to a channel or person…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Channels">
          {channelData?.channels
            .filter((c) => c.type !== 'dm')
            .map((c) => (
              <CommandItem
                key={c.id}
                value={c.name ?? ''}
                onSelect={() => {
                  navigate(`/chat/${c.id}`);
                  onOpenChange(false);
                }}
              >
                # {c.name}
              </CommandItem>
            ))}
        </CommandGroup>
        <CommandGroup heading="People">
          {userData?.users.map((u) => (
            <CommandItem
              key={u.id}
              value={u.displayName}
              onSelect={async () => {
                const { channel } = await createDm(u.id);
                navigate(`/chat/${channel.id}`);
                onOpenChange(false);
              }}
            >
              {u.displayName}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
```

- [ ] **Step 4: rewrite `AppLayout.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { Outlet } from 'react-router';
import { Sidebar } from '@/features/chat/Sidebar';
import { QuickSwitcher } from '@/features/chat/QuickSwitcher';

export function AppLayout() {
  const [switcherOpen, setSwitcherOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSwitcherOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="flex h-dvh bg-background text-foreground">
      <Sidebar />
      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
      <QuickSwitcher open={switcherOpen} onOpenChange={setSwitcherOpen} />
    </div>
  );
}
```

- [ ] **Step 5:** `npm run build` → clean; manual check deferred to Task 11 gate. **Commit** — `feat(web): Slack-replica sidebar (department sections, unread badges) + Ctrl+K quick-switcher`

### Task 10: ChannelPage — reverse-infinite-scroll chat + composer + reactions + typing

**Files:**
- Create: `src/features/chat/ChannelPage.tsx`, `MessageList.tsx`, `MessageItem.tsx`, `MessageInput.tsx`, `TypingIndicator.tsx`
- Modify: `src/app/router.tsx` (add `/chat/:channelId` and `/chat` index)
- Modify: `src/features/home/HomePage.tsx` — becomes a redirect stub (or delete route usage; simplest: `router.tsx` sends `/` to `/chat`)

**Interfaces:**
- `ChannelPage`: reads `:channelId` param, `useInfiniteQuery(['messages', channelId], ...)` with `getMessages`, `getNextPageParam` = oldest message id of the last page (or undefined if page shorter than limit); joins the socket room on mount (`joinChannel`), subscribes `onNewMessage`/`onReaction`/`onTyping`, unsubscribes on unmount/channel change; marks read on new-message-at-bottom via `markRead`.
- `MessageInput`: controlled textarea, Enter-to-send (Shift+Enter newline), calls `sendMessage` from `@/lib/socket` (optimistic: append immediately, reconcile on ack), emits `startTyping`/`stopTyping` on keystroke with a 3s debounce-to-stop.
- `MessageItem`: renders author/time/body, reaction chips (click toggles via `sendReaction`), hover actions for the message's own author (edit/delete via REST).

- [ ] **Step 1: `TypingIndicator.tsx`**

```tsx
export function TypingIndicator({ names }: { names: string[] }) {
  if (names.length === 0) return <div className="h-5" />;
  const text = names.length === 1 ? `${names[0]} is typing…` : `${names.join(', ')} are typing…`;
  return <div className="h-5 px-4 text-xs text-muted-foreground">{text}</div>;
}
```

- [ ] **Step 2: `MessageItem.tsx`**

```tsx
import { useAuthStore } from '@/features/auth/authStore';
import { sendReaction } from '@/lib/socket';
import { deleteMessageRest } from './api';
import type { Message } from './types';

export function MessageItem({ message, onDeleted }: { message: Message; onDeleted: (id: number) => void }) {
  const me = useAuthStore((s) => s.user);
  const isAuthor = me?.id === message.userId;

  return (
    <div className="group flex gap-3 px-4 py-1.5 hover:bg-muted/50">
      <div className="flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold">{message.displayName}</span>
          <span className="text-xs text-muted-foreground">
            {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
          {message.editedAt && <span className="text-xs text-muted-foreground">(edited)</span>}
        </div>
        <p className="whitespace-pre-wrap text-sm">{message.body}</p>
        {message.reactions.length > 0 && (
          <div className="mt-1 flex gap-1">
            {message.reactions.map((r) => (
              <button
                key={r.emoji}
                type="button"
                className="rounded-full border px-2 py-0.5 text-xs hover:bg-accent"
                onClick={() => sendReaction(message.id, message.channelId, r.emoji)}
              >
                {r.emoji} {r.userIds.length}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="hidden gap-1 group-hover:flex">
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={() => sendReaction(message.id, message.channelId, '👍')}
        >
          👍
        </button>
        {isAuthor && (
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-destructive"
            onClick={async () => {
              await deleteMessageRest(message.id);
              onDeleted(message.id);
            }}
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: `MessageInput.tsx`**

```tsx
import { useRef, useState } from 'react';
import { sendMessage as sendSocketMessage, startTyping, stopTyping } from '@/lib/socket';

export function MessageInput({ channelId, onSent }: { channelId: number; onSent: () => void }) {
  const [value, setValue] = useState('');
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleChange(v: string) {
    setValue(v);
    startTyping(channelId);
    if (typingTimeout.current) clearTimeout(typingTimeout.current);
    typingTimeout.current = setTimeout(() => stopTyping(channelId), 3000);
  }

  async function send() {
    const body = value.trim();
    if (!body) return;
    setValue('');
    stopTyping(channelId);
    await sendSocketMessage({ channelId, body });
    onSent();
  }

  return (
    <div className="border-t p-3">
      <textarea
        className="w-full resize-none rounded-md border bg-background p-2 text-sm outline-none focus:ring-1 focus:ring-ring"
        rows={2}
        value={value}
        placeholder="Message…"
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      />
    </div>
  );
}
```

- [ ] **Step 4: `MessageList.tsx`**

```tsx
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { onNewMessage, onReaction } from '@/lib/socket';
import { getMessages } from './api';
import { MessageItem } from './MessageItem';
import type { Message } from './types';

export function MessageList({ channelId }: { channelId: number }) {
  const queryClient = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);
  const key = ['messages', channelId];

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => getMessages(channelId, pageParam as number | undefined),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.messages.length === 50 ? lastPage.messages[lastPage.messages.length - 1].id : undefined,
  });

  useEffect(() => {
    const offNew = onNewMessage((m) => {
      if (m.channelId !== channelId) return;
      queryClient.setQueryData(key, (old: { pages: { messages: Message[] }[]; pageParams: unknown[] } | undefined) => {
        if (!old) return old;
        const pages = [...old.pages];
        pages[0] = { messages: [m as unknown as Message, ...pages[0].messages] };
        return { ...old, pages };
      });
    });
    const offReaction = onReaction((e) => {
      queryClient.setQueryData(key, (old: { pages: { messages: Message[] }[]; pageParams: unknown[] } | undefined) => {
        if (!old) return old;
        const pages = old.pages.map((p) => ({
          messages: p.messages.map((m) => {
            if (m.id !== e.messageId) return m;
            const reactions = [...m.reactions];
            const idx = reactions.findIndex((r) => r.emoji === e.emoji);
            if (e.added) {
              if (idx === -1) reactions.push({ emoji: e.emoji, userIds: [e.userId] });
              else reactions[idx] = { ...reactions[idx], userIds: [...reactions[idx].userIds, e.userId] };
            } else if (idx !== -1) {
              const userIds = reactions[idx].userIds.filter((id) => id !== e.userId);
              if (userIds.length === 0) reactions.splice(idx, 1);
              else reactions[idx] = { ...reactions[idx], userIds };
            }
            return { ...m, reactions };
          }),
        }));
        return { ...old, pages };
      });
    });
    return () => {
      offNew();
      offReaction();
    };
  }, [channelId, queryClient]);

  const messages = data?.pages.flatMap((p) => p.messages) ?? [];
  // messages arrive newest-first per page; reverse for top-to-bottom display
  const ordered = [...messages].reverse();

  return (
    <div ref={scrollRef} className="flex h-full flex-col-reverse overflow-y-auto">
      <div>
        {ordered.map((m) => (
          <MessageItem
            key={m.id}
            message={m}
            onDeleted={(id) =>
              queryClient.setQueryData(key, (old: { pages: { messages: Message[] }[] } | undefined) => {
                if (!old) return old;
                return { ...old, pages: old.pages.map((p) => ({ messages: p.messages.filter((m2) => m2.id !== id) })) };
              })
            }
          />
        ))}
        {hasNextPage && (
          <button
            type="button"
            className="mx-auto my-2 block text-xs text-muted-foreground underline"
            disabled={isFetchingNextPage}
            onClick={() => fetchNextPage()}
          >
            {isFetchingNextPage ? 'Loading…' : 'Load older messages'}
          </button>
        )}
      </div>
    </div>
  );
}
```

(`flex-col-reverse` gives natural bottom-anchored scroll without manual scroll-position math — the simplest correct approach for v1; a manual "load older, preserve scroll offset" upgrade is a documented follow-up, not required for this phase's gate.)

- [ ] **Step 5: `ChannelPage.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { joinChannel, leaveChannel, onTyping } from '@/lib/socket';
import { useAuthStore } from '@/features/auth/authStore';
import { getChannel } from './api';
import { MessageInput } from './MessageInput';
import { MessageList } from './MessageList';
import { TypingIndicator } from './TypingIndicator';

export function ChannelPage() {
  const { channelId } = useParams();
  const id = Number(channelId);
  const me = useAuthStore((s) => s.user);
  const { data } = useQuery({ queryKey: ['channel', id], queryFn: () => getChannel(id), enabled: Number.isFinite(id) });
  const [typingUsers, setTypingUsers] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!Number.isFinite(id)) return;
    joinChannel(id);
    const off = onTyping((e) => {
      if (e.channelId !== id || e.userId === me?.id) return;
      setTypingUsers((prev) => {
        const next = { ...prev };
        if (e.isTyping) next[e.userId] = String(e.userId);
        else delete next[e.userId];
        return next;
      });
    });
    return () => {
      off();
      leaveChannel(id);
    };
  }, [id, me?.id]);

  if (!Number.isFinite(id)) return null;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b px-4 py-3">
        <h2 className="font-semibold"># {data?.channel.name ?? '…'}</h2>
        {data?.channel.topic && <p className="text-xs text-muted-foreground">{data.channel.topic}</p>}
      </header>
      <div className="min-h-0 flex-1">
        <MessageList channelId={id} />
      </div>
      <TypingIndicator names={Object.values(typingUsers)} />
      <MessageInput channelId={id} onSent={() => {}} />
    </div>
  );
}
```

- [ ] **Step 6: router wiring** — `router.tsx`: replace `{ path: '/', element: <HomePage /> }` with:

```tsx
import { Navigate } from 'react-router';
import { ChannelPage } from '@/features/chat/ChannelPage';
// ...
{ path: '/', element: <Navigate to="/chat" replace /> },
{ path: '/chat', element: <div className="flex h-full items-center justify-center text-muted-foreground">Select a channel</div> },
{ path: '/chat/:channelId', element: <ChannelPage /> },
```

Keep `HomePage.tsx` in the tree unused, or delete it and its import — since `/` now redirects, delete the `HomePage` route entry and the file's usage (leave the sign-out affordance; move a minimal "sign out" button into the sidebar footer instead — extend `Sidebar.tsx`'s footer div with a sign-out button using `logoutUser` from `@/features/auth/api`, mirroring what `HomePage` did). Delete `src/features/home/HomePage.tsx` once its logic (admin link, sign out) is folded into the sidebar footer.

- [ ] **Step 7:** `npm run build` → clean. **Commit** — `feat(web): channel page — reverse-infinite-scroll history, optimistic send, live reactions, typing indicator`

### Task 11: Phase gate — full verification + finish

- [ ] `cd server && npm test` → all suites green (existing 31 + new channel/message/dm/socket/cache/event tests)
- [ ] `npm run build` in `server/` and root → clean; `npm run lint` clean
- [ ] `docker build server/` → succeeds
- [ ] Restart PM2 (`npx pm2 restart fs-internal-system fs-internal-server --update-env`) and manually verify against the real dev servers:
  - two browser profiles (or incognito), two different users: post a message in a shared channel, confirm real-time delivery in the other tab within ~1s
  - react to a message from tab A, confirm the reaction chip appears live in tab B
  - type in the composer in tab A, confirm "X is typing…" appears in tab B and clears after ~3s of inactivity
  - create a private channel as user A, confirm user B does NOT see it in the sidebar or quick-switcher, and a direct API `GET /api/channels/:id` as B returns 404
  - create a department, add a channel under it, add a user to the department via admin UI → confirm that channel appears in their sidebar automatically
  - DM user B from the quick-switcher, send a message, confirm B sees it show up under their own DM list (requires reload or the existing 15s channel-list refetch interval — acceptable for v1)
  - reload mid-conversation → unread badge reflects true unread count; scroll up → older messages load without duplicating or skipping
  - search for a word that only exists in a private channel as a non-member → confirm it does not appear in results; as the member/admin it does
- [ ] Update memory (mark Phase 2 complete, note any deferred follow-ups), then use **superpowers:finishing-a-development-branch** to push + open a PR (same flow as Phase 1)

## Deviations / notes for the implementer

- Drizzle's mysql dialect doesn't have a FULLTEXT column helper — Task 1 Step 5 hand-writes the migration SQL; this is a documented, supported drizzle-kit workflow (`--custom` flag generates an empty migration + journal entry to fill in).
- `onDuplicateKeyUpdate({ set: { role: sql\`role\` } })` is the established "insert-or-ignore" idiom from Phase 1 — reuse it, don't reinvent.
- The `visibilityCondition` SQL fragment must be reused literally by both `channelService` (list/get) and `messageService` (search) and the socket `channel:join` handler — resist the temptation to write a second version "for messages"; that duplication is exactly how a privacy leak sneaks in later.
- `flex-col-reverse` for the message list is a deliberate v1 simplification flagged in the master plan's risk list (reverse-infinite-scroll is "the fiddliest UI"); don't over-invest in scroll-anchoring math this phase.
