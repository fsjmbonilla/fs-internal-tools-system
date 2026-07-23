import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/index.js';
import { attachments, users } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { createChannel } from './channelService.js';
import { sendMessage } from './messageService.js';
import {
  createUnlinkedAttachment,
  gcUnlinkedAttachments,
  getAttachment,
  getAttachmentsFor,
  linkAttachment,
} from './attachmentService.js';

async function seedUser(email: string) {
  const [{ id }] = await db
    .insert(users)
    .values({ email, passwordHash: 'x', displayName: email.split('@')[0] })
    .$returningId();
  return id;
}

describe('attachmentService', () => {
  beforeEach(resetDb);

  it('rejects a disallowed mime type', async () => {
    const uploader = await seedUser('u@flowerstore.ph');
    await expect(
      createUnlinkedAttachment({
        uploaderId: uploader,
        buffer: Buffer.from('x'),
        fileName: 'evil.exe',
        mimeType: 'application/x-msdownload',
        sizeBytes: 1,
      }),
    ).rejects.toThrow();
  });

  it('creates an unlinked attachment, then links it to a message; only the uploader may link', async () => {
    const uploader = await seedUser('u@flowerstore.ph');
    const other = await seedUser('other@flowerstore.ph');
    const chan = await createChannel({ name: 'g', isPrivate: false, createdBy: uploader });
    const msg = await sendMessage(chan.id, uploader, 'see attached');
    const att = await createUnlinkedAttachment({
      uploaderId: uploader,
      buffer: Buffer.from('hello'),
      fileName: 'note.txt',
      mimeType: 'text/csv',
      sizeBytes: 5,
    });
    expect(await linkAttachment(att.id, other, { messageId: msg.id })).toBe(false);
    expect(await linkAttachment(att.id, uploader, { messageId: msg.id })).toBe(true);
    const linked = await getAttachment(att.id);
    expect(linked?.messageId).toBe(msg.id);
    const list = await getAttachmentsFor({ messageId: msg.id });
    expect(list.map((a) => a.id)).toEqual([att.id]);
  });

  it('garbage-collects unlinked attachments older than the cutoff, leaves linked ones alone', async () => {
    const uploader = await seedUser('u@flowerstore.ph');
    const stale = await createUnlinkedAttachment({
      uploaderId: uploader,
      buffer: Buffer.from('x'),
      fileName: 'stale.csv',
      mimeType: 'text/csv',
      sizeBytes: 1,
    });
    const fresh = await createUnlinkedAttachment({
      uploaderId: uploader,
      buffer: Buffer.from('x'),
      fileName: 'fresh.csv',
      mimeType: 'text/csv',
      sizeBytes: 1,
    });
    await db
      .update(attachments)
      .set({ createdAt: sql`DATE_SUB(NOW(), INTERVAL 48 HOUR)` })
      .where(sql`${attachments.id} = ${stale.id}`);

    const removed = await gcUnlinkedAttachments(24);
    expect(removed).toBe(1);
    expect(await getAttachment(stale.id)).toBeNull();
    expect(await getAttachment(fresh.id)).not.toBeNull();
  });
});
