import { Menu } from 'lucide-react';
import { Suspense, useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { QuickSwitcher } from '@/features/chat/QuickSwitcher';
import { Sidebar } from '@/features/chat/Sidebar';

const TITLES: Array<[string, string]> = [
  ['/dashboard', 'Dashboard'],
  ['/projects', 'Projects'],
  ['/notes', 'Notes'],
  ['/routines', 'Routines'],
  ['/calendar', 'Calendar'],
  ['/gmail', 'Gmail'],
  ['/drive', 'Drive'],
  ['/scripts', 'Scripts'],
  ['/settings', 'Settings'],
  ['/admin', 'Administration'],
  ['/sheets', 'Sheets'],
  ['/chat', 'Chat'],
];

export function AppLayout() {
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSwitcherOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Navigating from the drawer should land you on the page, not back in the menu.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  const title = TITLES.find(([prefix]) => location.pathname.startsWith(prefix))?.[1] ?? 'Chat';

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground md:flex-row">
      <header className="flex shrink-0 items-center gap-1 border-b bg-sidebar px-2 pt-[env(safe-area-inset-top)] text-sidebar-foreground md:hidden">
        <button
          type="button"
          aria-label="Open navigation"
          className="flex size-11 items-center justify-center rounded-md transition-colors hover:bg-sidebar-accent/60"
          onClick={() => setDrawerOpen(true)}
        >
          <Menu className="size-5" />
        </button>
        <h1 className="text-sm font-semibold">{title}</h1>
      </header>
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="left" className="w-80 gap-0 p-0" aria-describedby={undefined}>
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <Sidebar />
        </SheetContent>
      </Sheet>
      <div className="hidden w-64 shrink-0 md:block">
        <Sidebar />
      </div>
      <main className="min-h-0 flex-1 overflow-hidden">
        {/* Route components are code-split, so the first visit to a section
            fetches its chunk. The sidebar stays put while that happens. */}
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-muted-foreground">
              Loading…
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </main>
      <QuickSwitcher open={switcherOpen} onOpenChange={setSwitcherOpen} />
    </div>
  );
}
