import { and, eq, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { departmentMembers, projectMembers, projects } from '../db/schema/index.js';

export type ProjectRow = typeof projects.$inferSelect;

/** Public OR member OR belongs to the owning department. Admins bypass at the call site.
 * Same shape as channelService.visibilityCondition — kept as a separate copy because
 * projects and channels are different tables, but the rule must match exactly. */
export function visibilityCondition(userId: number) {
  return or(
    eq(projects.isPrivate, false),
    sql`EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = projects.id AND pm.user_id = ${userId})`,
    and(
      sql`projects.department_id IS NOT NULL`,
      sql`EXISTS (SELECT 1 FROM department_members dm WHERE dm.department_id = projects.department_id AND dm.user_id = ${userId})`,
    ),
  );
}

export async function listVisibleProjects(userId: number, isAdmin: boolean) {
  const query = db.select().from(projects).orderBy(projects.name);
  return isAdmin ? query : query.where(visibilityCondition(userId));
}

export async function getVisibleProject(
  projectId: number,
  userId: number,
  isAdmin: boolean,
): Promise<ProjectRow | null> {
  const where = isAdmin
    ? eq(projects.id, projectId)
    : and(eq(projects.id, projectId), visibilityCondition(userId));
  const [row] = await db.select().from(projects).where(where);
  return row ?? null;
}

export async function isProjectMember(projectId: number, userId: number): Promise<boolean> {
  const [row] = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  return Boolean(row);
}

export async function addProjectMember(
  projectId: number,
  userId: number,
  role: 'lead' | 'member' = 'member',
): Promise<void> {
  await db
    .insert(projectMembers)
    .values({ projectId, userId, role })
    .onDuplicateKeyUpdate({ set: { role: sql`role` } });
}

export async function removeProjectMember(projectId: number, userId: number): Promise<void> {
  await db
    .delete(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
}

export async function createProject(input: {
  name: string;
  isPrivate: boolean;
  description?: string;
  departmentId?: number;
  createdBy: number;
}): Promise<ProjectRow> {
  const [{ id }] = await db
    .insert(projects)
    .values({
      name: input.name,
      isPrivate: input.isPrivate,
      description: input.description,
      departmentId: input.departmentId,
      createdBy: input.createdBy,
    })
    .$returningId();
  await addProjectMember(id, input.createdBy, 'lead');
  if (input.departmentId) {
    const members = await db
      .select({ userId: departmentMembers.userId })
      .from(departmentMembers)
      .where(eq(departmentMembers.departmentId, input.departmentId));
    for (const m of members) await addProjectMember(id, m.userId);
  }
  const [row] = await db.select().from(projects).where(eq(projects.id, id));
  return row;
}

export async function updateProject(
  id: number,
  patch: { name?: string; description?: string | null },
): Promise<void> {
  await db.update(projects).set(patch).where(eq(projects.id, id));
}

export async function archiveProject(id: number): Promise<void> {
  await db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, id));
}
