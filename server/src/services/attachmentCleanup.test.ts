/**
 * Phase 5 Task B1 — stored objects must not outlive their rows.
 *
 * The attachments foreign keys cascade, so deleting a task or doc removed the
 * rows and with them the only record of which files existed. Nothing deleted the
 * files, so every deletion leaked them: a bill on S3, a slow disk-fill locally.
 */

import { Buffer } from 'node:buffer';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { resetDb } from '../db/testUtils.js';
import { runAttachmentGc, sweepOrphanObjects } from '../services/attachmentService.js';
import { LocalStorageDriver } from '../storage/local.js';
import { getStorageDriver } from '../storage/index.js';
import { makeUser } from '../testHelpers.js';

const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` } as Record<string, string>);

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

async function storedFiles(): Promise<string[]> {
  return getStorageDriver().list('uploads/');
}

async function setupProjectWithAttachment(kind: 'task' | 'doc') {
  const user = await makeUser(app, { email: `cl${Date.now()}${Math.random()}@flowerstore.ph` });
  const project = await request(app)
    .post('/api/projects')
    .set(auth(user.token))
    .send({ name: 'Cleanup', isPrivate: false });
  const projectId = project.body.project.id;

  const upload = await request(app)
    .post('/api/uploads')
    .set(auth(user.token))
    .attach('files', PNG, { filename: 'pic.png', contentType: 'image/png' });
  const attachmentId = upload.body.attachments[0].id;
  const storageKey = await storedFiles();

  if (kind === 'task') {
    const board = await request(app).get(`/api/projects/${projectId}/board`).set(auth(user.token));
    const created = await request(app)
      .post(`/api/projects/${projectId}/tasks`)
      .set(auth(user.token))
      .send({ columnId: board.body.columns[0].id, title: 'T', attachmentIds: [attachmentId] });
    return { user, id: created.body.task.id, keys: storageKey };
  }
  const created = await request(app)
    .post(`/api/projects/${projectId}/docs`)
    .set(auth(user.token))
    .send({ title: 'D', attachmentIds: [attachmentId] });
  return { user, id: created.body.doc.id, keys: storageKey };
}

describe('attachment cleanup', () => {
  beforeEach(resetDb);

  it('deletes a task\'s stored files along with the task', async () => {
    const { user, id, keys } = await setupProjectWithAttachment('task');
    expect(keys).toHaveLength(1);

    const res = await request(app).delete(`/api/tasks/${id}`).set(auth(user.token));
    expect(res.status).toBe(200);

    // Before this change the row cascaded away and the file stayed forever.
    expect(await storedFiles()).toHaveLength(0);
  });

  it("deletes a doc's stored files along with the doc", async () => {
    const { user, id, keys } = await setupProjectWithAttachment('doc');
    expect(keys).toHaveLength(1);

    const res = await request(app).delete(`/api/docs/${id}`).set(auth(user.token));
    expect(res.status).toBe(200);
    expect(await storedFiles()).toHaveLength(0);
  });

  it('leaves live objects alone when sweeping', async () => {
    const { keys } = await setupProjectWithAttachment('task');
    expect(keys).toHaveLength(1);

    const swept = await sweepOrphanObjects();

    expect(swept).toBe(0);
    expect(await storedFiles()).toHaveLength(1);
  });

  it('removes a stored object whose row is gone', async () => {
    const { keys } = await setupProjectWithAttachment('task');
    // Drop the rows the way a cascade would, without touching storage.
    const { db } = await import('../db/index.js');
    const { attachments } = await import('../db/schema/index.js');
    await db.delete(attachments);

    expect(await storedFiles()).toEqual(keys);
    const swept = await sweepOrphanObjects();

    expect(swept).toBe(1);
    expect(await storedFiles()).toHaveLength(0);
  });

  it('runs the whole GC under a lock and reports what it did', async () => {
    const result = await runAttachmentGc(24);
    expect(result.ran).toBe(true);
    // The lock is released afterwards, so a second run also gets it.
    expect((await runAttachmentGc(24)).ran).toBe(true);
  });

  it('returns an empty list rather than throwing when nothing was ever uploaded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fs-empty-'));
    expect(await new LocalStorageDriver(root).list('uploads/')).toEqual([]);
  });

  it('ignores directories when listing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fs-dirs-'));
    const driver = new LocalStorageDriver(root);
    await driver.put('uploads/a.png', PNG, 'image/png');
    await writeFile(join(root, 'uploads', 'b.png'), PNG);
    const entries = await readdir(join(root, 'uploads'));
    expect(entries).toHaveLength(2);
    expect((await driver.list('uploads/')).sort()).toEqual(['uploads/a.png', 'uploads/b.png']);
  });
});
