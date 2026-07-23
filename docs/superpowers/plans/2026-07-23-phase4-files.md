# Phase 4: File Uploads & Attachments — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upload files, attach them to messages/tasks/docs, and view/download them — with a storage abstraction that runs on local disk today and swaps to S3 without touching a single caller.

**Architecture:** A `StorageDriver` interface (`put`, `getStream` for local / `getSignedGetUrl` for S3, `delete`) picked once at boot from `config.STORAGE_DRIVER`. Uploads land as unlinked `attachments` rows via `POST /api/uploads`; the client then references those ids when sending a message or patching a task/doc, and the server links them (verifying the uploader owns the row). `GET /api/files/:id` authorizes via the linked parent's own visibility rule (message → channel visibility; task/doc → project visibility) — consistent with the platform-wide rule established in every prior phase: **invisible → 404, never a leaked 403** (this deliberately supersedes the master plan's literal wording of "403", to stay consistent with the pattern every other phase in this codebase already follows).

**Tech Stack:** `multer` (memory storage) ^2.2.0, `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (verified against the official aws-sdk-js-v3 READMEs, 2026-07-23) for the S3 driver; local driver uses `node:fs/promises`.

## Global Constraints

- Mime whitelist includes office formats from day one (docx/xlsx/pptx/odt/ods/odp/csv/pdf) plus common images (png/jpg/jpeg/gif/webp) so Phase 9's office previews are additive, not a schema change.
- Hard size cap: 20 MB per file (`multer` `limits.fileSize`).
- Exactly one of `messageId` / `taskId` / `docId` is set on a linked attachment row; unlinked rows older than 24h are garbage-collected by a periodic sweep.
- `GET /api/files/:id`: 404 (not 403) for a file whose parent the requester cannot see — same existence-hiding rule as channels/projects/notes in every prior phase.
- Local dev storage lives at `server/uploads/` (gitignored — already covered by the existing `.gitignore` entry from Phase 0).
- Commits: small, conventional (`feat(server): …` / `feat(web): …`), end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Every task ends with `npm test` green in `server/`; verify build/test success by redirecting to a log file and checking `$?` directly — **never** pipe `tsc`/`npm test` through `tail` inside a `&&` chain (this silently swallows real failures, as happened earlier this build).
- Continue the `parseId()` path-param helper convention; never chain two `validate()` calls on one route.

---

### Task 1: Migration 004 — attachments schema

**Files:**
- Create: `server/src/db/schema/files.ts`
- Modify: `server/src/db/schema/index.ts`, `server/src/db/testUtils.ts`

**Interfaces:** `attachments` table — `id, uploaderId, messageId (nullable), taskId (nullable), docId (nullable), storageKey, fileName, mimeType, sizeBytes, createdAt`.

- [ ] **Step 1: `db/schema/files.ts`**

```ts
import { bigint, int, mysqlTable, timestamp, varchar } from 'drizzle-orm/mysql-core';
import { users } from './auth.js';
import { messages } from './chat.js';
import { docs, tasks } from './projects.js';

export const attachments = mysqlTable('attachments', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  uploaderId: bigint('uploader_id', { mode: 'number', unsigned: true })
    .notNull()
    .references(() => users.id),
  messageId: bigint('message_id', { mode: 'number', unsigned: true }).references(() => messages.id, {
    onDelete: 'cascade',
  }),
  taskId: bigint('task_id', { mode: 'number', unsigned: true }).references(() => tasks.id, {
    onDelete: 'cascade',
  }),
  docId: bigint('doc_id', { mode: 'number', unsigned: true }).references(() => docs.id, {
    onDelete: 'cascade',
  }),
  storageKey: varchar('storage_key', { length: 500 }).notNull(),
  fileName: varchar('file_name', { length: 255 }).notNull(),
  mimeType: varchar('mime_type', { length: 120 }).notNull(),
  sizeBytes: int('size_bytes', { unsigned: true }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
```

- [ ] **Step 2: export from `schema/index.ts`** — add `export * from './files.js';`

- [ ] **Step 3: generate + apply**

```bash
cd server
npx drizzle-kit generate --name attachments
npm run db:migrate
mariadb -u fs_app -pfs_app_dev fs_internal_system -e "SHOW COLUMNS FROM attachments;"
```

- [ ] **Step 4: update `testUtils.ts`** — add `'attachments'` to the `TABLES` array, before `messages`/`tasks`/`docs` (children before parents; attachments references all three):

```ts
const TABLES = [
  'refresh_tokens',
  'department_members',
  'departments',
  'attachments',
  'message_reactions',
  'message_mentions',
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

- [ ] **Step 5:** `npm test` (redirect to a log, check `$?` explicitly) → existing 68 tests still green. **Step 6: Commit** — `feat(server): attachments schema (migration 0006)`

### Task 2: Storage driver abstraction — TDD

**Files:**
- Create: `server/src/storage/types.ts`, `server/src/storage/local.ts`, `server/src/storage/s3.ts`, `server/src/storage/index.ts`
- Test: `server/src/storage/local.test.ts`
- Modify: `server/src/config.ts` (add `STORAGE_DRIVER`, `UPLOAD_DIR`, `S3_BUCKET`/`AWS_REGION` — all optional, local is the default)
- Install: `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `multer`, `@types/multer`

**Interfaces:**
- `StorageDriver`: `put(key: string, body: Buffer, contentType: string): Promise<void>`, `getStream(key: string): NodeJS.ReadableStream` (local only — throws on the S3 driver, callers branch on driver kind), `getSignedGetUrl(key: string, ttlSeconds: number): Promise<string | null>` (returns `null` on the local driver — callers stream instead), `delete(key: string): Promise<void>`
- `getStorageDriver(): StorageDriver` — picks based on `config.STORAGE_DRIVER` (`'local' | 's3'`, default `'local'`)

- [ ] **Step 1: install**

```bash
cd server
npm install multer@^2.2.0 @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
npm install -D @types/multer
```

Add to `config.ts` `EnvSchema`:

```ts
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  UPLOAD_DIR: z.string().default('./uploads'),
  S3_BUCKET: z.string().optional(),
  AWS_REGION: z.string().default('us-east-1'),
```

- [ ] **Step 2: `storage/types.ts`**

```ts
export interface StorageDriver {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  getStream(key: string): NodeJS.ReadableStream;
  getSignedGetUrl(key: string, ttlSeconds: number): Promise<string | null>;
  delete(key: string): Promise<void>;
}
```

- [ ] **Step 3: failing test** — `storage/local.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalStorageDriver } from './local.js';

describe('LocalStorageDriver', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fs-storage-test-'));
  const driver = new LocalStorageDriver(dir);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('writes and reads back a file, returns null for getSignedGetUrl, deletes cleanly', async () => {
    await driver.put('a/b.txt', Buffer.from('hello world'), 'text/plain');
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = driver.getStream('a/b.txt');
      stream.on('data', (c) => chunks.push(Buffer.from(c)));
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });
    expect(Buffer.concat(chunks).toString()).toBe('hello world');
    expect(await driver.getSignedGetUrl('a/b.txt', 60)).toBeNull();
    await driver.delete('a/b.txt');
    expect(() => driver.getStream('a/b.txt')).toThrow();
  });
});
```

- [ ] **Step 4: run** → FAIL (module not found). **Step 5: implement** — `storage/local.ts`:

```ts
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { StorageDriver } from './types.js';

export class LocalStorageDriver implements StorageDriver {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    return join(this.root, key);
  }

  async put(key: string, body: Buffer, _contentType: string): Promise<void> {
    const path = this.resolve(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  getStream(key: string): NodeJS.ReadableStream {
    const path = this.resolve(key);
    if (!existsSync(path)) throw new Error(`file not found: ${key}`);
    return createReadStream(path);
  }

  async getSignedGetUrl(): Promise<string | null> {
    return null;
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }
}
```

- [ ] **Step 6: run** → PASS. **Step 7: implement `storage/s3.ts`** (no unit test — requires a real bucket; covered by the phase-gate manual check instead):

```ts
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageDriver } from './types.js';

export class S3StorageDriver implements StorageDriver {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    region: string,
  ) {
    this.client = new S3Client({ region });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  getStream(): NodeJS.ReadableStream {
    throw new Error('S3StorageDriver does not stream directly — use getSignedGetUrl and redirect');
  }

  async getSignedGetUrl(key: string, ttlSeconds: number): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, command, { expiresIn: ttlSeconds });
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
```

- [ ] **Step 8: `storage/index.ts`**

```ts
import { config } from '../config.js';
import { LocalStorageDriver } from './local.js';
import { S3StorageDriver } from './s3.js';
import type { StorageDriver } from './types.js';

let driver: StorageDriver | null = null;

export function getStorageDriver(): StorageDriver {
  if (driver) return driver;
  driver =
    config.STORAGE_DRIVER === 's3'
      ? new S3StorageDriver(config.S3_BUCKET ?? '', config.AWS_REGION)
      : new LocalStorageDriver(config.UPLOAD_DIR);
  return driver;
}
```

- [ ] **Step 9: run full suite** (redirect + check `$?`) → PASS. **Step 10: Commit** — `feat(server): storage driver abstraction (local disk dev, S3 prod)`

### Task 3: attachmentService — upload, link, GC — TDD

**Files:**
- Create: `server/src/services/attachmentService.ts`
- Test: `server/src/services/attachmentService.test.ts`

**Interfaces:**
- `MIME_WHITELIST: Set<string>` — images (png/jpeg/gif/webp) + office (docx/xlsx/pptx/odt/ods/odp) + csv/pdf
- `createUnlinkedAttachment(input: { uploaderId, buffer, fileName, mimeType, sizeBytes }): Promise<AttachmentDto>` — validates mime against the whitelist, writes via the storage driver at key `uploads/${uuid}-${sanitizedFileName}`, inserts the row
- `linkAttachment(id: number, uploaderId: number, target: { messageId?: number; taskId?: number; docId?: number }): Promise<boolean>` — false if the row doesn't exist or isn't owned by `uploaderId`, or is already linked
- `getAttachment(id: number): Promise<AttachmentDto | null>`
- `getAttachmentsFor(target: { messageId?: number; taskId?: number; docId?: number }): Promise<AttachmentDto[]>`
- `gcUnlinkedAttachments(olderThanHours: number): Promise<number>` — deletes unlinked rows (all three parent ids null) older than the cutoff, from storage and the DB; returns the count removed

- [ ] **Step 1: failing tests**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/index.js';
import { attachments, users } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { sql } from 'drizzle-orm';
import {
  createUnlinkedAttachment,
  gcUnlinkedAttachments,
  getAttachment,
  getAttachmentsFor,
  linkAttachment,
} from './attachmentService.js';

async function seedUser(email: string) {
  const [{ id }] = await db
    .insert(users)
    .values({ email, passwordHash: 'x', displayName: email.split('@')[0] })
    .$returningId();
  return id;
}

describe('attachmentService', () => {
  beforeEach(resetDb);

  it('rejects a disallowed mime type', async () => {
    const uploader = await seedUser('u@flowerstore.ph');
    await expect(
      createUnlinkedAttachment({
        uploaderId: uploader,
        buffer: Buffer.from('x'),
        fileName: 'evil.exe',
        mimeType: 'application/x-msdownload',
        sizeBytes: 1,
      }),
    ).rejects.toThrow();
  });

  it('creates an unlinked attachment, then links it to a message; only the uploader may link', async () => {
    const uploader = await seedUser('u@flowerstore.ph');
    const other = await seedUser('other@flowerstore.ph');
    const att = await createUnlinkedAttachment({
      uploaderId: uploader,
      buffer: Buffer.from('hello'),
      fileName: 'note.txt',
      mimeType: 'text/csv',
      sizeBytes: 5,
    });
    expect(await linkAttachment(att.id, other, { messageId: 1 })).toBe(false);
    expect(await linkAttachment(att.id, uploader, { messageId: 1 })).toBe(true);
    const linked = await getAttachment(att.id);
    expect(linked?.messageId).toBe(1);
    const list = await getAttachmentsFor({ messageId: 1 });
    expect(list.map((a) => a.id)).toEqual([att.id]);
  });

  it('garbage-collects unlinked attachments older than the cutoff, leaves linked ones alone', async () => {
    const uploader = await seedUser('u@flowerstore.ph');
    const stale = await createUnlinkedAttachment({
      uploaderId: uploader,
      buffer: Buffer.from('x'),
      fileName: 'stale.csv',
      mimeType: 'text/csv',
      sizeBytes: 1,
    });
    const fresh = await createUnlinkedAttachment({
      uploaderId: uploader,
      buffer: Buffer.from('x'),
      fileName: 'fresh.csv',
      mimeType: 'text/csv',
      sizeBytes: 1,
    });
    // Backdate the "stale" row directly — createUnlinkedAttachment always uses now().
    await db
      .update(attachments)
      .set({ createdAt: sql`DATE_SUB(NOW(), INTERVAL 48 HOUR)` })
      .where(sql`${attachments.id} = ${stale.id}`);

    const removed = await gcUnlinkedAttachments(24);
    expect(removed).toBe(1);
    expect(await getAttachment(stale.id)).toBeNull();
    expect(await getAttachment(fresh.id)).not.toBeNull();
  });
});
```

- [ ] **Step 2: run** → FAIL. **Step 3: implement**

```ts
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { attachments } from '../db/schema/index.js';
import { AppError } from '../middleware/errorHandler.js';
import { getStorageDriver } from '../storage/index.js';

export type AttachmentDto = typeof attachments.$inferSelect;

const MIME_WHITELIST = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
]);

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

export async function createUnlinkedAttachment(input: {
  uploaderId: number;
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}): Promise<AttachmentDto> {
  if (!MIME_WHITELIST.has(input.mimeType)) {
    throw new AppError(400, 'unsupported_mime', `File type ${input.mimeType} is not allowed`);
  }
  const key = `uploads/${randomUUID()}-${sanitizeFileName(input.fileName)}`;
  await getStorageDriver().put(key, input.buffer, input.mimeType);
  const [{ id }] = await db
    .insert(attachments)
    .values({
      uploaderId: input.uploaderId,
      storageKey: key,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
    })
    .$returningId();
  const [row] = await db.select().from(attachments).where(eq(attachments.id, id));
  return row;
}

export async function linkAttachment(
  id: number,
  uploaderId: number,
  target: { messageId?: number; taskId?: number; docId?: number },
): Promise<boolean> {
  const [row] = await db.select().from(attachments).where(eq(attachments.id, id));
  if (!row || row.uploaderId !== uploaderId) return false;
  if (row.messageId || row.taskId || row.docId) return false;
  await db.update(attachments).set(target).where(eq(attachments.id, id));
  return true;
}

export async function getAttachment(id: number): Promise<AttachmentDto | null> {
  const [row] = await db.select().from(attachments).where(eq(attachments.id, id));
  return row ?? null;
}

export async function getAttachmentsFor(target: {
  messageId?: number;
  taskId?: number;
  docId?: number;
}): Promise<AttachmentDto[]> {
  if (target.messageId) return db.select().from(attachments).where(eq(attachments.messageId, target.messageId));
  if (target.taskId) return db.select().from(attachments).where(eq(attachments.taskId, target.taskId));
  if (target.docId) return db.select().from(attachments).where(eq(attachments.docId, target.docId));
  return [];
}

export async function gcUnlinkedAttachments(olderThanHours: number): Promise<number> {
  const cutoff = sql`DATE_SUB(NOW(), INTERVAL ${olderThanHours} HOUR)`;
  const stale = await db
    .select()
    .from(attachments)
    .where(and(isNull(attachments.messageId), isNull(attachments.taskId), isNull(attachments.docId), lt(attachments.createdAt, cutoff)));
  for (const row of stale) {
    await getStorageDriver().delete(row.storageKey);
    await db.delete(attachments).where(eq(attachments.id, row.id));
  }
  return stale.length;
}
```

- [ ] **Step 4: run** → PASS. **Step 5: Commit** — `feat(server): attachmentService — mime whitelist, upload/link, unlinked-attachment GC`

### Task 4: routes — uploads + files — TDD

**Files:**
- Create: `server/src/routes/uploads.ts`, `server/src/routes/files.ts`
- Modify: `server/src/app.ts`, `server/src/routes/channels.ts` (attach `attachmentIds` on send), `server/src/routes/projects.ts` (attach on task/doc create+patch), `server/src/services/messageService.ts` (hydrate attachments alongside reactions), `server/src/index.ts` (periodic GC sweep)
- Test: `server/src/routes/uploads.test.ts`, `server/src/routes/files.test.ts`

**Interfaces:**
- POST `/api/uploads` (multer memory storage, ≤20MB, mime whitelist enforced twice — once by multer's `fileFilter` for a fast rejection, once in `attachmentService` as the source of truth) → `{ attachments: [{ id, fileName, mimeType, sizeBytes }] }`
- GET `/api/files/:id` → resolves the attachment's parent (message → channel visibility via `getVisibleChannel`; task/doc → project visibility via `getVisibleProject`), 404 if not visible or attachment missing; local driver streams with correct `Content-Type`/`Content-Disposition`, S3 driver 302-redirects to a signed URL
- `messages.attachmentIds?: number[]` accepted by `POST /channels/:id/messages` and the `message:send` socket event — each id must be uploaded by the caller and unlinked, else the whole send 400s (fail closed, no partial link)
- `tasks`/`docs` create+patch accept `attachmentIds?: number[]` the same way

- [ ] **Step 1: failing tests** — `uploads.test.ts`:

```ts
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { resetDb } from '../db/testUtils.js';
import { makeUser } from '../testHelpers.js';

const app = createApp();

describe('upload routes', () => {
  beforeEach(resetDb);

  it('uploads a file and rejects a bad mime type', async () => {
    const u = await makeUser(app, { email: 'u@flowerstore.ph' });

    const ok = await request(app)
      .post('/api/uploads')
      .set('Authorization', `Bearer ${u.token}`)
      .attach('files', Buffer.from('a,b,c'), { filename: 'data.csv', contentType: 'text/csv' });
    expect(ok.status).toBe(201);
    expect(ok.body.attachments).toHaveLength(1);
    expect(ok.body.attachments[0].fileName).toBe('data.csv');

    const bad = await request(app)
      .post('/api/uploads')
      .set('Authorization', `Bearer ${u.token}`)
      .attach('files', Buffer.from('MZ'), { filename: 'evil.exe', contentType: 'application/x-msdownload' });
    expect(bad.status).toBe(400);
  });
});
```

`files.test.ts`:

```ts
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { resetDb } from '../db/testUtils.js';
import { makeUser } from '../testHelpers.js';

const app = createApp();

describe('file routes', () => {
  beforeEach(resetDb);

  it('attaches a file to a message on send and streams it back only to channel members', async () => {
    const owner = await makeUser(app, { email: 'owner@flowerstore.ph' });
    const outsider = await makeUser(app, { email: 'outsider@flowerstore.ph' });

    const chan = await request(app)
      .post('/api/channels')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'g', isPrivate: true });
    const channelId = chan.body.channel.id;

    const upload = await request(app)
      .post('/api/uploads')
      .set('Authorization', `Bearer ${owner.token}`)
      .attach('files', Buffer.from('hello'), { filename: 'note.txt', contentType: 'text/csv' });
    const attachmentId = upload.body.attachments[0].id;

    const msg = await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ body: 'see attached', attachmentIds: [attachmentId] });
    expect(msg.status).toBe(201);
    expect(msg.body.message.attachments).toHaveLength(1);

    expect(
      (await request(app).get(`/api/files/${attachmentId}`).set('Authorization', `Bearer ${outsider.token}`))
        .status,
    ).toBe(404);
    const stream = await request(app)
      .get(`/api/files/${attachmentId}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(stream.status).toBe(200);
    expect(stream.text).toBe('hello');
  });

  it('attaches a file to a task', async () => {
    const owner = await makeUser(app, { email: 'owner2@flowerstore.ph' });
    const proj = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'P', isPrivate: false });
    const board = await request(app)
      .get(`/api/projects/${proj.body.project.id}/board`)
      .set('Authorization', `Bearer ${owner.token}`);
    const upload = await request(app)
      .post('/api/uploads')
      .set('Authorization', `Bearer ${owner.token}`)
      .attach('files', Buffer.from('spec'), { filename: 'spec.csv', contentType: 'text/csv' });
    const attachmentId = upload.body.attachments[0].id;

    const task = await request(app)
      .post(`/api/projects/${proj.body.project.id}/tasks`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ columnId: board.body.columns[0].id, title: 'T', attachmentIds: [attachmentId] });
    expect(task.status).toBe(201);
    expect(task.body.task.attachments).toHaveLength(1);
  });
});
```

- [ ] **Step 2: run** → FAIL. **Step 3: implement**

`routes/uploads.ts`:

```ts
import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import { createUnlinkedAttachment } from '../services/attachmentService.js';

export const uploadsRouter = Router();
uploadsRouter.use(requireAuth);

const ALLOWED_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    cb(null, ALLOWED_MIMES.has(file.mimetype));
  },
});

uploadsRouter.post('/', upload.array('files', 10), async (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) {
    res.status(400).json({ error: { code: 'unsupported_mime', message: 'No valid files uploaded' } });
    return;
  }
  const created = await Promise.all(
    files.map((f) =>
      createUnlinkedAttachment({
        uploaderId: req.auth!.userId,
        buffer: f.buffer,
        fileName: f.originalname,
        mimeType: f.mimetype,
        sizeBytes: f.size,
      }),
    ),
  );
  res.status(201).json({
    attachments: created.map((a) => ({ id: a.id, fileName: a.fileName, mimeType: a.mimeType, sizeBytes: a.sizeBytes })),
  });
});
```

`routes/files.ts`:

```ts
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { getAttachment } from '../services/attachmentService.js';
import { getVisibleChannel } from '../services/channelService.js';
import { messages } from '../db/schema/index.js';
import { db } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { getVisibleProject } from '../services/projectService.js';
import { docs, tasks } from '../db/schema/index.js';
import { getStorageDriver } from '../storage/index.js';

export const filesRouter = Router();
filesRouter.use(requireAuth);

function parseId(raw: string | string[]): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'validation_error', 'Bad id');
  return id;
}

filesRouter.get('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const attachment = await getAttachment(id);
  if (!attachment) throw new AppError(404, 'not_found', 'Not found');
  const isAdmin = req.auth!.role === 'admin';
  const userId = req.auth!.userId;

  let visible = false;
  if (attachment.messageId) {
    const [msg] = await db.select().from(messages).where(eq(messages.id, attachment.messageId));
    visible = Boolean(msg && (await getVisibleChannel(msg.channelId, userId, isAdmin)));
  } else if (attachment.taskId) {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, attachment.taskId));
    visible = Boolean(task && (await getVisibleProject(task.projectId, userId, isAdmin)));
  } else if (attachment.docId) {
    const [doc] = await db.select().from(docs).where(eq(docs.id, attachment.docId));
    visible = Boolean(doc && (await getVisibleProject(doc.projectId, userId, isAdmin)));
  }
  if (!visible) throw new AppError(404, 'not_found', 'Not found');

  const driver = getStorageDriver();
  const signedUrl = await driver.getSignedGetUrl(attachment.storageKey, 60);
  if (signedUrl) {
    res.redirect(signedUrl);
    return;
  }
  res.setHeader('Content-Type', attachment.mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${attachment.fileName}"`);
  driver.getStream(attachment.storageKey).pipe(res);
});
```

(NOTE for implementer: `routes/files.ts` above has two separate `import { docs, tasks } from '../db/schema/index.js';` style imports shown split for readability in this plan step — write it as ONE import line at the top of the real file, alongside the other imports. Same discipline as the Phase 3 postmortem: no imports appearing after other code.)

Mount both in `app.ts`:

```ts
import { filesRouter } from './routes/files.js';
import { uploadsRouter } from './routes/uploads.js';
// ...
app.use('/api/uploads', uploadsRouter);
app.use('/api/files', filesRouter);
```

- [ ] **Step 4: wire `attachmentIds` into message send.** In `services/messageService.ts`, extend `sendMessage` to accept an optional `attachmentIds?: number[]` fourth parameter; after inserting the message, call `linkAttachment(id, userId, { messageId })` for each (throw `AppError(400, 'invalid_attachment', ...)` if any `linkAttachment` call returns `false` — fail closed, don't silently drop). Extend `MessageWithAuthor` with `attachments: { id: number; fileName: string; mimeType: string; sizeBytes: number }[]`, hydrated via `getAttachmentsFor({ messageId })` in both `sendMessage` and `getMessagesBefore`/`searchMessages` (reuse a small `hydrateAttachments(messageIds: number[])` helper mirroring the existing `hydrateReactions` shape). Update `routes/channels.ts`'s `sendBody` schema to add `attachmentIds: z.array(z.number().int().positive()).max(10).optional()` and pass it through. Update `sockets/chatHandlers.ts`'s `SendPayload` interface and `message:send` handler the same way.

- [ ] **Step 5: wire `attachmentIds` into tasks/docs.** In `services/taskService.ts`, extend `createTask` to accept `attachmentIds?: number[]`, linking each via `linkAttachment(id, createdBy, { taskId })` after insert (same fail-closed rule); add `attachments` to `TaskDto`, hydrated in `getBoard`. In `services/docService.ts`, extend `createDoc` the same way for `docId`. Update `routes/projects.ts`'s `taskBody`/`docBody` schemas to accept `attachmentIds`.

- [ ] **Step 6: periodic GC.** In `server/src/index.ts`, after `registerAutomations()`, add:

```ts
import { gcUnlinkedAttachments } from './services/attachmentService.js';
// ...
setInterval(() => {
  gcUnlinkedAttachments(24).catch((err) => logger.error({ err }, 'attachment GC failed'));
}, 60 * 60 * 1000);
```

- [ ] **Step 7: run** (redirect to log, check `$?`) → PASS. **Step 8: Commit** — `feat(server): upload/files routes, attachments wired into messages/tasks/docs, periodic GC`

### Task 5: Frontend — AttachButton, AttachmentChip, Lightbox

**Files:**
- Create: `src/lib/uploads.ts`, `src/features/files/AttachmentChip.tsx`, `src/features/files/Lightbox.tsx`
- Modify: `src/features/chat/types.ts`, `src/features/chat/MessageInput.tsx`, `src/features/chat/MessageItem.tsx`, `src/features/kanban/TaskDetailSheet.tsx`, `src/features/docs/DocPage.tsx`, `src/lib/socket.ts` (attachmentIds in send payload)

- [ ] **Step 1: `src/lib/uploads.ts`** — a raw-fetch multipart helper (the shared `api()` wrapper always sends `Content-Type: application/json`, which is wrong for `FormData`; multipart needs the browser to set its own boundary header):

```ts
import { useAuthStore } from '@/features/auth/authStore';

const BASE = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:4000';

export interface UploadedFile {
  id: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export async function uploadFiles(files: File[]): Promise<UploadedFile[]> {
  const form = new FormData();
  for (const f of files) form.append('files', f);
  const token = useAuthStore.getState().accessToken;
  const res = await fetch(`${BASE}/api/uploads`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });
  if (!res.ok) throw new Error('upload failed');
  const data = await res.json();
  return data.attachments;
}

export function fileUrl(id: number): string {
  return `${BASE}/api/files/${id}`;
}
```

(`fileUrl` returns a bare path — the browser's normal cookie-less `<img>`/`<a>` request won't carry the bearer token, so image previews and downloads route through `Lightbox`'s authenticated `fetch` + object-URL pattern below, not a raw `<img src>`.)

- [ ] **Step 2: `src/features/files/Lightbox.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { useAuthStore } from '@/features/auth/authStore';
import { fileUrl } from '@/lib/uploads';

export function Lightbox({
  attachmentId,
  onClose,
}: {
  attachmentId: number | null;
  onClose: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (attachmentId === null) return;
    let objectUrl: string | null = null;
    const token = useAuthStore.getState().accessToken;
    fetch(fileUrl(attachmentId), { headers: token ? { Authorization: `Bearer ${token}` } : undefined })
      .then((res) => res.blob())
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      });
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setSrc(null);
    };
  }, [attachmentId]);

  return (
    <Dialog open={attachmentId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        {src && <img src={src} alt="attachment preview" className="max-h-[80vh] w-full object-contain" />}
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 3: `src/features/files/AttachmentChip.tsx`**

```tsx
import { useState } from 'react';
import { fileUrl } from '@/lib/uploads';
import { Lightbox } from './Lightbox';

export interface AttachmentInfo {
  id: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function AttachmentChip({ attachment }: { attachment: AttachmentInfo }) {
  const [previewing, setPreviewing] = useState(false);
  const isImage = attachment.mimeType.startsWith('image/');

  return (
    <>
      <button
        type="button"
        onClick={() => (isImage ? setPreviewing(true) : window.open(fileUrl(attachment.id), '_blank'))}
        className="flex items-center gap-2 rounded-md border px-2 py-1 text-xs hover:bg-accent"
      >
        <span className="truncate">{attachment.fileName}</span>
        <span className="text-muted-foreground">{formatSize(attachment.sizeBytes)}</span>
      </button>
      {isImage && (
        <Lightbox attachmentId={previewing ? attachment.id : null} onClose={() => setPreviewing(false)} />
      )}
    </>
  );
}
```

- [ ] **Step 4: wire into chat.** `src/features/chat/types.ts`: add `attachments: { id: number; fileName: string; mimeType: string; sizeBytes: number }[]` to `Message`. `src/lib/socket.ts`: `sendMessage` accepts `Pick<Message, 'channelId' | 'body'> & { attachmentIds?: number[] }`. `MessageInput.tsx`: add a file input + paperclip button; on selection, call `uploadFiles`, store the returned ids in local state (`pendingAttachmentIds`), render a row of `AttachmentChip`-like pending previews above the textarea, clear on send, pass `attachmentIds: pendingAttachmentIds` into `sendSocketMessage`. `MessageItem.tsx`: render `attachment.attachments.map((a) => <AttachmentChip key={a.id} attachment={a} />)` below the reactions row.

- [ ] **Step 5: wire into kanban.** `TaskDetailSheet.tsx`: add an attach button (reuse the same `uploadFiles` flow) that, on selection, immediately `PATCH`es the task's attachment list via a small new endpoint call — simplest v1: since `attachmentIds` is accepted at task **creation** only per Task 4 Step 5, add attachments post-creation via a dedicated `POST /api/tasks/:id/attachments { attachmentIds }` route (mirrors `linkAttachment`, no new service logic — add this one small route+test now, in this task, not deferred). Render existing `task.attachments` as chips in the sheet.

- [ ] **Step 6: wire into docs.** `DocPage.tsx`: same attach button pattern; add `POST /api/docs/:id/attachments { attachmentIds }` (mirrors the task route above), render doc attachments as chips above the editor/preview toggle.

- [ ] **Step 7:** `npm run build` (redirect to a log, check `$?`) + `npm run lint` → clean. **Commit** — `feat(web): composer/task/doc attach buttons, attachment chips, image lightbox`

### Task 6: Phase gate — full verification + finish

- [ ] `cd server && npm test` (redirect to log, check `$?`) → all suites green (68 existing + new upload/attachment/file tests)
- [ ] `npm run build` in `server/` and root → clean (verified via log + `$?`, not piped through `tail`); `npm run lint` clean
- [ ] `docker build .` (from `server/` as context) → succeeds
- [ ] Restart PM2, manually verify against the real dev servers:
  - upload a 25MB file → rejected (413 or the multer file-size error surfaced as a 400/500 — confirm the error is handled gracefully, not a raw crash)
  - upload a disallowed mime (e.g. `.exe`) → rejected with a clear error
  - attach an image to a message as user A in a private channel → user B (non-member) hits `GET /api/files/:id` directly → 404
  - as a member, open the same image → confirms via an actual browser session (Claude_Browser tools) that the lightbox renders the real image bytes, not a broken image icon
  - attach a file to a task and to a doc, confirm both show up as chips after a reload
  - S3 driver: if a real bucket/credentials are available, set `STORAGE_DRIVER=s3` + `S3_BUCKET`/`AWS_REGION`, restart, and repeat the upload+fetch cycle to confirm the presigned-redirect path works — if no bucket is available in this environment, note it as deferred rather than skipping silently
  - wait is impractical for the 24h GC in a live check — instead, directly backdate a row in MariaDB (as the unit test does) and manually invoke the GC path once (e.g. temporarily lower the interval or call the function via a throwaway script) to confirm storage + DB rows both disappear
- [ ] Update memory (mark Phase 4 complete, record S3 real-bucket test result — done or deferred), then use **superpowers:finishing-a-development-branch**

## Deviations / notes for the implementer

- The `routes/files.ts` step above deliberately shows imports mid-explanation for readability — write them as one clean import block at the top of the real file (see the inline NOTE).
- `getSignedGetUrl` returning `null` is the local-driver signal to stream directly — every route calling it must branch on that, never assume S3.
- Fail-closed linking (`linkAttachment` returning `false` aborts the whole create/send with a 400) is a deliberate simplification: it avoids ever silently dropping an attachment the user thought they sent. A partial-success UX can be a later refinement, not required this phase.
