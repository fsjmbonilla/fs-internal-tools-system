import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { channelMembers, channels, departmentMembers, departments } from '../db/schema/index.js';

export async function createDepartment(input: { name: string; description?: string }) {
  const [{ id }] = await db.insert(departments).values(input).$returningId();
  const [row] = await db.select().from(departments).where(eq(departments.id, id));
  return row;
}

export async function updateDepartment(
  id: number,
  patch: { name?: string; description?: string | null },
) {
  await db.update(departments).set(patch).where(eq(departments.id, id));
  const [row] = await db.select().from(departments).where(eq(departments.id, id));
  return row ?? null;
}

export async function deleteDepartment(id: number): Promise<void> {
  await db.delete(departments).where(eq(departments.id, id));
}

export interface DepartmentWithMembers {
  id: number;
  name: string;
  description: string | null;
  members: { userId: number; role: 'lead' | 'member' }[];
}

export async function listDepartments(): Promise<DepartmentWithMembers[]> {
  const depts = await db.select().from(departments).orderBy(departments.name);
  const members = await db.select().from(departmentMembers);
  return depts.map((d) => ({
    id: d.id,
    name: d.name,
    description: d.description,
    members: members
      .filter((m) => m.departmentId === d.id)
      .map((m) => ({ userId: m.userId, role: m.role })),
  }));
}

export async function addMember(
  departmentId: number,
  userId: number,
  role: 'lead' | 'member' = 'member',
): Promise<void> {
  await db
    .insert(departmentMembers)
    .values({ departmentId, userId, role })
    .onDuplicateKeyUpdate({ set: { role } });
  const deptChannels = await db
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.departmentId, departmentId));
  for (const ch of deptChannels) {
    // "insert or ignore": update a key column to itself on duplicate
    await db
      .insert(channelMembers)
      .values({ channelId: ch.id, userId })
      .onDuplicateKeyUpdate({ set: { userId: sql`user_id` } });
  }
}

export async function removeMember(departmentId: number, userId: number): Promise<void> {
  await db
    .delete(departmentMembers)
    .where(
      and(eq(departmentMembers.departmentId, departmentId), eq(departmentMembers.userId, userId)),
    );
}

export async function isDepartmentLead(departmentId: number, userId: number): Promise<boolean> {
  const [row] = await db
    .select()
    .from(departmentMembers)
    .where(
      and(eq(departmentMembers.departmentId, departmentId), eq(departmentMembers.userId, userId)),
    );
  return row?.role === 'lead';
}
