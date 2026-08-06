import {
  bigint,
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

/**
 * Staff-written automation, executed server-side in a sandbox.
 *
 * The source lives here, but *nothing* in the API process ever runs it. Execution
 * belongs to the runner service, which is a separate container with no outbound
 * network except this API — the separation is the security model, not an
 * architectural preference.
 *
 * `scopes` is what the run's minted token will carry. A script therefore cannot
 * do more than its declared scopes allow even if its code tries, and the scopes
 * are visible to whoever approves the script rather than buried in its body.
 */
export const scripts = mysqlTable(
  'scripts',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    name: varchar('name', { length: 200 }).notNull(),
    description: varchar('description', { length: 500 }),
    // Python only for now; the column exists so adding JS later is a value, not a migration.
    language: mysqlEnum('language', ['python']).notNull().default('python'),
    source: mediumtext('source').notNull(),
    /** Scope strings, validated against SCOPES at the route edge. */
    scopes: json('scopes').$type<string[]>().notNull(),
    createdBy: bigint('created_by', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => users.id),
    updatedBy: bigint('updated_by', { mode: 'number', unsigned: true }).references(() => users.id),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (table) => [index('idx_scripts_created_by').on(table.createdBy)],
);

/**
 * One execution.
 *
 * The row *is* the queue: the runner claims `queued` rows and moves them to
 * `running`. A dedicated queue would be better under load, but this is a handful
 * of runs a day by design, and one fewer moving part in a security boundary is
 * worth more than throughput here.
 *
 * `timeout` and `failed` are distinct states because they mean different things
 * to whoever is reading the history — one is a runaway, the other is a bug.
 */
export const scriptRuns = mysqlTable(
  'script_runs',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    scriptId: bigint('script_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => scripts.id, { onDelete: 'cascade' }),
    status: mysqlEnum('status', ['queued', 'running', 'succeeded', 'failed', 'timeout'])
      .notNull()
      .default('queued'),
    triggeredBy: bigint('triggered_by', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => users.id),
    /** The token minted for this run, revoked the moment it finishes. */
    tokenId: bigint('token_id', { mode: 'number', unsigned: true }),
    exitCode: int('exit_code'),
    stdout: mediumtext('stdout'),
    stderr: mediumtext('stderr'),
    /** Why a run failed before it ever started (no runner, mint failure, …). */
    error: text('error'),
    startedAt: timestamp('started_at'),
    finishedAt: timestamp('finished_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_runs_script_created').on(table.scriptId, table.createdAt),
    // The runner's claim query: oldest queued run first.
    index('idx_runs_status_id').on(table.status, table.id),
  ],
);
