import { sql } from 'drizzle-orm';
import { bigint, check, int, mysqlEnum, mysqlTable, timestamp, varchar } from 'drizzle-orm/mysql-core';
import { users } from './auth.js';
import { messages } from './chat.js';
import { notes } from './notes.js';
import { docs, tasks } from './projects.js';

export const attachments = mysqlTable('attachments', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  uploaderId: bigint('uploader_id', { mode: 'number', unsigned: true })
    .notNull()
    .references(() => users.id),
  messageId: bigint('message_id', { mode: 'number', unsigned: true }).references(() => messages.id, {
    onDelete: 'cascade',
  }),
  taskId: bigint('task_id', { mode: 'number', unsigned: true }).references(() => tasks.id, {
    onDelete: 'cascade',
  }),
  docId: bigint('doc_id', { mode: 'number', unsigned: true }).references(() => docs.id, {
    onDelete: 'cascade',
  }),
  // A note is the fourth thing an attachment can belong to. Unlike the others it
  // is owner-only — see the files route, which must not let an admin through.
  noteId: bigint('note_id', { mode: 'number', unsigned: true }).references(() => notes.id, {
    onDelete: 'cascade',
  }),
  /**
   * Where the bytes live — for `internal` rows only. A `gdrive` attachment is
   * a *reference* to a file whose bytes stay in Google Drive: no storage key,
   * nothing for the GC to collect, and deleting the row must never delete the
   * Drive file. The CHECK below makes the two shapes mutually exclusive at the
   * database, not just in service code.
   */
  storageKey: varchar('storage_key', { length: 500 }),
  provider: mysqlEnum('provider', ['internal', 'gdrive']).notNull().default('internal'),
  driveFileId: varchar('drive_file_id', { length: 120 }),
  webViewLink: varchar('web_view_link', { length: 500 }),
  /** Drive's mime for the icon (e.g. a Google Doc has no real file mime). */
  iconMime: varchar('icon_mime', { length: 120 }),
  fileName: varchar('file_name', { length: 255 }).notNull(),
  mimeType: varchar('mime_type', { length: 120 }).notNull(),
  sizeBytes: int('size_bytes', { unsigned: true }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  check(
    'chk_attachments_provider_shape',
    sql`(${table.provider} = 'internal' AND ${table.storageKey} IS NOT NULL AND ${table.driveFileId} IS NULL)
     OR (${table.provider} = 'gdrive' AND ${table.storageKey} IS NULL AND ${table.driveFileId} IS NOT NULL)`,
  ),
]);
