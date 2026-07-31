# Phase 7: AI Support Channels (Ticket-Through-Chat) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a chat channel into a support desk — someone describes a problem in a `support` channel, an AI reads the conversation and either asks one clarifying question as a bot user, or files a real kanban ticket in a bound project with an AI-written title/summary/priority linked back to the originating message.

**Architecture:** A new channel `kind` (`'standard' | 'support'`) plus a `support_configs` row binding a support channel to a target project + intake column. The whole mechanism rides the existing Phase 2 automation event bus: `automations/supportIntake.ts` subscribes to `message.created` exactly like `pushAutomation.ts` does, so chat send is never blocked or broken by AI failures. A seeded "FS Assistant" bot user (`users.is_bot`) authors every AI message, and a re-entrancy guard on that flag stops the bot from triggering itself. `aiService.ts` wraps the OpenAI SDK and is **fail-soft**: it returns `null` on any problem (unconfigured, API error, token exhaustion, schema mismatch) so the automation logs and skips rather than throwing into the chat path.

**Tech Stack:** `openai` ^7.2.0 (verified installed and inspected 2026-07-31: default export is a constructor, `client.chat.completions.create` exists), model `gpt-5-nano` (**verified live against the real API**: the model exists, `response_format: { type: 'json_schema', strict: true }` structured output works, and both the `ask_clarification` and `create_ticket` decision paths were exercised end-to-end before this plan was written).

## Global Constraints

- **Provider is OpenAI, not Claude.** This deliberately overrides the master plan's `@anthropic-ai/sdk` / `claude-sonnet-5` wording — the user directed the switch to OpenAI + `gpt-5-nano` on 2026-07-31. Do not "correct" it back to Anthropic.
- **`gpt-5-nano` is a reasoning model and burns a large hidden reasoning budget** — measured 768–1344 reasoning tokens on trivial prompts. Use `max_completion_tokens: 3000`. **Verified failure mode to guard against:** with a low cap (300), reasoning consumes the entire budget and the API returns HTTP 200 with `finish_reason: 'length'` and `content: ''` — an empty string, NOT an error. Never `JSON.parse` the content without first checking for empty/`length` and bailing out; a naive parse throws a misleading "Unexpected end of JSON input".
- **`aiService` is fail-soft, never fail-closed.** Every failure path returns `null`. A missing API key, an API outage, a malformed response, or a token-exhausted response must all leave chat completely functional — the automation logs and returns. This differs from Phase 6's calls (which 503) because chat must never degrade.
- **Re-entrancy guard is mandatory.** `sendMessage` emits `message.created` for bot messages too. `supportIntake` MUST skip when the author is a bot, or the bot's own clarifying question re-triggers the AI in an infinite loop.
- The secret lives only in the gitignored `server/.env` (`OPENAI_API_KEY`, `AI_MODEL`). **Never** commit it, echo it into a log, bake it into a test fixture, or put it in a snapshot/migration. Tests always mock the SDK — no test may make a real API call.
- Debounce per channel (default 5000 ms, from `SUPPORT_DEBOUNCE_MS`) so a burst of rapid messages produces one AI turn, not one per message. Tests set this low to stay fast.
- Migration numbering continues from Phase 6: the next migration is **0009** (`0008` was `calls`).
- Continue existing conventions: `parseId()` path-param helper, never chain two `validate()` calls on one route, 404 (never 403) for invisible resources, reuse `getVisibleChannel`/`isChannelMember`/`getVisibleProject`/`isProjectMember` rather than reimplementing visibility.
- Commits end with the **exact literal line** `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` — not the implementer model's own name. This has been gotten wrong three times in this project; get it right the first time.
- Never pipe `tsc`/`npm test` through `tail` inside a `&&` chain — redirect to a log file and check `$?` explicitly.
- No frontend test framework exists — frontend tasks verify via `npm run build` (tsc) + `npm run lint` (oxlint) clean, run from the repo ROOT.

---

### Task 1: Migration 0009 — support schema

**Files:**
- Create: `server/src/db/schema/support.ts`
- Modify: `server/src/db/schema/chat.ts`, `server/src/db/schema/auth.ts`, `server/src/db/schema/projects.ts`, `server/src/db/schema/index.ts`, `server/src/db/testUtils.ts`

**Interfaces:** `channels.kind` (`'standard'|'support'`, default `'standard'`); `users.isBot` (boolean, default false); `tasks.originChannelId`/`originMessageId` (nullable), `tasks.source` (`'manual'|'support'`, default `'manual'`), `tasks.priority` (`'low'|'medium'|'high'|'urgent'`, nullable); new `supportConfigs` table.

- [ ] **Step 1: add `kind` to `channels` — modify `server/src/db/schema/chat.ts`**

In the `channels` table definition, add this line immediately after the existing `type:` line:

```ts
  kind: mysqlEnum('kind', ['standard', 'support']).notNull().default('standard'),
```

(`mysqlEnum` is already imported in this file — do not add a duplicate import.)

- [ ] **Step 2: add `isBot` to `users` — modify `server/src/db/schema/auth.ts`**

In the `users` table definition, add this line immediately after the existing `isActive:` line:

```ts
  isBot: boolean('is_bot').notNull().default(false),
```

(`boolean` is already imported in this file.)

- [ ] **Step 3: add ticket-origin columns to `tasks` — modify `server/src/db/schema/projects.ts`**

In the `tasks` table definition, add these four lines immediately after the existing `dueDate:` line:

```ts
  originChannelId: bigint('origin_channel_id', { mode: 'number', unsigned: true }),
  originMessageId: bigint('origin_message_id', { mode: 'number', unsigned: true }),
  source: mysqlEnum('source', ['manual', 'support']).notNull().default('manual'),
  priority: mysqlEnum('priority', ['low', 'medium', 'high', 'urgent']),
```

Deliberately **no FK** on `originChannelId`/`originMessageId`: a ticket must survive its originating channel or message being deleted (the chip just stops linking). This mirrors `tasks.createdBy`, which is also FK-less. If `mysqlEnum` is not already imported in this file, add it to the existing `drizzle-orm/mysql-core` import list.

- [ ] **Step 4: `server/src/db/schema/support.ts`**

```ts
import { bigint, boolean, mysqlTable, text, timestamp } from 'drizzle-orm/mysql-core';
import { channels } from './chat.js';
import { projects, taskColumns } from './projects.js';

export const supportConfigs = mysqlTable('support_configs', {
  channelId: bigint('channel_id', { mode: 'number', unsigned: true })
    .primaryKey()
    .references(() => channels.id, { onDelete: 'cascade' }),
  projectId: bigint('project_id', { mode: 'number', unsigned: true })
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  intakeColumnId: bigint('intake_column_id', { mode: 'number', unsigned: true })
    .notNull()
    .references(() => taskColumns.id, { onDelete: 'cascade' }),
  aiEnabled: boolean('ai_enabled').notNull().default(true),
  instructions: text('instructions'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
```

`channelId` is the primary key (one support config per channel — enforces the "UNIQUE(channel_id)" the master plan asks for without a separate surrogate id).

- [ ] **Step 5: register the schema — modify `server/src/db/schema/index.ts`**

```ts
export * from './auth.js';
export * from './calls.js';
export * from './chat.js';
export * from './departments.js';
export * from './files.js';
export * from './notes.js';
export * from './projects.js';
export * from './push.js';
export * from './reactions.js';
export * from './support.js';
```

- [ ] **Step 6: truncation order — modify `server/src/db/testUtils.ts`**

Add `'support_configs'` immediately before `'calls'` (it references channels, projects, and task_columns, so it must truncate before all three):

```ts
const TABLES = [
  'refresh_tokens',
  'department_members',
  'departments',
  'attachments',
  'device_tokens',
  'message_reactions',
  'message_mentions',
  'support_configs',
  'calls',
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

- [ ] **Step 7: generate and apply the migration**

Run: `cd server && npx drizzle-kit generate --name support`
Expected: creates `server/drizzle/0009_support.sql` (eight migrations already exist, `0000`–`0008`) containing `ALTER TABLE` statements for `channels`/`users`/`tasks` plus `CREATE TABLE support_configs`.

Run: `npm run db:migrate`
Expected: applies cleanly against local MariaDB, no errors.

- [ ] **Step 8: Commit**

```bash
git add server/src/db/schema/ server/src/db/testUtils.ts server/drizzle/
git commit -m "feat(server): support channels schema (migration 0009)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Bot user — `botService.ts` + seed script

**Files:**
- Create: `server/src/services/botService.ts`, `server/src/scripts/seedBot.ts`
- Test: `server/src/services/botService.test.ts`
- Modify: `server/package.json`

**Interfaces:**
- `BOT_EMAIL = 'assistant@flowerstore.ph'`, `BOT_DISPLAY_NAME = 'FS Assistant'`
- `ensureBotUser(): Promise<number>` — idempotent upsert, returns the bot's userId
- `getBotUserId(): Promise<number | null>` — lookup only, null if not seeded

- [ ] **Step 1: failing test — `server/src/services/botService.test.ts`**

```ts
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { BOT_DISPLAY_NAME, BOT_EMAIL, ensureBotUser, getBotUserId } from './botService.js';

describe('botService', () => {
  beforeEach(resetDb);

  it('getBotUserId returns null before the bot is seeded', async () => {
    expect(await getBotUserId()).toBeNull();
  });

  it('ensureBotUser creates the bot with is_bot set, and is idempotent', async () => {
    const first = await ensureBotUser();
    const second = await ensureBotUser();
    expect(second).toBe(first);

    const rows = await db.select().from(users).where(eq(users.email, BOT_EMAIL));
    expect(rows).toHaveLength(1);
    expect(rows[0].isBot).toBe(true);
    expect(rows[0].displayName).toBe(BOT_DISPLAY_NAME);
    expect(rows[0].isActive).toBe(true);
  });

  it('getBotUserId finds the bot once seeded', async () => {
    const id = await ensureBotUser();
    expect(await getBotUserId()).toBe(id);
  });
});
```

- [ ] **Step 2: run to verify it fails**

Run: `cd server && npx vitest run src/services/botService.test.ts`
Expected: FAIL — `Cannot find module './botService.js'`

- [ ] **Step 3: implement — `server/src/services/botService.ts`**

```ts
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { hashPassword } from './passwords.js';

export const BOT_EMAIL = 'assistant@flowerstore.ph';
export const BOT_DISPLAY_NAME = 'FS Assistant';

export async function getBotUserId(): Promise<number | null> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, BOT_EMAIL));
  return row?.id ?? null;
}

export async function ensureBotUser(): Promise<number> {
  const existing = await getBotUserId();
  if (existing !== null) return existing;
  // The bot never logs in; hash a throwaway random secret so no usable password exists.
  const passwordHash = await hashPassword(randomBytes(32).toString('hex'));
  const [{ id }] = await db
    .insert(users)
    .values({ email: BOT_EMAIL, passwordHash, displayName: BOT_DISPLAY_NAME, isBot: true })
    .$returningId();
  return id;
}
```

- [ ] **Step 4: run to verify it passes**

Run: `cd server && npx vitest run src/services/botService.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: `server/src/scripts/seedBot.ts`** (mirrors the existing `seedAdmin.ts` top-level-await + `pool.end()` pattern)

```ts
import { pool } from '../db/index.js';
import { BOT_DISPLAY_NAME, ensureBotUser } from '../services/botService.js';

const id = await ensureBotUser();
console.log(`${BOT_DISPLAY_NAME} bot user ready (id ${id})`);
await pool.end();
```

- [ ] **Step 6: wire the script — modify `server/package.json`**

Add to `scripts`, immediately after the existing `"seed:admin"` line:

```json
    "seed:bot": "tsx src/scripts/seedBot.ts"
```

- [ ] **Step 7: run the seed script for real**

Run: `cd server && npm run seed:bot`
Expected: prints `FS Assistant bot user ready (id <n>)`, exits 0. Run it a second time and confirm it prints the same id (idempotent).

- [ ] **Step 8: Commit**

```bash
git add server/src/services/botService.ts server/src/services/botService.test.ts server/src/scripts/seedBot.ts server/package.json
git commit -m "feat(server): FS Assistant bot user + seed:bot script

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `aiService.ts` — OpenAI triage wrapper

**Files:**
- Modify: `server/src/config.ts`
- Create: `server/src/services/aiService.ts`
- Test: `server/src/services/aiService.test.ts`, `server/src/services/aiService.unconfigured.test.ts`
- Install: `openai` (server dependency — may already be installed; confirm)

**Interfaces:**
- `TriageDecision { action: 'ask_clarification' | 'create_ticket'; question: string | null; title: string | null; description: string | null; priority: 'low'|'medium'|'high'|'urgent'|null }`
- `isAiConfigured(): boolean`
- `triageSupportConversation(input: { messages: { displayName: string; body: string }[]; instructions?: string | null }): Promise<TriageDecision | null>` — returns `null` on ANY failure

- [ ] **Step 1: confirm the dependency**

Run: `cd server && npm ls openai`
Expected: shows `openai@7.x`. If missing, run `npm install openai`.

Then verify the real SDK shape before writing code (this project has shipped three plans with wrong third-party API assumptions — always check):

Run: `cd server && node -e "const O=require('openai'); const C=O.default??O; const c=new C({apiKey:'x'}); console.log(typeof C, typeof c.chat.completions.create)"`
Expected: `function function`. If the shape differs, adapt Step 4 to the real API and document the discrepancy in your report.

- [ ] **Step 2: add AI env vars — modify `server/src/config.ts`**

Insert these lines immediately after the `LIVEKIT_API_SECRET` line, before the closing `});` of `EnvSchema`:

```ts
  // AI support intake: unset means aiService.ts returns null and supportIntake skips —
  // chat must stay fully functional without AI (fail-soft, unlike LIVEKIT's 503).
  OPENAI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('gpt-5-nano'),
  SUPPORT_DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(5000),
```

- [ ] **Step 3: failing tests — `server/src/services/aiService.test.ts`**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const create = vi.hoisted(() => vi.fn());
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create } };
  },
}));

vi.mock('../config.js', () => ({
  config: { OPENAI_API_KEY: 'sk-test', AI_MODEL: 'gpt-5-nano' },
}));

const { isAiConfigured, triageSupportConversation } = await import('./aiService.js');

function reply(content: string, finishReason = 'stop') {
  return { choices: [{ message: { content }, finish_reason: finishReason }] };
}

describe('aiService (configured)', () => {
  beforeEach(() => create.mockReset());

  it('reports configured', () => {
    expect(isAiConfigured()).toBe(true);
  });

  it('parses a create_ticket decision', async () => {
    create.mockResolvedValue(
      reply(
        JSON.stringify({
          action: 'create_ticket',
          question: null,
          title: 'Printer jammed',
          description: 'Floor 2 printer is jammed.',
          priority: 'high',
        }),
      ),
    );

    const decision = await triageSupportConversation({
      messages: [{ displayName: 'jane', body: 'printer jammed' }],
    });

    expect(decision).toEqual({
      action: 'create_ticket',
      question: null,
      title: 'Printer jammed',
      description: 'Floor 2 printer is jammed.',
      priority: 'high',
    });
  });

  it('parses an ask_clarification decision', async () => {
    create.mockResolvedValue(
      reply(
        JSON.stringify({
          action: 'ask_clarification',
          question: 'Which printer?',
          title: null,
          description: null,
          priority: null,
        }),
      ),
    );
    const decision = await triageSupportConversation({ messages: [{ displayName: 'j', body: 'broken' }] });
    expect(decision?.action).toBe('ask_clarification');
    expect(decision?.question).toBe('Which printer?');
  });

  it('passes per-channel instructions into the system prompt', async () => {
    create.mockResolvedValue(
      reply(JSON.stringify({ action: 'ask_clarification', question: 'q', title: null, description: null, priority: null })),
    );
    await triageSupportConversation({
      messages: [{ displayName: 'j', body: 'hi' }],
      instructions: 'Always ask for the store branch.',
    });
    const systemContent = create.mock.calls[0][0].messages[0].content as string;
    expect(systemContent).toContain('Always ask for the store branch.');
  });

  // The verified real-world failure mode: gpt-5-nano is a reasoning model, and when the
  // token budget is exhausted the API returns 200 with finish_reason 'length' and an
  // EMPTY content string. A naive JSON.parse would throw a misleading syntax error.
  it('returns null when the response was truncated to empty by reasoning-token exhaustion', async () => {
    create.mockResolvedValue(reply('', 'length'));
    expect(await triageSupportConversation({ messages: [{ displayName: 'j', body: 'hi' }] })).toBeNull();
  });

  it('returns null on malformed JSON rather than throwing', async () => {
    create.mockResolvedValue(reply('not json at all'));
    expect(await triageSupportConversation({ messages: [{ displayName: 'j', body: 'hi' }] })).toBeNull();
  });

  it('returns null when the decision fails schema validation', async () => {
    create.mockResolvedValue(reply(JSON.stringify({ action: 'explode', question: null })));
    expect(await triageSupportConversation({ messages: [{ displayName: 'j', body: 'hi' }] })).toBeNull();
  });

  it('returns null when the API call throws, never propagating the error', async () => {
    create.mockRejectedValue(new Error('502 upstream'));
    expect(await triageSupportConversation({ messages: [{ displayName: 'j', body: 'hi' }] })).toBeNull();
  });
});
```

- [ ] **Step 4: failing test — `server/src/services/aiService.unconfigured.test.ts`** (separate file: `vi.mock` is file-scoped)

```ts
import { describe, expect, it, vi } from 'vitest';

const create = vi.hoisted(() => vi.fn());
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create } };
  },
}));
vi.mock('../config.js', () => ({ config: { OPENAI_API_KEY: undefined, AI_MODEL: 'gpt-5-nano' } }));

const { isAiConfigured, triageSupportConversation } = await import('./aiService.js');

describe('aiService (unconfigured)', () => {
  it('reports not configured and never calls the API', async () => {
    expect(isAiConfigured()).toBe(false);
    expect(await triageSupportConversation({ messages: [{ displayName: 'j', body: 'hi' }] })).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: run to verify both fail**

Run: `cd server && npx vitest run src/services/aiService.test.ts src/services/aiService.unconfigured.test.ts`
Expected: FAIL — `Cannot find module './aiService.js'`

- [ ] **Step 6: implement — `server/src/services/aiService.ts`**

```ts
import OpenAI from 'openai';
import { z } from 'zod';
import { config } from '../config.js';
import { logger } from '../logger.js';

// gpt-5-nano is a reasoning model: it spends 700–1400 hidden reasoning tokens even on
// trivial prompts. Too low a cap and reasoning eats the whole budget, yielding HTTP 200
// with finish_reason 'length' and an EMPTY content string (verified against the live API).
const MAX_COMPLETION_TOKENS = 3000;
const MAX_CONTEXT_MESSAGES = 20;

const DecisionSchema = z.object({
  action: z.enum(['ask_clarification', 'create_ticket']),
  question: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).nullable(),
});

export type TriageDecision = z.infer<typeof DecisionSchema>;

const RESPONSE_FORMAT = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'triage',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['ask_clarification', 'create_ticket'] },
        question: { type: ['string', 'null'] },
        title: { type: ['string', 'null'] },
        description: { type: ['string', 'null'] },
        priority: { type: ['string', 'null'], enum: ['low', 'medium', 'high', 'urgent', null] },
      },
      required: ['action', 'question', 'title', 'description', 'priority'],
    },
  },
};

const BASE_PROMPT = [
  'You triage an internal company support chat.',
  'Read the conversation and decide exactly one action.',
  'If the report is too vague to act on, choose "ask_clarification" and write ONE specific question.',
  'If there is enough detail, choose "create_ticket" with a short imperative title, a concise',
  'description summarising the problem, and a priority of low, medium, high, or urgent.',
  'Set every field you are not using to null.',
].join(' ');

let client: OpenAI | null | undefined;

function getClient(): OpenAI | null {
  if (client !== undefined) return client;
  client = config.OPENAI_API_KEY ? new OpenAI({ apiKey: config.OPENAI_API_KEY }) : null;
  return client;
}

export function isAiConfigured(): boolean {
  return Boolean(config.OPENAI_API_KEY);
}

export async function triageSupportConversation(input: {
  messages: { displayName: string; body: string }[];
  instructions?: string | null;
}): Promise<TriageDecision | null> {
  const openai = getClient();
  if (!openai) return null;

  const system = input.instructions ? `${BASE_PROMPT}\n\nExtra guidance: ${input.instructions}` : BASE_PROMPT;
  const transcript = input.messages
    .slice(-MAX_CONTEXT_MESSAGES)
    .map((m) => `${m.displayName}: ${m.body}`)
    .join('\n');

  try {
    const completion = await openai.chat.completions.create({
      model: config.AI_MODEL,
      max_completion_tokens: MAX_COMPLETION_TOKENS,
      response_format: RESPONSE_FORMAT,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: transcript },
      ],
    });

    const choice = completion.choices[0];
    const content = choice?.message?.content;
    if (!content) {
      // Empty content with finish_reason 'length' = reasoning exhausted the token budget.
      logger.warn({ finishReason: choice?.finish_reason }, 'AI triage returned no content');
      return null;
    }

    const parsed = DecisionSchema.safeParse(JSON.parse(content));
    if (!parsed.success) {
      logger.warn({ issues: parsed.error.issues }, 'AI triage response failed schema validation');
      return null;
    }
    return parsed.data;
  } catch (err) {
    // Fail-soft on everything (network, 4xx/5xx, malformed JSON): chat must never break.
    logger.error({ err }, 'AI triage failed');
    return null;
  }
}
```

- [ ] **Step 7: run to verify both pass**

Run: `cd server && npx vitest run src/services/aiService.test.ts src/services/aiService.unconfigured.test.ts`
Expected: PASS (9 tests total)

- [ ] **Step 8: Commit**

```bash
git add server/package.json server/package-lock.json server/src/config.ts server/src/services/aiService.ts server/src/services/aiService.test.ts server/src/services/aiService.unconfigured.test.ts
git commit -m "feat(server): aiService — OpenAI support triage, fail-soft

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `supportConfigService.ts`

**Files:**
- Create: `server/src/services/supportConfigService.ts`
- Test: `server/src/services/supportConfigService.test.ts`

**Interfaces:**
- `SupportConfigRow` (Drizzle-inferred)
- `getSupportConfig(channelId: number): Promise<SupportConfigRow | null>`
- `upsertSupportConfig(input: { channelId: number; projectId: number; intakeColumnId: number; aiEnabled?: boolean; instructions?: string | null }): Promise<SupportConfigRow>`
- `resolveIntakeColumnId(projectId: number): Promise<number | null>` — lowest-`position` column of a project, used as the default intake column

- [ ] **Step 1: failing test — `server/src/services/supportConfigService.test.ts`**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { createChannel } from './channelService.js';
import { createProject } from './projectService.js';
import {
  getSupportConfig,
  resolveIntakeColumnId,
  upsertSupportConfig,
} from './supportConfigService.js';
import { createDefaultColumns, getBoard } from './taskService.js';

async function seedUser(email: string) {
  const [{ id }] = await db
    .insert(users)
    .values({ email, passwordHash: 'x', displayName: email.split('@')[0] })
    .$returningId();
  return id;
}

describe('supportConfigService', () => {
  beforeEach(resetDb);

  it('resolveIntakeColumnId returns the lowest-position column, or null with no columns', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const project = await createProject({ name: 'P', isPrivate: false, createdBy: owner });
    expect(await resolveIntakeColumnId(project.id)).toBeNull();

    await createDefaultColumns(project.id);
    const board = await getBoard(project.id);
    const lowest = [...board.columns].sort((a, b) => a.position - b.position)[0];
    expect(await resolveIntakeColumnId(project.id)).toBe(lowest.id);
  });

  it('upserts a config and reads it back', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const project = await createProject({ name: 'P2', isPrivate: false, createdBy: owner });
    await createDefaultColumns(project.id);
    const intakeColumnId = (await resolveIntakeColumnId(project.id))!;
    const channel = await createChannel({ name: 'help', isPrivate: false, createdBy: owner });

    const created = await upsertSupportConfig({
      channelId: channel.id,
      projectId: project.id,
      intakeColumnId,
      instructions: 'Ask for the branch.',
    });
    expect(created.aiEnabled).toBe(true);
    expect(created.instructions).toBe('Ask for the branch.');

    const fetched = await getSupportConfig(channel.id);
    expect(fetched?.projectId).toBe(project.id);
    expect(fetched?.intakeColumnId).toBe(intakeColumnId);
  });

  it('upsert is idempotent per channel and overwrites settings', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const project = await createProject({ name: 'P3', isPrivate: false, createdBy: owner });
    await createDefaultColumns(project.id);
    const intakeColumnId = (await resolveIntakeColumnId(project.id))!;
    const channel = await createChannel({ name: 'help3', isPrivate: false, createdBy: owner });

    await upsertSupportConfig({ channelId: channel.id, projectId: project.id, intakeColumnId });
    const updated = await upsertSupportConfig({
      channelId: channel.id,
      projectId: project.id,
      intakeColumnId,
      aiEnabled: false,
      instructions: 'Paused.',
    });
    expect(updated.aiEnabled).toBe(false);
    expect(updated.instructions).toBe('Paused.');
  });

  it('getSupportConfig returns null for a non-support channel', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const channel = await createChannel({ name: 'general', isPrivate: false, createdBy: owner });
    expect(await getSupportConfig(channel.id)).toBeNull();
  });
});
```

- [ ] **Step 2: run to verify it fails**

Run: `cd server && npx vitest run src/services/supportConfigService.test.ts`
Expected: FAIL — `Cannot find module './supportConfigService.js'`

- [ ] **Step 3: implement — `server/src/services/supportConfigService.ts`**

```ts
import { asc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { supportConfigs, taskColumns } from '../db/schema/index.js';

export type SupportConfigRow = typeof supportConfigs.$inferSelect;

export async function getSupportConfig(channelId: number): Promise<SupportConfigRow | null> {
  const [row] = await db.select().from(supportConfigs).where(eq(supportConfigs.channelId, channelId));
  return row ?? null;
}

export async function resolveIntakeColumnId(projectId: number): Promise<number | null> {
  const [row] = await db
    .select({ id: taskColumns.id })
    .from(taskColumns)
    .where(eq(taskColumns.projectId, projectId))
    .orderBy(asc(taskColumns.position))
    .limit(1);
  return row?.id ?? null;
}

export async function upsertSupportConfig(input: {
  channelId: number;
  projectId: number;
  intakeColumnId: number;
  aiEnabled?: boolean;
  instructions?: string | null;
}): Promise<SupportConfigRow> {
  const values = {
    channelId: input.channelId,
    projectId: input.projectId,
    intakeColumnId: input.intakeColumnId,
    aiEnabled: input.aiEnabled ?? true,
    instructions: input.instructions ?? null,
  };
  await db
    .insert(supportConfigs)
    .values(values)
    .onDuplicateKeyUpdate({
      set: {
        projectId: values.projectId,
        intakeColumnId: values.intakeColumnId,
        aiEnabled: values.aiEnabled,
        instructions: values.instructions,
      },
    });
  const row = await getSupportConfig(input.channelId);
  if (!row) throw new Error('support config upsert failed');
  return row;
}
```

- [ ] **Step 4: run to verify it passes**

Run: `cd server && npx vitest run src/services/supportConfigService.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/services/supportConfigService.ts server/src/services/supportConfigService.test.ts
git commit -m "feat(server): supportConfigService — bind support channels to project intake columns

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `supportIntake` automation

**Files:**
- Modify: `server/src/services/events.ts`, `server/src/services/messageService.ts`, `server/src/services/messageService.test.ts`, `server/src/automations/index.ts`
- Create: `server/src/automations/supportIntake.ts`
- Test: `server/src/automations/supportIntake.test.ts`

**Interfaces:**
- `MessageCreatedEvent.message` gains `isBot: boolean`; `MessageCreatedEvent.channel` gains `kind: 'standard' | 'support'`
- `registerSupportIntake(): void`

- [ ] **Step 1: extend the event type — modify `server/src/services/events.ts`**

Replace the `MessageCreatedEvent` interface with:

```ts
export interface MessageCreatedEvent {
  message: {
    id: number;
    channelId: number;
    userId: number;
    displayName: string;
    body: string;
    mentionedUserIds: number[];
    isBot: boolean;
  };
  channel: {
    id: number;
    type: 'public' | 'private' | 'dm';
    kind: 'standard' | 'support';
    isPrivate: boolean;
  };
}
```

(The rest of the file — `EventMap`, `TypedBus`, `events` — is unchanged. `logAutomation.ts` and `pushAutomation.ts` only read fields that still exist, so both keep working untouched.)

- [ ] **Step 2: populate the new fields — modify `server/src/services/messageService.ts`**

Add `isBot: users.isBot,` to the `messageSelection` object (after the existing `displayName:` line). Add `isBot: boolean;` to the `RawMessageRow` type (after its `displayName: string;` line). Then update the `events.emit` call inside `sendMessage` to:

```ts
  events.emit('message.created', {
    message: {
      id: row.id,
      channelId,
      userId,
      displayName: row.displayName,
      body,
      mentionedUserIds,
      isBot: row.isBot,
    },
    channel: { id: channel.id, type: channel.type, kind: channel.kind, isPrivate: channel.isPrivate },
  });
```

`toDto` is unchanged — `isBot` is used for routing only and deliberately stays off the `MessageWithAuthor` DTO here; Task 7 adds it to the DTO separately for bot styling.

- [ ] **Step 3: failing test — `server/src/automations/supportIntake.test.ts`**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/index.js';
import { tasks, users } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { ensureBotUser } from '../services/botService.js';
import { addChannelMember, createChannel } from '../services/channelService.js';
import { getMessagesBefore, sendMessage } from '../services/messageService.js';
import { createProject } from '../services/projectService.js';
import {
  resolveIntakeColumnId,
  upsertSupportConfig,
} from '../services/supportConfigService.js';
import { createDefaultColumns } from '../services/taskService.js';
import { registerSupportIntake } from './supportIntake.js';

const triageSupportConversation = vi.hoisted(() => vi.fn());
vi.mock('../services/aiService.js', () => ({
  triageSupportConversation,
  isAiConfigured: () => true,
}));

// Debounce must be ~instant in tests.
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { config: { ...actual.config, SUPPORT_DEBOUNCE_MS: 1 } };
});

async function seedUser(email: string) {
  const [{ id }] = await db
    .insert(users)
    .values({ email, passwordHash: 'x', displayName: email.split('@')[0] })
    .$returningId();
  return id;
}

async function seedSupportChannel(ownerId: number, name: string) {
  const project = await createProject({ name: `${name}-proj`, isPrivate: false, createdBy: ownerId });
  await createDefaultColumns(project.id);
  const intakeColumnId = (await resolveIntakeColumnId(project.id))!;
  const channel = await createChannel({ name, isPrivate: false, createdBy: ownerId, kind: 'support' });
  await upsertSupportConfig({ channelId: channel.id, projectId: project.id, intakeColumnId });
  return { project, channel, intakeColumnId };
}

registerSupportIntake(); // once at module load, like real boot — not per-test

describe('supportIntake', () => {
  beforeEach(async () => {
    await resetDb();
    triageSupportConversation.mockReset();
    await ensureBotUser();
  });

  it('files a ticket in the bound intake column with origin links and priority', async () => {
    const reporter = await seedUser('reporter@flowerstore.ph');
    const { project, channel, intakeColumnId } = await seedSupportChannel(reporter, 'help1');
    triageSupportConversation.mockResolvedValue({
      action: 'create_ticket',
      question: null,
      title: 'Printer jammed on floor 2',
      description: 'Invoices cannot print.',
      priority: 'high',
    });

    const msg = await sendMessage(channel.id, reporter, 'the floor 2 printer is jammed');

    await vi.waitFor(async () => {
      const rows = await db.select().from(tasks);
      expect(rows).toHaveLength(1);
    });
    const [ticket] = await db.select().from(tasks);
    expect(ticket.projectId).toBe(project.id);
    expect(ticket.columnId).toBe(intakeColumnId);
    expect(ticket.title).toBe('Printer jammed on floor 2');
    expect(ticket.priority).toBe('high');
    expect(ticket.source).toBe('support');
    expect(ticket.originChannelId).toBe(channel.id);
    expect(ticket.originMessageId).toBe(msg.id);
  });

  it('posts the clarifying question as the bot, and the bot reply does not re-trigger the AI', async () => {
    const reporter = await seedUser('reporter2@flowerstore.ph');
    const { channel } = await seedSupportChannel(reporter, 'help2');
    triageSupportConversation.mockResolvedValue({
      action: 'ask_clarification',
      question: 'Which printer, and on which floor?',
      title: null,
      description: null,
      priority: null,
    });

    await sendMessage(channel.id, reporter, 'its broken');

    await vi.waitFor(async () => {
      const history = await getMessagesBefore(channel.id, null, 10);
      expect(history.some((m) => m.body === 'Which printer, and on which floor?')).toBe(true);
    });
    // The bot's own message must not cause a second AI turn.
    expect(triageSupportConversation).toHaveBeenCalledTimes(1);
    expect(await db.select().from(tasks)).toHaveLength(0);
  });

  it('ignores messages in a standard (non-support) channel', async () => {
    const u = await seedUser('u@flowerstore.ph');
    const channel = await createChannel({ name: 'general', isPrivate: false, createdBy: u });
    await sendMessage(channel.id, u, 'just chatting');
    await new Promise((r) => setTimeout(r, 30));
    expect(triageSupportConversation).not.toHaveBeenCalled();
  });

  it('does nothing when the support config has ai_enabled false', async () => {
    const reporter = await seedUser('reporter3@flowerstore.ph');
    const { project, channel, intakeColumnId } = await seedSupportChannel(reporter, 'help3');
    await upsertSupportConfig({
      channelId: channel.id,
      projectId: project.id,
      intakeColumnId,
      aiEnabled: false,
    });
    await sendMessage(channel.id, reporter, 'something is broken');
    await new Promise((r) => setTimeout(r, 30));
    expect(triageSupportConversation).not.toHaveBeenCalled();
  });

  it('leaves chat working when the AI returns null (outage/unconfigured)', async () => {
    const reporter = await seedUser('reporter4@flowerstore.ph');
    const { channel } = await seedSupportChannel(reporter, 'help4');
    triageSupportConversation.mockResolvedValue(null);

    const msg = await sendMessage(channel.id, reporter, 'printer broken');
    expect(msg.id).toBeGreaterThan(0); // send succeeded

    await new Promise((r) => setTimeout(r, 30));
    expect(await db.select().from(tasks)).toHaveLength(0);
  });

  it('debounces a burst of messages into a single AI turn', async () => {
    const reporter = await seedUser('reporter5@flowerstore.ph');
    const { channel } = await seedSupportChannel(reporter, 'help5');
    triageSupportConversation.mockResolvedValue({
      action: 'ask_clarification',
      question: 'Details?',
      title: null,
      description: null,
      priority: null,
    });

    await sendMessage(channel.id, reporter, 'hi');
    await sendMessage(channel.id, reporter, 'the printer');
    await sendMessage(channel.id, reporter, 'is broken');

    await vi.waitFor(() => expect(triageSupportConversation).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(triageSupportConversation).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 4: run to verify it fails**

Run: `cd server && npx vitest run src/automations/supportIntake.test.ts`
Expected: FAIL — `Cannot find module './supportIntake.js'` (and `createChannel` not yet accepting `kind`)

- [ ] **Step 5: let `createChannel` accept `kind` — modify `server/src/services/channelService.ts`**

Add `kind?: 'standard' | 'support';` to `createChannel`'s `input` parameter type (after `departmentId?: number;`), and add `kind: input.kind ?? 'standard',` to the `.values({...})` object (after the `type:` line).

- [ ] **Step 6: extend `createTask` to accept the ticket-origin fields — modify `server/src/services/taskService.ts`**

Do this BEFORE writing the automation — the automation calls `createTask` with these fields and will not compile without them.

Add these four optional fields to `createTask`'s `input` parameter type (after `attachmentIds?: number[];`):

```ts
  originChannelId?: number;
  originMessageId?: number;
  source?: 'manual' | 'support';
  priority?: 'low' | 'medium' | 'high' | 'urgent';
```

and add them to the `db.insert(tasks).values({...})` object (after `createdBy: input.createdBy,`):

```ts
      originChannelId: input.originChannelId,
      originMessageId: input.originMessageId,
      source: input.source ?? 'manual',
      priority: input.priority,
```

Then extend `TaskDto` with the same four fields (`originChannelId: number | null; originMessageId: number | null; source: 'manual' | 'support'; priority: 'low'|'medium'|'high'|'urgent'|null;`) and map them through in `toTaskDto` (`originChannelId: row.originChannelId, originMessageId: row.originMessageId, source: row.source, priority: row.priority,`) so the board endpoint returns them for Task 7's frontend chips.

- [ ] **Step 7: implement — `server/src/automations/supportIntake.ts`**

```ts
import { config } from '../config.js';
import { logger } from '../logger.js';
import { triageSupportConversation } from '../services/aiService.js';
import { getBotUserId } from '../services/botService.js';
import { events, type MessageCreatedEvent } from '../services/events.js';
import { getMessagesBefore, sendMessage } from '../services/messageService.js';
import { getSupportConfig } from '../services/supportConfigService.js';
import { createTask } from '../services/taskService.js';

const CONTEXT_MESSAGES = 20;

// One pending timer per channel: a burst of rapid messages collapses into a single AI turn.
const pending = new Map<number, NodeJS.Timeout>();

export function registerSupportIntake(): void {
  events.on('message.created', (payload: MessageCreatedEvent) => {
    // Bot messages must never re-trigger the AI, or the bot talks to itself forever.
    if (payload.message.isBot) return;
    if (payload.channel.kind !== 'support') return;

    const channelId = payload.channel.id;
    const existing = pending.get(channelId);
    if (existing) clearTimeout(existing);
    pending.set(
      channelId,
      setTimeout(() => {
        pending.delete(channelId);
        handleSupportMessage(payload).catch((err) => {
          logger.error({ err }, 'supportIntake failed');
        });
      }, config.SUPPORT_DEBOUNCE_MS),
    );
  });
}

async function handleSupportMessage(payload: MessageCreatedEvent): Promise<void> {
  const channelId = payload.channel.id;
  const supportConfig = await getSupportConfig(channelId);
  if (!supportConfig || !supportConfig.aiEnabled) return;

  const botUserId = await getBotUserId();
  if (botUserId === null) {
    logger.warn('supportIntake: no bot user seeded — run `npm run seed:bot`');
    return;
  }

  const history = await getMessagesBefore(channelId, null, CONTEXT_MESSAGES);
  const decision = await triageSupportConversation({
    // getMessagesBefore returns newest-first; the AI reads oldest-first.
    messages: [...history].reverse().map((m) => ({ displayName: m.displayName, body: m.body })),
    instructions: supportConfig.instructions,
  });
  if (!decision) return; // AI unavailable or unusable — chat is unaffected

  if (decision.action === 'ask_clarification') {
    if (!decision.question) return;
    await sendMessage(channelId, botUserId, decision.question);
    return;
  }

  if (!decision.title) return;
  const ticket = await createTask({
    projectId: supportConfig.projectId,
    columnId: supportConfig.intakeColumnId,
    title: decision.title,
    description: decision.description ?? undefined,
    createdBy: botUserId,
    originChannelId: channelId,
    originMessageId: payload.message.id,
    source: 'support',
    priority: decision.priority ?? undefined,
  });
  await sendMessage(channelId, botUserId, `Filed ticket #${ticket.id}: ${ticket.title}`);
}
```

- [ ] **Step 8: register the automation — modify `server/src/automations/index.ts`**

```ts
import { registerLogAutomation } from './logAutomation.js';
import { registerPushAutomation } from './pushAutomation.js';
import { registerSupportIntake } from './supportIntake.js';

export function registerAutomations(): void {
  registerLogAutomation();
  registerPushAutomation();
  registerSupportIntake();
}
```

- [ ] **Step 9: run to verify it passes**

Run: `cd server && npx vitest run src/automations/supportIntake.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 10: full suite sanity check**

Run: `cd server && npm test > /tmp/phase7-task5.log 2>&1; echo "EXIT:$?"`
Expected: `EXIT:0`, or only the one known pre-existing unrelated `settingsService.test.ts` failure if it hasn't been fixed on `main` yet — nothing new.

- [ ] **Step 11: Commit**

```bash
git add server/src/services/events.ts server/src/services/messageService.ts server/src/services/messageService.test.ts server/src/services/channelService.ts server/src/services/taskService.ts server/src/automations/supportIntake.ts server/src/automations/supportIntake.test.ts server/src/automations/index.ts
git commit -m "feat(server): supportIntake automation — AI triage to clarifying question or ticket

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Support-channel routes

**Files:**
- Modify: `server/src/routes/channels.ts`
- Test: `server/src/routes/channels.test.ts`

**Interfaces:**
- `POST /api/channels` accepts optional `kind: 'support'` + `supportConfig: { projectId: number; intakeColumnId?: number; instructions?: string }` → 201 `{ channel }`; 404 if the caller can't see the target project; 400 `invalid_support_config` if the project has no columns and no `intakeColumnId` was given.
- `GET /api/channels/:id/support-config` → 200 `{ supportConfig: SupportConfigRow | null }` (404 if the channel isn't visible)
- `PUT /api/channels/:id/support-config` → 200 `{ supportConfig }` (channel owner/admin only, 404 otherwise)

- [ ] **Step 1: failing tests — append to `server/src/routes/channels.test.ts`** (add inside the existing `describe` block; do not remove or restructure existing tests)

```ts
  it('creates a support channel bound to a project and exposes its config', async () => {
    const owner = await makeUser(app, { email: 'supowner@flowerstore.ph' });
    const project = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Support Proj', isPrivate: false });

    const res = await request(app)
      .post('/api/channels')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        name: 'helpdesk',
        isPrivate: false,
        kind: 'support',
        supportConfig: { projectId: project.body.project.id, instructions: 'Ask for the branch.' },
      });
    expect(res.status).toBe(201);
    expect(res.body.channel.kind).toBe('support');

    const cfg = await request(app)
      .get(`/api/channels/${res.body.channel.id}/support-config`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(cfg.status).toBe(200);
    expect(cfg.body.supportConfig.projectId).toBe(project.body.project.id);
    expect(cfg.body.supportConfig.instructions).toBe('Ask for the branch.');
    expect(cfg.body.supportConfig.intakeColumnId).toBeGreaterThan(0);
  });

  it('404s when binding a support channel to a project the caller cannot see', async () => {
    const owner = await makeUser(app, { email: 'supowner2@flowerstore.ph' });
    const outsider = await makeUser(app, { email: 'supoutsider@flowerstore.ph' });
    const project = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Secret Proj', isPrivate: true });

    const res = await request(app)
      .post('/api/channels')
      .set('Authorization', `Bearer ${outsider.token}`)
      .send({
        name: 'sneaky',
        isPrivate: false,
        kind: 'support',
        supportConfig: { projectId: project.body.project.id },
      });
    expect(res.status).toBe(404);
  });

  it('PUT support-config toggles ai_enabled for the channel owner', async () => {
    const owner = await makeUser(app, { email: 'supowner3@flowerstore.ph' });
    const project = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Proj3', isPrivate: false });
    const channel = await request(app)
      .post('/api/channels')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        name: 'helpdesk3',
        isPrivate: false,
        kind: 'support',
        supportConfig: { projectId: project.body.project.id },
      });

    const res = await request(app)
      .put(`/api/channels/${channel.body.channel.id}/support-config`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ projectId: project.body.project.id, aiEnabled: false });
    expect(res.status).toBe(200);
    expect(res.body.supportConfig.aiEnabled).toBe(false);
  });

  it('GET support-config returns null for a standard channel', async () => {
    const owner = await makeUser(app, { email: 'supowner4@flowerstore.ph' });
    const channel = await request(app)
      .post('/api/channels')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'plain', isPrivate: false });
    const res = await request(app)
      .get(`/api/channels/${channel.body.channel.id}/support-config`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(200);
    expect(res.body.supportConfig).toBeNull();
  });
```

- [ ] **Step 2: run to verify it fails**

Run: `cd server && npx vitest run src/routes/channels.test.ts`
Expected: FAIL — the support-channel create returns a channel with `kind: 'standard'`, and the support-config routes 404 (not mounted)

- [ ] **Step 3: implement — modify `server/src/routes/channels.ts`**

Add these imports alongside the existing service imports:

```ts
import { getVisibleProject } from '../services/projectService.js';
import {
  getSupportConfig,
  resolveIntakeColumnId,
  upsertSupportConfig,
} from '../services/supportConfigService.js';
```

Replace the existing `createBody` schema and `POST /` handler with:

```ts
const supportConfigBody = z.object({
  projectId: z.number().int().positive(),
  intakeColumnId: z.number().int().positive().optional(),
  instructions: z.string().max(2000).optional(),
});

const createBody = z.object({
  name: z.string().min(1).max(80),
  isPrivate: z.boolean(),
  topic: z.string().max(255).optional(),
  departmentId: z.number().int().positive().optional(),
  kind: z.enum(['standard', 'support']).optional(),
  supportConfig: supportConfigBody.optional(),
});

// A support channel files tickets into a project, so the creator must be able to see that
// project — otherwise creating one would leak the existence of a private project.
async function resolveSupportBinding(
  input: z.infer<typeof supportConfigBody>,
  userId: number,
  isAdmin: boolean,
): Promise<{ projectId: number; intakeColumnId: number; instructions?: string }> {
  const project = await getVisibleProject(input.projectId, userId, isAdmin);
  if (!project) throw new AppError(404, 'not_found', 'Not found');
  const intakeColumnId = input.intakeColumnId ?? (await resolveIntakeColumnId(input.projectId));
  if (intakeColumnId === null) {
    throw new AppError(400, 'invalid_support_config', 'Target project has no columns to file tickets into');
  }
  return { projectId: input.projectId, intakeColumnId, instructions: input.instructions };
}

channelsRouter.post('/', validate(createBody), async (req, res) => {
  const input = req.valid as z.infer<typeof createBody>;
  const isAdmin = req.auth!.role === 'admin';
  const { kind, supportConfig, ...channelInput } = input;

  if (kind === 'support' && !supportConfig) {
    throw new AppError(400, 'invalid_support_config', 'A support channel requires supportConfig');
  }
  // Authorize the project binding BEFORE creating the channel, so a failed bind
  // never leaves an orphaned support channel with no config behind.
  const binding =
    kind === 'support' && supportConfig
      ? await resolveSupportBinding(supportConfig, req.auth!.userId, isAdmin)
      : null;

  const channel = await createChannel({ ...channelInput, kind, createdBy: req.auth!.userId });
  if (binding) await upsertSupportConfig({ channelId: channel.id, ...binding });
  res.status(201).json({ channel });
});
```

Then add these two routes to `channelsRouter` (place them next to the other `/:id/...` routes, before `export const messagesRouter`):

```ts
channelsRouter.get('/:id/support-config', async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleChannel(id, req.auth!.userId, req.auth!.role === 'admin');
  res.json({ supportConfig: await getSupportConfig(id) });
});

const supportConfigPut = z.object({
  projectId: z.number().int().positive(),
  intakeColumnId: z.number().int().positive().optional(),
  instructions: z.string().max(2000).nullable().optional(),
  aiEnabled: z.boolean().optional(),
});

channelsRouter.put('/:id/support-config', validate(supportConfigPut), async (req, res) => {
  const id = parseId(req.params.id);
  const isAdmin = req.auth!.role === 'admin';
  await requireVisibleChannel(id, req.auth!.userId, isAdmin);
  await requireOwnerOrAdmin(id, req.auth!.userId, isAdmin);
  const input = req.valid as z.infer<typeof supportConfigPut>;
  const binding = await resolveSupportBinding(
    { projectId: input.projectId, intakeColumnId: input.intakeColumnId },
    req.auth!.userId,
    isAdmin,
  );
  const supportConfig = await upsertSupportConfig({
    channelId: id,
    projectId: binding.projectId,
    intakeColumnId: binding.intakeColumnId,
    aiEnabled: input.aiEnabled,
    instructions: input.instructions ?? null,
  });
  res.json({ supportConfig });
});
```

- [ ] **Step 4: run to verify it passes**

Run: `cd server && npx vitest run src/routes/channels.test.ts`
Expected: PASS (4 new tests + all pre-existing tests in the file)

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/channels.ts server/src/routes/channels.test.ts
git commit -m "feat(server): support channel creation + GET/PUT support-config routes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Frontend — bot styling, support-channel creation, ticket origin chips

**Files:**
- Modify: `server/src/services/messageService.ts` (add `isBot` to the message DTO), `src/features/chat/types.ts`, `src/features/chat/MessageItem.tsx`, `src/features/chat/api.ts`, `src/features/kanban/TaskCard.tsx`, `src/features/kanban/BoardColumn.tsx`, `src/features/projects/NewProjectDialog.tsx` (reference only — do not change), `src/features/chat/Sidebar.tsx`
- Create: `src/features/chat/NewSupportChannelDialog.tsx`

**Interfaces:**
- `Message` gains `isBot: boolean`
- `TaskCardData` gains `originChannelId: number | null`, `priority: 'low'|'medium'|'high'|'urgent'|null`
- `createSupportChannel(input: { name: string; isPrivate: boolean; projectId: number; instructions?: string })`

- [ ] **Step 1: expose `isBot` on the message DTO — modify `server/src/services/messageService.ts`**

Add `isBot: boolean;` to the `MessageWithAuthor` interface (after `displayName: string;`) and `isBot: row.isBot,` to the object `toDto` returns (after `displayName: row.displayName,`). `messageSelection` and `RawMessageRow` already carry `isBot` from Task 5 — no further change needed there.

- [ ] **Step 2: frontend message type — modify `src/features/chat/types.ts`**

Add `isBot: boolean;` to the `Message` interface (after `displayName: string;`).

- [ ] **Step 3: bot message styling — modify `src/features/chat/MessageItem.tsx`**

Replace the author-name line (`<span className="font-semibold">{message.displayName}</span>`) with:

```tsx
          <span className="font-semibold">{message.displayName}</span>
          {message.isBot && (
            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
              Bot
            </span>
          )}
```

- [ ] **Step 4: support-channel creation API — modify `src/features/chat/api.ts`**

Add:

```ts
export const createSupportChannel = (input: {
  name: string;
  isPrivate: boolean;
  projectId: number;
  instructions?: string;
}) =>
  api<{ channel: Channel }>('/api/channels', {
    method: 'POST',
    body: {
      name: input.name,
      isPrivate: input.isPrivate,
      kind: 'support',
      supportConfig: { projectId: input.projectId, instructions: input.instructions },
    },
  });
```

(If `Channel` is not already imported in this file, add it to the existing `./types` import.)

- [ ] **Step 5: `src/features/chat/NewSupportChannelDialog.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { listProjects } from '@/features/projects/api';
import { ApiError } from '@/lib/api';
import { createSupportChannel } from './api';

export function NewSupportChannelDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState<number | null>(null);
  const [instructions, setInstructions] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { data } = useQuery({ queryKey: ['projects'], queryFn: listProjects, enabled: open });

  async function handleCreate() {
    setError(null);
    if (!name.trim() || projectId === null) {
      setError('Pick a name and a target project.');
      return;
    }
    try {
      await createSupportChannel({
        name: name.trim(),
        isPrivate: false,
        projectId,
        instructions: instructions.trim() || undefined,
      });
      setName('');
      setInstructions('');
      setProjectId(null);
      onOpenChange(false);
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create support channel');
    }
  }

  if (!open) return null;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New support channel</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <input
            className="rounded-md border px-2 py-1 text-sm"
            placeholder="Channel name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <select
            className="rounded-md border px-2 py-1 text-sm"
            value={projectId ?? ''}
            onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Select target project…</option>
            {data?.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <textarea
            className="rounded-md border px-2 py-1 text-sm"
            rows={3}
            placeholder="Optional extra guidance for the assistant"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
          {error && <p className="text-xs text-red-600">{error}</p>}
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
            onClick={handleCreate}
          >
            Create
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

**Before writing this file**, open `src/features/projects/NewProjectDialog.tsx` and confirm the exact shadcn `Dialog` import path and the exact shape of `listProjects`'s return value (`{ projects: [...] }` vs a bare array) — mirror whatever that file really does rather than assuming. Note the `if (!open) return null;` guard before the `<Dialog open ...>`: this is the Phase 4 lesson (a toggled-but-mounted shadcn Dialog left an invisible click-blocking overlay in the DOM) — always unmount the subtree instead of toggling `open` on a permanently-mounted Dialog.

- [ ] **Step 6: wire the dialog into the sidebar — modify `src/features/chat/Sidebar.tsx`**

Read the file first. Add `const [supportOpen, setSupportOpen] = useState(false);` alongside its existing state, add a small "+ Support channel" button next to the existing channel-section heading, and render `<NewSupportChannelDialog open={supportOpen} onOpenChange={setSupportOpen} onCreated={() => refetch()} />` — wiring `onCreated` to whatever the file already uses to refresh its channel list (a TanStack Query `refetch` or `queryClient.invalidateQueries({ queryKey: ['channels'] })`; use the mechanism already present rather than introducing a new one).

- [ ] **Step 7: ticket origin chip + priority badge — modify `src/features/kanban/TaskCard.tsx`**

Extend `TaskCardData`:

```tsx
export interface TaskCardData {
  id: number;
  columnId: number;
  title: string;
  assigneeId: number | null;
  dueDate: string | null;
  originChannelId: number | null;
  priority: 'low' | 'medium' | 'high' | 'urgent' | null;
}
```

and add the badges to the card body, immediately after the `{task.title}` line:

```tsx
      {(task.priority || task.originChannelId) && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {task.priority && (
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${
                task.priority === 'urgent' || task.priority === 'high'
                  ? 'bg-red-100 text-red-700'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              {task.priority}
            </span>
          )}
          {task.originChannelId && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              from chat
            </span>
          )}
        </div>
      )}
```

- [ ] **Step 8: build check**

Run: `npm run build > /tmp/phase7-web-build.log 2>&1; echo "EXIT:$?"`
Expected: `EXIT:0`. If tsc complains that `BoardColumn.tsx`/`ProjectBoardPage.tsx` construct `TaskCardData` objects missing the two new required fields, that's the expected consequence of widening the type — the board data comes from the server's `TaskDto`, which now includes them, so fix by ensuring those files pass the fields through rather than by loosening the type.

Run: `npm run lint`
Expected: clean (aside from pre-existing shadcn-ui warnings).

- [ ] **Step 9: Commit**

```bash
git add server/src/services/messageService.ts src/features/chat/ src/features/kanban/TaskCard.tsx src/features/kanban/BoardColumn.tsx src/features/kanban/ProjectBoardPage.tsx
git commit -m "feat(web): bot message badge, support channel creation, ticket origin/priority chips

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Phase gate — full verification + finish

- [ ] `cd server && npm test > /tmp/phase7-gate.log 2>&1; echo "EXIT:$?"` → `EXIT:0` (or only the known pre-existing unrelated `settingsService.test.ts` failure)
- [ ] `cd server && npm run build > /tmp/phase7-server-build.log 2>&1; echo "EXIT:$?"` → `EXIT:0`
- [ ] `npm run build > /tmp/phase7-web-build2.log 2>&1; echo "EXIT:$?"` (root) → `EXIT:0`; `npm run lint` clean
- [ ] `docker build .` (from `server/` as context) → succeeds with `openai` now in the image
- [ ] **Confirm no secret leaked into the repo**: `git log -p origin/main..HEAD | grep -i "sk-proj" ; echo "exit=$?"` → must find NOTHING (exit=1). Also `grep -rn "sk-proj" server/src src docs` → nothing. The key lives only in the gitignored `server/.env`.
- [ ] Restart PM2 (`npx pm2 restart ecosystem.config.cjs` from repo root after rebuilding both dists), run `npm run seed:bot`, then verify live against the running dev server **with the real OpenAI key configured**:
  - create a project, then create a support channel bound to it via `POST /api/channels` with `kind: 'support'`
  - post a deliberately **vague** message ("its broken") as a normal user → within ~6s (debounce) confirm the FS Assistant bot posts a real clarifying question into the channel, and that NO ticket was created
  - reply with real detail ("the floor 2 printer is jammed and invoices won't print") → confirm a ticket appears in the bound project's intake column with a sensible AI-written title/description/priority, `source='support'`, and `origin_channel_id`/`origin_message_id` populated (check via `SELECT * FROM tasks`)
  - confirm the bot's own messages did NOT trigger further AI turns (check the server log for exactly the expected number of triage calls, and that no runaway loop occurred) — this is the single most important live check, since a re-entrancy bug would burn API credits in a loop
  - confirm a message in a **standard** channel triggers no AI call at all
  - set `ai_enabled = 0` for the support config in MariaDB, post again, confirm no AI call
  - temporarily unset `OPENAI_API_KEY`, restart, post in the support channel → confirm the message sends normally and chat is fully functional with no AI response and no crash (fail-soft), then restore the key
  - browser check (Claude_Browser tools): confirm the bot's messages render with the "Bot" badge, and that a filed ticket shows its priority + "from chat" chip on the kanban board
- [ ] **Rotate the API key**: the key was pasted in plaintext into a chat transcript. Remind the user to rotate it at platform.openai.com once verification is done, and note whether they've done so.
- [ ] Update memory (mark Phase 7 complete; record the OpenAI-instead-of-Claude stack decision, the `gpt-5-nano` reasoning-token gotcha, and the live-verification results), then use **superpowers:finishing-a-development-branch**

## Deviations / notes for the implementer

- **Provider swap is intentional.** The master plan says Claude/`@anthropic-ai/sdk`; the user directed OpenAI/`gpt-5-nano` on 2026-07-31 and that governs. Everything else about the master plan's Phase 7 design (support channel kind, bound project + intake column, bot user, event-bus automation, origin links) is unchanged.
- **`aiService` returns `null` rather than throwing, on purpose.** Every caller treats `null` as "skip silently". Do not "improve" this into throwing — a thrown error inside the automation would be caught by `pushAutomation`-style `.catch` anyway, but returning `null` keeps the failure explicit and testable, and guarantees the chat path is untouched.
- **The debounce map is per-process and unbounded in principle** — one `setTimeout` entry per active support channel, deleted when it fires. With a realistic number of support channels this is negligible; it does not need an eviction policy. If the backend ever scales to multiple tasks, each task would debounce independently (worst case: one AI turn per task per burst) — acceptable, and noted here so nobody is surprised.
- **`getMessagesBefore` returns newest-first**, so `supportIntake` reverses it before handing the transcript to the AI. Getting this backwards silently produces much worse AI output while everything still "works" — don't drop the `.reverse()`.
- The `create_ticket` path posts a confirmation message ("Filed ticket #N: …") through the same `sendMessage`, which re-emits `message.created` — the `isBot` guard is what stops that from looping. This is why that guard is a Global Constraint, not a nice-to-have.
- Task 7 Step 5's dialog code assumes the shadcn `Dialog` import path and `listProjects` shape used elsewhere in this codebase; the step explicitly instructs verifying both against `NewProjectDialog.tsx` first, because those are the two most likely places for a small mismatch.
- **Known softness — Task 7 Step 6 (Sidebar wiring) is prose, not exact code.** `src/features/chat/Sidebar.tsx` was not read when this plan was written, so prescribing exact code would risk being confidently wrong about its existing state/refetch mechanism. The step names precisely what to add and instructs reusing whatever refresh mechanism the file already has. Read that file first; this is the one step in the plan where you must derive the exact diff yourself.
- **Scope trim vs. the master plan's literal wording:** the master plan mentions a "support-config settings tab" for editing an existing support channel's binding. The `PUT /api/channels/:id/support-config` route is fully implemented and tested (Task 6), but no edit UI is built — only the creation dialog (Task 7). Toggling `ai_enabled` or re-binding a project is therefore an API-only operation for now. Deferred deliberately, not dropped; the backend is ready for whenever that tab is wanted.
