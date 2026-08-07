---
name: mobile-first
description: Mobile-first layout rules for this SPA — breakpoints, app-shell drawer pattern, touch targets, pane collapsing, Capacitor constraints. Read before writing any layout or page structure in src/.
---

# Mobile-first — fs-internal-tools-system

This SPA **is** the future native app (Capacitor wraps it unchanged), so mobile web
is not a degraded view — it is the primary product. Write the mobile layout first,
then widen with `md:` / `lg:`.

## Breakpoints

Default (no prefix) = phone. `md:` (768px) = tablet/small desktop. `lg:` = full
desktop with permanent sidebar. Never write a desktop layout and then bolt
`max-md:hidden` onto it — start from the phone.

## The app shell

- Height is `h-dvh` (already the convention) — never `h-screen`, which breaks under
  mobile browser chrome.
- `< md`: the sidebar is hidden; navigation lives in a **`Sheet`** (shadcn, already in
  `components/ui/sheet.tsx`) opened by a hamburger in a sticky top bar. `md:+`: the
  permanent sidebar returns. One nav component, two containers — don't fork the menu.
- Capacitor/iOS notch: pad fixed bars with `env(safe-area-inset-top/bottom)`
  (Tailwind arbitrary value: `pt-[env(safe-area-inset-top)]`).

## Touch rules

- Tap targets ≥ 44px: interactive rows/buttons get `min-h-11` on mobile even if
  desktop uses `h-8`.
- No hover-only affordances. Anything revealed by `hover:` needs a tap path on
  mobile — visible button, long-press, or overflow menu.
- Inputs: ≥16px font on mobile (`text-base md:text-sm`, the existing `Input` already
  does this) or iOS zooms the viewport on focus.

## Collapsing multi-pane pages

Desktop pages here are list+detail (Gmail, Notes, Docs) or sidebar+thread (Chat) or
column boards (Kanban). On `< md`:

- **List+detail** → one pane at a time: list fills the screen; selecting an item slides
  the detail in (`animate-in slide-in-from-right`) with a back button. URL state should
  survive reload on the detail view.
- **Kanban** → horizontal scroll with `snap-x snap-mandatory`, one column ≈ 85vw.
- **Tables** (admin, sheets list) → either card rows on mobile or a scroll container
  (`overflow-x-auto` on a wrapper, never page-level horizontal scroll).
- **Dialogs** → shadcn `Dialog` is fine ≥ md; on phones prefer `Sheet` side="bottom"
  for anything with a form in it.

## Verify

Screenshot at **390×844** (phone) and **768×1024** (tablet) with playwright-core +
`/usr/bin/google-chrome` (`page.setViewportSize`), plus desktop. A layout is not done
until the phone screenshot shows no horizontal page scroll and no sub-44px targets.
