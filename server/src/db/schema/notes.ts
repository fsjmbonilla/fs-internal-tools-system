import {
  bigint,
  boolean,
  mediumtext,
  mysqlEnum,
  mysqlTable,
  timestamp,
  varchar,
} from 'drizzle-orm/mysql-core';
import { users } from './auth.js';

export const notes = mysqlTable('notes', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  userId: bigint('user_id', { mode: 'number', unsigned: true })
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 200 }).notNull(),
  /**
   * MEDIUMTEXT, not TEXT. A rich document stores ProseMirror JSON, which carries
   * every mark and attribute as structure — a note that was 30 KB of markdown can
   * be several times that as a document, and TEXT's 64 KB ceiling truncates
   * silently on MySQL rather than erroring.
   */
  content: mediumtext('content').notNull(),
  /**
   * How `content` is encoded.
   *
   * `markdown` is every note written before rich documents existed and is still
   * written by nothing — it is a read path, kept so old notes render as authored
   * instead of being converted by a migration that could only guess. New notes are
   * `rich`: ProseMirror JSON, which is what makes images, tables, and links
   * possible without ever storing HTML.
   */
  format: mysqlEnum('format', ['markdown', 'rich']).notNull().default('markdown'),
  pinned: boolean('pinned').notNull().default(false),
  /**
   * The note's backup copy in the OWNER's own Drive (via their own
   * connection) — an id in their account, never a token, never shared
   * storage. NULL until the first successful backup.
   */
  driveFileId: varchar('drive_file_id', { length: 64 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
});
