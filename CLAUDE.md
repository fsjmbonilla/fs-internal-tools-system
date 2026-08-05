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
| `server/src/services/` | All business logic. Routes validate and delegate; services never import express. |
| `server/src/mcp/` | The MCP endpoint. Thin wrappers over services — no business logic here, ever. |
| `server/src/automations/` | Event-bus listeners (support intake, ticket-status announcements). Registered in `index.ts` at boot, **not** in `createApp()`. |
| `server/drizzle/` | Migrations. Rename generated files to describe them (`0011_api_tokens.sql`) and update `meta/_journal.json` to match. |
| `docs/superpowers/plans/` | Per-phase plans written before the work. Read the relevant one before starting a phase. |

## Commands

```bash
# server (from server/)
npm test                  # vitest + supertest against a real MySQL — 252 tests, 55 files
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

## Current state (2026-08-05)

**Phases 0–8 are complete.** Phase 8 (service tokens + MCP) shipped in commits
`dbc3089`, `5b1e010`, `a984695`, verified end to end against the running dev server.

**Phase 9 is in progress** — Sheets (Univer) + office previews + notes as full rich
documents. Done so far: migration `0012_notes_rich_format` (notes.content widened to
MEDIUMTEXT, `format` enum added, applied to dev). Nothing reads `format` yet.

### Next steps, in order

1. **Note attachments.** `attachments.note_id` and `attachmentService` already support
   a note parent (migration 0010), but there is no route to link one and `files.ts`
   has no `noteId` branch — so an image inside a note would 404. Add both, and make
   the file branch **owner-only, admins excluded** (this is the one place where admin
   reach is deliberately narrower than everywhere else, because the admin can already
   transfer notes without reading them).
2. **Rich editor.** TipTap 3 (`@tiptap/react` + `starter-kit`, plus image/link/table
   extensions) storing ProseMirror JSON with `format: 'rich'`. `NoteEditor` in
   `src/features/notes/NotesPage.tsx` is the markdown textarea to replace; keep the
   markdown render path for existing notes. Never store HTML.
3. **Server support** for `format` in the notes create/patch schemas, validating that
   rich content parses as a ProseMirror doc.
4. **Sheets** (Univer via `@univerjs/presets`, lazy-loaded route, snapshot JSON as the
   storage contract, lock service) and **office previews** (SheetJS grid, mammoth for
   docx with sanitize, PDF iframe) — see `docs/MASTER-PLAN.md` Phase 9.

### Open items

- **Rotate three credentials.** The OpenAI key, Pusher secret, and Firebase
  service-account were pasted in plaintext into a chat session. They live only in
  gitignored `.env` files, but they should be rotated. The service-account JSON is
  still in the working tree at the repo root.
- **Phase numbering collision.** `docs/superpowers/plans/2026-08-05-phase5-*` and
  `-phase6-*` are my hardening and teleconferencing docs, but the master plan assigns
  5 = push and 6 = teleconferencing (both already built). Renumbering is unresolved.
- **Two Phase 7 leftovers**: `intakeColumnId` is not validated against its
  `projectId`, and there is an inert `PUT` on a standard (non-support) channel.
- **Deferred by the user:** iOS/Android native push (needs `google-services.json`,
  `GoogleService-Info.plist`, an APNs `.p8`) and the native apps generally — web
  first.
- **Recovered file:** a corrupt `e2e-smoke.mjs` (not written by me) broke repo-wide
  lint and was moved out of the tree rather than deleted. If it mattered, it is in the
  job's tmp directory as `recovered-e2e-smoke.mjs`.

### A trap worth remembering

`npm audit fix --omit=dev` prunes devDependencies and breaks both builds (152 tsc
errors, missing `@types/node`). Recover with a plain `npm install`.
