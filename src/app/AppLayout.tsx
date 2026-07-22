import { Outlet } from 'react-router';

// Minimal shell — the Slack-style sidebar layout lands in Phase 2.
export function AppLayout() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <Outlet />
    </div>
  );
}
