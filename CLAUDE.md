# CLAUDE.md

Guidance for Claude Code working in this repository. `README.md` documents the
product; this file covers what you need to know before changing it.

## What this is

A React 19 + Vite SPA (repo root) and an Express 5 + Socket.IO API (`server/`),
sharing one MySQL 8 database through Drizzle. Capacitor wraps the SPA for
iOS/Android. `docs/MASTER-PLAN.md` defines phases 0–13 and is the authority on
scope and order.

## Where things are

| Path | What |
|---|---|
| `src/` | SPA. `features/<area>/` per domain (chat, kanban, docs, notes, admin, calls, files), `components/ui/` is shadcn. |
| `server/src/routes/` | HTTP surface. One file per area; every router carries an explicit auth gate. |
| `server/src/services/` | All business logic. Routes validate and delegate; services never import express. A service that may need to join a caller's transaction takes a trailing `exec: Executor = db` (from `db/index.ts`) and uses it for every query — see `createChannel` / `upsertSupportConfig`. |
| `server/src/shared/` | The few definitions the SPA needs verbatim (currently the scope vocabulary). Reached from the client via the `@shared/*` alias, so **these files must stay leaves with no imports** — anything they import follows them into the browser bundle. |
| `server/src/mcp/` | The MCP endpoint. A thin adapter over `services/agentTools.ts` — no business logic here, ever. |
| `server/src/automations/` | Event-bus listeners (support intake, ticket-status announcements). Registered in `index.ts` at boot, **not** in `createApp()`. |
| `runner/` | The script sandbox — a **separate service**, and the only thing that executes user-written code. No database credentials; talks to the API over `RUNNER_TOKEN` and, in production, has no other egress. |
| `server/drizzle/` | Migrations. Rename generated files to describe them (`0011_api_tokens.sql`) and update `meta/_journal.json` to match. |
| `docs/superpowers/plans/` | Per-phase plans written before the work. Read the relevant one before starting a phase. Name them `<date>-phase<N>-<slug>.md` **only** when `<N>` is that phase's number in `docs/MASTER-PLAN.md`; anything else (a hardening pass, a design spike) gets a descriptive name and no number. |

## Commands

```bash
# server (from server/)
npm test                  # vitest + supertest against a real MySQL — 287 tests, 60 files
npx vitest run src/routes/notes.test.ts   # one file
npm run build              # tsc
npm run db:generate        # drizzle-kit generate, then rename the file + journal tag
npm run db:migrate
npm run dev                # tsx watch on :4000

# web (from the repo root)
npm run build              # tsc -b && vite build
npx oxlint                 # the whole repo's linter
```

`npx oxlint` is the only linter. **Do not run `npx prettier --write`** — the repo has
no prettier config, so prettier reformats every file to its own defaults (double
quotes) and produces thousands of lines of noise. This has already happened once.

## Invariants — do not work around these

1. **Invisible means 404, never 403.** If you cannot see it, the API behaves as
   though it does not exist. The one exception: a project you can see but are not a
   member of gets 403 on mutation. Every new list endpoint must reuse the
   centralized visibility SQL in `projectService`/`channelService`.
2. **Notes are private to their owner and out of AI reach.** There is no service-token
   scope for notes and there must never be one; `notesRouter` and the admin
   note-transfer endpoints use `requireUserAuth`, which refuses token auth outright
   (401 — no scope could fix it). A note attachment must be owner-only *including
   from admins*.
3. **Every endpoint carries an explicit auth gate.** `requireScope(...)` for the agent
   surface (tickets/chat/docs), `requireUserAuth` for everything else. Adding a route
   without one silently grants service tokens access.
4. **Service tokens act as bot users**, validated at creation. Hash at rest, plaintext
   shown once, revoked-not-deleted.
5. **Files inherit their parent's visibility** — `GET /api/files/:id` resolves the
   message/task/doc and applies that parent's rule.
6. **Uploads are verified against their bytes**, not the declared MIME type.
7. **AI triage costs money, so it goes through `aiBudgetService`.** Every dispatched
   triage writes an `ai_usage` row with its token counts, and `checkAiBudget()` gates the
   next one (`AI_MIN_INTERVAL_MS` per channel, `AI_DAILY_CALL_CAP` per day). Any future
   paid AI call — routines, the script runner — belongs behind the same gate.
8. **Agent tools are defined once — `services/agentTools.ts`**, with their
   authorization in `services/access.ts` (shared with the socket handlers). The MCP endpoint and AI Routines are
   both thin adapters over that registry: MCP registers the zod shape, routines
   derive JSON Schema from it. Adding a tool to one surface only is how the two
   drift apart. `unattended: false` withholds a tool from routines — a routine
   runs with nobody watching, an MCP client has a person driving it.
   `services/access.ts` answers "visible, then member" for every non-REST surface.
   The **routes deliberately do not use it**: they need the 404-vs-403 distinction,
   which means checking visibility and membership as two steps that throw.
9. **User-written code never runs in the API process.** Scripts are queued; the
   `runner/` service claims them and executes each in a scratch dir as a child
   process with a SIGKILL timeout and a `ulimit -v` memory cap, holding a token
   minted for that run alone and revoked when it ends. Anything that would
   execute user input belongs behind that boundary, not in `server/`.
10. **Compare timestamps inside the database, not across the JS boundary.** Drizzle maps
   a MySQL TIMESTAMP back through UTC, so a `defaultNow()` column read into JS is off by
   the host's UTC offset — invisible on a UTC server, eight hours wrong on a Manila
   workstation. Use `NOW()` / `CURDATE()` in the query, as `aiBudgetService` does.

## Testing conventions

- `resetDb()` from `src/db/testUtils.ts` truncates every table, clears the uploads
  directory, and resets in-memory state that outlives a truncation. If you add
  process-level caches keyed by row id, reset them there — truncation reuses ids and
  a stale cache entry will suppress the behaviour you are testing.
- `makeUser(app, { admin: true })` from `src/testHelpers.ts` registers and returns a
  token.
- Automations are not registered by `createApp()`. A test that expects an
  event-driven side effect must call `registerTicketStatus()` (or the relevant
  register function) itself, and the effect is fire-and-forget — wait for it.
- Files named `*.test.ts` are real suites here; `npm test` is a meaningful gate.

## Current state (2026-08-06)

**Phases 0–8 are complete.** Phase 8 (service tokens + MCP) shipped in commits
`dbc3089`, `5b1e010`, `a984695`, verified end to end against the running dev server.

**Phase 9 is in progress — steps 1–3 of 4 are done** (2026-08-06). Notes are full rich
documents: TipTap 3 storing ProseMirror JSON, images as attachments, `format` validated
server-side. Verified end to end in a real browser, not only by tests.

- **Note attachments** — `POST /api/notes/:id/attachments`, and the `noteId` branch in
  `files.ts` is **owner-only with admins deliberately excluded** (see invariant 2).
  Deleting a note now deletes its stored objects, and converting one to a doc re-points
  its attachments instead of orphaning them.
- **Rich editor** — `src/features/notes/RichNoteEditor.tsx`. StarterKit v3 already
  bundles Link and Underline; adding either separately registers a duplicate extension
  name and throws at mount. Only `Image` and `TableKit` are extra.
- **`format`** — `markdown` (every pre-existing note, a read path only) or `rich`. The
  API refuses `rich` content that is not a ProseMirror document.

### Next step

4. **Sheets** (Univer via `@univerjs/presets`, lazy-loaded route, snapshot JSON as the
   storage contract, lock service) and **office previews** (SheetJS grid, mammoth for
   docx with sanitize, PDF iframe) — see `docs/MASTER-PLAN.md` Phase 9. Nothing for this
   step exists yet. Lazy-load it: TipTap already took the Notes chunk to ~450 kB, and
   Univer is heavier again.

### Rich notes — three traps, all found by running the app

- **An image src cannot be a URL.** `GET /api/files/:id` needs an `Authorization`
  header and `<img>` sends none, so images are stored as `fs-attachment:<id>` and
  swapped for object URLs on load. `richDoc.ts` does the swap in both directions;
  storing the object URL instead would look fine until reload.
- **StrictMode double-mounts.** A "load once" ref that survives the unmount leaves the
  first run cancelled and the second skipped — a saved note opens *blank*, with no
  error, because nothing failed. Clear the guard in the effect's cleanup.
- **Toolbar buttons must not take focus.** Without `onMouseDown` preventDefault the
  button steals the selection, and the next thing typed goes to the button rather than
  the note.

### Open items

- **Phase 7 review is closed** as of 2026-08-06 — every Critical, Important and actionable
  Minor is fixed, and `docs/PHASE7-PENDING-FIXES.md` tags each one with its verified state.
  Two things are kept deliberately, with reasons recorded there: `isAiConfigured()`, and
  the debounce test's real timers.
- **Deferred by the user:** iOS/Android native push (needs `google-services.json`,
  `GoogleService-Info.plist`, an APNs `.p8`) and the native apps generally — web
  first.
- **Recovered file:** a corrupt `e2e-smoke.mjs` (not written by me) broke repo-wide
  lint and was moved out of the tree rather than deleted. If it mattered, it is in the
  job's tmp directory as `recovered-e2e-smoke.mjs`.

### A trap worth remembering

`npm audit fix --omit=dev` prunes devDependencies and breaks both builds (152 tsc
errors, missing `@types/node`). Recover with a plain `npm install`.
