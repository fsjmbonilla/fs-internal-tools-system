import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/index.js';
import { channelMembers, channels, users } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { addMember, createDepartment, isDepartmentLead, removeMember } from './departmentService.js';

async function seedUser(email: string) {
  const [{ id }] = await db
    .insert(users)
    .values({ email, passwordHash: 'x', displayName: email.split('@')[0] })
    .$returningId();
  return id;
}

describe('departmentService', () => {
  beforeEach(resetDb);

  it('auto-joins new department members to department channels (idempotently)', async () => {
    const dept = await createDepartment({ name: 'Marketing' });
    const userId = await seedUser('m@flowerstore.ph');
    const [{ id: chanId }] = await db
      .insert(channels)
      .values({ name: 'mkt-general', departmentId: dept.id })
      .$returningId();
    await db.insert(channels).values({ name: 'unrelated' });

    await addMember(dept.id, userId);
    await addMember(dept.id, userId); // idempotent

    const memberships = await db
      .select()
      .from(channelMembers)
      .where(eq(channelMembers.userId, userId));
    expect(memberships).toHaveLength(1);
    expect(memberships[0].channelId).toBe(chanId);
  });

  it('tracks lead role and removes members', async () => {
    const dept = await createDepartment({ name: 'Ops' });
    const userId = await seedUser('lead@flowerstore.ph');
    await addMember(dept.id, userId, 'lead');
    expect(await isDepartmentLead(dept.id, userId)).toBe(true);
    await removeMember(dept.id, userId);
    expect(await isDepartmentLead(dept.id, userId)).toBe(false);
  });
});
