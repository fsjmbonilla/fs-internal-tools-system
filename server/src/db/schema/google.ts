import {
  bigint,
  boolean,
  customType,
  index,
  json,
  mediumtext,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { users } from './auth.js';
import { channels, messages } from './chat.js';
import { projects } from './projects.js';

// Drizzle's own `varbinary` types the column as string, but mysql2 hands
// VARBINARY back as a Buffer — this keeps the TS type honest.
const binary1024 = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'varbinary(1024)',
});

/**
 * A Google connection — one user's Calendar/Gmail grant, or the org-level
 * support mailbox.
 *
 * Only the refresh token is stored, and only encrypted (AES-256-GCM under
 * `GOOGLE_TOKEN_ENC_KEY` — see `googleCrypto.ts`). Access tokens are minted
 * from it on demand and live in memory; a database dump must not be a mailbox
 * dump.
 *
 * `status` goes `broken` when Google answers `invalid_grant` (the user revoked
 * us from their account page, or the token aged out). A broken row is skipped,
 * not retried — retrying a dead grant is a crash loop with an owner who was
 * already told to reconnect.
 */
export const googleAccounts = mysqlTable(
  'google_accounts',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    /** NULL = the org-level support mailbox, which belongs to no one person. */
    userId: bigint('user_id', { mode: 'number', unsigned: true }).references(() => users.id, {
      onDelete: 'cascade',
    }),
    kind: mysqlEnum('kind', ['user', 'support_mailbox']).notNull(),
    googleEmail: varchar('google_email', { length: 320 }).notNull(),
    refreshTokenEnc: binary1024('refresh_token_enc').notNull(),
    scopes: json('scopes').$type<string[]>().notNull(),
    status: mysqlEnum('status', ['active', 'broken']).notNull().default('active'),
    connectedBy: bigint('connected_by', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    connectedAt: timestamp('connected_at').notNull().defaultNow(),
  },
  (table) => [
    // One connection per user. NULL user_ids are NOT deduplicated by MySQL
    // (every NULL is distinct to a unique index), so "exactly one support
    // mailbox" is enforced by the service's upsert, not by this index.
    uniqueIndex('uq_google_accounts_user_kind').on(table.userId, table.kind),
  ],
);

/**
 * Where the support-mailbox poller is, expressed in Gmail's clock.
 *
 * `last_internal_date` is a Gmail `internalDate` (ms since epoch, assigned by
 * Gmail) — comparing Gmail's values with each other sidesteps invariant 10
 * entirely; our own clock never enters the comparison. The watermark makes a
 * normal tick cheap; the UNIQUE gmail_message_id in `message_email_origins`
 * is what makes a replayed tick harmless.
 */
export const gmailIngestState = mysqlTable('gmail_ingest_state', {
  googleAccountId: bigint('google_account_id', { mode: 'number', unsigned: true })
    .primaryKey()
    .references(() => googleAccounts.id, { onDelete: 'cascade' }),
  lastInternalDate: bigint('last_internal_date', { mode: 'number' }).notNull().default(0),
  targetChannelId: bigint('target_channel_id', { mode: 'number', unsigned: true })
    .notNull()
    .references(() => channels.id, { onDelete: 'cascade' }),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
});

/**
 * Which email an ingested message came from, so replies stay traceable and so
 * ingestion is idempotent at the database rather than only at the watermark:
 * inserting the same gmail_message_id twice fails, and the poller treats that
 * as "already ingested", not as an error.
 */
/**
 * A project's bound Drive folder — ids only, never tokens. Browsing and
 * uploading always happen with the *acting user's* connection; the binding
 * just says where the project's files live in Drive.
 */
export const projectDriveFolders = mysqlTable('project_drive_folders', {
  projectId: bigint('project_id', { mode: 'number', unsigned: true })
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  folderId: varchar('folder_id', { length: 120 }).notNull(),
  folderName: varchar('folder_name', { length: 300 }).notNull(),
  connectedBy: bigint('connected_by', { mode: 'number', unsigned: true })
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  connectedAt: timestamp('connected_at').notNull().defaultNow(),
});

export const messageEmailOrigins = mysqlTable(
  'message_email_origins',
  {
    messageId: bigint('message_id', { mode: 'number', unsigned: true })
      .primaryKey()
      .references(() => messages.id, { onDelete: 'cascade' }),
    gmailMessageId: varchar('gmail_message_id', { length: 32 }).notNull(),
    fromAddr: varchar('from_addr', { length: 320 }).notNull(),
    subject: varchar('subject', { length: 500 }).notNull().default(''),
  },
  (table) => [uniqueIndex('uq_message_email_origins_gmail_id').on(table.gmailMessageId)],
);

/**
 * Per-account inbox cache. The UI reads mail from here; Google is only asked
 * for messages newer than the account's watermark (and at most once per
 * throttle window — see gmailService). Bodies are filled in lazily on first
 * open and kept forever: a Gmail message is immutable, so a cached body never
 * goes stale. `bodyHtml` is stored ALREADY SANITIZED — nothing may write an
 * unsanitized body here.
 */
export const gmailCache = mysqlTable(
  'gmail_cache',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    googleAccountId: bigint('google_account_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => googleAccounts.id, { onDelete: 'cascade' }),
    messageId: varchar('message_id', { length: 32 }).notNull(),
    threadId: varchar('thread_id', { length: 32 }).notNull(),
    fromAddr: varchar('from_addr', { length: 512 }).notNull(),
    toAddr: varchar('to_addr', { length: 1024 }).notNull().default(''),
    subject: varchar('subject', { length: 1024 }).notNull().default(''),
    snippet: text('snippet').notNull(),
    /** Gmail's internalDate in ms — ordering and the watermark use Gmail's clock. */
    internalDate: bigint('internal_date', { mode: 'number', unsigned: true }).notNull(),
    unread: boolean('unread').notNull().default(false),
    bodyText: mediumtext('body_text'),
    /** Sanitized by sanitizeEmailHtml BEFORE storage. */
    bodyHtml: mediumtext('body_html'),
    bodyFetchedAt: timestamp('body_fetched_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_gmail_cache_account_message').on(table.googleAccountId, table.messageId),
    index('ix_gmail_cache_account_date').on(table.googleAccountId, table.internalDate),
  ],
);

/** One row per account: the sync watermark and when Google was last asked. */
export const gmailSyncState = mysqlTable('gmail_sync_state', {
  googleAccountId: bigint('google_account_id', { mode: 'number', unsigned: true })
    .primaryKey()
    .references(() => googleAccounts.id, { onDelete: 'cascade' }),
  /** Highest internalDate (ms, Gmail's clock) already cached. */
  watermark: bigint('watermark', { mode: 'number', unsigned: true }).notNull().default(0),
  lastSyncAt: timestamp('last_sync_at').notNull().defaultNow(),
});
