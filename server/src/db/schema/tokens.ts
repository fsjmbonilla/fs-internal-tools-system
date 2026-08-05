import { bigint, char, json, mysqlTable, timestamp, varchar } from 'drizzle-orm/mysql-core';
import { users } from './auth.js';

/**
 * Service tokens — how an AI agent or automation authenticates as itself.
 *
 * Only the sha256 of the token is stored, the same treatment refresh_tokens get
 * and for the same reason: a database leak must not yield usable credentials.
 * The plaintext is shown once, at creation, and is unrecoverable afterwards.
 *
 * `actsAsUserId` points at a bot user, so every AI-made ticket, message, or doc
 * edit is attributed to an identity that appears in the UI like any other author
 * — the audit trail reads as "FS Assistant did this", not as an anonymous API
 * call. `scopes` is what keeps a token from doing more than its job: notes have
 * no scope at all and never will (see routes/notes.ts).
 */
export const apiTokens = mysqlTable('api_tokens', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  name: varchar('name', { length: 120 }).notNull(),
  tokenHash: char('token_hash', { length: 64 }).notNull().unique(),
  scopes: json('scopes').$type<string[]>().notNull(),
  actsAsUserId: bigint('acts_as_user_id', { mode: 'number', unsigned: true })
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdBy: bigint('created_by', { mode: 'number', unsigned: true })
    .notNull()
    .references(() => users.id),
  lastUsedAt: timestamp('last_used_at'),
  expiresAt: timestamp('expires_at'),
  // Revoked rather than deleted: an audit trail needs the row to survive.
  revokedAt: timestamp('revoked_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
