import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import { uploadLimiter } from '../middleware/rateLimit.js';
import {
  createUnlinkedAttachment,
  MIME_WHITELIST,
  verifyMime,
} from '../services/attachmentService.js';

export const uploadsRouter = Router();
uploadsRouter.use(requireAuth);

const MAX_FILES = 10;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: MAX_FILES },
  // Cheap first pass on the declared type so an obviously wrong file never
  // reaches memory. The real check is verifyMime below, against the bytes.
  fileFilter: (_req, file, cb) => {
    cb(null, MIME_WHITELIST.has(file.mimetype));
  },
});

interface Rejected {
  fileName: string;
  reason: string;
}

uploadsRouter.post('/', uploadLimiter, upload.array('files', MAX_FILES), async (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) {
    res
      .status(400)
      .json({ error: { code: 'unsupported_mime', message: 'No valid files uploaded' } });
    return;
  }

  // Verify before storing anything, and report what did not make it. The
  // composer renders one chip per returned attachment, so silently dropping a
  // file left the user with fewer chips than they picked and no explanation.
  const rejected: Rejected[] = [];
  const accepted: Express.Multer.File[] = [];
  for (const file of files) {
    if (await verifyMime(file.buffer, file.mimetype)) {
      accepted.push(file);
    } else {
      rejected.push({
        fileName: file.originalname,
        reason: `contents do not match the declared type ${file.mimetype}`,
      });
    }
  }

  if (accepted.length === 0) {
    res.status(400).json({
      error: { code: 'unsupported_mime', message: 'No valid files uploaded' },
      rejected,
    });
    return;
  }

  const created = await Promise.all(
    accepted.map((f) =>
      createUnlinkedAttachment({
        uploaderId: req.auth!.userId,
        buffer: f.buffer,
        fileName: f.originalname,
        mimeType: f.mimetype,
        sizeBytes: f.size,
      }),
    ),
  );

  res.status(201).json({
    attachments: created.map((a) => ({
      id: a.id,
      fileName: a.fileName,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
    })),
    rejected,
  });
});
