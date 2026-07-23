import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/index.js';
import { departmentMembers, departments, projectMembers, users } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import {
  addProjectMember,
  createProject,
  getVisibleProject,
  isProjectMember,
  listVisibleProjects,
  removeProjectMember,
} from './projectService.js';

async function seedUser(email: string) {
  const [{ id }] = await db
    .insert(users)
    .values({ email, passwordHash: 'x', displayName: email.split('@')[0] })
    .$returningId();
  return id;
}

describe('projectService', () => {
  beforeEach(resetDb);

  it('lists public projects to everyone, hides private ones from non-members', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const outsider = await seedUser('outsider@flowerstore.ph');
    await createProject({ name: 'Public Proj', isPrivate: false, createdBy: owner });
    const priv = await createProject({ name: 'Secret Proj', isPrivate: true, createdBy: owner });

    expect((await listVisibleProjects(outsider, false)).map((p) => p.name)).toEqual(['Public Proj']);
    expect(await getVisibleProject(priv.id, outsider, false)).toBeNull();
    expect(await getVisibleProject(priv.id, owner, false)).not.toBeNull();
    expect(await getVisibleProject(priv.id, outsider, true)).not.toBeNull();
  });

  it('department members see department-owned private projects', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const deptUser = await seedUser('deptuser@flowerstore.ph');
    const [{ id: deptId }] = await db.insert(departments).values({ name: 'Mkt' }).$returningId();
    await db.insert(departmentMembers).values({ departmentId: deptId, userId: deptUser });
    const proj = await createProject({
      name: 'Dept Proj',
      isPrivate: true,
      departmentId: deptId,
      createdBy: owner,
    });
    expect(await getVisibleProject(proj.id, deptUser, false)).not.toBeNull();
  });

  it('creating a department project auto-joins existing department members, plus the creator as lead', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const existingMember = await seedUser('existing@flowerstore.ph');
    const [{ id: deptId }] = await db.insert(departments).values({ name: 'Ops' }).$returningId();
    await db.insert(departmentMembers).values({ departmentId: deptId, userId: existingMember });

    const proj = await createProject({
      name: 'Ops Proj',
      isPrivate: false,
      departmentId: deptId,
      createdBy: owner,
    });
    expect(await isProjectMember(proj.id, existingMember)).toBe(true);
    expect(await isProjectMember(proj.id, owner)).toBe(true);
    const [ownerRow] = await db.select().from(projectMembers).where(eq(projectMembers.userId, owner));
    expect(ownerRow.role).toBe('lead');
  });

  it('member add/remove works', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const u = await seedUser('u@flowerstore.ph');
    const proj = await createProject({ name: 'P2', isPrivate: false, createdBy: owner });
    await addProjectMember(proj.id, u);
    expect(await isProjectMember(proj.id, u)).toBe(true);
    await removeProjectMember(proj.id, u);
    expect(await isProjectMember(proj.id, u)).toBe(false);
  });
});
