import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { addChannelMember, createChannel } from './channelService.js';
import { events } from './events.js';
import {
  editMessage,
  getMessagesBefore,
  getUnreadCounts,
  markRead,
  searchMessages,
  sendMessage,
  softDeleteMessage,
  toggleReaction,
} from './messageService.js';

async function seedUser(email: string) {
  const [{ id }] = await db
    .insert(users)
    .values({ email, passwordHash: 'x', displayName: email.split('@')[0] })
    .$returningId();
  return id;
}

describe('messageService', () => {
  beforeEach(resetDb);

  it('sends a message, emits message.created, and paginates by cursor', async () => {
    const u = await seedUser('u@flowerstore.ph');
    const chan = await createChannel({ name: 'g', isPrivate: false, createdBy: u });
    const handler = vi.fn();
    events.on('message.created', handler);

    const first = await sendMessage(chan.id, u, 'hello');
    expect(first.displayName).toBe('u');
    expect(handler).toHaveBeenCalledOnce();
    events.off('message.created', handler);

    for (let i = 0; i < 3; i++) await sendMessage(chan.id, u, `msg ${i}`);
    const page1 = await getMessagesBefore(chan.id, null, 2);
    expect(page1).toHaveLength(2);
    const page2 = await getMessagesBefore(chan.id, page1[page1.length - 1].id, 2);
    expect(page2.map((m) => m.id)).not.toContain(page1[0].id);
    expect(page2.map((m) => m.id)).not.toContain(page1[1].id);
  });

  it('tracks unread counts per channel membership only', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const reader = await seedUser('reader@flowerstore.ph');
    const chan = await createChannel({ name: 'g2', isPrivate: false, createdBy: owner });
    await addChannelMember(chan.id, reader);
    const m1 = await sendMessage(chan.id, owner, 'one');
    await sendMessage(chan.id, owner, 'two');

    let counts = await getUnreadCounts(reader);
    expect(counts[chan.id]).toBe(2);
    await markRead(chan.id, reader, m1.id);
    counts = await getUnreadCounts(reader);
    expect(counts[chan.id]).toBe(1);
  });

  it('reactions toggle on/off', async () => {
    const u = await seedUser('u@flowerstore.ph');
    const chan = await createChannel({ name: 'g3', isPrivate: false, createdBy: u });
    const msg = await sendMessage(chan.id, u, 'react to me');
    const r1 = await toggleReaction(msg.id, u, '👍');
    expect(r1.added).toBe(true);
    const r2 = await toggleReaction(msg.id, u, '👍');
    expect(r2.added).toBe(false);
  });

  it('edit/delete are author-only', async () => {
    const author = await seedUser('author@flowerstore.ph');
    const other = await seedUser('other@flowerstore.ph');
    const chan = await createChannel({ name: 'g4', isPrivate: false, createdBy: author });
    const msg = await sendMessage(chan.id, author, 'original');
    expect(await editMessage(msg.id, other, 'hacked')).toBe(false);
    expect(await editMessage(msg.id, author, 'edited')).toBe(true);
    expect(await softDeleteMessage(msg.id, other)).toBe(false);
    expect(await softDeleteMessage(msg.id, author)).toBe(true);
    const page = await getMessagesBefore(chan.id, null, 10);
    expect(page).toHaveLength(0); // soft-deleted, excluded from history
  });

  it('search respects channel visibility', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const outsider = await seedUser('outsider@flowerstore.ph');
    const pub = await createChannel({ name: 'pub', isPrivate: false, createdBy: owner });
    const priv = await createChannel({ name: 'priv', isPrivate: true, createdBy: owner });
    await sendMessage(pub.id, owner, 'findable pizza party');
    await sendMessage(priv.id, owner, 'secret pizza party');

    const outsiderResults = await searchMessages(outsider, false, 'pizza');
    expect(outsiderResults.map((m) => m.channelId)).toEqual([pub.id]);

    const ownerResults = await searchMessages(owner, false, 'pizza');
    expect(ownerResults).toHaveLength(2);
  });
});
