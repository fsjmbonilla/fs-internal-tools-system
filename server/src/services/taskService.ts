import { asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { attachments, taskColumns, taskComments, tasks, users } from '../db/schema/index.js';
import { AppError } from '../middleware/errorHandler.js';
import { linkAttachment } from './attachmentService.js';

export interface ColumnDto {
  id: number;
  name: string;
  position: number;
}

export interface AttachmentInfo {
  id: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
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
  attachments: AttachmentInfo[];
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

function toTaskDto(row: typeof tasks.$inferSelect, taskAttachments: AttachmentInfo[]): TaskDto {
  return {
    id: row.id,
    projectId: row.projectId,
    columnId: row.columnId,
    title: row.title,
    description: row.description,
    assigneeId: row.assigneeId,
    dueDate: row.dueDate,
    position: row.position,
    attachments: taskAttachments,
  };
}

async function hydrateAttachments(taskIds: number[]): Promise<Map<number, AttachmentInfo[]>> {
  const map = new Map<number, AttachmentInfo[]>();
  if (taskIds.length === 0) return map;
  const rows = await db.select().from(attachments).where(inArray(attachments.taskId, taskIds));
  for (const r of rows) {
    const list = map.get(r.taskId!) ?? [];
    list.push({ id: r.id, fileName: r.fileName, mimeType: r.mimeType, sizeBytes: r.sizeBytes });
    map.set(r.taskId!, list);
  }
  return map;
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
  const attachmentsByTask = await hydrateAttachments(taskRows.map((t) => t.id));
  return {
    columns: columns.map(toColumnDto),
    tasks: taskRows.map((t) => toTaskDto(t, attachmentsByTask.get(t.id) ?? [])),
  };
}

export async function getTaskById(id: number): Promise<TaskDto | null> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
  if (!row) return null;
  const attachmentsByTask = await hydrateAttachments([id]);
  return toTaskDto(row, attachmentsByTask.get(id) ?? []);
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
  attachmentIds?: number[];
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
  for (const attachmentId of input.attachmentIds ?? []) {
    const ok = await linkAttachment(attachmentId, input.createdBy, { taskId: id });
    if (!ok) throw new AppError(400, 'invalid_attachment', `Attachment ${attachmentId} could not be linked`);
  }
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
  const attachmentsByTask = await hydrateAttachments([id]);
  return toTaskDto(row, attachmentsByTask.get(id) ?? []);
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
  if (!row) return null;
  const attachmentsByTask = await hydrateAttachments([id]);
  return toTaskDto(row, attachmentsByTask.get(id) ?? []);
}

export async function addTaskAttachments(
  taskId: number,
  userId: number,
  attachmentIds: number[],
): Promise<boolean> {
  for (const attachmentId of attachmentIds) {
    const ok = await linkAttachment(attachmentId, userId, { taskId });
    if (!ok) return false;
  }
  return true;
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
