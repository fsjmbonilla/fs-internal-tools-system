import { Suspense, lazy } from 'react';
import { Navigate, createBrowserRouter } from 'react-router';
import { LoginPage } from '@/features/auth/LoginPage';
import { RegisterPage } from '@/features/auth/RegisterPage';
import { AppLayout } from './AppLayout';
import { RequireAdmin, RequireAuth } from './guards';

/**
 * Everything behind the login screen loads on demand.
 *
 * One bundle meant the login screen shipped all eight features, the kanban
 * drag-and-drop engine and the whole markdown renderer before anyone had typed a
 * password. Login and register stay eager — they are the first paint — and
 * AppLayout holds the Suspense boundary the rest fall into.
 */
const DashboardPage = lazy(() =>
  import('@/features/dashboard/DashboardPage').then((m) => ({ default: m.DashboardPage })),
);
const ChannelPage = lazy(() =>
  import('@/features/chat/ChannelPage').then((m) => ({ default: m.ChannelPage })),
);
const ProjectListPage = lazy(() =>
  import('@/features/projects/ProjectListPage').then((m) => ({ default: m.ProjectListPage })),
);
const ProjectBoardPage = lazy(() =>
  import('@/features/kanban/ProjectBoardPage').then((m) => ({ default: m.ProjectBoardPage })),
);
const DocListPage = lazy(() =>
  import('@/features/docs/DocListPage').then((m) => ({ default: m.DocListPage })),
);
const DocPage = lazy(() => import('@/features/docs/DocPage').then((m) => ({ default: m.DocPage })));
const NotesPage = lazy(() =>
  import('@/features/notes/NotesPage').then((m) => ({ default: m.NotesPage })),
);
// Admin-only, and heavy for what it is (a code editor), so it stays behind its
// own chunk like every other feature.
const ScriptsPage = lazy(() =>
  import('@/features/scripts/ScriptsPage').then((m) => ({ default: m.ScriptsPage })),
);
// Routines are not admin-only: everyone owns their own.
const RoutinesPage = lazy(() =>
  import('@/features/routines/RoutinesPage').then((m) => ({ default: m.RoutinesPage })),
);
const AdminPage = lazy(() =>
  import('@/features/admin/AdminPage').then((m) => ({ default: m.AdminPage })),
);
const SettingsPage = lazy(() =>
  import('@/features/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);
const CalendarPage = lazy(() =>
  import('@/features/google/CalendarPage').then((m) => ({ default: m.CalendarPage })),
);
const GmailPage = lazy(() =>
  import('@/features/google/GmailPage').then((m) => ({ default: m.GmailPage })),
);
const MyDrivePage = lazy(() =>
  import('@/features/drive/MyDrivePage').then((m) => ({ default: m.MyDrivePage })),
);
const ProjectFilesPage = lazy(() =>
  import('@/features/drive/ProjectFilesPage').then((m) => ({ default: m.ProjectFilesPage })),
);
// Univer is a whole spreadsheet engine — formula evaluation, a canvas renderer,
// the lot. Lazy like the rest, and worth being deliberate about: loading it on
// the chat route would make every page pay for a feature most sessions never open.
const SheetPage = lazy(() =>
  import('@/features/sheets/SheetPage').then((m) => ({ default: m.SheetPage })),
);
const SheetListPage = lazy(() =>
  import('@/features/sheets/SheetListPage').then((m) => ({ default: m.SheetListPage })),
);
// The heaviest chunk in the app — livekit-client ships a whole WebRTC stack, and
// it is only needed once someone is actually in a call.
const CallPage = lazy(() =>
  import('@/features/calls/CallPage').then((m) => ({ default: m.CallPage })),
);

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        path: '/call/:roomName',
        element: (
          <Suspense
            fallback={
              <div className="flex h-dvh items-center justify-center text-muted-foreground">
                Joining call…
              </div>
            }
          >
            <CallPage />
          </Suspense>
        ),
      },
      {
        element: <AppLayout />,
        children: [
          { path: '/', element: <Navigate to="/dashboard" replace /> },
          { path: '/dashboard', element: <DashboardPage /> },
          {
            path: '/chat',
            element: (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                Select a channel
              </div>
            ),
          },
          { path: '/chat/:channelId', element: <ChannelPage /> },
          { path: '/projects', element: <ProjectListPage /> },
          { path: '/projects/:projectId', element: <ProjectBoardPage /> },
          { path: '/projects/:projectId/docs', element: <DocListPage /> },
          { path: '/projects/:projectId/docs/:docId', element: <DocPage /> },
          { path: '/projects/:projectId/sheets', element: <SheetListPage /> },
          { path: '/projects/:projectId/files', element: <ProjectFilesPage /> },
          { path: '/drive', element: <MyDrivePage /> },
          { path: '/sheets/:sheetId', element: <SheetPage /> },
          { path: '/notes', element: <NotesPage /> },
          { path: '/routines', element: <RoutinesPage /> },
          { path: '/calendar', element: <CalendarPage /> },
          { path: '/gmail', element: <GmailPage /> },
          { path: '/settings', element: <SettingsPage /> },
          {
            element: <RequireAdmin />,
            children: [
              { path: '/admin', element: <AdminPage /> },
              { path: '/scripts', element: <ScriptsPage /> },
            ],
          },
        ],
      },
    ],
  },
]);
