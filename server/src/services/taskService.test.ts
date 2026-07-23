import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
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
    const ordered = board.tasks
      .filter((t) => t.columnId === todo.id)
      .sort((a, b) => a.position - b.position);
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
