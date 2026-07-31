import { bigint, index, mysqlTable, timestamp, varchar } from 'drizzle-orm/mysql-core';
import { users } from './auth.js';
import { channels } from './chat.js';

export const calls = mysqlTable(
  'calls',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    channelId: bigint('channel_id', { mode: 'number', unsigned: true }).references(() => channels.id, {
      onDelete: 'cascade',
    }),
    roomName: varchar('room_name', { length: 100 }).notNull().unique(),
    startedBy: bigint('started_by', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => users.id),
    startedAt: timestamp('started_at').notNull().defaultNow(),
    endedAt: timestamp('ended_at'),
  },
  (t) => [index('idx_calls_channel').on(t.channelId)],
);
