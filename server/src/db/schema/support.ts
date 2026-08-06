import { bigint, boolean, index, int, mysqlTable, text, timestamp, varchar } from 'drizzle-orm/mysql-core';
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

/**
 * One row per triage attempt — the ledger the spend ceiling is enforced from.
 *
 * Triage is the only thing in the platform that costs money per message, and
 * nothing throttled it: message send is unrated on both REST and socket, so a
 * message every few seconds sustained hundreds of paid calls an hour. The rows
 * answer both questions the limiter asks — when this channel was last triaged,
 * and how many calls have been made today — and carry the token counts so the
 * spend is auditable rather than inferred.
 *
 * This lives in the database rather than in memory on purpose: a crash loop that
 * reset an in-memory counter on every restart would defeat the daily cap in
 * exactly the situation the cap exists for.
 */
export const aiUsage = mysqlTable(
  'ai_usage',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    channelId: bigint('channel_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 32 }).notNull(),
    model: varchar('model', { length: 100 }).notNull(),
    // Zero when the provider reported no usage (a failed or unconfigured call).
    // The row is still written: an attempt that cost nothing still consumes the
    // channel's interval, which is what stops a failing provider being retried hot.
    promptTokens: int('prompt_tokens').notNull().default(0),
    completionTokens: int('completion_tokens').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_ai_usage_channel_created').on(table.channelId, table.createdAt),
    index('idx_ai_usage_created').on(table.createdAt),
  ],
);
