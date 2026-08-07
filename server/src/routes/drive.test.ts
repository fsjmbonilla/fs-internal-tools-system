/**
 * Drive — Phase 13.
 *
 * The properties under test: everything runs on the caller's OWN connection
 * (a member without Google gets the 409, never someone else's token), folder
 * binding is a lead's act, a gdrive attachment is a reference that survives
 * unbinding and is invisible to the storage GC, and a pre-Drive grant fails
 * with its own actionable 409 rather than a bare Google error.
 */

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { db } from '../db/index.js';
import { attachments, projectDriveFolders } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { deleteAttachmentObjectsFor } from '../services/attachmentService.js';
import { addChannelMember, createChannel } from '../services/channelService.js';
import { makeFakeGoogle, type FakeGoogle } from '../services/google/fake.js';
import { setGooglePortForTesting } from '../services/google/port.js';
import { sendMessage } from '../services/messageService.js';
import { addProjectMember, createProject } from '../services/projectService.js';
import { createDefaultColumns, createTask, getBoard, getTaskById } from '../services/taskService.js';
import { makeUser } from '../testHelpers.js';

const app = createApp();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` }) as Record<string, string>;

let fake: FakeGoogle;

beforeEach(async () => {
  await resetDb();
  fake = makeFakeGoogle();
  setGooglePortForTesting(fake);
});

afterEach(() => {
  setGooglePortForTesting(null);
});

async function connectedUser(opts: { admin?: boolean } = {}) {
  const user = await makeUser(app, opts);
  const urlRes = await request(app).get('/api/google/auth-url').set(auth(user.token));
  const state = new URL(urlRes.body.url).searchParams.get('state')!;
  await request(app).get(`/api/google/callback?code=good-code&state=${state}`);
  return user;
}

/** A project whose lead is `leadId`, with default columns. */
async function makeProject(leadId: number) {
  const project = await createProject({ name: 'ops', isPrivate: false, createdBy: leadId });
  await createDefaultColumns(project.id);
  return project;
}

describe('personal browse', () => {
  it('browses and searches the caller’s own Drive', async () => {
    const { token } = await connectedUser();
    const folder = fake.addDriveFile({ name: 'Reports', isFolder: true, mimeType: 'application/vnd.google-apps.folder' });
    fake.addDriveFile({ name: 'inventory-july.xlsx', parentId: folder.id });
    fake.addDriveFile({ name: 'logo.png' });

    const root = await request(app).get('/api/drive/files').set(auth(token));
    expect(root.body.files.map((f: { name: string }) => f.name).sort()).toEqual([
      'Reports',
      'logo.png',
    ]);

    const inFolder = await request(app)
      .get(`/api/drive/files?folderId=${folder.id}`)
      .set(auth(token));
    expect(inFolder.body.files.map((f: { name: string }) => f.name)).toEqual([
      'inventory-july.xlsx',
    ]);

    const search = await request(app).get('/api/drive/files?q=inventory').set(auth(token));
    expect(search.body.files).toHaveLength(1);
  });

  it('409s without a connection, and with a pre-Drive grant names the scope fix', async () => {
    const { token } = await makeUser(app);
    const none = await request(app).get('/api/drive/files').set(auth(token));
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe('google_not_connected');

    const connected = await connectedUser();
    fake.breakDriveScope();
    const scopeless = await request(app).get('/api/drive/files').set(auth(connected.token));
    expect(scopeless.status).toBe(409);
    expect(scopeless.body.error.code).toBe('google_drive_scope_missing');
  });
});

describe('in-app export', () => {
  it('exports a Google Doc as docx bytes; 404 for an unknown file', async () => {
    const { token } = await connectedUser();
    const doc = fake.addDriveFile({
      name: 'Handbook',
      mimeType: 'application/vnd.google-apps.document',
    });
    const res = await request(app)
      .get(`/api/drive/files/${doc.id}/export`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(res.headers['content-disposition']).toContain('Handbook.docx');

    const missing = await request(app)
      .get('/api/drive/files/nope/export')
      .set('Authorization', `Bearer ${token}`);
    expect(missing.status).toBe(404);
  });
});

describe('in-app content update', () => {
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  it('replaces the file bytes, keeps the name, and returns the refreshed file', async () => {
    const { token } = await connectedUser();
    const sheet = fake.addDriveFile({
      name: 'Inventory',
      mimeType: 'application/vnd.google-apps.spreadsheet',
    });
    const bytes = Buffer.from('edited xlsx bytes');

    const res = await request(app)
      .put(`/api/drive/files/${sheet.id}/content`)
      .set(auth(token))
      .attach('file', bytes, { filename: 'edited.xlsx', contentType: XLSX_MIME });
    expect(res.status).toBe(200);
    expect(res.body.file.id).toBe(sheet.id);
    // A content save is never a rename — the uploaded part's filename is ignored.
    expect(res.body.file.name).toBe('Inventory');
    expect(fake.uploads.get(sheet.id)).toEqual(bytes);
  });

  it('404s for an unknown file id', async () => {
    const { token } = await connectedUser();
    const res = await request(app)
      .put('/api/drive/files/nope/content')
      .set(auth(token))
      .attach('file', Buffer.from('x'), { filename: 'x.xlsx', contentType: XLSX_MIME });
    expect(res.status).toBe(404);
  });

  it('rejects an oversized body with 413 and writes nothing', async () => {
    const { token } = await connectedUser();
    const file = fake.addDriveFile({ name: 'big', mimeType: 'application/vnd.google-apps.spreadsheet' });
    const res = await request(app)
      .put(`/api/drive/files/${file.id}/content`)
      .set(auth(token))
      .attach('file', Buffer.alloc(20 * 1024 * 1024 + 1), {
        filename: 'big.xlsx',
        contentType: XLSX_MIME,
      });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('file_too_large');
    expect(fake.uploads.has(file.id)).toBe(false);
  });
});

describe('share with a colleague', () => {
  it('shares with a registered allowed-domain user; rejects outsiders', async () => {
    const { token } = await connectedUser();
    await makeUser(app, { email: 'colleague@flowerstore.ph' });
    const file = fake.addDriveFile({ name: 'plan.xlsx' });
    const auth = { Authorization: `Bearer ${token}` };

    await request(app)
      .post(`/api/drive/files/${file.id}/share`)
      .set(auth)
      .send({ email: 'colleague@flowerstore.ph' })
      .expect(201);
    expect(fake.shares).toEqual([
      { fileId: file.id, email: 'colleague@flowerstore.ph', role: 'reader' },
    ]);

    // Allowed domain but nobody registered under it.
    const ghost = await request(app)
      .post(`/api/drive/files/${file.id}/share`)
      .set(auth)
      .send({ email: 'ghost@flowerstore.ph' });
    expect(ghost.status).toBe(400);
    expect(ghost.body.error.code).toBe('not_registered');

    // Real mailbox, wrong workspace.
    const outsider = await request(app)
      .post(`/api/drive/files/${file.id}/share`)
      .set(auth)
      .send({ email: 'someone@gmail.com' });
    expect(outsider.status).toBe(400);
    expect(outsider.body.error.code).toBe('domain_not_allowed');

    // Not an email at all.
    await request(app)
      .post(`/api/drive/files/${file.id}/share`)
      .set(auth)
      .send({ email: 'not-an-email' })
      .expect(400);
    expect(fake.shares).toHaveLength(1);
  });
});

describe('project folder binding', () => {
  it('lead binds a folder; member cannot; non-folder rejected', async () => {
    const lead = await connectedUser();
    const member = await connectedUser();
    const project = await makeProject(lead.userId);
    await addProjectMember(project.id, member.userId, 'member');
    const folder = fake.addDriveFile({ name: 'ProjectFiles', isFolder: true });
    const file = fake.addDriveFile({ name: 'a.pdf' });

    const memberTry = await request(app)
      .post(`/api/projects/${project.id}/drive-folder`)
      .set(auth(member.token))
      .send({ folderId: folder.id });
    expect(memberTry.status).toBe(403);

    const notFolder = await request(app)
      .post(`/api/projects/${project.id}/drive-folder`)
      .set(auth(lead.token))
      .send({ folderId: file.id });
    expect(notFolder.status).toBe(400);
    expect(notFolder.body.error.code).toBe('not_a_folder');

    const ok = await request(app)
      .post(`/api/projects/${project.id}/drive-folder`)
      .set(auth(lead.token))
      .send({ folderId: folder.id });
    expect(ok.status).toBe(201);
    expect(ok.body.folder.folderName).toBe('ProjectFiles');
  });

  it('members browse the bound folder with their own token; outsiders 404', async () => {
    const lead = await connectedUser();
    const member = await connectedUser();
    const outsider = await connectedUser();
    const project = await createProject({
      name: 'secret',
      isPrivate: true,
      createdBy: lead.userId,
    });
    await addProjectMember(project.id, member.userId, 'member');
    const folder = fake.addDriveFile({ name: 'F', isFolder: true });
    fake.addDriveFile({ name: 'plan.pdf', parentId: folder.id });
    await request(app)
      .post(`/api/projects/${project.id}/drive-folder`)
      .set(auth(lead.token))
      .send({ folderId: folder.id });

    const asMember = await request(app)
      .get(`/api/projects/${project.id}/drive-files`)
      .set(auth(member.token));
    expect(asMember.status).toBe(200);
    expect(asMember.body.folder.name).toBe('F');
    expect(asMember.body.files.map((f: { name: string }) => f.name)).toEqual(['plan.pdf']);

    const asOutsider = await request(app)
      .get(`/api/projects/${project.id}/drive-files`)
      .set(auth(outsider.token));
    expect(asOutsider.status).toBe(404);
  });

  it('uploads land in the bound folder via the uploader’s own token', async () => {
    const lead = await connectedUser();
    const project = await makeProject(lead.userId);
    const folder = fake.addDriveFile({ name: 'F', isFolder: true });
    await request(app)
      .post(`/api/projects/${project.id}/drive-folder`)
      .set(auth(lead.token))
      .send({ folderId: folder.id });

    const res = await request(app)
      .post(`/api/projects/${project.id}/drive-files`)
      .set(auth(lead.token))
      .attach('file', Buffer.from('%PDF-1.4 fake'), {
        filename: 'notes.pdf',
        contentType: 'application/pdf',
      });
    expect(res.status).toBe(201);
    expect(res.body.file.name).toBe('notes.pdf');
    expect(fake.drive.find((f) => f.name === 'notes.pdf')?.parentId).toBe(folder.id);
  });
});

describe('attach from Drive', () => {
  it('attaches as a reference: provider gdrive, deep link, no stored bytes', async () => {
    const user = await connectedUser();
    const project = await makeProject(user.userId);
    const [column] = (await getBoard(project.id)).columns;
    const task = await createTask({
      projectId: project.id,
      columnId: column.id,
      title: 'review the sheet',
      createdBy: user.userId,
    });
    const file = fake.addDriveFile({ name: 'inventory.xlsx', sizeBytes: 2048 });

    const res = await request(app)
      .post('/api/attachments/from-drive')
      .set(auth(user.token))
      .send({ driveFileId: file.id, taskId: task.id });
    expect(res.status).toBe(201);
    expect(res.body.attachment.provider).toBe('gdrive');
    expect(res.body.attachment.storageKey).toBeNull();

    // The chip data rides the normal task payload.
    const loaded = await getTaskById(task.id);
    expect(loaded!.attachments).toHaveLength(1);
    expect(loaded!.attachments[0].provider).toBe('gdrive');
    expect(loaded!.attachments[0].webViewLink).toContain('drive.google.com');

    // GET /api/files/:id 302s to Drive after our visibility check.
    const chip = await request(app)
      .get(`/api/files/${res.body.attachment.id}`)
      .set(auth(user.token));
    expect(chip.status).toBe(302);
    expect(chip.headers.location).toContain('drive.google.com');

    // …and stays invisible to a non-member of the (private) parent.
    const outsider = await makeUser(app);
    const privateProject = await createProject({
      name: 'p2',
      isPrivate: true,
      createdBy: user.userId,
    });
    await createDefaultColumns(privateProject.id);
    const board = await getBoard(privateProject.id);
    const secretTask = await createTask({
      projectId: privateProject.id,
      columnId: board.columns[0].id,
      title: 'secret',
      createdBy: user.userId,
    });
    const secretFile = fake.addDriveFile({ name: 'secret.pdf' });
    const secretAttach = await request(app)
      .post('/api/attachments/from-drive')
      .set(auth(user.token))
      .send({ driveFileId: secretFile.id, taskId: secretTask.id });
    const denied = await request(app)
      .get(`/api/files/${secretAttach.body.attachment.id}`)
      .set(auth(outsider.token));
    expect(denied.status).toBe(404);
  });

  it('with no target creates an unlinked row the composer links at send time', async () => {
    const user = await connectedUser();
    const channel = await createChannel({
      name: 'compose',
      isPrivate: false,
      createdBy: user.userId,
    });
    await addChannelMember(channel.id, user.userId);
    const file = fake.addDriveFile({ name: 'later.pdf' });

    const res = await request(app)
      .post('/api/attachments/from-drive')
      .set(auth(user.token))
      .send({ driveFileId: file.id });
    expect(res.status).toBe(201);
    expect(res.body.attachment.messageId).toBeNull();

    const message = await sendMessage(channel.id, user.userId, 'here', [res.body.attachment.id]);
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0].provider).toBe('gdrive');
  });

  it('attaches to a message the caller can write to', async () => {
    const user = await connectedUser();
    const channel = await createChannel({
      name: 'general',
      isPrivate: false,
      createdBy: user.userId,
    });
    await addChannelMember(channel.id, user.userId);
    const message = await sendMessage(channel.id, user.userId, 'see the sheet');
    const file = fake.addDriveFile({ name: 'sheet.xlsx' });

    const res = await request(app)
      .post('/api/attachments/from-drive')
      .set(auth(user.token))
      .send({ driveFileId: file.id, messageId: message.id });
    expect(res.status).toBe(201);
  });

  it('unbinding the folder leaves existing gdrive attachments alive', async () => {
    const lead = await connectedUser();
    const project = await makeProject(lead.userId);
    const folder = fake.addDriveFile({ name: 'F', isFolder: true });
    await request(app)
      .post(`/api/projects/${project.id}/drive-folder`)
      .set(auth(lead.token))
      .send({ folderId: folder.id });
    const board = await getBoard(project.id);
    const task = await createTask({
      projectId: project.id,
      columnId: board.columns[0].id,
      title: 't',
      createdBy: lead.userId,
    });
    const file = fake.addDriveFile({ name: 'kept.pdf', parentId: folder.id });
    await request(app)
      .post('/api/attachments/from-drive')
      .set(auth(lead.token))
      .send({ driveFileId: file.id, taskId: task.id });

    const unbind = await request(app)
      .delete(`/api/projects/${project.id}/drive-folder`)
      .set(auth(lead.token));
    expect(unbind.status).toBe(200);
    expect(await db.$count(projectDriveFolders)).toBe(0);
    expect(await db.$count(attachments, eq(attachments.provider, 'gdrive'))).toBe(1);
  });

  it('the storage cleanup never touches gdrive rows', async () => {
    const user = await connectedUser();
    const project = await makeProject(user.userId);
    const board = await getBoard(project.id);
    const task = await createTask({
      projectId: project.id,
      columnId: board.columns[0].id,
      title: 't',
      createdBy: user.userId,
    });
    const file = fake.addDriveFile({ name: 'ref.pdf' });
    await request(app)
      .post('/api/attachments/from-drive')
      .set(auth(user.token))
      .send({ driveFileId: file.id, taskId: task.id });

    // Nothing to delete, and no throw — the row is a reference.
    await expect(deleteAttachmentObjectsFor({ taskId: task.id })).resolves.toBe(0);
  });
});
