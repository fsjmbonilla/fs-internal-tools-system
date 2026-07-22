import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
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
  name: varchar('name', { length: 80 }).notNull().unique(),
  isPrivate: boolean('is_private').notNull().default(false),
  departmentId: bigint('department_id', { mode: 'number', unsigned: true }).references(
    () => departments.id,
    { onDelete: 'set null' },
  ),
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
    createdAt: timestamp('created_at', { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => [index('idx_channel_created').on(table.channelId, table.createdAt)],
);
