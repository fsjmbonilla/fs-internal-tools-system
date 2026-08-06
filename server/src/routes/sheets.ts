import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireScope } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { getVisibleProject, isProjectMember } from '../services/projectService.js';
import {
  canWrite,
  createSheet,
  deleteSheet,
  getLock,
  getSheet,
  getSheetSummary,
  isWorkbookSnapshot,
  listSheets,
  updateSheet,
} from '../services/sheetService.js';
import { getIo } from '../sockets/registry.js';

/**
 * Native spreadsheets.
 *
 * A sheet has no visibility of its own: it belongs to a project and answers to
 * that project's rule, exactly as docs do. Every guard below therefore resolves
 * the sheet's project first — reusing `getVisibleProject`, never a new WHERE
 * clause, so "invisible means 404" stays true here without a second copy of the
 * visibility SQL.
 */
export const sheetsRouter = Router();
sheetsRouter.use(requireAuth);

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

async function requireProjectMember(projectId: number, userId: number, isAdmin: boolean) {
  await requireVisibleProject(projectId, userId, isAdmin);
  if (isAdmin) return;
  if (!(await isProjectMember(projectId, userId))) {
    throw new AppError(403, 'forbidden', 'Only project members can change this project');
  }
}

/** The sheet, once its project has been checked. 404 for an invisible project. */
async function requireVisibleSheet(sheetId: number, userId: number, isAdmin: boolean) {
  const summary = await getSheetSummary(sheetId);
  if (!summary) throw new AppError(404, 'not_found', 'Not found');
  await requireVisibleProject(summary.projectId, userId, isAdmin);
  return summary;
}

async function requireSheetMember(sheetId: number, userId: number, isAdmin: boolean) {
  const summary = await getSheetSummary(sheetId);
  if (!summary) throw new AppError(404, 'not_found', 'Not found');
  await requireProjectMember(summary.projectId, userId, isAdmin);
  return summary;
}

sheetsRouter.get('/:id', requireScope('sheets:read'), async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleSheet(id, req.auth!.userId, req.auth!.role === 'admin');
  const sheet = await getSheet(id);
  if (!sheet) throw new AppError(404, 'not_found', 'Not found');
  // The lock travels with the sheet so the client can open read-only without a
  // second round trip — and without ever guessing that it holds the lock.
  res.json({ sheet, lock: getLock(id) });
});

const patchBody = z.object({
  title: z.string().min(1).max(200).optional(),
  // 24 MB of JSON: a real workbook is large, and the column is LONGTEXT. The
  // express json limit is raised for this router alone, in app.ts.
  data: z.string().max(24_000_000).optional(),
});

sheetsRouter.patch('/:id', requireScope('sheets:write'), validate(patchBody), async (req, res) => {
  const id = parseId(req.params.id);
  const userId = req.auth!.userId;
  await requireSheetMember(id, userId, req.auth!.role === 'admin');
  const patch = req.valid as z.infer<typeof patchBody>;

  // The lock is what makes single-editor concurrency mean anything. Without this
  // check the second editor's save would silently overwrite the first's work —
  // last write wins, with no indication to either of them.
  if (!canWrite(id, userId)) {
    const lock = getLock(id);
    throw new AppError(
      409,
      'sheet_locked',
      `${lock?.displayName ?? 'Someone else'} is editing this sheet`,
    );
  }
  if (patch.data !== undefined && !isWorkbookSnapshot(patch.data)) {
    throw new AppError(400, 'invalid_snapshot', 'data must be a workbook snapshot (JSON object)');
  }

  const sheet = await updateSheet(id, userId, patch);
  if (!sheet) throw new AppError(404, 'not_found', 'Not found');
  // Viewers refetch rather than receiving the snapshot: it is far too large to
  // broadcast, and everyone watching can afford one GET.
  getIo()?.to(`sheet:${id}`).emit('sheet:updated', { sheetId: id, updatedBy: userId });
  res.json({ sheet: { ...sheet, data: undefined }, lock: getLock(id) });
});

sheetsRouter.delete('/:id', requireScope('sheets:write'), async (req, res) => {
  const id = parseId(req.params.id);
  await requireSheetMember(id, req.auth!.userId, req.auth!.role === 'admin');
  await deleteSheet(id);
  res.json({ ok: true });
});

/** Mounted under /api/projects/:id/sheets — see app.ts. */
export const projectSheetsRouter = Router({ mergeParams: true });
projectSheetsRouter.use(requireAuth);

projectSheetsRouter.get('/', requireScope('sheets:read'), async (req, res) => {
  const projectId = parseId((req.params as { id: string }).id);
  await requireVisibleProject(projectId, req.auth!.userId, req.auth!.role === 'admin');
  res.json({ sheets: await listSheets(projectId) });
});

const createBody = z.object({
  title: z.string().min(1).max(200),
  data: z.string().max(24_000_000).optional(),
});

projectSheetsRouter.post('/', requireScope('sheets:write'), validate(createBody), async (req, res) => {
  const projectId = parseId((req.params as { id: string }).id);
  await requireProjectMember(projectId, req.auth!.userId, req.auth!.role === 'admin');
  const input = req.valid as z.infer<typeof createBody>;
  if (input.data !== undefined && !isWorkbookSnapshot(input.data)) {
    throw new AppError(400, 'invalid_snapshot', 'data must be a workbook snapshot (JSON object)');
  }
  const sheet = await createSheet({ projectId, ...input, userId: req.auth!.userId });
  res.status(201).json({ sheet: { ...sheet, data: undefined } });
});
