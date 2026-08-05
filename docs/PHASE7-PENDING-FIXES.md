# Phase 7 — pending post-review fixes (NOT yet applied)

**State:** branch `phase-7-ai-support`, 8 commits, **NOT merged**. `main` is clean at Phase 6 (`67f8cae`).
All 8 plan tasks are implemented, task-reviewed, and committed. The full whole-branch review then
found the issues below. User paused before fixes were applied ("fix it next time").

Plan: `docs/superpowers/plans/2026-07-31-phase7-ai-support.md`
Verdict: **Ready to merge = With fixes** (2 Critical must be fixed first).

---

## CRITICAL 1 — No terminal state: AI files DUPLICATE tickets (EMPIRICALLY REPRODUCED)

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

3. **No in-flight guard.** `supportIntake.ts` does `pending.delete(channelId)` before invoking the
   async handler, so a message arriving during a multi-second AI call starts a second overlapping
   triage on the same channel → two tickets, double spend. Add a module-level
   `inFlight = new Set<number>()`; skip if present; add before the handler, remove in `finally`.

4. **`ensureBotUser` doesn't repair `is_bot`** — it's get-or-create, so a pre-existing account at
   `assistant@flowerstore.ph` or a manual `UPDATE users SET is_bot=0` silently disables the ONLY
   loop guard. Fix: make it a real upsert (force `isBot: true` on the existing-row path), AND add
   belt-and-braces `if (payload.message.userId === botUserId) return;` in `handleSupportMessage`.

5. **`intakeColumnId` never validated against `projectId`.** `resolveSupportBinding` authorizes the
   project but accepts any positive column id, including one from another/invisible project. Tickets
   then get `projectId: A` + a column of project B; since `getBoard` filters by projectId they render
   on NO board — AI tickets silently vanish. Add a `columnBelongsToProject(columnId, projectId)`
   helper in `supportConfigService.ts` and 400 (`invalid_support_config`) when it fails.

6. **`GET /:id/support-config` leaks a private project's existence.** Gates only on
   `requireVisibleChannel`, then returns `projectId`/`intakeColumnId`/`instructions` — so a public
   support channel bound to a private project exposes it to everyone. The create path deliberately
   prevents exactly this. Fix: check `getVisibleProject`; if not visible return `{ supportConfig: null }`
   (do NOT 404 the channel — it is legitimately visible).

7. **No spend ceiling.** `express-rate-limit` is applied only to auth routes; message send is
   unlimited on REST and socket. The debounce coalesces but doesn't throttle: one message every 6s
   sustains ~600 triage calls/hour at up to ~20k input tokens each. Recommend a per-channel minimum
   interval + a daily cap + cost logging. (Fixing Critical 1 materially reduces this.)
   *Partial cheap fix worth doing now:* cap each transcript body to ~2000 chars in `aiService.ts`.

8. **`PUT /:id/support-config` on a standard channel returns 200 and does nothing** — it writes a
   config row but never sets `channels.kind`, and nothing else can flip `kind`, so the row is
   permanently inert. Fix: 400 when the channel's `kind !== 'support'`.

## Minor (optional)

- `isAiConfigured()` is dead production code (only tests/mocks reference it).
- `POST /api/channels` with `kind` standard/omitted + a `supportConfig` body silently discards it — reject.
- `if (!decision.question) return;` / `if (!decision.title) return;` are silent — should `logger.warn`.
- Unused `addChannelMember` import in `supportIntake.test.ts`.
- `MAX_CONTEXT_MESSAGES` (aiService) and `CONTEXT_MESSAGES` (supportIntake) are duplicated 20s.
- `server/.env.example` doesn't document `OPENAI_API_KEY`/`AI_MODEL`/`SUPPORT_DEBOUNCE_MS`
  (pre-existing practice — LIVEKIT/FIREBASE undocumented too).
- No pino `redact` config (low risk; OpenAI `APIError` carries response, not request, headers).
- Frontend `Channel` type has no `kind`, so support channels look identical in the sidebar.
- Nothing in the deploy path runs `seed:bot` (degrades to one warn per triage — fail-soft, easy to miss).
- `NewSupportChannelDialog` lacks a busy/disabled state (double-click could double-POST) and `<label>`s.
- The debounce test is wall-clock sensitive (50ms window vs. real MySQL round trips) — fake timers
  would make it robust.
- Channel-create + config-upsert aren't in one DB transaction, so a mid-failure could orphan a channel.

## Testing gaps worth closing

- No test asserts the transcript is handed to the AI OLDEST-FIRST (a dropped `.reverse()` silently
  degrades AI quality while everything still "works"). Trivially assertable from the existing mock.
- No test for: missing bot user, `create_ticket` with a null title, PUT-on-standard-channel, or a
  second human message after a ticket is filed (that last one would have caught Critical 1).

## Recommended verification after fixing

Re-run the live check and add the step that caught Critical 1: post a **third** human message
(e.g. "thanks!") after a ticket is filed and confirm NO second ticket appears. Also watch a channel
live (don't navigate fresh) to confirm the bot reply now streams in via socket.
