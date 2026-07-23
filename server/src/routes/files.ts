import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { db } from '../db/index.js';
import { docs, messages, tasks } from '../db/schema/index.js';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { getAttachment } from '../services/attachmentService.js';
import { getVisibleChannel } from '../services/channelService.js';
import { getVisibleProject } from '../services/projectService.js';
import { getStorageDriver } from '../storage/index.js';

export const filesRouter = Router();
filesRouter.use(requireAuth);

function parseId(raw: string | string[]): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'validation_error', 'Bad id');
  return id;
}

filesRouter.get('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const attachment = await getAttachment(id);
  if (!attachment) throw new AppError(404, 'not_found', 'Not found');
  const isAdmin = req.auth!.role === 'admin';
  const userId = req.auth!.userId;

  let visible = false;
  if (attachment.messageId) {
    const [msg] = await db.select().from(messages).where(eq(messages.id, attachment.messageId));
    visible = Boolean(msg && (await getVisibleChannel(msg.channelId, userId, isAdmin)));
  } else if (attachment.taskId) {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, attachment.taskId));
    visible = Boolean(task && (await getVisibleProject(task.projectId, userId, isAdmin)));
  } else if (attachment.docId) {
    const [doc] = await db.select().from(docs).where(eq(docs.id, attachment.docId));
    visible = Boolean(doc && (await getVisibleProject(doc.projectId, userId, isAdmin)));
  }
  if (!visible) throw new AppError(404, 'not_found', 'Not found');

  const driver = getStorageDriver();
  const signedUrl = await driver.getSignedGetUrl(attachment.storageKey, 60);
  if (signedUrl) {
    res.redirect(signedUrl);
    return;
  }
  res.setHeader('Content-Type', attachment.mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${attachment.fileName}"`);
  driver.getStream(attachment.storageKey).pipe(res);
});
