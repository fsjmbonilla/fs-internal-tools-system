import { Navigate, createBrowserRouter } from 'react-router';
import { AdminPage } from '@/features/admin/AdminPage';
import { LoginPage } from '@/features/auth/LoginPage';
import { RegisterPage } from '@/features/auth/RegisterPage';
import { ChannelPage } from '@/features/chat/ChannelPage';
import { DocListPage } from '@/features/docs/DocListPage';
import { DocPage } from '@/features/docs/DocPage';
import { ProjectBoardPage } from '@/features/kanban/ProjectBoardPage';
import { NotesPage } from '@/features/notes/NotesPage';
import { ProjectListPage } from '@/features/projects/ProjectListPage';
import { AppLayout } from './AppLayout';
import { RequireAdmin, RequireAuth } from './guards';

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
  {
    element: <RequireAuth />,
    children: [
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
