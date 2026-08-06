# FS Internal System — documentation

Internal ops platform for flowerstore.ph (domains: flowerstore.ph, potico.ph, potico.co.th).
Vite + React 19 + TypeScript frontend, Capacitor 8 for iOS/Android, Express 5 + Socket.IO +
Drizzle ORM (MariaDB local / MySQL 8 prod) backend in `server/`, Dockerized for AWS ECS.

## Start here

| Document | What it is |
| --- | --- |
| [LOCAL-SETUP.md](LOCAL-SETUP.md) | How to get running on a fresh machine: DB creation, `server/.env` contents, migrations, seeds, PM2, and what's expected to fail. |
| [MASTER-PLAN.md](MASTER-PLAN.md) | The overall product spec and phase roadmap (Phases 0–13): features, database schema, API surface, socket events, and cross-phase risks. The source of truth for *what* we're building. |
| [PHASE7-PENDING-FIXES.md](PHASE7-PENDING-FIXES.md) | Whole-branch review of Phase 7, kept as a record. Every Critical and Important is fixed as of 2026-08-06; what remains is frontend and ops. Each item is tagged with its verified state. |
| [superpowers/plans/](superpowers/plans/) | Per-phase implementation plans (task-by-task, TDD, with exact code). Written before each phase, kept afterwards as a record of what was built and why. **Numbering:** `<date>-phase<N>-<slug>.md` only when `<N>` matches a MASTER-PLAN phase; a hardening pass or design spike gets a descriptive name and no number. |

## Phase status

| Phase | Feature | Status |
| --- | --- | --- |
| 1 | Auth, admin, departments | Merged |
| 2 | Messaging + Slack-style UI | Merged |
| 3 | Projects, kanban, docs, personal notes | Merged |
| 4 | File uploads & attachments | Merged |
| 5 | Push notifications (FCM) | Merged |
| 6 | Teleconference (self-hosted LiveKit) | Merged |
| 7 | AI support channels (ticket-through-chat) | Merged (`b2b9bc9`), post-review fixes applied |
| 8 | Service-token API + MCP server | Merged — verified end to end against the dev server |
| 9 | Native Sheets + office previews | **In progress** — migration `0012_notes_rich_format` applied; nothing reads `format` yet |
| 10–13 | Python script runner, AI Routines, Google Calendar/Gmail, Drive | Not started |

Off-roadmap work, deliberately unnumbered: [hardening & optimization](superpowers/plans/2026-08-05-hardening-optimization.md)
(cross-cutting pass over phases 1–4) and the superseded
[teleconferencing design](superpowers/plans/2026-08-05-teleconferencing-livekit-design.md).

## Conventions worth knowing before contributing

- **Privacy rule:** anything a user can't see returns **404, never 403** — so the API never leaks
  the existence of a private channel, project, or note. Visibility is centralized in
  `channelService.visibilityCondition()` / `projectService.visibilityCondition()`; reuse those
  rather than writing new WHERE clauses.
- **Personal notes are owner-only** — 404 for everyone else including admins, and deliberately
  unreachable by service tokens or AI.
- **Drizzle: core query builder only.** Never use the relational API (`db.query.*`) — it emits
  `LEFT JOIN LATERAL`, which MariaDB doesn't support, and local dev runs on MariaDB.
- **Migrations** are generated (`npm run db:generate`), never hand-written, and applied with
  `npm run db:migrate`. MySQL/MariaDB have no transactional DDL, so dry-run on a scratch DB.
- **Third-party SDKs: verify against the installed package, not the docs.** This project has been
  bitten repeatedly by plausible-but-wrong API assumptions (firebase-admin's namespace vs. modular
  API, an arrow function used as a mock constructor, a reasoning model returning empty content).
  Check real exports before writing code against them.
- **Optional integrations degrade, they don't crash.** Push, caching, and AI intake all no-op
  cleanly when their env vars are unset; calls return a clear 503. Chat must keep working regardless.

## Local development

```bash
# backend (port 4000) + static frontend (port 3000), both under PM2 from the repo root
npx pm2 start ecosystem.config.cjs

cd server && npm run db:migrate   # apply migrations
cd server && npm run seed:admin -- <email> <password>   # create an admin
cd server && npm run seed:bot     # create the FS Assistant bot user (Phase 7)
cd server && npm test             # vitest + supertest against a real test DB
npm run build && npm run lint     # frontend (repo root)
```

Environment variables are documented in `server/src/config.ts` (a zod schema that fails fast on a
bad config). Secrets live in `server/.env`, which is gitignored and must never be committed.
