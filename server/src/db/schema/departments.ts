import {
  bigint,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/mysql-core';
import { users } from './auth.js';

export const departments = mysqlTable('departments', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  name: varchar('name', { length: 80 }).notNull().unique(),
  description: text('description'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const departmentMembers = mysqlTable(
  'department_members',
  {
    departmentId: bigint('department_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => departments.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: mysqlEnum('role', ['lead', 'member']).notNull().default('member'),
    joinedAt: timestamp('joined_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.departmentId, t.userId] })],
);
