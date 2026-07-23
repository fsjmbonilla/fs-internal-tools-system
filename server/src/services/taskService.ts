import { asc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { taskColumns, taskComments, tasks, users } from '../db/schema/index.js';

export interface ColumnDto {
  id: number;
  name: string;
  position: number;
}

export interface TaskDto {
  id: number;
  projectId: number;
  columnId: number;
  title: string;
  description: string | null;
  assigneeId: number | null;
  dueDate: string | null;
  position: number;
}

export interface CommentDto {
  id: number;
  taskId: number;
  userId: number;
  displayName: string;
  body: string;
  createdAt: Date;
}

const GAP = 1000;
const MIN_GAP = 1e-6;

export async function createDefaultColumns(projectId: number): Promise<void> {
  await db.insert(taskColumns).values([
    { projectId, name: 'Todo', position: 0 },
    { projectId, name: 'In Progress', position: GAP },
    { projectId, name: 'Done', position: GAP * 2 },
  ]);
}

function toColumnDto(row: typeof taskColumns.$inferSelect): ColumnDto {
  return { id: row.id, name: row.name, position: row.position };
}

function toTaskDto(row: typeof tasks.$inferSelect): TaskDto {
  return {
    id: row.id,
    projectId: row.projectId,
    columnId: row.columnId,
    title: row.title,
    description: row.description,
    assigneeId: row.assigneeId,
    dueDate: row.dueDate,
    position: row.position,
  };
}

export async function getBoard(
  projectId: number,
): Promise<{ columns: ColumnDto[]; tasks: TaskDto[] }> {
  const columns = await db
    .select()
    .from(taskColumns)
    .where(eq(taskColumns.projectId, projectId))
    .orderBy(asc(taskColumns.position));
  const taskRows = await db.select().from(tasks).where(eq(tasks.projectId, projectId));
  return { columns: columns.map(toColumnDto), tasks: taskRows.map(toTaskDto) };
}

async function maxPositionInColumn(columnId: number): Promise<number> {
  const rows = await db
    .select({ position: tasks.position })
    .from(tasks)
    .where(eq(tasks.columnId, columnId));
  return rows.length ? Math.max(...rows.map((r) => r.position)) : -GAP;
}

export async function createTask(input: {
  projectId: number;
  columnId: number;
  title: string;
  description?: string;
  assigneeId?: number;
  dueDate?: string;
  createdBy: number;
}): Promise<TaskDto> {
  const position = (await maxPositionInColumn(input.columnId)) + GAP;
  const [{ id }] = await db
    .insert(tasks)
    .values({
      projectId: input.projectId,
      columnId: input.columnId,
      title: input.title,
      description: input.description,
      assigneeId: input.assigneeId,
      dueDate: input.dueDate,
      position,
      createdBy: input.createdBy,
    })
    .$returningId();
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
  return toTaskDto(row);
}

export async function updateTask(
  id: number,
  patch: {
    title?: string;
    description?: string | null;
    assigneeId?: number | null;
    dueDate?: string | null;
  },
): Promise<TaskDto | null> {
  await db.update(tasks).set(patch).where(eq(tasks.id, id));
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
  return row ? toTaskDto(row) : null;
}

async function renormalizeColumn(columnId: number): Promise<void> {
  const rows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.columnId, columnId))
    .orderBy(asc(tasks.position));
  for (let i = 0; i < rows.length; i++) {
    await db.update(tasks).set({ position: i * GAP }).where(eq(tasks.id, rows[i].id));
  }
}

export async function moveTask(
  taskId: number,
  columnId: number,
  beforeTaskId?: number,
  afterTaskId?: number,
): Promise<void> {
  async function computePosition(): Promise<number> {
    const before = beforeTaskId
      ? (await db.select().from(tasks).where(eq(tasks.id, beforeTaskId)))[0]
      : undefined;
    const after = afterTaskId
      ? (await db.select().from(tasks).where(eq(tasks.id, afterTaskId)))[0]
      : undefined;
    if (before && after) return (before.position + after.position) / 2;
    if (before) return before.position + GAP;
    if (after) return after.position - GAP;
    return (await maxPositionInColumn(columnId)) + GAP;
  }

  let position = await computePosition();

  if (beforeTaskId && afterTaskId) {
    const before = (await db.select().from(tasks).where(eq(tasks.id, beforeTaskId)))[0];
    const after = (await db.select().from(tasks).where(eq(tasks.id, afterTaskId)))[0];
    if (Math.abs(before.position - after.position) < MIN_GAP) {
      await renormalizeColumn(columnId);
      position = await computePosition();
    }
  }

  await db.update(tasks).set({ columnId, position }).where(eq(tasks.id, taskId));
}

export async function addComment(taskId: number, userId: number, body: string): Promise<CommentDto> {
  const [{ id }] = await db.insert(taskComments).values({ taskId, userId, body }).$returningId();
  const [row] = await db
    .select({
      id: taskComments.id,
      taskId: taskComments.taskId,
      userId: taskComments.userId,
      body: taskComments.body,
      createdAt: taskComments.createdAt,
      displayName: users.displayName,
    })
    .from(taskComments)
    .innerJoin(users, eq(users.id, taskComments.userId))
    .where(eq(taskComments.id, id));
  return row;
}

export async function listComments(taskId: number): Promise<CommentDto[]> {
  return db
    .select({
      id: taskComments.id,
      taskId: taskComments.taskId,
      userId: taskComments.userId,
      body: taskComments.body,
      createdAt: taskComments.createdAt,
      displayName: users.displayName,
    })
    .from(taskComments)
    .innerJoin(users, eq(users.id, taskComments.userId))
    .where(eq(taskComments.taskId, taskId))
    .orderBy(asc(taskComments.createdAt));
}
