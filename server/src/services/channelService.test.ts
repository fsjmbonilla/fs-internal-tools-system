import { eq } from 'drizzle-orm';
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
  removeChannelMember,
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

    const chan = await createChannel({
      name: 'ops-general',
      isPrivate: false,
      departmentId: deptId,
      createdBy: owner,
    });
    expect(await isChannelMember(chan.id, existingMember)).toBe(true);
    expect(await isChannelMember(chan.id, owner)).toBe(true);
  });

  it('DMs are found-or-created idempotently regardless of argument order', async () => {
    const a = await seedUser('a@flowerstore.ph');
    const b = await seedUser('b@flowerstore.ph');
    const dm1 = await findOrCreateDm(a, b);
    const dm2 = await findOrCreateDm(b, a);
    expect(dm1.id).toBe(dm2.id);
    expect(dm1.type).toBe('dm');
    const rows = await db
      .select()
      .from(channelMembers)
      .where(eq(channelMembers.channelId, dm1.id));
    expect(rows.map((r) => r.userId).sort((x, y) => x - y)).toEqual([a, b].sort((x, y) => x - y));
  });

  it('member add/remove works', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const u = await seedUser('u@flowerstore.ph');
    const chan = await createChannel({ name: 'g2', isPrivate: false, createdBy: owner });
    await addChannelMember(chan.id, u);
    expect(await isChannelMember(chan.id, u)).toBe(true);
    await removeChannelMember(chan.id, u);
    expect(await isChannelMember(chan.id, u)).toBe(false);
  });
});
