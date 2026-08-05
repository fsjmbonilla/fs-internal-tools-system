import { bigint, index, mysqlEnum, mysqlTable, timestamp, varchar } from 'drizzle-orm/mysql-core';
import { users } from './auth.js';

export const deviceTokens = mysqlTable(
  'device_tokens',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    userId: bigint('user_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: varchar('token', { length: 255 }).notNull().unique(),
    platform: mysqlEnum('platform', ['ios', 'android', 'web']).notNull(),
    lastSeenAt: timestamp('last_seen_at').notNull().defaultNow().onUpdateNow(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('idx_dt_user').on(t.userId)],
);
