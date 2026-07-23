import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  datetime,
  index,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/mysql-core';
import { users } from './auth.js';
import { departments } from './departments.js';

export const channels = mysqlTable('channels', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  name: varchar('name', { length: 80 }),
  type: mysqlEnum('type', ['public', 'private', 'dm']).notNull().default('public'),
  isPrivate: boolean('is_private').notNull().default(false),
  topic: varchar('topic', { length: 255 }),
  dmKey: varchar('dm_key', { length: 50 }).unique(),
  departmentId: bigint('department_id', { mode: 'number', unsigned: true }).references(
    () => departments.id,
    { onDelete: 'set null' },
  ),
  createdBy: bigint('created_by', { mode: 'number', unsigned: true }).references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const channelMembers = mysqlTable(
  'channel_members',
  {
    channelId: bigint('channel_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: mysqlEnum('role', ['owner', 'member']).notNull().default('member'),
    lastReadMessageId: bigint('last_read_message_id', { mode: 'number', unsigned: true })
      .notNull()
      .default(0),
    joinedAt: timestamp('joined_at').notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.channelId, table.userId] })],
);

export const messages = mysqlTable(
  'messages',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    channelId: bigint('channel_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => users.id),
    body: text('body').notNull(),
    editedAt: datetime('edited_at'),
    deletedAt: datetime('deleted_at'),
    createdAt: timestamp('created_at', { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    index('idx_channel_created').on(table.channelId, table.createdAt),
    index('idx_channel_id').on(table.channelId, table.id),
  ],
);

export const messageMentions = mysqlTable(
  'message_mentions',
  {
    messageId: bigint('message_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.userId] }),
    index('idx_mm_user').on(table.userId),
  ],
);
