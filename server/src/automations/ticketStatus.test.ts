/**
 * A ticket's status goes back to the conversation it came from.
 *
 * Someone reports a problem in a support channel and the AI files a ticket —
 * after that they had no way to learn whether anyone picked it up short of
 * opening a kanban board they may not even be a member of.
 */

import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { resetDb } from '../db/testUtils.js';
import { ensureBotUser } from '../services/botService.js';
import { createTask, moveTask } from '../services/taskService.js';
import { getMessagesBefore } from '../services/messageService.js';
import { makeUser } from '../testHelpers.js';
import { registerTicketStatus } from './ticketStatus.js';

const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` } as Record<string, string>);

// The automation registers a listener on the shared bus; once is enough.
registerTicketStatus();

/** Wait for the fire-and-forget announcement to land. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
}

async function scenario() {
  const user = await makeUser(app, { email: `t${Date.now()}@flowerstore.ph` });
  await ensureBotUser();

  const project = await request(app)
    .post('/api/projects')
    .set(auth(user.token))
    .send({ name: 'Ops', isPrivate: false });
  const projectId = project.body.project.id;
  const board = await request(app).get(`/api/projects/${projectId}/board`).set(auth(user.token));
  const [todo, inProgress] = board.body.columns.map((c: { id: number }) => c.id);

  const channel = await request(app)
    .post('/api/channels')
    .set(auth(user.token))
    .send({ name: `help${Date.now()}`, isPrivate: false });
  const channelId = channel.body.channel.id;

  return { user, projectId, channelId, todo, inProgress };
}

describe('ticket status announcements', () => {
  beforeEach(resetDb);

  it('posts the new status to the originating channel', async () => {
    const s = await scenario();
    const ticket = await createTask({
      projectId: s.projectId,
      columnId: s.todo,
      title: 'Fix the AC leak',
      createdBy: s.user.userId,
      originChannelId: s.channelId,
      source: 'support',
    });

    await moveTask(ticket.id, s.inProgress, undefined, undefined, s.user.userId);
    await settle();

    const messages = await getMessagesBefore(s.channelId, null, 20);
    const announcement = messages.find((m) => m.body.includes(`#${ticket.id}`));
    expect(announcement, 'the origin channel should hear about the move').toBeDefined();
    expect(announcement?.body).toContain('Fix the AC leak');
    expect(announcement?.body).toContain('In Progress');
    // Names the person and where it came from, so the update reads as an update.
    expect(announcement?.body).toContain('Todo');
    expect(announcement?.body).toMatch(/moved/);
  });

  it('says nothing when a task is only reordered inside its column', async () => {
    const s = await scenario();
    const ticket = await createTask({
      projectId: s.projectId,
      columnId: s.todo,
      title: 'Reorder me',
      createdBy: s.user.userId,
      originChannelId: s.channelId,
      source: 'support',
    });
    const other = await createTask({
      projectId: s.projectId,
      columnId: s.todo,
      title: 'Neighbour',
      createdBy: s.user.userId,
    });

    // Same column — a drag within a list, not a status change.
    await moveTask(ticket.id, s.todo, other.id, undefined, s.user.userId);
    await settle();

    const messages = await getMessagesBefore(s.channelId, null, 20);
    expect(messages.filter((m) => m.body.includes(`#${ticket.id}`))).toHaveLength(0);
  });

  it('says nothing for a manually created task', async () => {
    // A task nobody reported in chat has no conversation to report back to.
    const s = await scenario();
    const task = await createTask({
      projectId: s.projectId,
      columnId: s.todo,
      title: 'Internal chore',
      createdBy: s.user.userId,
    });

    await moveTask(task.id, s.inProgress, undefined, undefined, s.user.userId);
    await settle();

    const messages = await getMessagesBefore(s.channelId, null, 20);
    expect(messages).toHaveLength(0);
  });

  it('survives the origin channel having been deleted', async () => {
    const s = await scenario();
    const ticket = await createTask({
      projectId: s.projectId,
      columnId: s.todo,
      title: 'Orphaned',
      createdBy: s.user.userId,
      // A channel id that does not exist — the same shape as one deleted since.
      originChannelId: 999_999,
      source: 'support',
    });

    // The move itself must still succeed; the announcement is best-effort.
    await expect(
      moveTask(ticket.id, s.inProgress, undefined, undefined, s.user.userId),
    ).resolves.toBeUndefined();
    await settle();
  });
});
