import { Navigate, createBrowserRouter } from 'react-router';
import { AdminPage } from '@/features/admin/AdminPage';
import { LoginPage } from '@/features/auth/LoginPage';
import { RegisterPage } from '@/features/auth/RegisterPage';
import { ChannelPage } from '@/features/chat/ChannelPage';
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
          {
            element: <RequireAdmin />,
            children: [{ path: '/admin', element: <AdminPage /> }],
          },
        ],
      },
    ],
  },
]);
