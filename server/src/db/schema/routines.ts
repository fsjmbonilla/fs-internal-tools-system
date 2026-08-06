import {
  bigint,
  boolean,
  index,
  int,
  json,
  mediumtext,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/mysql-core';
import { users } from './auth.js';
import { channels } from './chat.js';

/**
 * A scheduled agent task.
 *
 * A routine is a prompt plus a schedule: on its cron tick the platform runs an
 * agentic loop against the model, giving it the same tools an MCP client gets and
 * the same scopes discipline — a routine can do exactly what its `scopes` allow
 * and nothing more, whatever its prompt asks for.
 *
 * `enabled` is a kill switch that survives restart, which matters more here than
 * anywhere else in the platform: a routine is the one thing that acts without a
 * person present, so turning it off must not depend on a process staying up.
 */
export const routines = mysqlTable(
  'routines',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    name: varchar('name', { length: 200 }).notNull(),
    /** What the agent is asked to do, in the owner's own words. */
    prompt: mediumtext('prompt').notNull(),
    /** Standard 5-field cron. Validated with croner at the route edge. */
    schedule: varchar('schedule', { length: 120 }).notNull(),
    scopes: json('scopes').$type<string[]>().notNull(),
    /** Where a routine's summary goes, if it has one to post. */
    outputChannelId: bigint('output_channel_id', { mode: 'number', unsigned: true }).references(
      () => channels.id,
      { onDelete: 'set null' },
    ),
    enabled: boolean('enabled').notNull().default(true),
    ownerId: bigint('owner_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (table) => [index('idx_routines_enabled').on(table.enabled)],
);

/**
 * One execution of a routine, with the transcript that explains it.
 *
 * The transcript is the product feature, not debug output: a routine acts
 * unattended, so the only way to trust it is to read what it did — each tool
 * call and each result, in order.
 *
 * `budget_exceeded` is its own status because it is not a failure. The routine
 * worked; it ran out of the allowance it was given, and that distinction is what
 * tells an owner to raise the cap rather than debug the prompt.
 */
export const routineRuns = mysqlTable(
  'routine_runs',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    routineId: bigint('routine_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => routines.id, { onDelete: 'cascade' }),
    status: mysqlEnum('status', ['running', 'succeeded', 'failed', 'budget_exceeded'])
      .notNull()
      .default('running'),
    /** 'schedule' or 'manual' — a Run now and a cron tick read differently. */
    trigger: mysqlEnum('trigger', ['schedule', 'manual']).notNull().default('schedule'),
    /** Chronological [{type, ...}] entries: model text, tool calls, tool results. */
    transcript: json('transcript').$type<unknown[]>(),
    /** The model's closing summary, and what gets posted to the output channel. */
    summary: text('summary'),
    inputTokens: int('input_tokens').notNull().default(0),
    outputTokens: int('output_tokens').notNull().default(0),
    iterations: int('iterations').notNull().default(0),
    error: text('error'),
    startedAt: timestamp('started_at').notNull().defaultNow(),
    finishedAt: timestamp('finished_at'),
  },
  (table) => [index('idx_routine_runs_routine').on(table.routineId, table.id)],
);
