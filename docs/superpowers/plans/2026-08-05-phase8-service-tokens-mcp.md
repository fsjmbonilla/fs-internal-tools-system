# Phase 8: AI-exposed API — service tokens + MCP server

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal (master plan §10):** let an AI agent operate the platform — not just the
built-in intake bot. Scoped service tokens on the existing REST surface, plus an
MCP server so Claude or any MCP-capable agent gets typed tools.

**Why this phase next:** Phases 10–13 all depend on it. The Python runner (§12)
receives "a short-lived scoped service token as env vars", and AI Routines (§13)
drive "the Phase 8 MCP toolset". Building either first would mean inventing a
throwaway auth mechanism and then replacing it.

## Correction to the master plan (verified 2026-08-05)

The plan says build on `@modelcontextprotocol/sdk` 1.x because "SDK v2 split
packages reach stable ~2026-07-28". **That date has passed and v2 is now the
stable line**, released with the 2026-07-28 spec revision. It replaces the
monolithic v1 package with modular ones — and ships an official
**`@modelcontextprotocol/express`** adapter, which matters here because this
server is Express 5.

- [ ] Build on v2 (`@modelcontextprotocol/server` + `@modelcontextprotocol/express`).
      Keep the MCP layer thin regardless — it stays a wrapper over services, which
      is what made this correction cheap rather than a rewrite.

## Global Constraints

- **The visibility rules are not relaxed for tokens.** A token acts as its bot
  user; every existing query keeps filtering by that user's memberships. An agent
  must not be able to read a private channel its identity does not belong to.
- **No notes scope. Ever.** `notesRouter` rejects token auth outright. Phase 3's
  plan says this twice and `notes.ts` carries the comment; personal data stays out
  of agent reach. Adding one requires deliberately revisiting that decision, not a
  habit-driven line in a scope map.
- Invisible → 404, never 403 — including for tokens.
- Every AI-made write is attributed to the token's bot user, so the audit trail
  reads like a person did it.
- Commits: small, conventional, ending with the `Co-Authored-By` trailer.
- `npm test` green in `server/` per task; check `$?` directly.

---

### Task 1: Migration 011 — `api_tokens`

**Files:** `server/src/db/schema/tokens.ts` (new), `schema/index.ts`, `db/testUtils.ts`

`api_tokens`: `id, name, token_hash CHAR(64) UNIQUE, scopes JSON,
acts_as_user_id → users, created_by, last_used_at, expires_at NULL,
revoked_at NULL`.

- [ ] Store **sha256 of the token**, never the token — same treatment as
      `refresh_tokens`, for the same reason.
- [ ] Plaintext is shown once, at creation, and is unrecoverable afterwards.
- [ ] `acts_as_user_id` should point at a bot user (`is_bot = true`); validate at
      creation rather than trusting the caller.

### Task 2: Token verification in the existing auth middleware

**Files:** `middleware/auth.ts`, `services/apiTokenService.ts` (new)

`req.auth` becomes `{ kind: 'user' | 'token', userId, role, scopes? }` — the
shape the master plan already specifies.

- [ ] `Authorization: Bearer fsk_<random>` → hash → look up → reject if revoked,
      expired, or its bot user is inactive. Anything else falls through to the
      existing JWT path unchanged.
- [ ] Touch `last_used_at`, but not on every request — a write per API call is a
      needless hot path. Debounce (e.g. at most once a minute per token).
- [ ] `requireScope('tickets:write')` middleware. A user JWT satisfies any scope
      check (people are not scope-limited); a token must hold it explicitly.
- [ ] **Tests: the negative cases are the point.** Revoked token → 401. Expired →
      401. Wrong scope → 403. Token on a notes route → 401 regardless of scope.
      Token cannot read a private channel its bot is not a member of → 404.

### Task 3: Scope enforcement across the existing routes

Scope map from the master plan: `tickets:read/write` → tasks, move, comments;
`chat:read/write` → channels, messages; `docs:read/write` → project docs.

- [ ] Apply `requireScope` to those routes. No new endpoint namespace — the same
      REST surface serves people and agents, which is what keeps the two from
      drifting apart.
- [ ] Test that a `chat:read` token cannot post, and a `tickets:write` token
      cannot read docs.

### Task 4: Admin token management

**Files:** `routes/admin.ts`, `src/features/admin/TokensTab.tsx`

- [ ] `GET/POST /api/admin/tokens`, `DELETE /api/admin/tokens/:id` (revoke, not
      delete — an audit trail needs the row).
- [ ] UI: create with a name + scope checkboxes + optional expiry; show the
      plaintext once with a copy button and an explicit "this is the only time you
      will see this"; list with last-used and a revoke action.

### Task 5: MCP server

**Files:** `mcp/server.ts` (new), `app.ts`

`POST /mcp`, Streamable HTTP, authenticated by service token.

- [ ] Ten tools, all thin wrappers over existing services — no business logic in
      the MCP layer: `create_ticket`, `update_ticket`, `move_ticket_status`,
      `list_tickets`, `search_messages`, `post_message`, `list_channels`,
      `read_doc`, `write_doc`, `list_docs`.
- [ ] Each tool checks the same scope its REST equivalent does, by calling the
      same service. A tool that bypasses a scope check is the failure mode to test
      for.
- [ ] Tests: an unauthenticated `POST /mcp` is rejected; a scoped token sees only
      the tools it may use; `move_ticket_status` triggers the existing
      `task.moved` announcement, since an agent moving a ticket should notify the
      channel exactly as a person does.

### Task 6: Documentation

- [ ] README section: what a service token is, how to mint one, the scope list,
      and the MCP endpoint with a worked `claude mcp add` example.
- [ ] State plainly that notes are unreachable by tokens, and why.

---

## Deliberately out of scope

Rate limiting per token (the platform-wide limiter applies), per-tool budgets
(Phase 11 owns that for routines), and OAuth for third-party agents — tokens are
minted by admins for internal use.

## Sources (checked 2026-08-05)

- MCP TypeScript SDK v2, stable, modular packages + Express adapter:
  <https://github.com/modelcontextprotocol/typescript-sdk>,
  <https://ts.sdk.modelcontextprotocol.io/v2/>
- 2026-07-28 spec revision support notes:
  <https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28>
