/**
 * Google agent tools — Phase 12.
 *
 * The design under test: agents act as bot users, and a bot cannot hold a
 * Google grant — so Google tools borrow the connection of the human who
 * empowered the agent (`Caller.googleUserId`: a routine's owner, a token's
 * creator). No googleUserId, no connection, broken connection → a refusal the
 * model can read, never a throw. And `send_gmail` is withheld from routines:
 * unattended outbound email is the damage class the flag exists for.
 */

import { eq } from 'drizzle-orm';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { db } from '../db/index.js';
import { googleAccounts, routines, users } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { AGENT_TOOLS, isRefusal, toolsForScopes } from './agentTools.js';
import { ensureBotUser } from './botService.js';
import { makeFakeGoogle, type FakeGoogle } from './google/fake.js';
import { setGooglePortForTesting } from './google/port.js';
import { encryptToken } from './googleCrypto.js';
import { runRoutine, setRoutineClient, type RoutineRow } from './routineRunner.js';
import type Anthropic from '@anthropic-ai/sdk';

const byName = (name: string) => AGENT_TOOLS.find((t) => t.name === name)!;

let fake: FakeGoogle;

beforeEach(async () => {
  await resetDb();
  fake = makeFakeGoogle();
  setGooglePortForTesting(fake);
});

afterEach(() => {
  setGooglePortForTesting(null);
  setRoutineClient(null);
});

async function seedUser(email: string): Promise<number> {
  const [{ id }] = await db
    .insert(users)
    .values({ email, passwordHash: 'x', displayName: email.split('@')[0] })
    .$returningId();
  return id;
}

async function connectGoogle(userId: number): Promise<void> {
  await db.insert(googleAccounts).values({
    userId,
    kind: 'user',
    googleEmail: 'person@flowerstore.ph',
    refreshTokenEnc: encryptToken('fake-refresh-token'),
    scopes: [],
    status: 'active',
    connectedBy: userId,
  });
}

describe('scope and unattended gating', () => {
  it('each Google tool sits behind its own scope', () => {
    const read = toolsForScopes(['calendar:read']).map((t) => t.name);
    expect(read).toContain('list_calendar_events');
    expect(read).not.toContain('create_calendar_event');
    expect(read).not.toContain('search_gmail');
  });

  it('send_gmail is withheld from routines (unattended surface)', () => {
    const unattended = toolsForScopes(['gmail:read', 'gmail:write'], { unattendedOnly: true }).map(
      (t) => t.name,
    );
    expect(unattended).toContain('search_gmail');
    expect(unattended).not.toContain('send_gmail');
    // …but an MCP client (person-driven) does get it.
    expect(toolsForScopes(['gmail:write']).map((t) => t.name)).toContain('send_gmail');
  });
});

describe('whose Google a tool uses', () => {
  it('refuses when the caller has no empowering human at all', async () => {
    const bot = (await ensureBotUser())!;
    const result = await byName('list_calendar_events').handler(
      { from: '2026-08-01', to: '2026-08-31' } as never,
      { userId: bot, isAdmin: false },
    );
    expect(isRefusal(result)).toBe(true);
  });

  it('refuses, naming the fix, when the empowering user never connected', async () => {
    const bot = (await ensureBotUser())!;
    const owner = await seedUser('owner@flowerstore.ph');
    const result = await byName('list_calendar_events').handler(
      { from: '2026-08-01', to: '2026-08-31' } as never,
      { userId: bot, isAdmin: false, googleUserId: owner },
    );
    expect(isRefusal(result)).toBe(true);
    expect((result as { refusal: string }).refusal).toContain('not connected');
  });

  it("reaches the empowering user's calendar when connected", async () => {
    const bot = (await ensureBotUser())!;
    const owner = await seedUser('owner2@flowerstore.ph');
    await connectGoogle(owner);
    fake.events.push({
      id: 'e1',
      title: 'Standup',
      start: '2026-08-10T09:00:00Z',
      end: '2026-08-10T09:15:00Z',
      allDay: false,
      attendees: [],
      location: null,
      description: null,
      htmlLink: null,
    });

    const result = (await byName('list_calendar_events').handler(
      { from: '2026-08-01T00:00:00Z', to: '2026-08-31T00:00:00Z' } as never,
      { userId: bot, isAdmin: false, googleUserId: owner },
    )) as { title: string }[];
    expect(result.map((e) => e.title)).toEqual(['Standup']);
  });

  it('a broken grant becomes a readable refusal, not a throw', async () => {
    const bot = (await ensureBotUser())!;
    const owner = await seedUser('owner3@flowerstore.ph');
    await connectGoogle(owner);
    fake.breakGrant();

    const result = await byName('search_gmail').handler({ query: 'invoice' } as never, {
      userId: bot,
      isAdmin: false,
      googleUserId: owner,
    });
    expect(isRefusal(result)).toBe(true);
    expect((result as { refusal: string }).refusal).toContain('reconnect');
  });
});

describe('a routine borrows its owner’s connection', () => {
  it('list_calendar_events inside a routine reads the owner’s calendar', async () => {
    await ensureBotUser();
    const owner = await seedUser('routine-owner@flowerstore.ph');
    await connectGoogle(owner);
    fake.events.push({
      id: 'e1',
      title: 'Investor call',
      start: '2026-08-10T09:00:00Z',
      end: '2026-08-10T10:00:00Z',
      allDay: false,
      attendees: [],
      location: null,
      description: null,
      htmlLink: null,
    });

    const [{ id }] = await db
      .insert(routines)
      .values({
        name: 'digest',
        prompt: 'list my events',
        schedule: '* * * * *',
        scopes: ['calendar:read'],
        ownerId: owner,
        enabled: true,
      })
      .$returningId();
    const [routine] = await db.select().from(routines).where(eq(routines.id, id));

    // A two-turn stub: call the tool, then close with a summary.
    let turn = 0;
    const toolResults: string[] = [];
    setRoutineClient({
      messages: {
        create: async (params: {
          messages: { content: unknown }[];
        }) => {
          if (turn++ === 0) {
            return {
              content: [
                {
                  type: 'tool_use',
                  id: 'tu_1',
                  name: 'list_calendar_events',
                  input: { from: '2026-08-01T00:00:00Z', to: '2026-08-31T00:00:00Z' },
                },
              ],
              usage: { input_tokens: 10, output_tokens: 5 },
            };
          }
          // The tool result came back in the second request's messages.
          toolResults.push(JSON.stringify(params.messages.at(-1)?.content));
          return {
            content: [{ type: 'text', text: 'done' }],
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        },
      },
    } as unknown as Anthropic);

    const run = await runRoutine(routine as RoutineRow, 'manual');
    expect(run.status).toBe('succeeded');
    expect(toolResults[0]).toContain('Investor call');
  });
});
