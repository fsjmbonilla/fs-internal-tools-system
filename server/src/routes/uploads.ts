import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import { createUnlinkedAttachment, MIME_WHITELIST } from '../services/attachmentService.js';

export const uploadsRouter = Router();
uploadsRouter.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    cb(null, MIME_WHITELIST.has(file.mimetype));
  },
});

uploadsRouter.post('/', upload.array('files', 10), async (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) {
    res.status(400).json({ error: { code: 'unsupported_mime', message: 'No valid files uploaded' } });
    return;
  }
  const created = await Promise.all(
    files.map((f) =>
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
  });
});
