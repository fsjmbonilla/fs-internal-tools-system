# Phase 7 — post-review fixes (mostly applied; a record)

> **Status as of 2026-08-06: this review is closed.** Every Critical, every Important,
> and every actionable Minor is fixed. Phase 7 merged at `b2b9bc9`; both Criticals in
> `3afa5df`, Important 3/4/6 in `a8834fc`, and the rest — Important 5/7/8 plus the
> frontend, ops and Minor items — on 2026-08-06. Each item below is tagged with its
> state, **verified against the code**, not inferred from commit messages.
>
> **Deliberately not done:** `isAiConfigured()` is kept (see the Minor list), and the
> debounce test still uses real timers rather than fake ones — it is not flaky in
> practice, and the 50ms window is documented where it is set. Two entries near the end
> (pino `redact`, the two remaining test gaps) are unchanged and were judged low value.
>
> Read this for *why* each fix looks the way it does. It is history, not a to-do list.

**Original state when written:** branch `phase-7-ai-support`, 8 commits, not merged. `main`
was clean at Phase 6 (`67f8cae`). All 8 plan tasks were implemented, task-reviewed, and
committed. The full whole-branch review then found the issues below. User paused before
fixes were applied ("fix it next time").

Plan: `docs/superpowers/plans/2026-07-31-phase7-ai-support.md`
Verdict at the time: **Ready to merge = With fixes** (2 Critical must be fixed first).

---

## CRITICAL 1 — No terminal state: AI files DUPLICATE tickets (EMPIRICALLY REPRODUCED)

**FIXED** (`3afa5df`) — fix (a)+(b) applied; `supportIntake.ts` handles `action === 'none'`.
The optional `last_triaged_message_id` watermark was **not** added.

`aiService.ts`'s `DecisionSchema.action` is only `'ask_clarification' | 'create_ticket'`, so every
non-bot message in a support channel forces one of those two. Nothing records that a ticket was
already filed.

**Reproduced live:** a detailed AC-leak report filed ticket #7 ("Fix AC-77 leak in Meeting Room B").
A subsequent bare `"thanks!"` re-triaged the whole transcript and filed DUPLICATE ticket #8
("Inspect and fix AC-77 leak - Meeting Room B"). Every further human message forces another paid
autonomous action. The `isBot` guard stops bot→bot recursion; it does nothing about this
human-in-the-loop perpetuity, which is the real runaway path.

**Fix:**
- (a) Add `'none'` to `DecisionSchema.action` AND to the `response_format` JSON-schema `enum` in
  `RESPONSE_FORMAT`. Extend `BASE_PROMPT`: choose `none` for small talk, acknowledgements/thanks,
  or when a prior bot message in this same conversation already says a ticket was filed.
- (b) In `supportIntake.ts`, handle `action === 'none'` by returning without posting or filing.
- Consider also a `support_configs.last_triaged_message_id` watermark (belt-and-braces).

## CRITICAL 2 — Bot messages never delivered in real time (VERIFIED)

**FIXED** (`3afa5df`) — exactly as prescribed: `server/src/sockets/registry.ts` exists and
`messageService.sendMessage` broadcasts via `getIo()`.

Only `server/src/sockets/chatHandlers.ts:42` emits `message:new`. The automation and the REST send
route call `messageService.sendMessage` directly, so those messages are never pushed.
`src/features/chat/MessageList.tsx` has NO `refetchInterval` and updates only from the `message:new`
socket event → a user watching a support channel never sees the bot reply until reload/channel
switch. The headline feature is invisible in the running app.
(My browser verification navigated to the page fresh, which masked this.)

**Fix:** move the broadcast into `messageService.sendMessage` so every producer delivers identically.
- New `server/src/sockets/registry.ts` with module-level `setIo(server)` / `getIo(): Server | undefined`
  (undefined in tests — every caller treats it as optional, mirroring the `req.app.get('io')` pattern).
- Call `setIo(io)` in `server/src/index.ts` beside the existing `app.set('io', io)`.
- In `sendMessage`, build the DTO before returning and `getIo()?.to(\`channel:${channelId}\`).emit('message:new', dto)`.
- REMOVE the now-duplicate emit in `chatHandlers.ts` (keep its `ack?.(...)`).
- `server/src/sockets/socketAuth.test.ts` asserts `message:new` delivery and MUST still pass — it
  proves the new path works.

---

## Important

3. **FIXED** (`a8834fc`). **No in-flight guard.** `supportIntake.ts` does `pending.delete(channelId)` before invoking the
   async handler, so a message arriving during a multi-second AI call starts a second overlapping
   triage on the same channel → two tickets, double spend. Add a module-level
   `inFlight = new Set<number>()`; skip if present; add before the handler, remove in `finally`.

4. **FIXED** (`a8834fc`) — both halves: `botService.ts` forces `isBot: true` on the existing-row
   path, and `supportIntake.ts` has the `payload.message.userId === botUserId` guard.
   **`ensureBotUser` doesn't repair `is_bot`** — it's get-or-create, so a pre-existing account at
   `assistant@flowerstore.ph` or a manual `UPDATE users SET is_bot=0` silently disables the ONLY
   loop guard. Fix: make it a real upsert (force `isBot: true` on the existing-row path), AND add
   belt-and-braces `if (payload.message.userId === botUserId) return;` in `handleSupportMessage`.

5. **FIXED** (2026-08-06) — `columnBelongsToProject()` in `supportConfigService.ts`, called from
   `resolveSupportBinding` whenever the caller supplies a column; 400 `invalid_support_config`
   otherwise. Covered both ways in `routes/supportHardening.test.ts`.
   **`intakeColumnId` never validated against `projectId`.** `resolveSupportBinding` authorizes the
   project but accepts any positive column id, including one from another/invisible project. Tickets
   then get `projectId: A` + a column of project B; since `getBoard` filters by projectId they render
   on NO board — AI tickets silently vanish. Add a `columnBelongsToProject(columnId, projectId)`
   helper in `supportConfigService.ts` and 400 (`invalid_support_config`) when it fails.

6. **FIXED** (`a8834fc`) — the GET now runs `getVisibleProject` and returns a null config
   rather than the binding. **`GET /:id/support-config` leaks a private project's existence.** Gates only on
   `requireVisibleChannel`, then returns `projectId`/`intakeColumnId`/`instructions` — so a public
   support channel bound to a private project exposes it to everyone. The create path deliberately
   prevents exactly this. Fix: check `getVisibleProject`; if not visible return `{ supportConfig: null }`
   (do NOT 404 the channel — it is legitimately visible).

7. **FIXED** (2026-08-06). The transcript cap had landed earlier (`MAX_BODY_CHARS` in
   `services/ai/triage.ts`); the ceiling itself now exists as `services/aiBudgetService.ts`,
   backed by migration `0013_ai_usage` — one row per dispatched triage, carrying the token
   counts. `checkAiBudget()` enforces a per-channel minimum interval (`AI_MIN_INTERVAL_MS`,
   default 60s) and a platform-wide daily cap (`AI_DAILY_CALL_CAP`, default 500); both fail
   *open* on a DB error, since refusing to answer a support channel because a COUNT failed
   would be the wrong trade. A dispatched call that then failed is still recorded, so a broken
   provider is not retried hot. Two suites cover it: `services/aiBudget.test.ts` and
   `automations/aiSpendCeiling.test.ts`.

   Two things learned building it, worth keeping: the ledger is in the database rather than in
   memory because a crash loop resetting an in-memory counter would defeat the cap in exactly
   the situation it exists for; and **both sides of every time comparison stay inside MySQL**
   (`NOW()`, `CURDATE()`) because drizzle maps a MySQL TIMESTAMP back through UTC — comparing a
   default-generated `created_at` against a JS `Date` is off by the host's UTC offset, which is
   zero on a UTC server and eight hours on this workstation.
   **No spend ceiling.** `express-rate-limit` is applied only to auth routes; message send is
   unlimited on REST and socket. The debounce coalesces but doesn't throttle: one message every 6s
   sustains ~600 triage calls/hour at up to ~20k input tokens each. Recommend a per-channel minimum
   interval + a daily cap + cost logging. (Fixing Critical 1 materially reduces this.)
   *Partial cheap fix worth doing now:* cap each transcript body to ~2000 chars in `aiService.ts`.

8. **FIXED** (2026-08-06) — the PUT 400s when `kind !== 'support'`, and the create path now
   rejects a `supportConfig` sent for a standard channel instead of discarding it behind a 201
   (the same bug at the other door — it was in the Minor list separately).
   **`PUT /:id/support-config` on a standard channel returns 200 and does nothing** — it writes a
   config row but never sets `channels.kind`, and nothing else can flip `kind`, so the row is
   permanently inert. Fix: 400 when the channel's `kind !== 'support'`.

## Minor (optional)

*Not systematically re-audited. Four items were spot-checked on 2026-08-06 and are tagged;
the rest are as-written in the original review and may or may not still hold.*

- **Kept deliberately.** `isAiConfigured()` has no production caller, but three suites assert it
  as the "is a provider configured" predicate alongside `aiProviderName()`. Deleting it would
  remove tested diagnostic surface for a cosmetic win.
- **FIXED.** `POST /api/channels` with `kind` standard/omitted + a `supportConfig` body silently
  discards it — now 400, matching the PUT (Important 8).
- **FIXED.** `if (!decision.question) return;` / `if (!decision.title) return;` were silent — both
  now `logger.warn`, since an action named without its payload is a model fault, not a no-op.
- **FIXED.** Unused `addChannelMember` import in `supportIntake.test.ts`.
- **FIXED.** The duplicated 20s: `MAX_CONTEXT_MESSAGES` is exported from `services/ai/triage.ts`
  and the automation fetches exactly that many.
- **FIXED.** `server/.env.example` now documents `AI_PROVIDER`/`OPENAI_API_KEY`/`AI_MODEL`/
  `SUPPORT_DEBOUNCE_MS`.
- No pino `redact` config (low risk; OpenAI `APIError` carries response, not request, headers).
- **FIXED** (2026-08-06). Frontend `Channel` type (`src/features/chat/types.ts`) has no `kind`,
  so support channels look identical in the sidebar. `kind` was already in the list payload —
  only the type and the UI were missing. `ChannelLink` now renders a "support" chip, and a route
  test asserts `kind` survives the payload so the chip cannot silently stop working.
- **FIXED** (2026-08-06). Nothing in the deploy path runs `seed:bot` — `index.ts` now calls
  `ensureBotUser()` at boot. It is an idempotent upsert, so it costs one query per start and
  removes the failure mode entirely; the `seed:bot` script stays for setting up a database by
  hand. Deliberately non-fatal: on a first deploy the migrations may not have run yet, and
  refusing to start would take chat down over a feature that degrades fine on its own.
- **FIXED** (2026-08-06). `NewSupportChannelDialog` lacks a busy/disabled state (double-click could
  double-POST) and `<label>`s. Every control now has a real `<label>` via `useId`, inputs disable
  while the request is in flight, the button reads "Creating…", and `handleCreate` returns early
  if it is re-entered. The error line is `role="alert"`.
- The debounce test is wall-clock sensitive (50ms window vs. real MySQL round trips) — fake timers
  would make it robust.
- **FIXED** (2026-08-06). Channel-create + config-upsert aren't in one DB transaction, so a
  mid-failure could orphan a channel. Both now run in one `db.transaction`, the same pattern
  `findOrCreateDm` already used. `createChannel`, `addChannelMember`, `getSupportConfig` and
  `upsertSupportConfig` take an optional `Executor` (pool or open transaction, exported from
  `db/index.ts`) so a service can join a caller's transaction without knowing it is in one.
  Rollback is proven in `routes/channelCreateAtomicity.test.ts`.

## Testing gaps worth closing

- **CLOSED.** No test asserts the transcript is handed to the AI OLDEST-FIRST (a dropped
  `.reverse()` silently degrades AI quality while everything still "works") — now asserted in
  `supportIntake.test.ts`.
- **PUT-on-standard-channel: CLOSED** (`supportHardening.test.ts`). The second-human-message case
  is covered at the decision level by `services/aiTerminalAction.test.ts` (the `'none'` action and
  the prompt that produces it) and, from 2026-08-06, end-to-end by `aiSpendCeiling.test.ts` — where
  a second message no longer reaches the provider at all, for the independent reason that the
  interval limit blocks it. **Still untested:** a missing bot user, and `create_ticket` with a null
  title — both now log a warning rather than returning silently, so they are at least visible.

## Recommended verification after fixing

Re-run the live check and add the step that caught Critical 1: post a **third** human message
(e.g. "thanks!") after a ticket is filed and confirm NO second ticket appears. Also watch a channel
live (don't navigate fresh) to confirm the bot reply now streams in via socket.
