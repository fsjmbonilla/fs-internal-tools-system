import { bigint, int, mysqlTable, timestamp, varchar } from 'drizzle-orm/mysql-core';
import { users } from './auth.js';
import { messages } from './chat.js';
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
  storageKey: varchar('storage_key', { length: 500 }).notNull(),
  fileName: varchar('file_name', { length: 255 }).notNull(),
  mimeType: varchar('mime_type', { length: 120 }).notNull(),
  sizeBytes: int('size_bytes', { unsigned: true }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
