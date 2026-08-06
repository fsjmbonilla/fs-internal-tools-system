import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireAuth, requireUserAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { projectForReading } from '../services/access.js';
import {
  attachFromDrive,
  bindProjectFolder,
  getProjectFolder,
  listFiles,
  listProjectFiles,
  unbindProjectFolder,
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
