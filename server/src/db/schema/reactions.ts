import { bigint, mysqlTable, primaryKey, varchar } from 'drizzle-orm/mysql-core';
import { users } from './auth.js';
import { messages } from './chat.js';

export const messageReactions = mysqlTable(
  'message_reactions',
  {
    messageId: bigint('message_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emoji: varchar('emoji', { length: 32 }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.messageId, table.userId, table.emoji] })],
);
