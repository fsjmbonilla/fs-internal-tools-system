/**
 * The scope vocabulary — the one definition, shared by the server and the SPA.
 *
 * This file is deliberately a leaf: **no imports, ever.** The browser bundle
 * reaches it through a `@shared/*` alias, so anything imported here would be
 * pulled into the client too — and the module that used to own this list
 * (`apiTokenService`) reaches the database, hashes tokens, and could never be
 * bundled. Keeping the vocabulary separate from the enforcement is what lets one
 * copy serve both sides.
 *
 * The client uses it to render pickers; the server uses it to validate. Before
 * this existed the two lists were maintained by hand, and adding a scope meant
 * remembering a file in a different project.
 *
 * Deliberately absent: anything for notes. Notes are private to their owner and
 * `notesRouter` rejects token auth outright; Phase 3 recorded that decision twice
 * so a later phase would not add a scope here by habit. Adding one means
 * revisiting that decision on purpose, not extending this list.
 */
export const SCOPES = [
  'tickets:read',
  'tickets:write',
  'chat:read',
  'chat:write',
  'docs:read',
  'docs:write',
  'sheets:read',
  'sheets:write',
  // Google surfaces (Phase 12). These gate *whose* Google? Never the bot's —
  // a tool call uses the connection of the human behind the agent (a routine's
  // owner, a token's creator), resolved via Caller.googleUserId in access.ts.
  'calendar:read',
  'calendar:write',
  'gmail:read',
  'gmail:write',
  // Read-only by design: agents find and reference Drive files; they do not
  // write to anyone's Drive.
  'drive:read',
] as const;

export type Scope = (typeof SCOPES)[number];

export function isScope(value: string): value is Scope {
  return (SCOPES as readonly string[]).includes(value);
}
