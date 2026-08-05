import { create as contentDisposition } from 'content-disposition';
import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { db } from '../db/index.js';
import { docs, messages, tasks } from '../db/schema/index.js';
import { requireAuth, requireUserAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { getAttachment, INLINEABLE } from '../services/attachmentService.js';
import { getVisibleChannel } from '../services/channelService.js';
import { getVisibleProject } from '../services/projectService.js';
import { getStorageDriver } from '../storage/index.js';

export const filesRouter = Router();
// User-only, matching uploadsRouter: a token cannot create attachments, so it has
// no need to read them. (Note attachments have no branch below and 404 for everyone.)
filesRouter.use(requireAuth, requireUserAuth);

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

  // Only images and PDFs render in place; everything else downloads. An office
  // document or CSV opened inline is a document the browser may hand to a
  // plugin, and there is no reason to take that risk for a file the user is
  // going to save anyway.
  const disposition = INLINEABLE.has(attachment.mimeType) ? 'inline' : 'attachment';

  res.setHeader('Content-Type', attachment.mimeType);
  // contentDisposition() encodes the filename per RFC 6266. Interpolating it
  // into the header by hand broke on any name containing a quote.
  res.setHeader('Content-Disposition', contentDisposition(attachment.fileName, { type: disposition }));
  // Defense in depth for the inline path: never let the browser re-guess the
  // type, and strip the file of any origin privileges if it does render.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  driver.getStream(attachment.storageKey).pipe(res);
});
