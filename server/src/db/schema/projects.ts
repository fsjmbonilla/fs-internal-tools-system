import {
  bigint,
  boolean,
  date,
  double,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/mysql-core';
import { users } from './auth.js';
import { departments } from './departments.js';

export const projects = mysqlTable('projects', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  name: varchar('name', { length: 120 }).notNull(),
  description: text('description'),
  isPrivate: boolean('is_private').notNull().default(false),
  departmentId: bigint('department_id', { mode: 'number', unsigned: true }).references(
    () => departments.id,
    { onDelete: 'set null' },
  ),
  createdBy: bigint('created_by', { mode: 'number', unsigned: true }).references(() => users.id),
  archivedAt: timestamp('archived_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const projectMembers = mysqlTable(
  'project_members',
  {
    projectId: bigint('project_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: mysqlEnum('role', ['lead', 'member']).notNull().default('member'),
    joinedAt: timestamp('joined_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] })],
);

export const docs = mysqlTable('docs', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  projectId: bigint('project_id', { mode: 'number', unsigned: true })
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 200 }).notNull(),
  content: text('content').notNull().default(''),
  createdBy: bigint('created_by', { mode: 'number', unsigned: true }).notNull(),
  updatedBy: bigint('updated_by', { mode: 'number', unsigned: true }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
});

export const taskColumns = mysqlTable('task_columns', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  projectId: bigint('project_id', { mode: 'number', unsigned: true })
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 60 }).notNull(),
  position: double('position').notNull(),
});

export const tasks = mysqlTable('tasks', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  projectId: bigint('project_id', { mode: 'number', unsigned: true })
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  columnId: bigint('column_id', { mode: 'number', unsigned: true })
    .notNull()
    .references(() => taskColumns.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 300 }).notNull(),
  description: text('description'),
  assigneeId: bigint('assignee_id', { mode: 'number', unsigned: true }).references(() => users.id),
  dueDate: date('due_date'),
  position: double('position').notNull(),
  createdBy: bigint('created_by', { mode: 'number', unsigned: true }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
});

export const taskComments = mysqlTable('task_comments', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  taskId: bigint('task_id', { mode: 'number', unsigned: true })
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  userId: bigint('user_id', { mode: 'number', unsigned: true }).notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
