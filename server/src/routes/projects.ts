import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { tasks as tasksTable } from '../db/schema/index.js';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { createDoc, deleteDoc, getDoc, listDocs, updateDoc } from '../services/docService.js';
import {
  addProjectMember,
  createProject,
  getVisibleProject,
  listVisibleProjects,
  removeProjectMember,
  updateProject,
} from '../services/projectService.js';
import {
  addComment,
  createDefaultColumns,
  createTask,
  getBoard,
  listComments,
  moveTask,
  updateTask,
} from '../services/taskService.js';

export const projectsRouter = Router();
projectsRouter.use(requireAuth);

function parseId(raw: string | string[]): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'validation_error', 'Bad id');
  return id;
}

async function requireVisibleProject(projectId: number, userId: number, isAdmin: boolean) {
  const project = await getVisibleProject(projectId, userId, isAdmin);
  if (!project) throw new AppError(404, 'not_found', 'Not found');
  return project;
}

projectsRouter.get('/', async (req, res) => {
  const projects = await listVisibleProjects(req.auth!.userId, req.auth!.role === 'admin');
  res.json({ projects });
});

const createBody = z.object({
  name: z.string().min(1).max(120),
  isPrivate: z.boolean(),
  description: z.string().max(2000).optional(),
  departmentId: z.number().int().positive().optional(),
});

projectsRouter.post('/', validate(createBody), async (req, res) => {
  const input = req.valid as z.infer<typeof createBody>;
  const project = await createProject({ ...input, createdBy: req.auth!.userId });
  await createDefaultColumns(project.id);
  res.status(201).json({ project });
});

projectsRouter.get('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const project = await requireVisibleProject(id, req.auth!.userId, req.auth!.role === 'admin');
  res.json({ project });
});

const patchBody = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
});

projectsRouter.patch('/:id', validate(patchBody), async (req, res) => {
  const id = parseId(req.params.id);
  const isAdmin = req.auth!.role === 'admin';
  await requireVisibleProject(id, req.auth!.userId, isAdmin);
  await updateProject(id, req.valid as z.infer<typeof patchBody>);
  const project = await getVisibleProject(id, req.auth!.userId, true);
  res.json({ project });
});

const memberBody = z.object({ userId: z.number().int().positive() });

projectsRouter.post('/:id/members', validate(memberBody), async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleProject(id, req.auth!.userId, req.auth!.role === 'admin');
  await addProjectMember(id, (req.valid as z.infer<typeof memberBody>).userId);
  res.status(201).json({ ok: true });
});

projectsRouter.delete('/:id/members/:userId', async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleProject(id, req.auth!.userId, req.auth!.role === 'admin');
  await removeProjectMember(id, parseId(req.params.userId));
  res.json({ ok: true });
});

projectsRouter.get('/:id/board', async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleProject(id, req.auth!.userId, req.auth!.role === 'admin');
  res.json(await getBoard(id));
});

const taskBody = z.object({
  columnId: z.number().int().positive(),
  title: z.string().min(1).max(300),
  description: z.string().max(10000).optional(),
  assigneeId: z.number().int().positive().optional(),
  dueDate: z.string().date().optional(),
});

projectsRouter.post('/:id/tasks', validate(taskBody), async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleProject(id, req.auth!.userId, req.auth!.role === 'admin');
  const input = req.valid as z.infer<typeof taskBody>;
  const task = await createTask({ projectId: id, ...input, createdBy: req.auth!.userId });
  res.status(201).json({ task });
});

const docBody = z.object({
  title: z.string().min(1).max(200),
  content: z.string().max(200000).optional(),
});

projectsRouter.post('/:id/docs', validate(docBody), async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleProject(id, req.auth!.userId, req.auth!.role === 'admin');
  const input = req.valid as z.infer<typeof docBody>;
  const doc = await createDoc({ projectId: id, ...input, userId: req.auth!.userId });
  res.status(201).json({ doc });
});

projectsRouter.get('/:id/docs', async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleProject(id, req.auth!.userId, req.auth!.role === 'admin');
  res.json({ docs: await listDocs(id) });
});

export const docsRouter = Router();
docsRouter.use(requireAuth);

async function requireVisibleDoc(docId: number, userId: number, isAdmin: boolean) {
  const doc = await getDoc(docId);
  if (!doc) throw new AppError(404, 'not_found', 'Not found');
  await requireVisibleProject(doc.projectId, userId, isAdmin);
  return doc;
}

docsRouter.get('/:id', async (req, res) => {
  const doc = await requireVisibleDoc(parseId(req.params.id), req.auth!.userId, req.auth!.role === 'admin');
  res.json({ doc });
});

const docPatch = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.string().max(200000).optional(),
});

docsRouter.patch('/:id', validate(docPatch), async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleDoc(id, req.auth!.userId, req.auth!.role === 'admin');
  await updateDoc(id, req.valid as z.infer<typeof docPatch>, req.auth!.userId);
  res.json({ doc: await getDoc(id) });
});

docsRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleDoc(id, req.auth!.userId, req.auth!.role === 'admin');
  await deleteDoc(id);
  res.json({ ok: true });
});

export const tasksRouter = Router();
tasksRouter.use(requireAuth);

// Tasks don't carry visibility metadata directly — defense-in-depth is via
// task.projectId once loaded, mirroring requireVisibleDoc's pattern.
async function requireVisibleTask(taskId: number, userId: number, isAdmin: boolean) {
  const [row] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
  if (!row) throw new AppError(404, 'not_found', 'Not found');
  await requireVisibleProject(row.projectId, userId, isAdmin);
  return row;
}

const taskPatch = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(10000).nullable().optional(),
  assigneeId: z.number().int().positive().nullable().optional(),
  dueDate: z.string().date().nullable().optional(),
});

tasksRouter.get('/:id', async (req, res) => {
  const task = await requireVisibleTask(parseId(req.params.id), req.auth!.userId, req.auth!.role === 'admin');
  res.json({ task });
});

tasksRouter.patch('/:id', validate(taskPatch), async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleTask(id, req.auth!.userId, req.auth!.role === 'admin');
  const task = await updateTask(id, req.valid as z.infer<typeof taskPatch>);
  res.json({ task });
});

tasksRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleTask(id, req.auth!.userId, req.auth!.role === 'admin');
  await db.delete(tasksTable).where(eq(tasksTable.id, id));
  res.json({ ok: true });
});

const moveBody = z.object({
  columnId: z.number().int().positive(),
  beforeTaskId: z.number().int().positive().optional(),
  afterTaskId: z.number().int().positive().optional(),
});

tasksRouter.post('/:id/move', validate(moveBody), async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleTask(id, req.auth!.userId, req.auth!.role === 'admin');
  const { columnId, beforeTaskId, afterTaskId } = req.valid as z.infer<typeof moveBody>;
  await moveTask(id, columnId, beforeTaskId, afterTaskId);
  res.json({ ok: true });
});

const commentBody = z.object({ body: z.string().min(1).max(4000) });

tasksRouter.post('/:id/comments', validate(commentBody), async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleTask(id, req.auth!.userId, req.auth!.role === 'admin');
  const comment = await addComment(id, req.auth!.userId, (req.valid as z.infer<typeof commentBody>).body);
  res.status(201).json({ comment });
});

tasksRouter.get('/:id/comments', async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleTask(id, req.auth!.userId, req.auth!.role === 'admin');
  res.json({ comments: await listComments(id) });
});
