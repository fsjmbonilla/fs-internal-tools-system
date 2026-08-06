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
const AdminPage = lazy(() =>
  import('@/features/admin/AdminPage').then((m) => ({ default: m.AdminPage })),
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
          { path: '/', element: <Navigate to="/chat" replace /> },
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
          { path: '/sheets/:sheetId', element: <SheetPage /> },
          { path: '/notes', element: <NotesPage /> },
          {
            element: <RequireAdmin />,
            children: [{ path: '/admin', element: <AdminPage /> }],
          },
        ],
      },
    ],
  },
]);
