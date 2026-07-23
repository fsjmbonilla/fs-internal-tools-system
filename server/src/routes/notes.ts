import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import {
  convertNoteToDoc,
  createNote,
  deleteNote,
  getOwnNote,
  listNotes,
  updateNote,
} from '../services/noteService.js';

export const notesRouter = Router();
// requireAuth only ever authenticates user JWTs — no service-token scope exists
// for notes, and none should be added later without deliberately revisiting
// this decision. Notes are strictly personal and stay out of AI/automation reach.
notesRouter.use(requireAuth);

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

const createBody = z.object({
  title: z.string().min(1).max(200),
  content: z.string().max(200000).optional(),
});

notesRouter.post('/', validate(createBody), async (req, res) => {
  const note = await createNote(req.auth!.userId, req.valid as z.infer<typeof createBody>);
  res.status(201).json({ note });
});

notesRouter.get('/:id', async (req, res) => {
  const note = await getOwnNote(parseId(req.params.id), req.auth!.userId);
  if (!note) throw new AppError(404, 'not_found', 'Not found');
  res.json({ note });
});

const patchBody = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.string().max(200000).optional(),
  pinned: z.boolean().optional(),
});

notesRouter.patch('/:id', validate(patchBody), async (req, res) => {
  const id = parseId(req.params.id);
  const ok = await updateNote(id, req.auth!.userId, req.valid as z.infer<typeof patchBody>);
  if (!ok) throw new AppError(404, 'not_found', 'Not found');
  res.json({ note: await getOwnNote(id, req.auth!.userId) });
});

notesRouter.delete('/:id', async (req, res) => {
  const ok = await deleteNote(parseId(req.params.id), req.auth!.userId);
  if (!ok) throw new AppError(404, 'not_found', 'Not found');
  res.json({ ok: true });
});

const convertBody = z.object({ projectId: z.number().int().positive() });

notesRouter.post('/:id/convert-to-doc', validate(convertBody), async (req, res) => {
  const id = parseId(req.params.id);
  const doc = await convertNoteToDoc(id, req.auth!.userId, (req.valid as z.infer<typeof convertBody>).projectId);
  if (!doc) throw new AppError(404, 'not_found', 'Not found');
  res.status(201).json({ doc });
});
