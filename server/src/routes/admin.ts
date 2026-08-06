import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { channels, gmailIngestState, users } from '../db/schema/index.js';
import { armMailboxPoller, stopMailboxPoller } from '../automations/mailboxPoller.js';
import { getConnection } from '../services/googleService.js';
import { requireAdmin, requireAuth, requireUserAuth } from '../middleware/auth.js';
import { logger } from '../logger.js';
import { AppError } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { events } from '../services/events.js';
import {
  createApiToken,
  isScope,
  listApiTokens,
  revokeApiToken,
  SCOPES,
  type Scope,
} from '../services/apiTokenService.js';
import { countNotes, transferNotes } from '../services/noteService.js';
import { getAllowedDomains, setAllowedDomains } from '../services/settingsService.js';

export const adminRouter = Router();
// User-only, deliberately. Two reasons: administering the org is not something an
// agent should do on its own credential, and this router exposes the note
// transfer/count endpoints — so notes stay out of automation reach here too, not
// only on notesRouter.
adminRouter.use(requireAuth, requireUserAuth, requireAdmin);

adminRouter.get('/settings/allowed-domains', async (_req, res) => {
  res.json({ domains: await getAllowedDomains() });
});

const domainsBody = z.object({
  domains: z
    .array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, 'must be a bare domain like example.com'))
    .min(1)
    .max(50),
});

adminRouter.put('/settings/allowed-domains', validate(domainsBody), async (req, res) => {
  const { domains } = req.valid as z.infer<typeof domainsBody>;
  await setAllowedDomains(domains, req.auth!.userId);
  res.json({ domains: await getAllowedDomains() });
});

adminRouter.get('/users', async (_req, res) => {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      isActive: users.isActive,
      isBot: users.isBot,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(users.displayName);
  res.json({ users: rows });
});

const transferBody = z.object({ toUserId: z.number().int().positive() });

/**
 * Hand one person's notes to another. The offboarding path.
 *
 * Admin-only, and a transfer rather than a grant: it moves ownership and returns
 * a count, never any content. That keeps "notes are private" true — an admin can
 * rescue a departing colleague's notes without gaining the ability to read
 * anyone's.
 */
adminRouter.post('/users/:id/notes/transfer', validate(transferBody), async (req, res) => {
  const fromId = Number(req.params.id);
  if (!Number.isInteger(fromId) || fromId <= 0) {
    throw new AppError(400, 'validation_error', 'Bad user id');
  }
  const { toUserId } = req.valid as z.infer<typeof transferBody>;
  if (fromId === toUserId) {
    throw new AppError(400, 'invalid_target', 'Source and destination are the same person');
  }

  const [from] = await db.select({ id: users.id }).from(users).where(eq(users.id, fromId));
  if (!from) throw new AppError(404, 'not_found', 'Not found');
  const [to] = await db
    .select({ id: users.id, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, toUserId));
  // Handing notes to a deactivated account would make them unreachable again.
  if (!to || !to.isActive) throw new AppError(404, 'not_found', 'Not found');

  const transferred = await transferNotes(fromId, toUserId);
  // Private content changing hands is worth a record, since there is no audit
  // table yet: who did it, whose notes, and how many.
  logger.info(
    { actor: req.auth!.userId, from: fromId, to: toUserId, transferred },
    'notes ownership transferred',
  );
  res.json({ transferred });
});

/** A count, so the console can say what a transfer would move. Never content. */
adminRouter.get('/users/:id/notes/count', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, 'validation_error', 'Bad user id');
  }
  res.json({ count: await countNotes(id) });
});

const userPatch = z.object({
  role: z.enum(['admin', 'member']).optional(),
  isActive: z.boolean().optional(),
});

adminRouter.patch('/users/:id', validate(userPatch), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, 'validation_error', 'Bad user id');
  }
  if (id === req.auth!.userId) {
    throw new AppError(400, 'cannot_modify_self', 'Admins cannot change their own role or status');
  }
  const patch = req.valid as z.infer<typeof userPatch>;
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, id));
  if (!row) throw new AppError(404, 'not_found', 'Not found');
  await db.update(users).set(patch).where(eq(users.id, id));

  // A live socket carries the role and active flag it was handed at handshake,
  // so both of these changes have to reach it. Deactivation must not leave a
  // working session behind, and a demoted admin must not keep admin reach until
  // their token happens to expire.
  if (patch.isActive === false) {
    events.emit('access.userSessionsInvalidated', { userId: id, reason: 'deactivated' });
  } else if (patch.role !== undefined) {
    events.emit('access.userSessionsInvalidated', { userId: id, reason: 'role_changed' });
  }

  res.json({ ok: true });
});

/**
 * Service tokens.
 *
 * Admin-only and user-only (see the router guard above): a token cannot be used
 * to mint another token, so a leaked token cannot widen its own reach or outlive
 * its revocation.
 */

/** The vocabulary, so the console does not hardcode a list that can drift. */
adminRouter.get('/tokens/scopes', (_req, res) => {
  res.json({ scopes: SCOPES });
});

adminRouter.get('/tokens', async (_req, res) => {
  res.json({ tokens: await listApiTokens() });
});

const tokenBody = z.object({
  name: z.string().min(1).max(120),
  scopes: z
    .array(z.string())
    .min(1)
    .max(SCOPES.length)
    .refine((list) => list.every(isScope), { message: 'unknown scope' })
    .refine((list) => new Set(list).size === list.length, { message: 'duplicate scope' }),
  actsAsUserId: z.number().int().positive(),
  // Optional, but an expiry is the cheapest way to bound a leak. The console
  // suggests one; the API does not force it, because a long-lived integration is
  // a legitimate thing to run.
  expiresAt: z.coerce.date().optional(),
});

adminRouter.post('/tokens', validate(tokenBody), async (req, res) => {
  const body = req.valid as z.infer<typeof tokenBody>;
  if (body.expiresAt && body.expiresAt.getTime() <= Date.now()) {
    throw new AppError(400, 'validation_error', 'Expiry must be in the future');
  }
  const { id, token } = await createApiToken({
    name: body.name,
    scopes: body.scopes as Scope[],
    actsAsUserId: body.actsAsUserId,
    createdBy: req.auth!.userId,
    expiresAt: body.expiresAt ?? null,
  });
  // Logged without the token itself — the point of the record is who minted what.
  logger.info(
    { actor: req.auth!.userId, tokenId: id, actsAs: body.actsAsUserId, scopes: body.scopes },
    'service token created',
  );
  // The only time the plaintext exists outside the caller's memory. 201 with the
  // secret in the body, and no endpoint that can show it again.
  res.status(201).json({ id, token });
});

adminRouter.delete('/tokens/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, 'validation_error', 'Bad token id');
  }
  // False means "no such live token" — already revoked reads the same as never
  // existed, which is the honest answer to "is this token usable?".
  if (!(await revokeApiToken(id))) throw new AppError(404, 'not_found', 'Not found');
  logger.info({ actor: req.auth!.userId, tokenId: id }, 'service token revoked');
  res.json({ ok: true });
});

// ─── Support mailbox binding (Phase 12) ──────────────────────────────────────

adminRouter.get('/google/support-mailbox', async (_req, res) => {
  const account = await getConnection('support_mailbox');
  if (!account) {
    res.json({ connected: false, email: null, broken: false, targetChannelId: null });
    return;
  }
  const [state] = await db
    .select()
    .from(gmailIngestState)
    .where(eq(gmailIngestState.googleAccountId, account.id));
  res.json({
    connected: true,
    email: account.googleEmail,
    broken: account.status === 'broken',
    targetChannelId: state?.targetChannelId ?? null,
  });
});

const mailboxBody = z.object({ targetChannelId: z.number().int().positive() });

adminRouter.put('/google/support-mailbox', validate(mailboxBody), async (req, res) => {
  const { targetChannelId } = req.valid as z.infer<typeof mailboxBody>;
  const account = await getConnection('support_mailbox');
  if (!account) {
    throw new AppError(409, 'google_not_connected', 'Connect the support mailbox first');
  }
  const [channel] = await db.select().from(channels).where(eq(channels.id, targetChannelId));
  if (!channel) throw new AppError(404, 'not_found', 'Not found');
  if (channel.kind !== 'support') {
    // Emails become intake fodder; aiming them at a standard channel would
    // ingest without ever filing tickets — a config that looks alive but isn't.
    throw new AppError(400, 'not_a_support_channel', 'Emails must land in a support channel');
  }

  const [existing] = await db
    .select()
    .from(gmailIngestState)
    .where(eq(gmailIngestState.googleAccountId, account.id));
  if (existing) {
    await db
      .update(gmailIngestState)
      .set({ targetChannelId })
      .where(eq(gmailIngestState.googleAccountId, account.id));
  } else {
    await db.insert(gmailIngestState).values({
      googleAccountId: account.id,
      targetChannelId,
      // The watermark starts *now* (approximately — Gmail assigns its own
      // internalDate): mail that predates the binding is history, not intake.
      lastInternalDate: Date.now(),
    });
  }
  await armMailboxPoller();
  logger.info({ actor: req.auth!.userId, targetChannelId }, 'support mailbox bound');
  res.json({ ok: true, targetChannelId });
});

adminRouter.delete('/google/support-mailbox', async (req, res) => {
  const account = await getConnection('support_mailbox');
  if (!account) throw new AppError(404, 'not_found', 'Not found');
  await db.delete(gmailIngestState).where(eq(gmailIngestState.googleAccountId, account.id));
  stopMailboxPoller();
  logger.info({ actor: req.auth!.userId }, 'support mailbox unbound');
  res.json({ ok: true });
});
