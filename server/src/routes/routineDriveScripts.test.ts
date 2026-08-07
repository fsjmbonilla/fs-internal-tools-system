/**
 * Drive-script routines.
 *
 * The property under test is invariant 9 wearing a schedule: the API process
 * fetches the owner's .py from Drive and QUEUES it — a scripts row plus a
 * queued script_runs row for the runner service to claim — and never executes
 * anything itself. Around that: the fetch uses the OWNER's Google connection,
 * every pre-queue rejection (not connected, file gone, not Python, oversized)
 * is recorded as a failed routine run, and the runner reporting back through
 * finishRun completes the routine run with the script's output.
 */

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { db } from '../db/index.js';
import { routines, scriptRuns, scripts } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { makeFakeGoogle, type FakeGoogle } from '../services/google/fake.js';
import { setGooglePortForTesting } from '../services/google/port.js';
import { finishRun } from '../services/scriptService.js';
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

/** A user whose Google connection exists, so routines they own can reach Drive. */
async function connectedUser(opts: { admin?: boolean; email?: string } = {}) {
  const user = await makeUser(app, opts);
  const urlRes = await request(app).get('/api/google/auth-url').set(auth(user.token));
  const state = new URL(urlRes.body.url).searchParams.get('state')!;
  await request(app).get(`/api/google/callback?code=good-code&state=${state}`);
  return user;
}

/** A .py file in the fake Drive whose export returns `source`. */
function addPyFile(name: string, source: string) {
  const file = fake.addDriveFile({ name, mimeType: 'text/x-python' });
  fake.uploads.set(file.id, Buffer.from(source));
  return file;
}

async function makeDriveRoutine(token: string, body: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/api/routines')
    .set(auth(token))
    .send({
      name: 'Nightly export',
      kind: 'drive_script',
      // Once a day, so no cron tick can fire mid-test.
      schedule: '0 8 * * *',
      scopes: [],
      scriptScopes: ['tickets:read'],
      ...body,
    });
  return res;
}

describe('creating and updating a drive_script routine', () => {
  it('rejects drive_script without a driveFileId, and a bad script scope', async () => {
    const user = await makeUser(app, { email: 'ds-val@flowerstore.ph' });

    const noFile = await makeDriveRoutine(user.token);
    expect(noFile.status).toBe(400);
    expect(noFile.body.error.code).toBe('validation_error');

    const badScope = await makeDriveRoutine(user.token, {
      driveFileId: 'df_x',
      scriptScopes: ['notes:read'],
    });
    expect(badScope.status).toBe(400);
    expect(badScope.body.error.code).toBe('validation_error');
  });

  it('still requires a prompt for an AI routine', async () => {
    const user = await makeUser(app, { email: 'ds-ai@flowerstore.ph' });
    const res = await request(app)
      .post('/api/routines')
      .set(auth(user.token))
      .send({ name: 'No prompt', schedule: '0 8 * * *', scopes: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('creates one without a prompt, and refuses a patch to drive_script with no file', async () => {
    const user = await makeUser(app, { email: 'ds-create@flowerstore.ph' });
    const res = await makeDriveRoutine(user.token, {
      driveFileId: 'df_1',
      driveFileName: 'daily.py',
    });
    expect(res.status).toBe(201);
    expect(res.body.routine.kind).toBe('drive_script');
    expect(res.body.routine.driveFileId).toBe('df_1');
    expect(res.body.routine.scriptScopes).toEqual(['tickets:read']);

    // An AI routine flipped to drive_script must bring a file with it.
    const ai = await request(app)
      .post('/api/routines')
      .set(auth(user.token))
      .send({ name: 'Was AI', prompt: 'do things', schedule: '0 8 * * *', scopes: [] });
    const flip = await request(app)
      .patch(`/api/routines/${ai.body.routine.id}`)
      .set(auth(user.token))
      .send({ kind: 'drive_script' });
    expect(flip.status).toBe(400);
  });
});

describe('running a drive_script routine', () => {
  it('fetches via the owner and queues a sandbox run — nothing executes here', async () => {
    const owner = await connectedUser({ email: 'ds-run@flowerstore.ph' });
    const file = addPyFile('daily.py', 'print("hello routine")');
    const created = await makeDriveRoutine(owner.token, {
      driveFileId: file.id,
      driveFileName: file.name,
    });
    const routineId = created.body.routine.id as number;

    const res = await request(app).post(`/api/routines/${routineId}/run`).set(auth(owner.token));
    expect(res.status).toBe(201);
    // Still running: the queued sandbox run settles it, not this request.
    expect(res.body.run.status).toBe('running');
    expect(res.body.run.scriptRunId).toEqual(expect.any(Number));
    expect(res.body.run.transcript[0]).toMatchObject({
      type: 'script_queued',
      fileName: 'daily.py',
    });

    // The managed scripts row carries the FETCHED source and the routine's scopes.
    const [script] = await db.select().from(scripts);
    expect(script.name).toBe('[routine] Nightly export');
    expect(script.source).toBe('print("hello routine")');
    expect(script.scopes).toEqual(['tickets:read']);

    // Queued for the runner — not run: no started/finished, status queued.
    const [queued] = await db.select().from(scriptRuns);
    expect(queued.id).toBe(res.body.run.scriptRunId);
    expect(queued.scriptId).toBe(script.id);
    expect(queued.status).toBe('queued');

    const [row] = await db.select().from(routines).where(eq(routines.id, routineId));
    expect(row.managedScriptId).toBe(script.id);

    // The runner reports back → the routine run completes with the output.
    await finishRun(queued.id, {
      status: 'succeeded',
      exitCode: 0,
      stdout: 'hello routine\n',
      stderr: '',
    });
    const runs = await request(app).get(`/api/routines/${routineId}/runs`).set(auth(owner.token));
    expect(runs.body.runs[0].status).toBe('succeeded');
    const result = (runs.body.runs[0].transcript as { type: string; stdout?: string }[]).find(
      (e) => e.type === 'script_result',
    );
    expect(result?.stdout).toBe('hello routine\n');
  });

  it('reuses its managed script and refreshes the source from Drive each run', async () => {
    const owner = await connectedUser({ email: 'ds-reuse@flowerstore.ph' });
    const file = addPyFile('daily.py', 'print(1)');
    const created = await makeDriveRoutine(owner.token, { driveFileId: file.id });
    const routineId = created.body.routine.id as number;

    await request(app).post(`/api/routines/${routineId}/run`).set(auth(owner.token));
    // The file changes in Drive; the next tick must run the new code.
    fake.uploads.set(file.id, Buffer.from('print(2)'));
    await request(app).post(`/api/routines/${routineId}/run`).set(auth(owner.token));

    const scriptRows = await db.select().from(scripts);
    expect(scriptRows).toHaveLength(1);
    expect(scriptRows[0].source).toBe('print(2)');
    expect(await db.select().from(scriptRuns)).toHaveLength(2);
  });

  it('fails the run when the owner has no Google connection', async () => {
    const owner = await makeUser(app, { email: 'ds-nogoogle@flowerstore.ph' });
    const created = await makeDriveRoutine(owner.token, { driveFileId: 'df_any' });

    const res = await request(app)
      .post(`/api/routines/${created.body.routine.id}/run`)
      .set(auth(owner.token));
    expect(res.body.run.status).toBe('failed');
    expect(res.body.run.error).toMatch(/Google/i);
    expect(await db.select().from(scriptRuns)).toHaveLength(0);
  });

  it('fails the run when the file is gone, not Python, or too large', async () => {
    const owner = await connectedUser({ email: 'ds-badfile@flowerstore.ph' });

    const gone = await makeDriveRoutine(owner.token, { name: 'Gone', driveFileId: 'nope' });
    const goneRun = await request(app)
      .post(`/api/routines/${gone.body.routine.id}/run`)
      .set(auth(owner.token));
    expect(goneRun.body.run.status).toBe('failed');
    expect(goneRun.body.run.error).toMatch(/not found/i);

    const txt = fake.addDriveFile({ name: 'notes.txt', mimeType: 'text/plain' });
    const notPy = await makeDriveRoutine(owner.token, { name: 'Txt', driveFileId: txt.id });
    const notPyRun = await request(app)
      .post(`/api/routines/${notPy.body.routine.id}/run`)
      .set(auth(owner.token));
    expect(notPyRun.body.run.status).toBe('failed');
    expect(notPyRun.body.run.error).toMatch(/\.py/);

    const big = fake.addDriveFile({ name: 'big.py', mimeType: 'text/x-python' });
    fake.uploads.set(big.id, Buffer.alloc(200 * 1024 + 1, 0x61));
    const huge = await makeDriveRoutine(owner.token, { name: 'Big', driveFileId: big.id });
    const hugeRun = await request(app)
      .post(`/api/routines/${huge.body.routine.id}/run`)
      .set(auth(owner.token));
    expect(hugeRun.body.run.status).toBe('failed');
    expect(hugeRun.body.run.error).toMatch(/KB/);

    // None of the rejections reached the queue.
    expect(await db.select().from(scriptRuns)).toHaveLength(0);
  });

  it('deleting the routine removes its managed script', async () => {
    const owner = await connectedUser({ email: 'ds-del@flowerstore.ph' });
    const file = addPyFile('daily.py', 'print(1)');
    const created = await makeDriveRoutine(owner.token, { driveFileId: file.id });
    const routineId = created.body.routine.id as number;
    await request(app).post(`/api/routines/${routineId}/run`).set(auth(owner.token));
    expect(await db.select().from(scripts)).toHaveLength(1);

    await request(app).delete(`/api/routines/${routineId}`).set(auth(owner.token));
    expect(await db.select().from(scripts)).toHaveLength(0);
  });
});
