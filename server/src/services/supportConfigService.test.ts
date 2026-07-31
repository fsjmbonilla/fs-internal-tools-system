import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { createChannel } from './channelService.js';
import { createProject } from './projectService.js';
import {
  getSupportConfig,
  resolveIntakeColumnId,
  upsertSupportConfig,
} from './supportConfigService.js';
import { createDefaultColumns, getBoard } from './taskService.js';

async function seedUser(email: string) {
  const [{ id }] = await db
    .insert(users)
    .values({ email, passwordHash: 'x', displayName: email.split('@')[0] })
    .$returningId();
  return id;
}

describe('supportConfigService', () => {
  beforeEach(resetDb);

  it('resolveIntakeColumnId returns the lowest-position column, or null with no columns', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const project = await createProject({ name: 'P', isPrivate: false, createdBy: owner });
    expect(await resolveIntakeColumnId(project.id)).toBeNull();

    await createDefaultColumns(project.id);
    const board = await getBoard(project.id);
    const lowest = [...board.columns].sort((a, b) => a.position - b.position)[0];
    expect(await resolveIntakeColumnId(project.id)).toBe(lowest.id);
  });

  it('upserts a config and reads it back', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const project = await createProject({ name: 'P2', isPrivate: false, createdBy: owner });
    await createDefaultColumns(project.id);
    const intakeColumnId = (await resolveIntakeColumnId(project.id))!;
    const channel = await createChannel({ name: 'help', isPrivate: false, createdBy: owner });

    const created = await upsertSupportConfig({
      channelId: channel.id,
      projectId: project.id,
      intakeColumnId,
      instructions: 'Ask for the branch.',
    });
    expect(created.aiEnabled).toBe(true);
    expect(created.instructions).toBe('Ask for the branch.');

    const fetched = await getSupportConfig(channel.id);
    expect(fetched?.projectId).toBe(project.id);
    expect(fetched?.intakeColumnId).toBe(intakeColumnId);
  });

  it('upsert is idempotent per channel and overwrites settings', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const project = await createProject({ name: 'P3', isPrivate: false, createdBy: owner });
    await createDefaultColumns(project.id);
    const intakeColumnId = (await resolveIntakeColumnId(project.id))!;
    const channel = await createChannel({ name: 'help3', isPrivate: false, createdBy: owner });

    await upsertSupportConfig({ channelId: channel.id, projectId: project.id, intakeColumnId });
    const updated = await upsertSupportConfig({
      channelId: channel.id,
      projectId: project.id,
      intakeColumnId,
      aiEnabled: false,
      instructions: 'Paused.',
    });
    expect(updated.aiEnabled).toBe(false);
    expect(updated.instructions).toBe('Paused.');
  });

  it('getSupportConfig returns null for a non-support channel', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const channel = await createChannel({ name: 'general', isPrivate: false, createdBy: owner });
    expect(await getSupportConfig(channel.id)).toBeNull();
  });
});
