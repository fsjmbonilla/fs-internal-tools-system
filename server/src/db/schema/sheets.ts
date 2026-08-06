import { bigint, index, longtext, mysqlTable, timestamp, varchar } from 'drizzle-orm/mysql-core';
import { users } from './auth.js';
import { projects } from './projects.js';

/**
 * A native spreadsheet, stored as a Univer workbook snapshot.
 *
 * LONGTEXT rather than MEDIUMTEXT: a snapshot carries every cell's value, style
 * reference and formula as JSON, so a sheet that looks small in a browser is
 * routinely megabytes. MEDIUMTEXT's 16 MB ceiling is reachable by a real
 * spreadsheet, and MySQL truncates silently rather than erroring.
 *
 * The snapshot is opaque to the server on purpose. It is written by Univer's
 * Facade API (`fWorkbook.save()`) and read back by `createWorkbook(snapshot)`;
 * the server validates that it is JSON and nothing more, because any schema it
 * asserted here would be a second copy of Univer's, drifting on every upgrade.
 *
 * Sheets live in a project and inherit its visibility exactly as docs do — there
 * is no separate sharing model, which is what keeps the "invisible means 404"
 * rule true for them without a second implementation.
 */
export const sheets = mysqlTable(
  'sheets',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    projectId: bigint('project_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 200 }).notNull(),
    /** Univer workbook snapshot JSON. Empty string means "never saved". */
    data: longtext('data').notNull(),
    createdBy: bigint('created_by', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => users.id),
    updatedBy: bigint('updated_by', { mode: 'number', unsigned: true }).references(() => users.id),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (table) => [index('idx_sheets_project').on(table.projectId)],
);
