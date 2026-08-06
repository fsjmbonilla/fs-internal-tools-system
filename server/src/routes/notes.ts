import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireUserAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import {
  addNoteAttachments,
  convertNoteToDoc,
  createNote,
  deleteNote,
  getOwnNote,
  getOwnNoteWithAttachments,
  isProseMirrorDoc,
  listNotes,
  updateNote,
} from '../services/noteService.js';
import { getVisibleProject, isProjectMember } from '../services/projectService.js';

export const notesRouter = Router();
// requireAuth only ever authenticates user JWTs — no service-token scope exists
// for notes, and none should be added later without deliberately revisiting
// this decision. Notes are strictly personal and stay out of AI/automation reach.
// Notes are strictly personal and stay out of AI/automation reach. That used to
// rest on requireAuth only ever recognizing user JWTs; now that service tokens
// exist, requireUserAuth enforces it structurally — a token is refused here
// whatever scopes it holds, and there is deliberately no notes scope to grant.
notesRouter.use(requireAuth, requireUserAuth);

function parseId(raw: string | string[]): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'validation_error', 'Bad id');
  return id;
}

const listQuery = z.object({
  q: z.string().max(200).optional(),
  pinned: z.coerce.boolean().optional(),
});

notesRouter.get('/', validate(listQuery, 'query'), async (req, res) => {
  const { q, pinned } = req.valid as z.infer<typeof listQuery>;
  const notes = await listNotes(req.auth!.userId, { q, pinnedOnly: pinned });
  res.json({ notes });
});

/**
 * `rich` content must actually be a ProseMirror document.
 *
 * Without this, a client could store markdown — or anything at all — under
 * `format: 'rich'`, and the editor would fail to load that note from then on
 * with no way for the user to repair it. Rejecting at the edge keeps every row
 * readable by the renderer its `format` names.
 */
function refineFormat(
  value: { content?: string; format?: 'markdown' | 'rich' },
  ctx: z.RefinementCtx,
): void {
  if (value.format !== 'rich' || value.content === undefined) return;
  if (!isProseMirrorDoc(value.content)) {
    ctx.addIssue({
      code: 'custom',
      path: ['content'],
      message: 'rich content must be a ProseMirror document (JSON with type "doc")',
    });
  }
}

const createBody = z
  .object({
    title: z.string().min(1).max(200),
    content: z.string().max(200000).optional(),
    format: z.enum(['markdown', 'rich']).optional(),
  })
  .superRefine(refineFormat);

notesRouter.post('/', validate(createBody), async (req, res) => {
  const note = await createNote(req.auth!.userId, req.valid as z.infer<typeof createBody>);
  res.status(201).json({ note });
});

notesRouter.get('/:id', async (req, res) => {
  const note = await getOwnNoteWithAttachments(parseId(req.params.id), req.auth!.userId);
  if (!note) throw new AppError(404, 'not_found', 'Not found');
  res.json({ note });
});

const patchBody = z
  .object({
    title: z.string().min(1).max(200).optional(),
    content: z.string().max(200000).optional(),
    format: z.enum(['markdown', 'rich']).optional(),
    pinned: z.boolean().optional(),
  })
  .superRefine(refineFormat);

notesRouter.patch('/:id', validate(patchBody), async (req, res) => {
  const id = parseId(req.params.id);
  const ok = await updateNote(id, req.auth!.userId, req.valid as z.infer<typeof patchBody>);
  if (!ok) throw new AppError(404, 'not_found', 'Not found');
  // With attachments, like GET — the editor re-renders from this response.
  res.json({ note: await getOwnNoteWithAttachments(id, req.auth!.userId) });
});

const attachBody = z.object({ attachmentIds: z.array(z.number().int().positive()).min(1).max(10) });

notesRouter.post('/:id/attachments', validate(attachBody), async (req, res) => {
  const id = parseId(req.params.id);
  // 404 before 400: an attachment failure must not confirm that someone else's
  // note exists. The whole router is requireUserAuth, so there is no admin path
  // in here either — a note's files answer to its owner and nobody else.
  if (!(await getOwnNote(id, req.auth!.userId))) throw new AppError(404, 'not_found', 'Not found');
  const { attachmentIds } = req.valid as z.infer<typeof attachBody>;
  if (!(await addNoteAttachments(id, req.auth!.userId, attachmentIds))) {
    throw new AppError(400, 'invalid_attachment', 'One or more attachments could not be linked');
  }
  res.status(201).json({ note: await getOwnNoteWithAttachments(id, req.auth!.userId) });
});

notesRouter.delete('/:id', async (req, res) => {
  const ok = await deleteNote(parseId(req.params.id), req.auth!.userId);
  if (!ok) throw new AppError(404, 'not_found', 'Not found');
  res.json({ ok: true });
});

const convertBody = z.object({ projectId: z.number().int().positive() });

notesRouter.post('/:id/convert-to-doc', validate(convertBody), async (req, res) => {
  const id = parseId(req.params.id);
  const { projectId } = req.valid as z.infer<typeof convertBody>;
  // Visibility is checked here at the HTTP edge, exactly as projectsRouter and
  // docsRouter do it. Without this, a note could be converted into a doc inside
  // a project the author cannot see — which both bypasses project visibility and
  // pushes personal note content somewhere its owner cannot follow it.
  const isAdmin = req.auth!.role === 'admin';
  const project = await getVisibleProject(projectId, req.auth!.userId, isAdmin);
  if (!project) throw new AppError(404, 'not_found', 'Not found');
  // Converting creates a doc, so it answers to the same rule as creating one
  // through the projects router: members only, 403 once the project is known to
  // be visible.
  if (!isAdmin && !(await isProjectMember(projectId, req.auth!.userId))) {
    throw new AppError(403, 'forbidden', 'Only project members can add documents');
  }
  const doc = await convertNoteToDoc(id, req.auth!.userId, projectId);
  if (!doc) throw new AppError(404, 'not_found', 'Not found');
  res.status(201).json({ doc });
});
