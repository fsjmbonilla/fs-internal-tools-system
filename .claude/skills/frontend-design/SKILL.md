---
name: frontend-design
description: Design language and interaction rules for this SPA — tokens, components, motion, rich-content classes. Read before styling or building any UI in src/.
---

# Frontend design — fs-internal-tools-system

## Foundations (what exists — use these, add nothing)

- **Tailwind v4** (`@import "tailwindcss"` in `src/index.css`) + **shadcn** components
  in `src/components/ui/` (backed by the consolidated `radix-ui` package).
  **`tw-animate-css`** is already imported — `animate-in fade-in slide-in-from-*`
  utilities work everywhere. Do not add framer-motion or any UI dependency without
  asking; the SPA ships inside Capacitor and bundle size is felt.
- **Icons**: `lucide-react`. **Font**: Geist Variable (`--font-sans`), no second face.
- **Color**: semantic tokens only — `bg-background`, `text-foreground`,
  `text-muted-foreground`, `border-border`, `bg-card`, `bg-accent`, `text-destructive`,
  `ring-ring`. Never a raw palette class (`bg-gray-100`) and never a hex/oklch literal
  in a component: dark mode is `.dark` swapping the CSS variables in `src/index.css`,
  and a hardcoded color breaks silently there. Check both themes when you touch color.

## Rich content — `prose` is dead here

`@tailwindcss/typography` is **deliberately not installed**. `prose` classes do
nothing. Long-form HTML/markdown gets the scoped stylesheet in `src/index.css`:

- `.fs-rich` — notes, docs markdown, office previews (headings, lists, tables, code).
- `.fs-rich fs-email` — Gmail bodies: same, minus table borders/background, because an
  email's tables are layout scaffolding once inline styles are sanitized away.

New tag rendering wrong in rich content → extend `.fs-rich` in `index.css`, don't
inline-style the consumer.

## Interaction — nothing static that can respond

- Every interactive element gets `hover:` + `focus-visible:` states and
  `transition-colors` (150ms default). List rows: `hover:bg-accent`. Selected row:
  `bg-accent` + a `font-medium` cue, never color alone.
- Panels/dialogs entering the screen: `animate-in fade-in` (+ `slide-in-from-*` for
  sheets/drawers). Keep durations ≤200ms; this is an ops tool, not a landing page.
- Async buttons follow the LoginPage pattern: `disabled={busy}` + label swap
  (`{busy ? 'Signing in…' : 'Sign in'}`). Never a dead click.
- Loading = skeleton blocks (`animate-pulse bg-muted rounded`) shaped like the content,
  not a centered spinner. Empty states = one line naming the thing + the action that
  creates the first one (see DIRECT MESSAGES in the sidebar for the tone).
- ⚠️ Toolbar buttons over inputs/editors need `onMouseDown={e => e.preventDefault()}`
  or they steal focus and the next keystroke goes to the button (live trap, already
  bitten once — see CLAUDE.md).

## Verify visually, always

Green tests have missed three real UI bugs in this repo. Drive a real browser:
`npm install playwright-core` in the scratchpad, launch `/usr/bin/google-chrome` via
`executablePath`, log in as `tech@flowerstore.ph` / `fs-internal-dev-2026`, screenshot
light **and** dark, desktop **and** 390×844 (see the `mobile-first` skill).
