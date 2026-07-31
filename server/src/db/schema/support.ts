import { bigint, boolean, mysqlTable, text, timestamp } from 'drizzle-orm/mysql-core';
import { channels } from './chat.js';
import { projects, taskColumns } from './projects.js';

export const supportConfigs = mysqlTable('support_configs', {
  channelId: bigint('channel_id', { mode: 'number', unsigned: true })
    .primaryKey()
    .references(() => channels.id, { onDelete: 'cascade' }),
  projectId: bigint('project_id', { mode: 'number', unsigned: true })
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  intakeColumnId: bigint('intake_column_id', { mode: 'number', unsigned: true })
    .notNull()
    .references(() => taskColumns.id, { onDelete: 'cascade' }),
  aiEnabled: boolean('ai_enabled').notNull().default(true),
  instructions: text('instructions'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
