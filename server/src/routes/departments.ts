import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import {
  addMember,
  createDepartment,
  deleteDepartment,
  isDepartmentLead,
  listDepartments,
  removeMember,
  updateDepartment,
} from '../services/departmentService.js';

export const departmentsRouter = Router();
departmentsRouter.use(requireAuth);

function parseId(raw: string | string[]): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'validation_error', 'Bad id');
  return id;
}

// Org structure is visible to all staff.
departmentsRouter.get('/', async (_req, res) => {
  res.json({ departments: await listDepartments() });
});

const deptBody = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(1000).optional(),
});

departmentsRouter.post('/', requireAdmin, validate(deptBody), async (req, res) => {
  const dept = await createDepartment(req.valid as z.infer<typeof deptBody>);
  res.status(201).json({ department: dept });
});

const deptPatch = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(1000).nullable().optional(),
});

departmentsRouter.patch('/:id', requireAdmin, validate(deptPatch), async (req, res) => {
  const dept = await updateDepartment(parseId(req.params.id), req.valid as z.infer<typeof deptPatch>);
  if (!dept) throw new AppError(404, 'not_found', 'Not found');
  res.json({ department: dept });
});

departmentsRouter.delete('/:id', requireAdmin, async (req, res) => {
  await deleteDepartment(parseId(req.params.id));
  res.json({ ok: true });
});

// Member management: admins OR that department's lead.
async function requireAdminOrLead(deptId: number, auth: { userId: number; role: string }) {
  if (auth.role === 'admin') return;
  if (await isDepartmentLead(deptId, auth.userId)) return;
  throw new AppError(404, 'not_found', 'Not found');
}

const memberBody = z.object({
  userId: z.number().int().positive(),
  role: z.enum(['lead', 'member']).optional(),
});

departmentsRouter.post('/:id/members', validate(memberBody), async (req, res) => {
  const deptId = parseId(req.params.id);
  await requireAdminOrLead(deptId, req.auth!);
  const { userId, role } = req.valid as z.infer<typeof memberBody>;
  await addMember(deptId, userId, role);
  res.status(201).json({ ok: true });
});

departmentsRouter.delete('/:id/members/:userId', async (req, res) => {
  const deptId = parseId(req.params.id);
  await requireAdminOrLead(deptId, req.auth!);
  await removeMember(deptId, parseId(req.params.userId));
  res.json({ ok: true });
});
