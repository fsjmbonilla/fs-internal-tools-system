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
