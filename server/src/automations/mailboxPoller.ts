import { Cron } from 'croner';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { gmailIngestState, messageEmailOrigins } from '../db/schema/index.js';
import { logger } from '../logger.js';
import { getBotUserId } from '../services/botService.js';
import { getGooglePort } from '../services/google/port.js';
import { getConnection, withGoogle } from '../services/googleService.js';
import { sendMessage } from '../services/messageService.js';

/**
 * The support-mailbox poller: every two minutes, new mail in the connected
 * Gmail inbox becomes bot-authored messages (origin 'email') in the bound
 * support channel — from there the ordinary intake automation takes over and
 * the email becomes a ticket.
 *
 * Idempotent twice over. The watermark (`last_internal_date`, in Gmail's own
 * clock) makes the normal tick cheap; the UNIQUE `gmail_message_id` in
 * `message_email_origins` makes a *replayed* tick harmless — a restart between
 * ingest and watermark-advance re-reads the same mail and skips it row by row.
 *
 * Same single-process caveat as the routine scheduler: one process owns this
 * timer, and scaling out means the same leader-election conversation.
 */

const SCHEDULE = '*/2 * * * *';

let job: Cron | null = null;

export function stopMailboxPoller(): void {
  job?.stop();
  job = null;
}

/**
 * (Re)arm from the database. Called at boot and after every bind/unbind —
 * armed only when a mailbox connection AND a binding both exist.
 */
export async function armMailboxPoller(): Promise<boolean> {
  stopMailboxPoller();
  const account = await getConnection('support_mailbox');
  if (!account) return false;
  const [state] = await db
    .select()
    .from(gmailIngestState)
    .where(eq(gmailIngestState.googleAccountId, account.id));
  if (!state) return false;

  job = new Cron(SCHEDULE, { protect: true }, () => {
    // `protect` skips a tick while the previous one still runs — a slow Gmail
    // answer must not stack overlapping ingests of the same watermark.
    void pollMailboxOnce().catch((err) => logger.error({ err }, 'mailbox poll threw'));
  });
  logger.info({ targetChannelId: state.targetChannelId }, 'support-mailbox poller armed');
  return true;
}

export function isMailboxPollerArmed(): boolean {
  return job !== null;
}

/** One tick. Exported for tests and for an admin "check now". */
export async function pollMailboxOnce(): Promise<{ ingested: number }> {
  const account = await getConnection('support_mailbox');
  if (!account || account.status === 'broken') return { ingested: 0 };
  const [state] = await db
    .select()
    .from(gmailIngestState)
    .where(eq(gmailIngestState.googleAccountId, account.id));
  if (!state) return { ingested: 0 };

  const botUserId = await getBotUserId();
  if (botUserId === null) {
    logger.warn('mailboxPoller: no bot user — cannot author ingested messages');
    return { ingested: 0 };
  }

  let emails;
  try {
    emails = await withGoogle(account, (token) =>
      getGooglePort().listMailSince(token, state.lastInternalDate),
    );
  } catch (err) {
    // withGoogle already marked a dead grant broken and DM'd the admin who
    // connected it; the next tick sees status='broken' and returns above.
    logger.warn({ err }, 'mailbox poll skipped — Google call failed');
    return { ingested: 0 };
  }

  let ingested = 0;
  let watermark = state.lastInternalDate;
  for (const email of emails) {
    // The DB-enforced idempotency layer: already ingested (by a tick whose
    // watermark write never landed) means skip, not error.
    const [seen] = await db
      .select({ messageId: messageEmailOrigins.messageId })
      .from(messageEmailOrigins)
      .where(eq(messageEmailOrigins.gmailMessageId, email.id));
    if (!seen) {
      const body = `📧 **${email.subject || '(no subject)'}**\nFrom: ${email.from}\n\n${email.snippet}`;
      const message = await sendMessage(state.targetChannelId, botUserId, body, undefined, {
        origin: 'email',
      });
      await db.insert(messageEmailOrigins).values({
        messageId: message.id,
        gmailMessageId: email.id,
        fromAddr: email.from,
        subject: email.subject,
      });
      ingested += 1;
    }
    if (email.internalDate > watermark) watermark = email.internalDate;
  }

  if (watermark !== state.lastInternalDate) {
    await db
      .update(gmailIngestState)
      .set({ lastInternalDate: watermark })
      .where(eq(gmailIngestState.googleAccountId, account.id));
  }
  if (ingested > 0) logger.info({ ingested }, 'support mailbox ingested');
  return { ingested };
}
