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
