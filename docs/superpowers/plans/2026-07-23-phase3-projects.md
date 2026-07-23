# Phase 3: Projects, Kanban, Docs & Notes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Projects (department-owned or org-wide, public/private, same visibility model as channels), markdown docs per project, a kanban board with server-authoritative drag-and-drop, task comments, and strictly-private personal Notes.

**Architecture:** `projectService` mirrors `channelService`'s visibility pattern exactly (public OR member OR department-member; admin bypasses; non-visible → 404) — a second copy of the idiom, not a shared function, because projects and channels are different tables, but the *shape* of the rule must match so the platform-wide privacy guarantee holds everywhere. Kanban positions are `DOUBLE` columns the server computes as a midpoint between neighbors on every move — the client never invents a position. Notes are deliberately NOT visibility-conditioned like everything else: they are hard-scoped to `WHERE user_id = req.auth.userId` with no admin bypass and no service-token access at all.

**Tech Stack:** Drizzle 0.45 (mysql2), Express 5, `@atlaskit/pragmatic-drag-and-drop` (verified API: `draggable`/`dropTargetForElements`/`monitorForElements` from `@atlaskit/pragmatic-drag-and-drop/element/adapter`, `combine` from `.../combine`, `attachClosestEdge`/`extractClosestEdge` from `.../hitbox/closest-edge`), `react-markdown`+`remark-gfm`+`rehype-sanitize` for docs/notes rendering.

## Global Constraints

- Visibility rule (identical shape to channels): project visible if `is_private = false`, OR requester is a project member, OR requester belongs to the owning department. Non-visible → 404 everywhere (list exclusion, direct GET, board GET). Admin bypasses.
- Notes are NOT subject to the visibility rule above — they use a *stricter*, separate rule: owner-only, 404 for literally everyone else including admins, and service tokens are rejected outright on every `/api/notes*` route (no scope exists for it).
- Task `position` is `DOUBLE`, server-computed as the midpoint of its new neighbors; if a gap collapses (midpoint equals a neighbor within float precision), renormalize the whole column to integer-spaced positions (0, 1000, 2000, …) before computing the requested position.
- Drag-and-drop library calls are exactly the shapes verified against the official docs (context7, 2026-07-23) — do not invent alternate function signatures.
- Commits: small, conventional (`feat(server): …` / `feat(web): …`), end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Every task ends with `npm test` green in `server/`; `npm run build` wherever files changed on that side.
- Continue following the `parseId()` path-param helper pattern (never chain two `validate()` calls on one route — see Phase 2 postmortem).

---

### Task 1: Migration 003 — projects/docs/kanban/notes schema

**Files:**
- Create: `server/src/db/schema/projects.ts`, `server/src/db/schema/notes.ts`
- Modify: `server/src/db/schema/index.ts`, `server/src/db/testUtils.ts`

**Interfaces:**
- Produces tables: `projects`, `project_members`, `docs`, `task_columns`, `tasks`, `task_comments`, `notes`

- [ ] **Step 1: `db/schema/projects.ts`**

```ts
import { sql } from 'drizzle-orm';
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
```

(`sql` import above is unused if no raw defaults are needed — drop it if `tsc` flags it as unused after Step 4.)

- [ ] **Step 2: `db/schema/notes.ts`**

```ts
import { bigint, boolean, mysqlTable, text, timestamp, varchar } from 'drizzle-orm/mysql-core';
import { users } from './auth.js';

export const notes = mysqlTable('notes', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  userId: bigint('user_id', { mode: 'number', unsigned: true })
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 200 }).notNull(),
  content: text('content').notNull().default(''),
  pinned: boolean('pinned').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
});
```

- [ ] **Step 3: export from `schema/index.ts`** — add `export * from './projects.js';` and `export * from './notes.js';`

- [ ] **Step 4: generate + apply + FULLTEXT custom migration**

```bash
cd server
npx drizzle-kit generate --name projects_docs_kanban_notes
npm run db:migrate
mariadb -u fs_app -pfs_app_dev fs_internal_system -e "SHOW TABLES LIKE '%project%'; SHOW TABLES LIKE '%task%'; SHOW TABLES LIKE 'notes';"
npx drizzle-kit generate --custom --name notes_fulltext
```

Edit the generated empty `drizzle/000X_notes_fulltext.sql` to:

```sql
-- Custom SQL migration file, put your code below! --
ALTER TABLE `notes` ADD FULLTEXT INDEX `idx_notes_fts` (`title`, `content`);
```

```bash
npm run db:migrate
mariadb -u fs_app -pfs_app_dev fs_internal_system -e "SHOW INDEX FROM notes WHERE Key_name LIKE '%fts%';"
```

- [ ] **Step 5: update `testUtils.ts` truncation order** — add before `channels`/`users` cleanup (children before parents):

```ts
const TABLES = [
  'refresh_tokens',
  'department_members',
  'departments',
  'message_reactions',
  'message_mentions',
  'channel_members',
  'messages',
  'channels',
  'task_comments',
  'tasks',
  'task_columns',
  'docs',
  'project_members',
  'projects',
  'notes',
  'settings',
  'users',
];
```

- [ ] **Step 6: `npm test`** → existing suites still green. **Step 7: Commit** — `feat(server): projects/docs/kanban/notes schema (migration + FULLTEXT notes search)`

### Task 2: projectService — visibility, CRUD, dept auto-join — TDD

**Files:**
- Create: `server/src/services/projectService.ts`
- Test: `server/src/services/projectService.test.ts`

**Interfaces:** mirrors `channelService.ts` exactly in shape —
`visibilityCondition(userId)`, `listVisibleProjects(userId, isAdmin)`, `getVisibleProject(id, userId, isAdmin)`, `isProjectMember(id, userId)`, `addProjectMember(id, userId, role?)`, `removeProjectMember(id, userId)`, `createProject(input)` (creator auto-joins as `lead`; dept members auto-join as `member`), `updateProject(id, patch)`, `archiveProject(id)`.

- [ ] **Step 1: failing tests** (mirror `channelService.test.ts` cases 1:1 for projects — public/private visibility, department visibility, dept auto-join on create, member add/remove):

```ts
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/index.js';
import { departmentMembers, departments, projectMembers, users } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import {
  addProjectMember,
  createProject,
  getVisibleProject,
  isProjectMember,
  listVisibleProjects,
  removeProjectMember,
} from './projectService.js';

async function seedUser(email: string) {
  const [{ id }] = await db
    .insert(users)
    .values({ email, passwordHash: 'x', displayName: email.split('@')[0] })
    .$returningId();
  return id;
}

describe('projectService', () => {
  beforeEach(resetDb);

  it('lists public projects to everyone, hides private ones from non-members', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const outsider = await seedUser('outsider@flowerstore.ph');
    await createProject({ name: 'Public Proj', isPrivate: false, createdBy: owner });
    const priv = await createProject({ name: 'Secret Proj', isPrivate: true, createdBy: owner });

    expect((await listVisibleProjects(outsider, false)).map((p) => p.name)).toEqual(['Public Proj']);
    expect(await getVisibleProject(priv.id, outsider, false)).toBeNull();
    expect(await getVisibleProject(priv.id, owner, false)).not.toBeNull();
    expect(await getVisibleProject(priv.id, outsider, true)).not.toBeNull();
  });

  it('department members see department-owned private projects', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const deptUser = await seedUser('deptuser@flowerstore.ph');
    const [{ id: deptId }] = await db.insert(departments).values({ name: 'Mkt' }).$returningId();
    await db.insert(departmentMembers).values({ departmentId: deptId, userId: deptUser });
    const proj = await createProject({
      name: 'Dept Proj',
      isPrivate: true,
      departmentId: deptId,
      createdBy: owner,
    });
    expect(await getVisibleProject(proj.id, deptUser, false)).not.toBeNull();
  });

  it('creating a department project auto-joins existing department members, plus the creator as lead', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const existingMember = await seedUser('existing@flowerstore.ph');
    const [{ id: deptId }] = await db.insert(departments).values({ name: 'Ops' }).$returningId();
    await db.insert(departmentMembers).values({ departmentId: deptId, userId: existingMember });

    const proj = await createProject({ name: 'Ops Proj', isPrivate: false, departmentId: deptId, createdBy: owner });
    expect(await isProjectMember(proj.id, existingMember)).toBe(true);
    expect(await isProjectMember(proj.id, owner)).toBe(true);
    const [ownerRow] = await db
      .select()
      .from(projectMembers)
      .where(eq(projectMembers.userId, owner));
    expect(ownerRow.role).toBe('lead');
  });

  it('member add/remove works', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const u = await seedUser('u@flowerstore.ph');
    const proj = await createProject({ name: 'P2', isPrivate: false, createdBy: owner });
    await addProjectMember(proj.id, u);
    expect(await isProjectMember(proj.id, u)).toBe(true);
    await removeProjectMember(proj.id, u);
    expect(await isProjectMember(proj.id, u)).toBe(false);
  });
});
```

- [ ] **Step 2: run** → FAIL. **Step 3: implement**

```ts
import { and, eq, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { departmentMembers, projectMembers, projects } from '../db/schema/index.js';

export type ProjectRow = typeof projects.$inferSelect;

export function visibilityCondition(userId: number) {
  return or(
    eq(projects.isPrivate, false),
    sql`EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = projects.id AND pm.user_id = ${userId})`,
    and(
      sql`projects.department_id IS NOT NULL`,
      sql`EXISTS (SELECT 1 FROM department_members dm WHERE dm.department_id = projects.department_id AND dm.user_id = ${userId})`,
    ),
  );
}

export async function listVisibleProjects(userId: number, isAdmin: boolean) {
  const where = isAdmin ? undefined : visibilityCondition(userId);
  const query = db.select().from(projects).orderBy(projects.name);
  return where ? query.where(where) : query;
}

export async function getVisibleProject(
  projectId: number,
  userId: number,
  isAdmin: boolean,
): Promise<ProjectRow | null> {
  const where = isAdmin
    ? eq(projects.id, projectId)
    : and(eq(projects.id, projectId), visibilityCondition(userId));
  const [row] = await db.select().from(projects).where(where);
  return row ?? null;
}

export async function isProjectMember(projectId: number, userId: number): Promise<boolean> {
  const [row] = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  return Boolean(row);
}

export async function addProjectMember(
  projectId: number,
  userId: number,
  role: 'lead' | 'member' = 'member',
): Promise<void> {
  await db
    .insert(projectMembers)
    .values({ projectId, userId, role })
    .onDuplicateKeyUpdate({ set: { role: sql`role` } });
}

export async function removeProjectMember(projectId: number, userId: number): Promise<void> {
  await db
    .delete(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
}

export async function createProject(input: {
  name: string;
  isPrivate: boolean;
  description?: string;
  departmentId?: number;
  createdBy: number;
}): Promise<ProjectRow> {
  const [{ id }] = await db
    .insert(projects)
    .values({
      name: input.name,
      isPrivate: input.isPrivate,
      description: input.description,
      departmentId: input.departmentId,
      createdBy: input.createdBy,
    })
    .$returningId();
  await addProjectMember(id, input.createdBy, 'lead');
  if (input.departmentId) {
    const members = await db
      .select({ userId: departmentMembers.userId })
      .from(departmentMembers)
      .where(eq(departmentMembers.departmentId, input.departmentId));
    for (const m of members) await addProjectMember(id, m.userId);
  }
  const [row] = await db.select().from(projects).where(eq(projects.id, id));
  return row;
}

export async function updateProject(
  id: number,
  patch: { name?: string; description?: string | null },
): Promise<void> {
  await db.update(projects).set(patch).where(eq(projects.id, id));
}

export async function archiveProject(id: number): Promise<void> {
  await db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, id));
}
```

- [ ] **Step 4: run** → PASS. **Step 5: Commit** — `feat(server): projectService — same visibility idiom as channelService, department auto-join`

### Task 3: taskService — board, default columns, server-authoritative move, comments — TDD

**Files:**
- Create: `server/src/services/taskService.ts`
- Test: `server/src/services/taskService.test.ts`

**Interfaces:**
- `createDefaultColumns(projectId): Promise<void>` — inserts Todo/In Progress/Done at positions 0/1000/2000
- `getBoard(projectId): Promise<{ columns: ColumnDto[]; tasks: TaskDto[] }>`
- `createTask(input: { projectId, columnId, title, description?, assigneeId?, dueDate?, createdBy }): Promise<TaskDto>` — appended to the end of the column
- `updateTask(id, patch): Promise<TaskDto | null>`
- `moveTask(id, columnId, beforeTaskId?, afterTaskId?): Promise<void>` — server computes the position; if the resulting gap is too small (`< 1e-9`), renormalizes the destination column first, then recomputes
- `addComment(taskId, userId, body): Promise<CommentDto>`, `listComments(taskId): Promise<CommentDto[]>`

- [ ] **Step 1: failing tests**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/index.js';
import { tasks, users } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { resetDb } from '../db/testUtils.js';
import { createProject } from './projectService.js';
import {
  addComment,
  createDefaultColumns,
  createTask,
  getBoard,
  listComments,
  moveTask,
  updateTask,
} from './taskService.js';

async function seedUser(email: string) {
  const [{ id }] = await db
    .insert(users)
    .values({ email, passwordHash: 'x', displayName: email.split('@')[0] })
    .$returningId();
  return id;
}

async function seedProject(owner: number) {
  return createProject({ name: 'Board Proj', isPrivate: false, createdBy: owner });
}

describe('taskService', () => {
  beforeEach(resetDb);

  it('creates default columns and returns an empty board', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const proj = await seedProject(owner);
    await createDefaultColumns(proj.id);
    const board = await getBoard(proj.id);
    expect(board.columns.map((c) => c.name)).toEqual(['Todo', 'In Progress', 'Done']);
    expect(board.tasks).toHaveLength(0);
  });

  it('appends new tasks to the end of a column and reports them in order', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const proj = await seedProject(owner);
    await createDefaultColumns(proj.id);
    const [todo] = (await getBoard(proj.id)).columns;
    const t1 = await createTask({ projectId: proj.id, columnId: todo.id, title: 'first', createdBy: owner });
    const t2 = await createTask({ projectId: proj.id, columnId: todo.id, title: 'second', createdBy: owner });
    const board = await getBoard(proj.id);
    const ordered = board.tasks.filter((t) => t.columnId === todo.id).sort((a, b) => a.position - b.position);
    expect(ordered.map((t) => t.id)).toEqual([t1.id, t2.id]);
  });

  it('moves a task between two others via midpoint position', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const proj = await seedProject(owner);
    await createDefaultColumns(proj.id);
    const [todo] = (await getBoard(proj.id)).columns;
    const t1 = await createTask({ projectId: proj.id, columnId: todo.id, title: 'A', createdBy: owner });
    const t2 = await createTask({ projectId: proj.id, columnId: todo.id, title: 'B', createdBy: owner });
    const t3 = await createTask({ projectId: proj.id, columnId: todo.id, title: 'C', createdBy: owner });

    // move C between A and B
    await moveTask(t3.id, todo.id, t2.id, t1.id);
    const board = await getBoard(proj.id);
    const ordered = board.tasks
      .filter((t) => t.columnId === todo.id)
      .sort((a, b) => a.position - b.position)
      .map((t) => t.id);
    expect(ordered).toEqual([t1.id, t3.id, t2.id]);
  });

  it('renormalizes a column when repeated moves collapse the float gap', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const proj = await seedProject(owner);
    await createDefaultColumns(proj.id);
    const [todo] = (await getBoard(proj.id)).columns;
    const t1 = await createTask({ projectId: proj.id, columnId: todo.id, title: 'A', createdBy: owner });
    const t2 = await createTask({ projectId: proj.id, columnId: todo.id, title: 'B', createdBy: owner });
    // repeatedly halve the gap between t1 and t2 many times
    for (let i = 0; i < 60; i++) {
      await moveTask(t2.id, todo.id, undefined, t1.id);
      await moveTask(t1.id, todo.id, t2.id, undefined);
    }
    const board = await getBoard(proj.id);
    const positions = board.tasks.filter((t) => t.columnId === todo.id).map((t) => t.position);
    expect(new Set(positions).size).toBe(2); // still distinct — renormalization kept them apart
  });

  it('updates a task and manages comments', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const proj = await seedProject(owner);
    await createDefaultColumns(proj.id);
    const [todo] = (await getBoard(proj.id)).columns;
    const t1 = await createTask({ projectId: proj.id, columnId: todo.id, title: 'A', createdBy: owner });

    const updated = await updateTask(t1.id, { title: 'A updated', assigneeId: owner });
    expect(updated?.title).toBe('A updated');

    await addComment(t1.id, owner, 'first comment');
    const comments = await listComments(t1.id);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toBe('first comment');
  });
});
```

- [ ] **Step 2: run** → FAIL. **Step 3: implement**

```ts
import { and, asc, eq, gt, lt } from 'drizzle-orm';
import { db } from '../db/index.js';
import { taskColumns, taskComments, tasks, users } from '../db/schema/index.js';

export interface ColumnDto {
  id: number;
  name: string;
  position: number;
}

export interface TaskDto {
  id: number;
  projectId: number;
  columnId: number;
  title: string;
  description: string | null;
  assigneeId: number | null;
  dueDate: string | null;
  position: number;
}

export interface CommentDto {
  id: number;
  taskId: number;
  userId: number;
  displayName: string;
  body: string;
  createdAt: Date;
}

const GAP = 1000;
const MIN_GAP = 1e-6;

export async function createDefaultColumns(projectId: number): Promise<void> {
  await db.insert(taskColumns).values([
    { projectId, name: 'Todo', position: 0 },
    { projectId, name: 'In Progress', position: GAP },
    { projectId, name: 'Done', position: GAP * 2 },
  ]);
}

function toColumnDto(row: typeof taskColumns.$inferSelect): ColumnDto {
  return { id: row.id, name: row.name, position: row.position };
}

function toTaskDto(row: typeof tasks.$inferSelect): TaskDto {
  return {
    id: row.id,
    projectId: row.projectId,
    columnId: row.columnId,
    title: row.title,
    description: row.description,
    assigneeId: row.assigneeId,
    dueDate: row.dueDate,
    position: row.position,
  };
}

export async function getBoard(projectId: number): Promise<{ columns: ColumnDto[]; tasks: TaskDto[] }> {
  const columns = await db
    .select()
    .from(taskColumns)
    .where(eq(taskColumns.projectId, projectId))
    .orderBy(asc(taskColumns.position));
  const taskRows = await db.select().from(tasks).where(eq(tasks.projectId, projectId));
  return { columns: columns.map(toColumnDto), tasks: taskRows.map(toTaskDto) };
}

export async function createTask(input: {
  projectId: number;
  columnId: number;
  title: string;
  description?: string;
  assigneeId?: number;
  dueDate?: string;
  createdBy: number;
}): Promise<TaskDto> {
  const [last] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.columnId, input.columnId))
    .orderBy(asc(tasks.position))
    .limit(1000); // small boards — fetch all, take max in JS below
  const maxPosition = last ? Math.max(...(await db
    .select({ position: tasks.position })
    .from(tasks)
    .where(eq(tasks.columnId, input.columnId))).map((r) => r.position)) : -GAP;
  const [{ id }] = await db
    .insert(tasks)
    .values({
      projectId: input.projectId,
      columnId: input.columnId,
      title: input.title,
      description: input.description,
      assigneeId: input.assigneeId,
      dueDate: input.dueDate,
      position: maxPosition + GAP,
      createdBy: input.createdBy,
    })
    .$returningId();
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
  return toTaskDto(row);
}

export async function updateTask(
  id: number,
  patch: {
    title?: string;
    description?: string | null;
    assigneeId?: number | null;
    dueDate?: string | null;
  },
): Promise<TaskDto | null> {
  await db.update(tasks).set(patch).where(eq(tasks.id, id));
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
  return row ? toTaskDto(row) : null;
}

async function renormalizeColumn(columnId: number): Promise<void> {
  const rows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.columnId, columnId))
    .orderBy(asc(tasks.position));
  for (let i = 0; i < rows.length; i++) {
    await db.update(tasks).set({ position: i * GAP }).where(eq(tasks.id, rows[i].id));
  }
}

export async function moveTask(
  taskId: number,
  columnId: number,
  beforeTaskId?: number,
  afterTaskId?: number,
): Promise<void> {
  async function computePosition(): Promise<number> {
    const before = beforeTaskId
      ? (await db.select().from(tasks).where(eq(tasks.id, beforeTaskId)))[0]
      : undefined;
    const after = afterTaskId
      ? (await db.select().from(tasks).where(eq(tasks.id, afterTaskId)))[0]
      : undefined;
    if (before && after) return (before.position + after.position) / 2;
    if (before) return before.position + GAP;
    if (after) return after.position - GAP;
    // empty column, or no neighbors given: append to end
    const rows = await db.select().from(tasks).where(eq(tasks.columnId, columnId));
    const max = rows.length ? Math.max(...rows.map((r) => r.position)) : -GAP;
    return max + GAP;
  }

  let position = await computePosition();

  if (beforeTaskId && afterTaskId) {
    const before = (await db.select().from(tasks).where(eq(tasks.id, beforeTaskId)))[0];
    const after = (await db.select().from(tasks).where(eq(tasks.id, afterTaskId)))[0];
    if (Math.abs(before.position - after.position) < MIN_GAP) {
      await renormalizeColumn(columnId);
      position = await computePosition();
    }
  }

  await db.update(tasks).set({ columnId, position }).where(eq(tasks.id, taskId));
}

export async function addComment(taskId: number, userId: number, body: string): Promise<CommentDto> {
  const [{ id }] = await db.insert(taskComments).values({ taskId, userId, body }).$returningId();
  const [row] = await db
    .select({
      id: taskComments.id,
      taskId: taskComments.taskId,
      userId: taskComments.userId,
      body: taskComments.body,
      createdAt: taskComments.createdAt,
      displayName: users.displayName,
    })
    .from(taskComments)
    .innerJoin(users, eq(users.id, taskComments.userId))
    .where(eq(taskComments.id, id));
  return row;
}

export async function listComments(taskId: number): Promise<CommentDto[]> {
  return db
    .select({
      id: taskComments.id,
      taskId: taskComments.taskId,
      userId: taskComments.userId,
      body: taskComments.body,
      createdAt: taskComments.createdAt,
      displayName: users.displayName,
    })
    .from(taskComments)
    .innerJoin(users, eq(users.id, taskComments.userId))
    .where(eq(taskComments.taskId, taskId))
    .orderBy(asc(taskComments.createdAt));
}
```

(NOTE for implementer: the `createTask` function above has a redundant/wasteful first query — the `last`/`limit(1000)` line is dead code left from an earlier draft. Delete it; only the `maxPosition` computation below it is needed. Fix this during Step 3, not after — it's a correctness-neutral but embarrassing leftover, don't ship it.)

- [ ] **Step 4: run** → PASS (after removing the dead code noted above). **Step 5: Commit** — `feat(server): taskService — board, server-authoritative task positions with renormalization, comments`

### Task 4: docService + noteService — TDD

**Files:**
- Create: `server/src/services/docService.ts`, `server/src/services/noteService.ts`
- Test: `server/src/services/docService.test.ts`, `server/src/services/noteService.test.ts`

**Interfaces:**
- doc: `listDocs(projectId)`, `getDoc(id)`, `createDoc(input: {projectId,title,content?,userId})`, `updateDoc(id,{title?,content?},userId)`, `deleteDoc(id)`
- note: `listNotes(userId, opts?: {q?, pinnedOnly?})`, `getOwnNote(id, userId)` — returns `null` if missing OR not owned (caller 404s either way), `createNote(userId,{title,content?})`, `updateNote(id,userId,{title?,content?,pinned?})` returns boolean, `deleteNote(id,userId)` returns boolean, `convertNoteToDoc(id,userId,projectId)` — creates the doc, deletes the note, returns the new doc or `null` if the note wasn't found/owned

- [ ] **Step 1: failing tests** — `docService.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { createProject } from './projectService.js';
import { createDoc, deleteDoc, getDoc, listDocs, updateDoc } from './docService.js';

async function seedUser(email: string) {
  const [{ id }] = await db
    .insert(users)
    .values({ email, passwordHash: 'x', displayName: email.split('@')[0] })
    .$returningId();
  return id;
}

describe('docService', () => {
  beforeEach(resetDb);

  it('creates, lists, updates, and deletes a doc', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const proj = await createProject({ name: 'P', isPrivate: false, createdBy: owner });
    const doc = await createDoc({ projectId: proj.id, title: 'Runbook', content: '# hi', userId: owner });
    expect((await listDocs(proj.id)).map((d) => d.id)).toContain(doc.id);
    await updateDoc(doc.id, { content: '# updated' }, owner);
    expect((await getDoc(doc.id))?.content).toBe('# updated');
    await deleteDoc(doc.id);
    expect(await getDoc(doc.id)).toBeNull();
  });
});
```

`noteService.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { createProject } from './projectService.js';
import {
  convertNoteToDoc,
  createNote,
  deleteNote,
  getOwnNote,
  listNotes,
  updateNote,
} from './noteService.js';

async function seedUser(email: string) {
  const [{ id }] = await db
    .insert(users)
    .values({ email, passwordHash: 'x', displayName: email.split('@')[0] })
    .$returningId();
  return id;
}

describe('noteService', () => {
  beforeEach(resetDb);

  it('is strictly owner-scoped', async () => {
    const a = await seedUser('a@flowerstore.ph');
    const b = await seedUser('b@flowerstore.ph');
    const note = await createNote(a, { title: 'Mine', content: 'secret' });
    expect(await getOwnNote(note.id, a)).not.toBeNull();
    expect(await getOwnNote(note.id, b)).toBeNull();
    expect(await updateNote(note.id, b, { title: 'hacked' })).toBe(false);
    expect(await deleteNote(note.id, b)).toBe(false);
    expect((await listNotes(a)).map((n) => n.id)).toContain(note.id);
    expect((await listNotes(b)).map((n) => n.id)).not.toContain(note.id);
  });

  it('searches and filters pinned within the owner scope only', async () => {
    const a = await seedUser('a@flowerstore.ph');
    await createNote(a, { title: 'Grocery list', content: 'milk eggs bread' });
    const pinned = await createNote(a, { title: 'Important', content: 'unique-note-token' });
    await updateNote(pinned.id, a, { pinned: true });

    const results = await listNotes(a, { q: 'unique-note-token' });
    expect(results.map((n) => n.id)).toEqual([pinned.id]);

    const pinnedOnly = await listNotes(a, { pinnedOnly: true });
    expect(pinnedOnly.map((n) => n.id)).toEqual([pinned.id]);
  });

  it('convert-to-doc creates the doc in the target project and removes the note', async () => {
    const a = await seedUser('a@flowerstore.ph');
    const proj = await createProject({ name: 'P', isPrivate: false, createdBy: a });
    const note = await createNote(a, { title: 'Share me', content: 'body text' });
    const doc = await convertNoteToDoc(note.id, a, proj.id);
    expect(doc?.title).toBe('Share me');
    expect(doc?.content).toBe('body text');
    expect(await getOwnNote(note.id, a)).toBeNull();
  });
});
```

- [ ] **Step 2: run** → FAIL. **Step 3: implement**

`docService.ts`:

```ts
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { docs } from '../db/schema/index.js';

export type DocRow = typeof docs.$inferSelect;

export async function listDocs(projectId: number): Promise<DocRow[]> {
  return db.select().from(docs).where(eq(docs.projectId, projectId)).orderBy(docs.title);
}

export async function getDoc(id: number): Promise<DocRow | null> {
  const [row] = await db.select().from(docs).where(eq(docs.id, id));
  return row ?? null;
}

export async function createDoc(input: {
  projectId: number;
  title: string;
  content?: string;
  userId: number;
}): Promise<DocRow> {
  const [{ id }] = await db
    .insert(docs)
    .values({
      projectId: input.projectId,
      title: input.title,
      content: input.content ?? '',
      createdBy: input.userId,
      updatedBy: input.userId,
    })
    .$returningId();
  const doc = await getDoc(id);
  return doc!;
}

export async function updateDoc(
  id: number,
  patch: { title?: string; content?: string },
  userId: number,
): Promise<void> {
  await db.update(docs).set({ ...patch, updatedBy: userId }).where(eq(docs.id, id));
}

export async function deleteDoc(id: number): Promise<void> {
  await db.delete(docs).where(eq(docs.id, id));
}
```

`noteService.ts`:

```ts
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { notes } from '../db/schema/index.js';
import { createDoc, type DocRow } from './docService.js';

export type NoteRow = typeof notes.$inferSelect;

export async function listNotes(
  userId: number,
  opts: { q?: string; pinnedOnly?: boolean } = {},
): Promise<NoteRow[]> {
  const conditions = [eq(notes.userId, userId)];
  if (opts.pinnedOnly) conditions.push(eq(notes.pinned, true));
  if (opts.q) {
    conditions.push(sql`MATCH(${notes.title}, ${notes.content}) AGAINST(${opts.q} IN NATURAL LANGUAGE MODE)`);
  }
  return db
    .select()
    .from(notes)
    .where(and(...conditions))
    .orderBy(desc(notes.pinned), desc(notes.updatedAt));
}

export async function getOwnNote(id: number, userId: number): Promise<NoteRow | null> {
  const [row] = await db.select().from(notes).where(and(eq(notes.id, id), eq(notes.userId, userId)));
  return row ?? null;
}

export async function createNote(
  userId: number,
  input: { title: string; content?: string },
): Promise<NoteRow> {
  const [{ id }] = await db
    .insert(notes)
    .values({ userId, title: input.title, content: input.content ?? '' })
    .$returningId();
  const [row] = await db.select().from(notes).where(eq(notes.id, id));
  return row;
}

export async function updateNote(
  id: number,
  userId: number,
  patch: { title?: string; content?: string; pinned?: boolean },
): Promise<boolean> {
  if (!(await getOwnNote(id, userId))) return false;
  await db.update(notes).set(patch).where(and(eq(notes.id, id), eq(notes.userId, userId)));
  return true;
}

export async function deleteNote(id: number, userId: number): Promise<boolean> {
  if (!(await getOwnNote(id, userId))) return false;
  await db.delete(notes).where(and(eq(notes.id, id), eq(notes.userId, userId)));
  return true;
}

export async function convertNoteToDoc(
  id: number,
  userId: number,
  projectId: number,
): Promise<DocRow | null> {
  const note = await getOwnNote(id, userId);
  if (!note) return null;
  const doc = await createDoc({ projectId, title: note.title, content: note.content, userId });
  await db.delete(notes).where(and(eq(notes.id, id), eq(notes.userId, userId)));
  return doc;
}
```

- [ ] **Step 4: run** → PASS. **Step 5: Commit** — `feat(server): docService + strictly owner-scoped noteService with convert-to-doc`

### Task 5: routes — projects/docs/columns/tasks/notes — TDD (supertest)

**Files:**
- Create: `server/src/routes/projects.ts`, `server/src/routes/notes.ts`
- Modify: `server/src/app.ts`
- Test: `server/src/routes/projects.test.ts`, `server/src/routes/notes.test.ts`

**Interfaces (all under `requireAuth`):**
- GET/POST `/api/projects`; GET/PATCH `/api/projects/:id`; POST/DELETE `/api/projects/:id/members`
- GET/POST `/api/projects/:id/docs`; GET/PATCH/DELETE `/api/docs/:id`
- GET `/api/projects/:id/board`; POST `/api/projects/:id/tasks`; GET/PATCH/DELETE `/api/tasks/:id`; POST `/api/tasks/:id/move`; GET/POST `/api/tasks/:id/comments`
- GET `/api/notes?q&pinned`; POST `/api/notes`; GET/PATCH/DELETE `/api/notes/:id`; POST `/api/notes/:id/convert-to-doc`
- Project creation auto-calls `createDefaultColumns`
- `PATCH/DELETE /api/tasks/:id`, doc mutation routes: require project visibility (404 for non-visible), not stricter membership — any project viewer may edit in v1 (matches "task detail w/ comments" simplicity; tightening to members-only is a fast follow, not required this phase)
- Notes routes: NO scope exists for service tokens; since tokens aren't implemented until Phase 8, this is enforced today simply by every notes route requiring `requireAuth` (which only recognizes user JWTs) — document this explicitly so Phase 8 doesn't accidentally wire a notes scope in

- [ ] **Step 1: failing tests** — `projects.test.ts`:

```ts
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { resetDb } from '../db/testUtils.js';
import { makeUser } from '../testHelpers.js';

const app = createApp();

describe('project routes', () => {
  beforeEach(resetDb);

  it('creates a project with default columns, 404s a private one for outsiders', async () => {
    const owner = await makeUser(app, { email: 'owner@flowerstore.ph' });
    const outsider = await makeUser(app, { email: 'outsider@flowerstore.ph' });

    const create = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Secret Proj', isPrivate: true });
    expect(create.status).toBe(201);
    const projectId = create.body.project.id;

    const board = await request(app)
      .get(`/api/projects/${projectId}/board`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(board.body.columns.map((c: { name: string }) => c.name)).toEqual(['Todo', 'In Progress', 'Done']);

    expect(
      (await request(app).get(`/api/projects/${projectId}`).set('Authorization', `Bearer ${outsider.token}`))
        .status,
    ).toBe(404);
  });

  it('creates a task, moves it, adds a comment, and manages docs', async () => {
    const owner = await makeUser(app, { email: 'owner2@flowerstore.ph' });
    const proj = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Board Proj', isPrivate: false });
    const projectId = proj.body.project.id;
    const board = await request(app)
      .get(`/api/projects/${projectId}/board`)
      .set('Authorization', `Bearer ${owner.token}`);
    const todoId = board.body.columns[0].id;
    const doneId = board.body.columns[2].id;

    const task = await request(app)
      .post(`/api/projects/${projectId}/tasks`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ columnId: todoId, title: 'Ship it' });
    expect(task.status).toBe(201);

    await request(app)
      .post(`/api/tasks/${task.body.task.id}/move`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ columnId: doneId })
      .expect(200);

    await request(app)
      .post(`/api/tasks/${task.body.task.id}/comments`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ body: 'done!' })
      .expect(201);

    const comments = await request(app)
      .get(`/api/tasks/${task.body.task.id}/comments`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(comments.body.comments).toHaveLength(1);

    const doc = await request(app)
      .post(`/api/projects/${projectId}/docs`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ title: 'Runbook', content: '# hi' });
    expect(doc.status).toBe(201);

    const docs = await request(app)
      .get(`/api/projects/${projectId}/docs`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(docs.body.docs).toHaveLength(1);
  });
});
```

`notes.test.ts`:

```ts
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { resetDb } from '../db/testUtils.js';
import { makeUser } from '../testHelpers.js';

const app = createApp();

describe('notes routes', () => {
  beforeEach(resetDb);

  it('is invisible to everyone else, including admins', async () => {
    const owner = await makeUser(app, { email: 'owner@flowerstore.ph' });
    const admin = await makeUser(app, { email: 'admin@flowerstore.ph', admin: true });

    const note = await request(app)
      .post('/api/notes')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ title: 'Private', content: 'shh' });
    expect(note.status).toBe(201);
    const noteId = note.body.note.id;

    expect(
      (await request(app).get(`/api/notes/${noteId}`).set('Authorization', `Bearer ${admin.token}`)).status,
    ).toBe(404);
    expect(
      (await request(app).get(`/api/notes/${noteId}`).set('Authorization', `Bearer ${owner.token}`)).status,
    ).toBe(200);
  });

  it('converts to a project doc and removes the note', async () => {
    const owner = await makeUser(app, { email: 'owner2@flowerstore.ph' });
    const proj = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'P', isPrivate: false });
    const note = await request(app)
      .post('/api/notes')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ title: 'Convert me', content: 'body' });

    const converted = await request(app)
      .post(`/api/notes/${note.body.note.id}/convert-to-doc`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ projectId: proj.body.project.id });
    expect(converted.status).toBe(201);
    expect(converted.body.doc.title).toBe('Convert me');

    expect(
      (await request(app).get(`/api/notes/${note.body.note.id}`).set('Authorization', `Bearer ${owner.token}`))
        .status,
    ).toBe(404);
  });
});
```

- [ ] **Step 2: run** → FAIL. **Step 3: implement**

`routes/projects.ts`:

```ts
import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  createDoc,
  deleteDoc,
  getDoc,
  listDocs,
  updateDoc,
} from '../services/docService.js';
import {
  addProjectMember,
  createProject,
  getVisibleProject,
  listVisibleProjects,
  removeProjectMember,
  updateProject,
} from '../services/projectService.js';
import {
  addComment,
  createDefaultColumns,
  createTask,
  getBoard,
  listComments,
  moveTask,
  updateTask,
} from '../services/taskService.js';

export const projectsRouter = Router();
projectsRouter.use(requireAuth);

function parseId(raw: string | string[]): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'validation_error', 'Bad id');
  return id;
}

async function requireVisibleProject(projectId: number, userId: number, isAdmin: boolean) {
  const project = await getVisibleProject(projectId, userId, isAdmin);
  if (!project) throw new AppError(404, 'not_found', 'Not found');
  return project;
}

projectsRouter.get('/', async (req, res) => {
  const projects = await listVisibleProjects(req.auth!.userId, req.auth!.role === 'admin');
  res.json({ projects });
});

const createBody = z.object({
  name: z.string().min(1).max(120),
  isPrivate: z.boolean(),
  description: z.string().max(2000).optional(),
  departmentId: z.number().int().positive().optional(),
});

projectsRouter.post('/', validate(createBody), async (req, res) => {
  const input = req.valid as z.infer<typeof createBody>;
  const project = await createProject({ ...input, createdBy: req.auth!.userId });
  await createDefaultColumns(project.id);
  res.status(201).json({ project });
});

projectsRouter.get('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const project = await requireVisibleProject(id, req.auth!.userId, req.auth!.role === 'admin');
  res.json({ project });
});

const patchBody = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
});

projectsRouter.patch('/:id', validate(patchBody), async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleProject(id, req.auth!.userId, req.auth!.role === 'admin');
  await updateProject(id, req.valid as z.infer<typeof patchBody>);
  const project = await getVisibleProject(id, req.auth!.userId, true);
  res.json({ project });
});

const memberBody = z.object({ userId: z.number().int().positive() });

projectsRouter.post('/:id/members', validate(memberBody), async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleProject(id, req.auth!.userId, req.auth!.role === 'admin');
  await addProjectMember(id, (req.valid as z.infer<typeof memberBody>).userId);
  res.status(201).json({ ok: true });
});

projectsRouter.delete('/:id/members/:userId', async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleProject(id, req.auth!.userId, req.auth!.role === 'admin');
  await removeProjectMember(id, parseId(req.params.userId));
  res.json({ ok: true });
});

projectsRouter.get('/:id/board', async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleProject(id, req.auth!.userId, req.auth!.role === 'admin');
  res.json(await getBoard(id));
});

const taskBody = z.object({
  columnId: z.number().int().positive(),
  title: z.string().min(1).max(300),
  description: z.string().max(10000).optional(),
  assigneeId: z.number().int().positive().optional(),
  dueDate: z.string().date().optional(),
});

projectsRouter.post('/:id/tasks', validate(taskBody), async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleProject(id, req.auth!.userId, req.auth!.role === 'admin');
  const input = req.valid as z.infer<typeof taskBody>;
  const task = await createTask({ projectId: id, ...input, createdBy: req.auth!.userId });
  res.status(201).json({ task });
});

const docBody = z.object({ title: z.string().min(1).max(200), content: z.string().max(200000).optional() });

projectsRouter.post('/:id/docs', validate(docBody), async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleProject(id, req.auth!.userId, req.auth!.role === 'admin');
  const input = req.valid as z.infer<typeof docBody>;
  const doc = await createDoc({ projectId: id, ...input, userId: req.auth!.userId });
  res.status(201).json({ doc });
});

projectsRouter.get('/:id/docs', async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleProject(id, req.auth!.userId, req.auth!.role === 'admin');
  res.json({ docs: await listDocs(id) });
});

export const docsRouter = Router();
docsRouter.use(requireAuth);

async function requireVisibleDoc(docId: number, userId: number, isAdmin: boolean) {
  const doc = await getDoc(docId);
  if (!doc) throw new AppError(404, 'not_found', 'Not found');
  await requireVisibleProject(doc.projectId, userId, isAdmin);
  return doc;
}

docsRouter.get('/:id', async (req, res) => {
  const doc = await requireVisibleDoc(parseId(req.params.id), req.auth!.userId, req.auth!.role === 'admin');
  res.json({ doc });
});

const docPatch = z.object({ title: z.string().min(1).max(200).optional(), content: z.string().max(200000).optional() });

docsRouter.patch('/:id', validate(docPatch), async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleDoc(id, req.auth!.userId, req.auth!.role === 'admin');
  await updateDoc(id, req.valid as z.infer<typeof docPatch>, req.auth!.userId);
  res.json({ doc: await getDoc(id) });
});

docsRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleDoc(id, req.auth!.userId, req.auth!.role === 'admin');
  await deleteDoc(id);
  res.json({ ok: true });
});

export const tasksRouter = Router();
tasksRouter.use(requireAuth);

// Tasks don't carry visibility metadata directly — trust the board fetch that
// preceded this call in the UI; a defense-in-depth project check happens via
// task.projectId once loaded, mirroring the doc pattern.
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tasks as tasksTable } from '../db/schema/index.js';

async function requireVisibleTask(taskId: number, userId: number, isAdmin: boolean) {
  const [row] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
  if (!row) throw new AppError(404, 'not_found', 'Not found');
  await requireVisibleProject(row.projectId, userId, isAdmin);
  return row;
}

const taskPatch = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(10000).nullable().optional(),
  assigneeId: z.number().int().positive().nullable().optional(),
  dueDate: z.string().date().nullable().optional(),
});

tasksRouter.get('/:id', async (req, res) => {
  const task = await requireVisibleTask(parseId(req.params.id), req.auth!.userId, req.auth!.role === 'admin');
  res.json({ task });
});

tasksRouter.patch('/:id', validate(taskPatch), async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleTask(id, req.auth!.userId, req.auth!.role === 'admin');
  const task = await updateTask(id, req.valid as z.infer<typeof taskPatch>);
  res.json({ task });
});

tasksRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleTask(id, req.auth!.userId, req.auth!.role === 'admin');
  await db.delete(tasksTable).where(eq(tasksTable.id, id));
  res.json({ ok: true });
});

const moveBody = z.object({
  columnId: z.number().int().positive(),
  beforeTaskId: z.number().int().positive().optional(),
  afterTaskId: z.number().int().positive().optional(),
});

tasksRouter.post('/:id/move', validate(moveBody), async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleTask(id, req.auth!.userId, req.auth!.role === 'admin');
  const { columnId, beforeTaskId, afterTaskId } = req.valid as z.infer<typeof moveBody>;
  await moveTask(id, columnId, beforeTaskId, afterTaskId);
  res.json({ ok: true });
});

const commentBody = z.object({ body: z.string().min(1).max(4000) });

tasksRouter.post('/:id/comments', validate(commentBody), async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleTask(id, req.auth!.userId, req.auth!.role === 'admin');
  const comment = await addComment(id, req.auth!.userId, (req.valid as z.infer<typeof commentBody>).body);
  res.status(201).json({ comment });
});

tasksRouter.get('/:id/comments', async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleTask(id, req.auth!.userId, req.auth!.role === 'admin');
  res.json({ comments: await listComments(id) });
});
```

(NOTE for implementer: move the `import { eq } from 'drizzle-orm'` and `import { db } from '../db/index.js'` and the `tasks as tasksTable` import to the top of the file with the other imports — they're written mid-file above only to keep this plan step readable next to the code that uses them. A real file must not have imports after other statements.)

`routes/notes.ts`:

```ts
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import {
  convertNoteToDoc,
  createNote,
  deleteNote,
  getOwnNote,
  listNotes,
  updateNote,
} from '../services/noteService.js';

export const notesRouter = Router();
notesRouter.use(requireAuth);

function parseId(raw: string | string[]): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'validation_error', 'Bad id');
  return id;
}

const listQuery = z.object({
  q: z.string().max(200).optional(),
  pinned: z.coerce.boolean().optional(),
});

notesRouter.get('/', validate(listQuery, 'query'), async (req, res) => {
  const { q, pinned } = req.valid as z.infer<typeof listQuery>;
  const notes = await listNotes(req.auth!.userId, { q, pinnedOnly: pinned });
  res.json({ notes });
});

const createBody = z.object({ title: z.string().min(1).max(200), content: z.string().max(200000).optional() });

notesRouter.post('/', validate(createBody), async (req, res) => {
  const note = await createNote(req.auth!.userId, req.valid as z.infer<typeof createBody>);
  res.status(201).json({ note });
});

notesRouter.get('/:id', async (req, res) => {
  const note = await getOwnNote(parseId(req.params.id), req.auth!.userId);
  if (!note) throw new AppError(404, 'not_found', 'Not found');
  res.json({ note });
});

const patchBody = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.string().max(200000).optional(),
  pinned: z.boolean().optional(),
});

notesRouter.patch('/:id', validate(patchBody), async (req, res) => {
  const id = parseId(req.params.id);
  const ok = await updateNote(id, req.auth!.userId, req.valid as z.infer<typeof patchBody>);
  if (!ok) throw new AppError(404, 'not_found', 'Not found');
  res.json({ note: await getOwnNote(id, req.auth!.userId) });
});

notesRouter.delete('/:id', async (req, res) => {
  const ok = await deleteNote(parseId(req.params.id), req.auth!.userId);
  if (!ok) throw new AppError(404, 'not_found', 'Not found');
  res.json({ ok: true });
});

const convertBody = z.object({ projectId: z.number().int().positive() });

notesRouter.post('/:id/convert-to-doc', validate(convertBody), async (req, res) => {
  const id = parseId(req.params.id);
  const doc = await convertNoteToDoc(id, req.auth!.userId, (req.valid as z.infer<typeof convertBody>).projectId);
  if (!doc) throw new AppError(404, 'not_found', 'Not found');
  res.status(201).json({ doc });
});
```

Mount in `app.ts`:

```ts
import { docsRouter, projectsRouter, tasksRouter } from './routes/projects.js';
import { notesRouter } from './routes/notes.js';
// ...
app.use('/api/projects', projectsRouter);
app.use('/api/docs', docsRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/notes', notesRouter);
```

- [ ] **Step 4: run** → PASS (after fixing the mid-file-imports note above). **Step 5: Commit** — `feat(server): project/doc/task/notes routes — project visibility reused, notes strictly owner-scoped`

### Task 6: Phase-2 gate item — verify notes reject service tokens (documentation-only, no code)

No service tokens exist until Phase 8, so there is nothing to test today. Add a one-line comment above `notesRouter.use(requireAuth)` (already present in Task 5's code) stating this explicitly, and add a line to this plan's own risk notes (below) so Phase 8 doesn't wire a `notes` scope in by habit. This "task" is a documentation checkpoint, not a code step — confirm the comment exists, then move on.

### Task 7: Frontend — projects list, docs, kanban board, notes

**Files:**
- Create: `src/features/projects/{api.ts,types.ts,ProjectListPage.tsx,NewProjectDialog.tsx}`
- Create: `src/features/docs/{DocListPage.tsx,DocPage.tsx,Markdown.tsx}`
- Create: `src/features/kanban/{ProjectBoardPage.tsx,BoardColumn.tsx,TaskCard.tsx,TaskDetailSheet.tsx,dnd.ts}`
- Create: `src/features/notes/{NotesPage.tsx,api.ts,types.ts}`
- Modify: `src/app/router.tsx`, `src/features/chat/Sidebar.tsx`
- Install: `@atlaskit/pragmatic-drag-and-drop`, `react-markdown`, `remark-gfm`, `rehype-sanitize`
- shadcn: `npx shadcn@latest add sheet textarea`

- [ ] **Step 1: install deps**

```bash
npm install @atlaskit/pragmatic-drag-and-drop react-markdown remark-gfm rehype-sanitize
npx shadcn@latest add sheet
```

- [ ] **Step 2: `src/features/projects/types.ts`**

```ts
export interface Project {
  id: number;
  name: string;
  description: string | null;
  isPrivate: boolean;
  departmentId: number | null;
  createdBy: number | null;
  archivedAt: string | null;
  createdAt: string;
}
```

- [ ] **Step 3: `src/features/projects/api.ts`**

```ts
import { api } from '@/lib/api';
import type { Project } from './types';

export const listProjects = () => api<{ projects: Project[] }>('/api/projects');

export const createProject = (input: {
  name: string;
  isPrivate: boolean;
  description?: string;
  departmentId?: number;
}) => api<{ project: Project }>('/api/projects', { method: 'POST', body: input });

export const getProject = (id: number) => api<{ project: Project }>(`/api/projects/${id}`);
```

- [ ] **Step 4: `NewProjectDialog.tsx`**

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createProject } from './api';

export function NewProjectDialog() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const { project } = await createProject({ name: name.trim(), isPrivate });
      setOpen(false);
      setName('');
      navigate(`/projects/${project.id}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>New project</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create project</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="proj-name">Name</Label>
            <Input id="proj-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
            Private (invite-only)
          </label>
          <Button disabled={!name.trim() || busy} onClick={submit}>
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 5: `ProjectListPage.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { listProjects } from './api';
import { NewProjectDialog } from './NewProjectDialog';

export function ProjectListPage() {
  const { data } = useQuery({ queryKey: ['projects'], queryFn: listProjects });

  return (
    <main className="mx-auto w-full max-w-3xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <NewProjectDialog />
      </div>
      <div className="grid gap-3">
        {data?.projects.map((p) => (
          <Link key={p.id} to={`/projects/${p.id}`}>
            <Card className="hover:bg-muted/50">
              <CardHeader>
                <CardTitle className="text-base">{p.name}</CardTitle>
              </CardHeader>
              {p.description && (
                <CardContent className="text-sm text-muted-foreground">{p.description}</CardContent>
              )}
            </Card>
          </Link>
        ))}
      </div>
    </main>
  );
}
```

- [ ] **Step 6: `src/features/docs/Markdown.tsx`**

```tsx
import rehypeSanitize from 'rehype-sanitize';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function Markdown({ content }: { content: string }) {
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
```

- [ ] **Step 7: `src/features/docs/DocPage.tsx`** (editor with preview toggle):

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { Markdown } from './Markdown';

interface Doc {
  id: number;
  projectId: number;
  title: string;
  content: string;
}

export function DocPage() {
  const { docId } = useParams();
  const id = Number(docId);
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['doc', id],
    queryFn: () => api<{ doc: Doc }>(`/api/docs/${id}`),
    enabled: Number.isFinite(id),
  });
  const [content, setContent] = useState('');
  const [preview, setPreview] = useState(false);

  useEffect(() => {
    if (data) setContent(data.doc.content);
  }, [data]);

  const save = useMutation({
    mutationFn: () => api(`/api/docs/${id}`, { method: 'PATCH', body: { content } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['doc', id] }),
  });

  if (!data) return null;

  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-semibold">{data.doc.title}</h2>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setPreview((v) => !v)}>
            {preview ? 'Edit' : 'Preview'}
          </Button>
          <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </div>
      </div>
      {preview ? (
        <Markdown content={content} />
      ) : (
        <textarea
          className="flex-1 resize-none rounded-md border bg-background p-3 font-mono text-sm outline-none"
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 8: `src/features/docs/DocListPage.tsx`**

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';

interface Doc {
  id: number;
  title: string;
}

export function DocListPage() {
  const { projectId } = useParams();
  const id = Number(projectId);
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const { data } = useQuery({
    queryKey: ['docs', id],
    queryFn: () => api<{ docs: Doc[] }>(`/api/projects/${id}/docs`),
    enabled: Number.isFinite(id),
  });

  const create = useMutation({
    mutationFn: () => api(`/api/projects/${id}/docs`, { method: 'POST', body: { title, content: '' } }),
    onSuccess: () => {
      setTitle('');
      queryClient.invalidateQueries({ queryKey: ['docs', id] });
    },
  });

  return (
    <div className="p-4">
      <div className="mb-3 flex gap-2">
        <Input placeholder="New doc title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <Button disabled={!title.trim() || create.isPending} onClick={() => create.mutate()}>
          Add
        </Button>
      </div>
      <ul className="grid gap-1">
        {data?.docs.map((d) => (
          <li key={d.id}>
            <Link className="text-sm underline" to={`/projects/${id}/docs/${d.id}`}>
              {d.title}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 9: `src/features/kanban/dnd.ts`** — thin verified-API wrappers used by the board:

```ts
export {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
export { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
export {
  attachClosestEdge,
  extractClosestEdge,
} from '@atlaskit/pragmatic-drag-and-drop/hitbox/closest-edge';
export type { Edge } from '@atlaskit/pragmatic-drag-and-drop/types';
```

- [ ] **Step 10: `TaskCard.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react';
import { attachClosestEdge, combine, draggable, dropTargetForElements, extractClosestEdge } from './dnd';
import type { Edge } from '@atlaskit/pragmatic-drag-and-drop/types';

export interface TaskCardData {
  id: number;
  columnId: number;
  title: string;
  assigneeId: number | null;
  dueDate: string | null;
}

export function TaskCard({
  task,
  onOpen,
}: {
  task: TaskCardData;
  onOpen: (id: number) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [closestEdge, setClosestEdge] = useState<Edge | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return combine(
      draggable({
        element: el,
        getInitialData: () => ({ type: 'task', taskId: task.id, columnId: task.columnId }),
        onDragStart: () => setDragging(true),
        onDrop: () => setDragging(false),
      }),
      dropTargetForElements({
        element: el,
        canDrop: ({ source }) => source.data.type === 'task' && source.data.taskId !== task.id,
        getData: ({ input, element }) =>
          attachClosestEdge({ type: 'task', taskId: task.id, columnId: task.columnId }, {
            input,
            element,
            allowedEdges: ['top', 'bottom'],
          }),
        onDragEnter: (args) => setClosestEdge(extractClosestEdge(args.self.data)),
        onDrag: (args) => setClosestEdge(extractClosestEdge(args.self.data)),
        onDragLeave: () => setClosestEdge(null),
        onDrop: () => setClosestEdge(null),
      }),
    );
  }, [task.id, task.columnId]);

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onOpen(task.id)}
      className={`relative w-full rounded-md border bg-card p-2 text-left text-sm shadow-sm ${dragging ? 'opacity-40' : ''}`}
    >
      {closestEdge === 'top' && <div className="absolute inset-x-0 -top-1 h-0.5 bg-primary" />}
      {task.title}
      {task.dueDate && <div className="mt-1 text-xs text-muted-foreground">{task.dueDate}</div>}
      {closestEdge === 'bottom' && <div className="absolute inset-x-0 -bottom-1 h-0.5 bg-primary" />}
    </button>
  );
}
```

- [ ] **Step 11: `BoardColumn.tsx`**

```tsx
import { useEffect, useRef } from 'react';
import { dropTargetForElements } from './dnd';
import { TaskCard, type TaskCardData } from './TaskCard';

export function BoardColumn({
  column,
  tasks,
  onOpenTask,
}: {
  column: { id: number; name: string };
  tasks: TaskCardData[];
  onOpenTask: (id: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return dropTargetForElements({
      element: el,
      canDrop: ({ source }) => source.data.type === 'task',
      getData: () => ({ type: 'column', columnId: column.id }),
    });
  }, [column.id]);

  return (
    <div className="flex w-72 flex-shrink-0 flex-col rounded-md bg-muted/40 p-2">
      <h3 className="mb-2 px-1 text-sm font-semibold text-muted-foreground">{column.name}</h3>
      <div ref={ref} className="flex flex-1 flex-col gap-2">
        {tasks.map((t) => (
          <TaskCard key={t.id} task={t} onOpen={onOpenTask} />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 12: `ProjectBoardPage.tsx`** (owns the single board-level `monitorForElements` + task creation + detail sheet trigger):

```tsx
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { extractClosestEdge, monitorForElements } from './dnd';
import { BoardColumn } from './BoardColumn';
import { TaskDetailSheet } from './TaskDetailSheet';
import type { TaskCardData } from './TaskCard';

interface Column {
  id: number;
  name: string;
  position: number;
}

interface Board {
  columns: Column[];
  tasks: TaskCardData[];
}

export function ProjectBoardPage() {
  const { projectId } = useParams();
  const id = Number(projectId);
  const queryClient = useQueryClient();
  const key = ['board', id];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => api<Board>(`/api/projects/${id}/board`),
    enabled: Number.isFinite(id),
  });
  const [newTitle, setNewTitle] = useState('');
  const [openTaskId, setOpenTaskId] = useState<number | null>(null);

  useEffect(() => {
    return monitorForElements({
      onDrop({ source, location }) {
        const destination = location.current.dropTargets[0];
        if (!destination || source.data.type !== 'task') return;
        const taskId = source.data.taskId as number;
        const destData = destination.data as { type: string; columnId: number; taskId?: number };
        const columnId = destData.columnId;

        queryClient.setQueryData<Board>(key, (old) => {
          if (!old) return old;
          const others = old.tasks.filter((t) => t.id !== taskId);
          const columnTasks = others
            .filter((t) => t.columnId === columnId)
            .sort((a, b) => a.id - b.id); // client-side ordering is cosmetic only until refetch
          const moved = old.tasks.find((t) => t.id === taskId);
          if (!moved) return old;
          return { ...old, tasks: [...others, { ...moved, columnId }] };
        });

        let beforeTaskId: number | undefined;
        let afterTaskId: number | undefined;
        if (destData.type === 'task' && destData.taskId) {
          const edge = extractClosestEdge(destination.data);
          if (edge === 'top') afterTaskId = destData.taskId;
          else beforeTaskId = destData.taskId;
        }

        void api(`/api/tasks/${taskId}/move`, {
          method: 'POST',
          body: { columnId, beforeTaskId, afterTaskId },
        }).then(() => queryClient.invalidateQueries({ queryKey: key }));
      },
    });
  }, [id, queryClient]);

  if (!data) return null;

  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-3 flex gap-2">
        <Input
          placeholder="New task title"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
        />
        <Button
          disabled={!newTitle.trim()}
          onClick={async () => {
            await api(`/api/projects/${id}/tasks`, {
              method: 'POST',
              body: { columnId: data.columns[0].id, title: newTitle.trim() },
            });
            setNewTitle('');
            queryClient.invalidateQueries({ queryKey: key });
          }}
        >
          Add task
        </Button>
      </div>
      <div className="flex flex-1 gap-3 overflow-x-auto">
        {data.columns.map((c) => (
          <BoardColumn
            key={c.id}
            column={c}
            tasks={data.tasks.filter((t) => t.columnId === c.id)}
            onOpenTask={setOpenTaskId}
          />
        ))}
      </div>
      {openTaskId && (
        <TaskDetailSheet taskId={openTaskId} onClose={() => setOpenTaskId(null)} />
      )}
    </div>
  );
}
```

- [ ] **Step 13: `TaskDetailSheet.tsx`** (comments + assignee + due date):

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';

interface Task {
  id: number;
  title: string;
  description: string | null;
  assigneeId: number | null;
  dueDate: string | null;
}

interface Comment {
  id: number;
  displayName: string;
  body: string;
  createdAt: string;
}

export function TaskDetailSheet({ taskId, onClose }: { taskId: number; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data: task } = useQuery({
    queryKey: ['task', taskId],
    queryFn: () => api<{ task: Task }>(`/api/tasks/${taskId}`),
  });
  const { data: commentsData } = useQuery({
    queryKey: ['task-comments', taskId],
    queryFn: () => api<{ comments: Comment[] }>(`/api/tasks/${taskId}/comments`),
  });
  const [comment, setComment] = useState('');

  const addComment = useMutation({
    mutationFn: () => api(`/api/tasks/${taskId}/comments`, { method: 'POST', body: { body: comment } }),
    onSuccess: () => {
      setComment('');
      queryClient.invalidateQueries({ queryKey: ['task-comments', taskId] });
    },
  });

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{task?.task.title}</SheetTitle>
        </SheetHeader>
        <div className="grid gap-4 p-4">
          {task?.task.description && <p className="text-sm">{task.task.description}</p>}
          {task?.task.dueDate && (
            <p className="text-xs text-muted-foreground">Due {task.task.dueDate}</p>
          )}
          <div>
            <h4 className="mb-2 text-sm font-semibold">Comments</h4>
            <div className="grid gap-2">
              {commentsData?.comments.map((c) => (
                <div key={c.id} className="text-sm">
                  <span className="font-medium">{c.displayName}:</span> {c.body}
                </div>
              ))}
            </div>
            <div className="mt-2 flex gap-2">
              <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} />
              <Button disabled={!comment.trim() || addComment.isPending} onClick={() => addComment.mutate()}>
                Post
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 14: `src/features/notes/types.ts` + `api.ts`**

```ts
// types.ts
export interface Note {
  id: number;
  title: string;
  content: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}
```

```ts
// api.ts
import { api } from '@/lib/api';
import type { Note } from './types';

export const listNotes = (q?: string) => {
  const params = q ? `?q=${encodeURIComponent(q)}` : '';
  return api<{ notes: Note[] }>(`/api/notes${params}`);
};
export const createNote = (title: string) =>
  api<{ note: Note }>('/api/notes', { method: 'POST', body: { title, content: '' } });
export const updateNote = (id: number, patch: Partial<Pick<Note, 'title' | 'content' | 'pinned'>>) =>
  api<{ note: Note }>(`/api/notes/${id}`, { method: 'PATCH', body: patch });
export const deleteNote = (id: number) => api(`/api/notes/${id}`, { method: 'DELETE' });
```

- [ ] **Step 15: `NotesPage.tsx`** (list + inline editor, pin toggle, search):

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createNote, deleteNote, listNotes, updateNote } from './api';

export function NotesPage() {
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const { data } = useQuery({ queryKey: ['notes', q], queryFn: () => listNotes(q || undefined) });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [content, setContent] = useState('');

  const selected = data?.notes.find((n) => n.id === selectedId);
  useEffect(() => setContent(selected?.content ?? ''), [selected?.id]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['notes'] });
  const save = useMutation({
    mutationFn: () => updateNote(selectedId!, { content }),
    onSuccess: invalidate,
  });
  const togglePin = useMutation({
    mutationFn: (n: { id: number; pinned: boolean }) => updateNote(n.id, { pinned: !n.pinned }),
    onSuccess: invalidate,
  });
  const create = useMutation({
    mutationFn: () => createNote('Untitled'),
    onSuccess: (res) => {
      invalidate();
      setSelectedId(res.note.id);
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => deleteNote(id),
    onSuccess: () => {
      setSelectedId(null);
      invalidate();
    },
  });

  return (
    <div className="flex h-full">
      <div className="w-64 border-r p-2">
        <div className="mb-2 flex gap-2">
          <Input placeholder="Search notes" value={q} onChange={(e) => setQ(e.target.value)} />
          <Button size="sm" onClick={() => create.mutate()}>
            +
          </Button>
        </div>
        <ul className="grid gap-1">
          {data?.notes.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                className={`w-full rounded px-2 py-1 text-left text-sm hover:bg-muted ${
                  selectedId === n.id ? 'bg-muted' : ''
                }`}
                onClick={() => setSelectedId(n.id)}
              >
                {n.pinned ? '📌 ' : ''}
                {n.title}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex-1 p-4">
        {selected ? (
          <div className="flex h-full flex-col gap-2">
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => togglePin.mutate(selected)}>
                {selected.pinned ? 'Unpin' : 'Pin'}
              </Button>
              <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
                Save
              </Button>
              <Button variant="destructive" size="sm" onClick={() => remove.mutate(selected.id)}>
                Delete
              </Button>
            </div>
            <textarea
              className="flex-1 resize-none rounded-md border bg-background p-3 text-sm outline-none"
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Select or create a note.</p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 16: router + sidebar wiring** — `router.tsx` add under the `AppLayout` children:

```tsx
{ path: '/projects', element: <ProjectListPage /> },
{ path: '/projects/:projectId', element: <ProjectBoardPage /> },
{ path: '/projects/:projectId/docs', element: <DocListPage /> },
{ path: '/projects/:projectId/docs/:docId', element: <DocPage /> },
{ path: '/notes', element: <NotesPage /> },
```

`Sidebar.tsx`: add two static links above the Channels section (inside the `ScrollArea`, before `SidebarSection title="Channels"`):

```tsx
<Link to="/projects" className="mb-1 block rounded px-2 py-1 text-sm text-white/80 hover:bg-white/10">
  Projects
</Link>
<Link to="/notes" className="mb-4 block rounded px-2 py-1 text-sm text-white/80 hover:bg-white/10">
  Notes
</Link>
```

- [ ] **Step 17:** `npm run build` + `npm run lint` → clean. **Commit** — `feat(web): projects, docs, kanban board (pragmatic-drag-and-drop), notes`

### Task 8: Phase gate — full verification + finish

- [ ] `cd server && npm test` → all suites green (existing 51 + new project/task/doc/note tests)
- [ ] `npm run build` in `server/` and root → clean; `npm run lint` clean
- [ ] `docker build server/` (from `server/` as context) → succeeds
- [ ] Restart PM2, manually verify against the real dev servers:
  - create a private project as user A → user B does not see it in `/projects` and a direct `GET /api/projects/:id` as B returns 404
  - create a task, drag it between columns and reorder within a column — confirm the position persists after a page reload
  - drag the same task rapidly back and forth ~10 times to exercise the renormalization path — confirm order stays sane, no crash
  - **drag on a real phone**: deferred — no Android/iOS device available in this environment; flag it for the user
  - open a task, add a comment, set an assignee via a follow-up `PATCH`, confirm it shows in the detail sheet after reload
  - create a doc, write markdown with an XSS attempt (`<img src=x onerror=alert(1)>`) in the body, switch to Preview → confirm it renders inert (no alert, tag stripped/neutered)
  - create a personal note, confirm another user (and an admin) get 404 on it via direct API call; use "Convert to project doc" and confirm the doc appears under the target project and the note disappears from the Notes list
- [ ] Update memory (mark Phase 3 complete, note the deferred real-device drag test), then use **superpowers:finishing-a-development-branch**

## Deviations / notes for the implementer

- Two dead-code / mid-file-import notes are embedded inline in Tasks 3 and 5 above (marked "NOTE for implementer") — fix them as part of writing those files, not as a follow-up.
- Task-level API surface intentionally allows any project viewer (not just members) to create/edit tasks and docs in v1 — matches the master plan's phase-3 scope ("task detail w/ comments", nothing about member-only mutation). Tightening this to members-only is a reasonable fast-follow, not required for this phase's gate.
- Notes explicitly have zero AI/service-token reach by construction (no scope defined, `requireAuth` only accepts user JWTs) — when Phase 8 introduces service tokens, do not add a notes scope without deliberately revisiting this decision.
