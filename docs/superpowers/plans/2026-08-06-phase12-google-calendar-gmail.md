# Phase 12: Google Calendar + Gmail

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal (master plan §Phase 12):** connect the platform to Google Workspace —
per-user Calendar and Gmail, an org-level support mailbox that feeds a support
channel (full email-to-ticket path through the existing AI intake), and
calendar/gmail tools on the shared agent-tool registry.

**Why now:** phases 0–11 are done and Phase 13 (Drive) builds directly on this
phase's `googleService` token lifecycle. The Cloud-console admin work is already
done: client id/secret are in `server/.env`, the redirect URI is registered.

## Verified against the repo before writing this (2026-08-06)

- `config.ts` already reads `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` /
  `GOOGLE_REDIRECT_URI` (optional — Google features degrade to "not offered",
  the push/AI pattern, not the LiveKit 503 pattern). What it does **not** have
  yet: an encryption key for refresh tokens at rest. This phase adds
  `GOOGLE_TOKEN_ENC_KEY`.
- Migration numbering continues at **0017** (master plan calls this group
  "013"; the plan's numbers drifted from reality around phase 3 — follow the
  journal, not the plan).
- The Phase 11 scheduler (`routineScheduler.ts`) is the croner pattern to copy
  for the mailbox poller: DB is the state, timers rebuilt at boot, `protect:
  true` so a slow tick cannot overlap itself, test-only `stopAll` hook wired
  into `resetDb()`.

## Two design conflicts the master plan doesn't resolve

**1. The bot guard vs. the email-to-ticket path.** Ingested emails become
messages *authored by the bot*, but `supportIntake` skips bot-authored messages
(twice — payload flag and belt-and-braces id check). Left as is, the flagship
"email → support channel → AI files ticket" flow silently does nothing.
Resolution: the `message.created` event payload gains an optional
`origin: 'email'`, and both guards in `supportIntake` skip bots **unless**
`origin === 'email'`. This cannot loop: the bot's own replies are never
email-ingested, so they still carry no origin and are still skipped.

**2. Whose Google connection do agent tools use?** Routines run as the bot
(`caller.userId = botUserId`) and MCP tokens act as bot users — neither can hold
a Google connection of its own. Resolution: `Caller` gains an optional
`googleUserId` — the human whose connection Google tools may use.
`routineRunner` sets it to `routine.ownerId` (the owner granted the scopes;
their calendar/mail is what a "morning digest" routine means). The MCP adapter
sets it to the token's `created_by`. REST routes set it to the session user.
A Google tool whose caller has no `googleUserId`, or whose `googleUserId` has
no (working) connection, returns a `refusal` naming the fix ("connect Google in
Settings") — never a throw.

## Library decision

The master plan says "`googleapis` npm client". Use the **modular** official
packages instead: `google-auth-library` (OAuth2Client: auth URL, code exchange,
auto-refresh) plus `@googleapis/calendar` and `@googleapis/gmail`. Same Google-
maintained code, same API shapes, without installing the ~100MB monolith for
two services. Verify current majors at install time; pin exact versions.

## Global constraints

- **Calendar and Gmail are personal data.** Every REST route in this phase is
  `requireUserAuth` — service tokens reach Google only through the agent-tool
  registry, gated by explicit new scopes. There is no admin bypass for reading
  someone else's mail; admin manages the *support mailbox connector*, nothing
  personal.
- **Refresh tokens are encrypted at rest** (AES-256-GCM, key from
  `GOOGLE_TOKEN_ENC_KEY`) and never logged. Access tokens live only in memory.
- **Nothing in this phase may call Google directly except `googleService.ts`**
  (and the calendar/gmail service modules it hands clients to). Routes and
  automations stay Google-free.
- **Invariant 10 applies to the ingest watermark**: compare timestamps inside
  MySQL or compare Gmail's own `internalDate`/`historyId` values — never a
  Drizzle-read TIMESTAMP against `Date.now()`.
- **Tests never talk to Google.** `googleService` exposes an injectable seam
  (test double swapped in like `aiService`'s provider modules); route and
  poller tests run against the double + real MySQL as usual.
- Fail-soft: `isGoogleConfigured()` false (missing client id/secret/enc key) →
  `/api/google/status` says so, UI shows nothing to connect, poller never arms,
  Google tools refuse. The server boots fine.
- Commits: small, conventional, `Co-Authored-By` trailer. `npm test` green in
  `server/` per task; check `$?` directly.

---

### Task 1: Migration 0017 — google tables

**Files:** `server/src/db/schema/google.ts` (new), `schema/index.ts`,
`db/testUtils.ts`, `server/drizzle/0017_google.sql` (+ journal tag)

- [ ] `google_accounts`: `id`, `user_id BIGINT NULL` (NULL = org-level
      connector), `kind ENUM('user','support_mailbox')`, `google_email`,
      `refresh_token_enc VARBINARY(1024)`, `scopes JSON`, `status
      ENUM('active','broken') DEFAULT 'active'`, `connected_by`,
      `connected_at`, `UNIQUE(user_id, kind)`.
- [ ] `gmail_ingest_state`: `google_account_id UNIQUE → google_accounts`,
      `last_internal_date BIGINT` (Gmail ms-epoch watermark — Gmail's clock,
      not ours), `target_channel_id → channels`.
- [ ] `message_email_origins`: `message_id UNIQUE → messages`,
      `gmail_message_id VARCHAR(32)`, `from_addr VARCHAR(320)`,
      `subject VARCHAR(500)`. Plus `UNIQUE(gmail_message_id)` — the second,
      DB-enforced idempotency layer under the watermark.
- [ ] Rename the generated migration, update `meta/_journal.json`, add the
      three tables to `resetDb()` truncation.

### Task 2: Config + token crypto

**Files:** `config.ts`, `server/.env.example`, `server/src/services/googleCrypto.ts` (new)

- [ ] `GOOGLE_TOKEN_ENC_KEY` (optional, 64 hex chars = 32 bytes).
      `isGoogleConfigured()` = id + secret + enc key all present.
- [ ] `encryptToken`/`decryptToken`: AES-256-GCM, random 12-byte IV, layout
      `iv ‖ authTag ‖ ciphertext` in one VARBINARY. Unit-test round-trip and
      tamper rejection (flipped byte → throws, never garbage plaintext).
- [ ] Document key generation in `.env.example`
      (`openssl rand -hex 32`) and set a dev key in `server/.env`.

### Task 3: `googleService.ts` — connection lifecycle

**Files:** `services/googleService.ts` (new), `routes/google.ts` (new),
`app.ts`

- [ ] OAuth client factory + injectable seam: the module talks to Google
      through a small interface (`exchangeCode`, `refreshAccessToken`,
      `revokeToken`, `fetchProfileEmail`); tests inject a fake.
- [ ] `GET /api/google/auth-url?kind=user|support_mailbox` (kind
      `support_mailbox` requires admin). Returns the consent URL with
      `access_type=offline`, `prompt=consent` (a refresh token is only
      guaranteed with consent), scopes per kind: user =
      `calendar.events gmail.readonly gmail.send email`; support_mailbox =
      `gmail.readonly email`. **State is a short-lived signed JWT** carrying
      `{ userId, kind }` — the callback arrives from Google with no
      Authorization header, so state *is* the auth. 10-minute expiry.
- [ ] `GET /api/google/callback` — verify state, exchange code, fetch the
      Google email, encrypt + upsert the `google_accounts` row (re-connect
      replaces the token and clears `broken`), then redirect to
      `/settings?google=connected` (the SPA reads the query param). No JSON
      body — a browser lands here.
- [ ] `DELETE /api/google/connection` — revoke at Google (best-effort; a
      Google-side failure must not strand the row), delete the row, and for
      support_mailbox also delete `gmail_ingest_state` + stop the poller.
- [ ] `GET /api/google/status` → `{ configured, user: {connected, email,
      broken}, supportMailbox (admins only): {...} }`.
- [ ] `authorizedClientFor(accountId)`: decrypt refresh token, build
      OAuth2Client, let it auto-refresh. On `invalid_grant`: mark the row
      `broken`, DM the owner via the bot (copy `routineRunner`'s
      owner-notification pattern), and surface a refusal-shaped error to
      callers — **no crash loop, no retry storm** (a broken row is skipped
      until reconnected).
- [ ] Tests: state tampering → 400; non-admin asking for support_mailbox URL →
      403; callback upserts + encrypts (assert the stored bytes are not the
      plaintext); invalid_grant path marks broken + DMs owner; disconnect
      revokes + deletes.

### Task 4: `calendarService` + routes

**Files:** `services/calendarService.ts` (new), `routes/calendar.ts` (new), `app.ts`

- [ ] `GET /api/calendar/events?from&to` → primary-calendar events in the
      window, normalized `{ id, title, start, end, allDay, attendees, meetLink,
      htmlLink }`.
- [ ] `POST /api/calendar/events { title, start, end, attendees?, description?,
      location? }` → created event (the "Schedule meeting" button passes a
      LiveKit call URL in `location`/`description` — no Meet integration,
      ours is the call product).
- [ ] Both `requireUserAuth`; no connection → 409 with a machine-readable
      `code: 'google_not_connected'` (the UI turns this into the connect
      prompt; 404 would lie — the *feature* exists).
- [ ] Tests with the injected fake: window passthrough, created-event echo,
      not-connected 409, broken-connection 409 with `code:
      'google_connection_broken'`.

### Task 5: `gmailService` + routes

**Files:** `services/gmailService.ts` (new), `routes/gmail.ts` (new), `app.ts`

- [ ] `GET /api/gmail/messages?q&label&pageToken` → list (id, threadId, from,
      subject, snippet, date, unread) via `messages.list` + metadata batch.
- [ ] `GET /api/gmail/messages/:id` → one message with a **sanitized** body:
      prefer text/plain; if only HTML exists, sanitize it server-side with the
      same sanitizer the docs renderer trusts. Gmail bodies are hostile input.
- [ ] `POST /api/gmail/send { to, subject, body }` — plain-text MIME, RFC 2047
      the subject, base64url encode. Send-as the connected address only.
- [ ] Same auth/409 contract as calendar. Tests mirror Task 4's.

### Task 6: Support-mailbox poller + intake exemption

**Files:** `server/src/automations/mailboxPoller.ts` (new), `automations/supportIntake.ts`,
`services/events.ts`, `services/messageService.ts`, `routes/admin.ts`, `index.ts`,
`db/testUtils.ts`

- [ ] `PUT /api/admin/google/support-mailbox { targetChannelId }` — requires a
      connected support_mailbox account and a `kind='support'` channel; upserts
      `gmail_ingest_state` (watermark starts at connect-time `internalDate`, so
      history predating the binding is not ingested) and (re)arms the poller.
      `DELETE` unbinds and stops it.
- [ ] Poller: croner every 2 min, `protect: true`, rebuilt from
      `gmail_ingest_state` at boot (`index.ts`, not `createApp()` — automations
      are not registered by the app factory). Each tick:
      `messages.list(q: after watermark)` → for each new message fetch
      headers + snippet → post a bot-authored message to the target channel
      (`From`, `Subject`, snippet, formatted) → insert `message_email_origins`
      → advance watermark to the max `internalDate` seen. The
      `UNIQUE(gmail_message_id)` insert makes a replayed tick a no-op, so a
      poller restart cannot duplicate (verify criterion).
- [ ] `message.created` payload gains `origin?: 'email'`; the poller posts
      through `messageService` with it. Both bot-guards in `supportIntake`
      become "skip bots **unless** origin is email". Existing debounce and
      budget gates apply unchanged — email triage is still AI spend.
- [ ] Poller test-teardown hook in `resetDb()` (timers outlive truncation —
      the routineScheduler lesson).
- [ ] Tests: email → bot message in channel with origin row; same Gmail id
      twice → one message; watermark advances; intake fires on an
      email-origin bot message and still ignores ordinary bot messages;
      broken mailbox connection → poller skips quietly and does not crash-loop.

### Task 7: Agent tools + scopes

**Files:** `server/src/shared/scopes.ts` (whatever holds the vocabulary),
`services/agentTools.ts`, `services/routineRunner.ts`, `mcp/server.ts` (only if
caller construction lives there), `src/features/admin` + routines scope pickers

- [ ] New scopes: `calendar:read`, `calendar:write`, `gmail:read`,
      `gmail:write`. Shared-file rule: the vocabulary file stays a leaf.
- [ ] `Caller` gains `googleUserId?: number`. `routineRunner` sets
      `routine.ownerId`; MCP sets the token's `created_by`; both keep
      `userId = botUserId` for attribution.
- [ ] Four tools in `AGENT_TOOLS` (defined once — invariant 8):
      `list_calendar_events` (`calendar:read`, unattended), `create_calendar_event`
      (`calendar:write`, unattended — the artifact is visible on the calendar),
      `search_gmail` (`gmail:read`, unattended), `send_gmail` (`gmail:write`,
      **`unattended: false`** — outbound email to arbitrary addresses with
      nobody watching is the exact damage class that flag exists for).
- [ ] No connection / broken / no `googleUserId` → `refusal(...)` with the
      "connect Google in Settings" message, never a throw.
- [ ] Tests: scope gating (a `calendar:read` token cannot create events);
      refusal without a connection; a routine owned by a connected user reaches
      the fake calendar; `send_gmail` absent from `toolsForScopes(...,
      { unattendedOnly: true })`.

### Task 8: Frontend — Connect Google card (/settings)

**Files:** `src/features/settings/` (wherever /settings lives), `lib/api.ts`

- [ ] Card shows status: not configured (hidden entirely) / not connected
      (Connect button → `auth-url` → full-page redirect) / connected (email,
      Disconnect) / broken (amber "reconnect" state — same button, `prompt=
      consent` re-issues the token).
- [ ] Handle the `?google=connected` return param (toast + status refetch).
- [ ] Admin-only second card for the support mailbox: connect, pick target
      support channel, unbind.

### Task 9: Frontend — /calendar agenda + entry points

**Files:** `src/features/calendar/` (new), router, channel header, task detail

- [ ] `/calendar`: agenda list grouped by day (this week default, prev/next
      paging). Not-connected state renders the connect prompt (the 409 code
      from Task 4), never an error boundary.
- [ ] "New event" form (title, start/end, attendees, description).
- [ ] Channel header "Schedule meeting": prefills title `#channel sync` and
      description with a `/call/<room>` LiveKit link.
- [ ] Task detail "Add to calendar": prefills from title + due date, link back
      to the task in the description.

### Task 10: Frontend — Gmail inbox panel

**Files:** `src/features/gmail/` (new), router/sidebar

- [ ] Inbox list (from, subject, snippet, date, unread weight; search box → `q`;
      pagination via pageToken) + reading pane rendering the sanitized body.
- [ ] Compose (to/subject/body) using `POST /send`.
- [ ] Same graceful not-connected state as /calendar.

### Task 11: Verification pass

- [ ] `npm test` (server), `npm run build` both sides, `npx oxlint` — all green.
- [ ] **Browser pass with real Google** (playwright-core driving
      `/usr/bin/google-chrome` — the established local pattern): connect →
      agenda shows real events → create event → appears in Google Calendar with
      the call link working → Gmail panel lists real inbox → send a mail to
      self → arrives → disconnect revokes (re-connect forces consent again).
- [ ] Support-mailbox path with a real mail: send email to the mailbox → bot
      message in the support channel → AI files a ticket (needs a triage
      provider key) → restart server → no duplicate ingest.
- [ ] Revoke the refresh token from Google's security page → next poll/API call
      marks the connection broken + DMs the owner, no crash loop.
- [ ] Update `CLAUDE.md` current-state + `README.md`; note that Phase 13 picks
      up `googleService.authorizedClientFor` as its base.
