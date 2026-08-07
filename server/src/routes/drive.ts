import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireAuth, requireUserAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { projectForReading } from '../services/access.js';
import {
  attachFromDrive,
  bindProjectFolder,
  exportFile,
  getProjectFolder,
  listFiles,
  listProjectFiles,
  moveFile,
  shareFile,
  unbindProjectFolder,
  updateFileContent,
  uploadPersonalFile,
  uploadProjectFile,
} from '../services/driveService.js';

/**
 * Drive. Everything is `requireUserAuth` and everything runs on the CALLER's
 * Google connection — the platform holds no Drive credential of its own, and
 * agents reach Drive only through the tool registry.
 */

function caller(req: { auth?: { userId: number; role: string } }) {
  return { userId: req.auth!.userId, isAdmin: req.auth!.role === 'admin' };
}

function parseId(raw: string | string[]): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'validation_error', 'Bad id');
  return id;
}

const browseQuery = z.object({
  folderId: z.string().max(120).optional(),
  q: z.string().max(300).optional(),
  pageToken: z.string().max(500).optional(),
});

// ─── Personal browse/search: /api/drive ──────────────────────────────────────

export const driveRouter = Router();
driveRouter.use(requireAuth, requireUserAuth);

driveRouter.get('/files', async (req, res) => {
  const query = browseQuery.safeParse(req.query);
  if (!query.success) throw new AppError(400, 'validation_error', 'Bad query');
  res.json(await listFiles(req.auth!.userId, query.data));
});

// Same limits as project uploads — declared before use by both routers.
const personalUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
});

// Drag-and-drop into My Drive: lands in the caller's own Drive, their token.
driveRouter.post('/files', personalUpload.single('file'), async (req, res) => {
  const body = z.object({ folderId: z.string().max(120).optional() }).safeParse(req.body);
  if (!body.success) throw new AppError(400, 'validation_error', 'Bad folder id');
  const file = req.file;
  if (!file) throw new AppError(400, 'validation_error', 'A file is required');
  const uploaded = await uploadPersonalFile(req.auth!.userId, {
    folderId: body.data.folderId,
    name: file.originalname,
    mimeType: file.mimetype || 'application/octet-stream',
    data: file.buffer,
  });
  res.status(201).json({ file: uploaded });
});

const moveBody = z.object({ folderId: z.string().min(1).max(120) });

// Drag a file onto a folder: move it, on the caller's own connection.
driveRouter.post('/files/:fileId/move', validate(moveBody), async (req, res) => {
  const fileId = z.string().min(1).max(120).parse(req.params.fileId);
  const { folderId } = req.valid as z.infer<typeof moveBody>;
  await moveFile(req.auth!.userId, fileId, folderId);
  res.json({ ok: true });
});

const shareBody = z.object({
  email: z.string().email(),
  role: z.enum(['reader', 'writer']).default('reader'),
});

// Share with a colleague: registered active user on an allowed domain only.
driveRouter.post('/files/:fileId/share', validate(shareBody), async (req, res) => {
  const fileId = z.string().min(1).max(120).parse(req.params.fileId);
  const input = req.valid as z.infer<typeof shareBody>;
  await shareFile(req.auth!.userId, fileId, input);
  res.status(201).json({ ok: true });
});

// In-app rendering of a Drive file: Docs/Sheets/Slides leave as docx/xlsx/pdf.
// The bytes flow through and are rendered by the same client pipeline that
// previews uploaded office files — nothing is stored server-side.
driveRouter.get('/files/:fileId/export', async (req, res) => {
  const fileId = z.string().min(1).max(120).parse(req.params.fileId);
  const exported = await exportFile(req.auth!.userId, fileId);
  if (!exported) throw new AppError(404, 'not_found', 'Not found');
  res.setHeader('Content-Type', exported.mimeType);
  res.setHeader(
    'Content-Disposition',
    `inline; filename*=UTF-8''${encodeURIComponent(exported.name)}`,
  );
  res.send(exported.data);
});

// The 20MB cap surfaced as an honest 413 rather than an opaque MulterError → 500.
const contentUpload: RequestHandler = (req, res, next) => {
  personalUpload.single('file')(req, res, (err?: unknown) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      next(new AppError(413, 'file_too_large', 'That file is too large — the limit is 20MB'));
      return;
    }
    next(err);
  });
};

// In-app editing writes back through here. Uploading xlsx media to a Google
// Sheet id (or markdown to a Doc id) makes Drive convert it in place — the
// file stays a Sheet/Doc, keeps its id and name; only its content is replaced.
driveRouter.put('/files/:fileId/content', contentUpload, async (req, res) => {
  const fileId = z.string().min(1).max(120).parse(req.params.fileId);
  const file = req.file;
  if (!file) throw new AppError(400, 'validation_error', 'A file is required');
  const updated = await updateFileContent(req.auth!.userId, fileId, {
    mimeType: file.mimetype || 'application/octet-stream',
    data: file.buffer,
  });
  res.json({ file: updated });
});

// ─── Attach-from-Drive: /api/attachments ─────────────────────────────────────

export const attachmentsRouter = Router();
attachmentsRouter.use(requireAuth, requireUserAuth);

const fromDriveBody = z.object({
  driveFileId: z.string().min(1).max(120),
  messageId: z.number().int().positive().optional(),
  taskId: z.number().int().positive().optional(),
  docId: z.number().int().positive().optional(),
});

attachmentsRouter.post('/from-drive', validate(fromDriveBody), async (req, res) => {
  const { driveFileId, ...target } = req.valid as z.infer<typeof fromDriveBody>;
  const attachment = await attachFromDrive(caller(req), driveFileId, target);
  res.status(201).json({ attachment });
});

// ─── Project folder: /api/projects/:id/drive-folder + /drive-files ───────────

export const projectDriveFolderRouter = Router({ mergeParams: true });
projectDriveFolderRouter.use(requireAuth, requireUserAuth);

projectDriveFolderRouter.get('/', async (req, res) => {
  const projectId = parseId((req.params as { id: string }).id);
  if (!(await projectForReading(projectId, caller(req)))) {
    throw new AppError(404, 'not_found', 'Not found');
  }
  const binding = await getProjectFolder(projectId);
  res.json({
    folder: binding ? { folderId: binding.folderId, folderName: binding.folderName } : null,
  });
});

const bindBody = z.object({ folderId: z.string().min(1).max(120) });

projectDriveFolderRouter.post('/', validate(bindBody), async (req, res) => {
  const projectId = parseId((req.params as { id: string }).id);
  const { folderId } = req.valid as z.infer<typeof bindBody>;
  const binding = await bindProjectFolder(projectId, folderId, caller(req));
  res.status(201).json({ folder: { folderId: binding.folderId, folderName: binding.folderName } });
});

projectDriveFolderRouter.delete('/', async (req, res) => {
  const projectId = parseId((req.params as { id: string }).id);
  if (!(await unbindProjectFolder(projectId, caller(req)))) {
    throw new AppError(404, 'not_found', 'Not found');
  }
  res.json({ ok: true });
});

export const projectDriveFilesRouter = Router({ mergeParams: true });
projectDriveFilesRouter.use(requireAuth, requireUserAuth);

// Same limits as the uploads route; Drive is not a way around the 20MB cap.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
});

projectDriveFilesRouter.get('/', async (req, res) => {
  const projectId = parseId((req.params as { id: string }).id);
  if (!(await projectForReading(projectId, caller(req)))) {
    throw new AppError(404, 'not_found', 'Not found');
  }
  const query = browseQuery.safeParse(req.query);
  if (!query.success) throw new AppError(400, 'validation_error', 'Bad query');
  res.json(await listProjectFiles(projectId, caller(req), query.data));
});

projectDriveFilesRouter.post('/', upload.single('file'), async (req, res) => {
  const projectId = parseId((req.params as { id: string }).id);
  if (!(await projectForReading(projectId, caller(req)))) {
    throw new AppError(404, 'not_found', 'Not found');
  }
  const file = req.file;
  if (!file) throw new AppError(400, 'validation_error', 'A file is required');
  const uploaded = await uploadProjectFile(projectId, caller(req), {
    name: file.originalname,
    mimeType: file.mimetype || 'application/octet-stream',
    data: file.buffer,
  });
  res.status(201).json({ file: uploaded });
});
