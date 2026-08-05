# Phase 5: Hardening, Gaps & Optimization (+ Teleconferencing Readiness) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the two confirmed bugs found by end-to-end testing (Part 0), close the security and data-integrity gaps found in a source review of phases 1–4, fix the known performance hot spots, and lay the groundwork for the master plan's teleconferencing feature — without changing any product behaviour users can see, except where a task says so.

**Order:** Part 0 ships first and alone. The rest is prevention and can be sequenced freely.

**Grounding:** Findings reference actual code (file:line as of `a26a7fc`). Part 0 was reproduced against a running server (48-check REST + Socket.IO pass, 2026-08-05); the other parts come from reading every route and service. Security tasks follow the official Express *Production Best Practices: Security* checklist (helmet, fingerprinting, cookie flags, brute-force limits, dependency audit — expressjs.com/en/advanced/best-practice-security.html, checked 2026-08-05). Teleconferencing constraints verified against LiveKit docs and Apple/Capacitor WKWebView getUserMedia support (iOS ≥ 14.3).

## Global Constraints (unchanged from phases 1–4)

- **Invisible → 404, never a leaked 403.** Every new authorization path keeps the existence-hiding rule.
- Continue the `parseId()` helper convention; never chain two `validate()` calls on one route.
- Commits: small, conventional (`feat(server): …` / `fix(web): …`), end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Every task ends with `npm test` green in `server/`; check `$?` directly — never pipe `tsc`/`npm test` through `tail` inside a `&&` chain.
- New behaviour gets a test in the same task, colocated `*.test.ts` as everywhere else.

---

## Part 0 — Confirmed bugs: FIX FIRST

Two defects, both **reproduced against a running server** on 2026-08-05 and both
currently on `main`. Everything else in this plan is prevention; these two are
live. Do this part before Part A, in its own PR, so the fixes are reviewable
without hardening noise.

The other 45 end-to-end checks passed — auth (including refresh rotation and
reuse-kills-the-family), channel visibility and the 404 rule, messaging,
reactions, fulltext search, DM idempotency, kanban fractional reordering,
notes isolation, the admin gate and self-modify guard, socket auth and live
delivery. So this is a short list on purpose, not a shallow pass.

### Task 0.1: `convert-note-to-doc` writes into projects the caller cannot see (SECURITY)

**Reproduction:** as a plain member, `POST /api/notes/:id/convert-to-doc` with a
`projectId` belonging to another user's **private** project returned `201` and
wrote the doc. Expected `404`.

**Cause:** `noteService.convertNoteToDoc` (route `notes.ts:76`) calls
`createDoc({ projectId, … })` with **no** `getVisibleProject` check. Every other
doc-creation path guards first — `projects.ts` POST `/:id/docs` uses
`requireVisibleProject`; `docsRouter` uses `requireVisibleDoc`. This single path
was missed, so it is an inconsistency bug, not a design decision.

**Extra weight:** `notes.ts:16` documents notes as *"strictly personal and stay
out of AI/automation reach"*. This lets personal note content land in a project
whose members the author cannot even enumerate.

- [ ] In the route (not the service — keep visibility checks at the HTTP edge as
      the other routers do), resolve the target project with `getVisibleProject`
      before converting; invisible → `AppError(404, 'not_found')`. Once Task B2
      lands, require membership too and keep 404 for invisible / 403 for
      visible-but-not-member.
- [ ] The note must survive a rejected conversion — today `convertNoteToDoc`
      deletes the note **after** creating the doc, so an early 404 is safe, but
      assert it: failed convert leaves the note intact.
- [ ] Tests (`routes/notes.test.ts`): member → another user's private project =
      404 **and** no `docs` row created; member → visible project = 201 and the
      note is gone (existing happy path stays green).

### Task 0.2: `POST /api/dms` with an unknown user 500s and orphans a channel

**Reproduction:** `POST /api/dms { userId: 999999 }` → `500 internal`. Server
log: `Cannot add or update a child row: a foreign key constraint fails
(channel_members.user_id → users.id)`.

**Cause:** `channelService.findOrCreateDm` inserts the `channels` row first, then
`addChannelMember` for each side. The FK violation happens on the **second**
statement, so the DM channel row is already committed — every failed call leaks a
memberless `dm:` channel, and its `dm_key` is now taken, which would poison a
later legitimate DM if the ids were ever reused.

- [ ] Validate the target user in the route: exists **and** `isActive` (a
      deactivated colleague is not DM-able) → otherwise `404`. Reject
      `userId === req.auth.userId` (self-DM) with a `400`.
- [ ] Wrap the channel + both member inserts in one `db.transaction(...)` so a
      failure leaves no orphan row, regardless of which statement fails.
- [ ] Tests (`routes/dms.test.ts`): unknown user = 404 and `channels` count
      unchanged; deactivated user = 404; self = 400; existing
      create-then-idempotent path stays green.

### Task 0.3: Keep the end-to-end check as a regression suite

The two bugs above were invisible to 76 passing unit/route tests because each
lived in a *cross-feature* path (notes → projects, DMs → users). That gap is
worth closing permanently.

- [ ] Port the ad-hoc smoke script into `server/src/routes/crossFeature.test.ts`
      (supertest, same `resetDb()` harness as the other suites): the two bug
      reproductions plus the cross-feature paths — note→doc into a visible
      project, DM lifecycle, attachment linked to a task then fetched via
      `/api/files/:id`, and a non-member's view of a public project.
- [ ] It must fail if either Part 0 fix is reverted.

---

## Part A — Security

### Task A1: Baseline HTTP hardening (helmet, fingerprinting, trust proxy)

**Findings:** No security headers at all; `x-powered-by: Express` visible in every response (`app.ts` sets nothing). `trust proxy` is unset, so behind the ALB `express-rate-limit` keys every client on the ALB's address — one shared bucket — and `req.ip` in logs is wrong.

- [ ] `npm i helmet`; in `createApp()`: `app.use(helmet())` with CSP disabled for the API (JSON only) but `noSniff`, `frameguard`, `hsts` (prod only) on; `app.disable('x-powered-by')`.
- [ ] `app.set('trust proxy', 1)` gated on `NODE_ENV === 'production'` (one hop: the ALB), and add `TRUST_PROXY` to config so it's explicit.
- [ ] Test: response to `/health` carries `X-Content-Type-Options: nosniff` and no `X-Powered-By`.

### Task A2: File serving — verify content, stop trusting the client's MIME

**Findings:** `uploads.ts:12-15` — multer's `fileFilter` whitelists on `file.mimetype`, which is **client-declared**. An HTML payload labelled `image/png` is stored and later served by `files.ts:47-50` with `Content-Type: image/png` and `Content-Disposition: inline` — and there is no `nosniff` today (A1 adds it). Also `files.ts:49`: `filename="${attachment.fileName}"` interpolates the raw upload name into the header; a `"` in a filename breaks the header (Node blocks `\r\n`, so no full injection, but malformed/spoofable download names).

- [ ] `npm i file-type content-disposition`. In `createUnlinkedAttachment`, sniff magic bytes with `file-type` and require the sniffed type to match the whitelist **and** the declared type's family; reject on mismatch (`unsupported_mime`). csv/plain-text types (no magic bytes) are exempt from sniffing but must not sniff as anything executable.
- [ ] `files.ts`: build the header with `contentDisposition(attachment.fileName, { type: inlineable ? 'inline' : 'attachment' })` where `inlineable` = images + pdf only; everything else downloads as `attachment`.
- [ ] Add `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff` on the file response itself (defense in depth for the inline path).
- [ ] Tests: spoofed-MIME upload rejected; quote-bearing filename produces a valid RFC 6266 header; docx serves as `attachment`, png as `inline`.

### Task A3: Stop logging bearer tokens

**Finding:** `app.ts:25-31` — `pino-http` logs `req.headers` with its default serializer; every authenticated request writes `authorization: Bearer <access token>` into the log stream (visible in `/tmp/fs-internal-boot.log` from any authed request). 15-minute tokens, but logs outlive them.

- [ ] Configure pino redaction: `redact: ['req.headers.authorization', 'req.headers.cookie']` on the logger (or a custom `serializers.req` that drops them).
- [ ] Test: a logged request's serialized output does not contain the token.

### Task A4: Rate-limit the unprotected write paths

**Findings:** `rateLimit.ts` defines one limiter, used only on `/register` + `/login` (`auth.ts:23,28`). `/api/auth/refresh` is unlimited (each call costs a DB lookup + family-revocation write path); `/api/uploads` is unlimited (20 MB × 10 files per request, unbounded requests → disk-fill); socket `message:send` is unlimited (spam floods every channel member in real time).

- [ ] Add `refreshLimiter` (per-IP, generous — e.g. 60/15 min) on `/refresh` and `/logout`; add `uploadLimiter` (e.g. 30/15 min) on `POST /api/uploads`.
- [ ] Socket: token-bucket per connected socket (e.g. 10 messages / 10 s, burst 10) inside `message:send`; over-limit gets `ack({ ok:false, error:'rate_limited' })`, never a disconnect.
- [ ] Tests: 61st refresh within the window → 429; flooding `message:send` acks `rate_limited`.

### Task A5: Socket authorization must not outlive the credentials

**Findings:** `authMiddleware.ts` verifies the JWT **once at handshake**. A connected socket then: (1) outlives access-token expiry indefinitely, (2) survives user deactivation and role demotion, (3) keeps receiving a private channel's messages after being removed from it — `socket.join('channel:N')` (`chatHandlers.ts:27`) is never revoked until reconnect.

- [ ] At handshake, store `exp` on `socket.data`; schedule a disconnect at expiry with a small grace window. The client's socket auth callback (`src/lib/socket.ts:16-18`) already supplies the fresh token on reconnect, so the UX is one silent reconnect per 15 min.
- [ ] On channel-member removal (channelService) and on user deactivation (admin route), emit through the existing `user:{id}` room: `io.in('user:'+userId).socketsLeave('channel:'+channelId)` / `io.in('user:'+userId).disconnectSockets()`.
- [ ] Tests: expired-token socket is disconnected; removed member's socket stops receiving `message:new` for that channel without a reconnect.

### Task A6: Web refresh-token storage — decide and document

**Finding:** `src/lib/storage.ts:21` keeps the 30-day refresh token in `localStorage` on web (Capacitor `Preferences` on native, fine). Any XSS = 30-day account takeover. The mitigations (A1/A2) reduce XSS surface; the structural fix is an httpOnly cookie flow for web.

- [x] **Decision (2026-08-05): (b) for now — keep localStorage, documented, and revisit with the same-origin change below.** Recorded in the README's security section. Two things came out of the spike that the plan did not know:

  1. **(a) cannot work in dev as the app is currently served.** The SPA runs on `localhost:5173` and the API on `localhost:4000` — different origins, so a `SameSite=Strict|Lax` cookie is never sent. Making it work requires `SameSite=None; Secure`, i.e. HTTPS on localhost, or a **Vite dev proxy** (`/api` → `:4000`) so dev is same-origin like production. The proxy is the right answer, but it changes how everyone runs the app locally and how `VITE_SERVER_URL`/the socket URL are resolved — that is the owner's call, not a side effect of a hardening pass.
  2. **The XSS surface is smaller than assumed.** There is exactly one HTML-rendering path (`src/features/docs/Markdown.tsx`), it runs `rehype-sanitize`, and there is no `dangerouslySetInnerHTML` anywhere in `src/`. Combined with helmet + `nosniff` + the sandboxed file CSP (A1/A2) and the fact that uploads can no longer masquerade as HTML, the token is not sitting behind an open door.

  Native is already correct: Capacitor `Preferences` is backed by the Keychain / EncryptedSharedPreferences, so mobile is unaffected either way.

- [ ] **Follow-up (needs an owner decision, not blocked on code):** add the Vite `/api` dev proxy, then move web refresh to `httpOnly; Secure; SameSite=Strict; Path=/api/auth`, keeping the body-token flow for native. Tests: cookie rotation, and family revocation on reuse (`tokenService.ts` semantics stay as they are — they are already correct).

### Task A7: Upload API must report what it rejected

**Finding:** `uploads.ts:12-15` — `fileFilter` silently drops non-whitelisted files; a mixed batch returns `201` listing only survivors. The composer shows chips for what came back, so a user who attached 3 files and got 2 chips has no idea why.

- [ ] Collect rejected filenames via the `fileFilter` callback closure; include `rejected: [{fileName, reason}]` in the 201 body; surface it in the composer (`src/lib/uploads.ts` + composer component) as a toast.
- [ ] Test: batch of one valid + one spoofed returns the valid attachment and names the rejected file.

## Part B — Correctness & data integrity

### Task B1: Storage objects leak when parents are hard-deleted

**Finding:** `schema/files.ts` — `messageId/taskId/docId` FKs cascade on delete, so deleting a task/doc removes the **rows** but nobody deletes the **storage objects** (`attachmentService.gcUnlinkedAttachments` only sweeps never-linked rows). Messages soft-delete so they rarely trigger it, but task/doc deletion orphans blobs forever — on S3 that's money, on local disk it's the fs_tools 96%-disk story again.

- [ ] In the task/doc delete services: fetch linked attachment storage keys first, delete the parent (cascade removes rows), then delete the storage objects; log failures without failing the request.
- [ ] Add a weekly orphan sweep to the GC interval: list `uploads/` keys (local driver: readdir; S3: paginated ListObjectsV2) minus known `storageKey`s → delete. Guard the whole GC with MySQL `GET_LOCK('fs_gc', 0)` so a future multi-instance deploy doesn't double-sweep (`index.ts:17-22` runs it in every process today).
- [ ] Test: deleting a task removes its attachment rows **and** the local storage files.

### Task B2: Members-only mutation for tasks/docs (flagged fast-follow)

**Finding:** Phase 3's own plan notes (line 2247) that any project **viewer** can create/edit tasks and docs in v1 and calls tightening it "a reasonable fast-follow".

- [ ] Add `isProjectMember` checks to task/doc/column mutation routes (admins bypass); viewers keep read access. Invisible stays 404; visible-but-not-member gets 403 here (it's not an existence leak — they can already see the project).
- [ ] Update the SPA to hide mutation affordances for non-members (query already returns membership).
- [ ] Tests: viewer PATCH → 403; member PATCH → 200.

### Task B3: Graceful shutdown

**Finding:** `index.ts` has no signal handling; ECS/PM2 SIGTERM kills in-flight requests and never drains sockets or the pool.

- [ ] On SIGTERM/SIGINT: `server.close()`, `io.close()`, clear the GC interval, `pool.end()`, exit; 10 s hard deadline.

### Task B4: Keep the admin password out of shell history

**Finding:** `scripts/seedAdmin.ts` takes the password as argv.

- [ ] Accept `SEED_ADMIN_PASSWORD` env (preferred) with argv fallback + a warning.

## Part C — Performance

### Task C1: `getUnreadCounts` is N+1

**Finding:** `messageService.ts:152-170` runs one `COUNT(*)` query **per channel membership** on every unread poll — the most frequently hit query in the app scales linearly with channel count.

- [ ] Replace with one query: `channel_members JOIN messages ON channel_id AND id > last_read_message_id AND deleted_at IS NULL WHERE user_id = ? GROUP BY channel_id`.
- [ ] Test asserts identical output to the old implementation on seeded data.

### Task C2: Index audit for the hot paths

- [ ] Verify/add via migration 0007: `messages (channel_id, id)` (serves `getMessagesBefore` and the unread join; the FK index on `channel_id` alone stops helping once `lt(id)` kicks in), and confirm `refresh_tokens.token_hash` and `attachments.message_id/task_id/doc_id` are indexed (FK-created). `EXPLAIN` before/after in the task notes.

### Task C3: Split the web bundle

**Finding:** `vite build` warns: main chunk > 500 kB. Everything — all eight features plus `react-markdown`/`remark-gfm` — ships on the login screen.

- [ ] `React.lazy` per route group in `src/app/router.tsx` (chat, projects, notes, admin) with a suspense fallback; lazy-import the markdown renderer inside the doc/message components that use it.
- [ ] Acceptance: build warning gone; initial JS < 250 kB gz; `npm run build` output pasted into the task notes.

### Task C4: Response compression

- [ ] Decide once: enable nginx/ALB gzip in front (preferred — document in README), or `npm i compression` and mount it before the routers. Message-list JSON is the payload that matters.

*(Deferred, noted for later: message-list virtualization — their own Phase 2 plan already flags `flex-col-reverse` as the v1 simplification; don't touch it until history length actually hurts.)*

## Part D — Delivery & operations

### Task D1: Write the real README

**Finding:** `README.md` is the stock Vite template; the only orientation is inside four phase plans.

- [ ] Document: what the system is, architecture map (SPA / server / DB / storage / sockets), local setup (DB names, `fs_app` user, `.env`, migrations, `seed:admin`), run/test commands, env-var reference (config.ts is the source of truth), the 404-not-403 rule, and the deploy shape (PM2/Docker).

### Task D2: CI (tests only — no deploy target required)

- [ ] GitHub Actions: oxlint, `tsc -b` (web), `tsc` (server), server vitest against a `mysql:8` service (`fs_internal_system_test`), `npm run build` (web), plus `npm audit --omit=dev --audit-level=high` per the official Express checklist. Public repo → free minutes; this is a test runner, not a deploy.

### Task D3: One-command dev environment

- [ ] `docker-compose.dev.yml` (mysql:8 + memcached) matching `.env.example` defaults, referenced from the new README. The initial commit message mentions a dev compose that is no longer in the tree.

## Part E — Teleconferencing readiness (master-plan feature)

Not building calls in this phase — de-risking them, since the master plan includes teleconferencing.

**Recommendation: self-hosted LiveKit** (Apache-2.0 SFU, single Go binary/Docker, `livekit-server --dev` for local). Fit with this codebase:

- **Auth model matches ours.** LiveKit grants access via short-lived JWTs minted by *our* server — so a `POST /api/channels/:id/call-token` endpoint reuses `getVisibleChannel()` and the 404 rule verbatim; room name = channel id. No second user database.
- **Official React components** (`@livekit/components-react`) drop into the SPA; official Swift/Android SDKs exist if the webview path ever falls short.
- **Capacitor path is viable but has sharp edges** (verified against Apple/Ionic docs): WKWebView supports `getUserMedia` from iOS 14.3; requires `NSCameraUsageDescription`/`NSMicrophoneUsageDescription` in Info.plist; iOS re-prompts for permission per `getUserMedia` call pre-iOS 15 (iOS 15+ adds an API to keep the grant); Android webview needs a runtime-permission bridge. Server must be HTTPS.

### Task E1: Spike (timeboxed)

- [ ] `livekit-server --dev` locally; token endpoint behind `getVisibleChannel`; `<LiveKitRoom>` in a hidden route; two browsers in one channel call. Deliverable: a `docs/superpowers/plans/` design doc for the real phase, including the Capacitor permission matrix tested on one physical iPhone + one Android device, and a fallback decision point (Jitsi iframe embed) if webview audio quality disappoints.

---

## Explicitly accepted as-is (so nobody "fixes" them silently)

- HS256 single-secret JWTs — fine for a single-issuer internal system; revisit only if a second service must verify tokens.
- `/health` is unauthenticated and reports DB state — wanted for load-balancer checks.
- `memcache` client is optional/no-op by design (`lib/cache.ts`); wire real caching only when a measured hot spot appears.
- Refresh-token family revocation (`tokenService.refreshSession`) is correct — reuse kills the family. Don't restructure it while doing A6.
