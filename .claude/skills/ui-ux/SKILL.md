---
name: ui-ux
description: Usability rules for this SPA — feedback, loading/empty/error states, forms, navigation, accessibility. Read when adding or changing any user-facing flow in src/.
---

# UI/UX — fs-internal-tools-system

Staff use this tool all day on phones and desktops. Optimize for "I can tell what
happened" over visual flair.

## Feedback — every action answers

- Mutations show their state where the user acted: button goes busy (`disabled` +
  label swap), then the UI reflects the result. If the update is optimistic, reconcile
  visibly on failure — never silently revert.
- Errors render inline next to the action (the LoginPage `text-destructive` pattern),
  worded as what to do next, not as an exception message. Nothing goes only to the
  console.
- Destructive actions (delete, revoke, unbind) get a confirm step naming the object
  ("Delete #general?" not "Are you sure?").

## Loading, empty, error — every async view has all three

- Loading: skeletons shaped like the content (`animate-pulse bg-muted`), not spinners.
- Empty: name the thing + the action that creates the first one, in one short line.
- Error: what failed + a retry affordance. A blank pane is never an acceptable state —
  that exact bug (note opens blank, no error) shipped once already.

## Forms

- Enter submits (real `<form onSubmit>` + `type="submit"`, like LoginPage — not
  onClick-only buttons). First field autofocused. Submit disabled while busy.
  Field values survive a failed submit.
- Validation messages appear at the field after interaction, not on first paint.

## Navigation & orientation

- The current section is visibly marked in the nav; on mobile the top bar shows the
  current page title — users arriving from a notification must know where they are.
- ⌘K/Ctrl-K quick switcher is the power path; every switcher destination must also be
  reachable by visible navigation (touch parity).
- Back must work: detail views get real routes, not modal-only state, so mobile
  back/refresh don't strand or reset the user.

## Accessibility (minimum bar)

- Icon-only buttons get `aria-label`. Focus rings stay visible (`focus-visible:` is
  styled by default here — don't suppress it). Selected/unread states never rely on
  color alone (pair with weight or an icon). Respect `prefers-reduced-motion` for
  anything that moves more than a fade.

## Scope guardrails (UX ≠ license to touch these)

Notes stay owner-private, invisible-means-404, and Gmail HTML only renders through
`sanitizeEmailHtml` — a friendlier UI never loosens those (see repo CLAUDE.md).
