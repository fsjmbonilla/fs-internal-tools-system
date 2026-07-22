import { Navigate, Outlet } from 'react-router';
import { useAuthStore } from '@/features/auth/authStore';

export function RequireAuth() {
  const status = useAuthStore((s) => s.status);
  if (status === 'loading') {
    return (
      <div className="flex min-h-dvh items-center justify-center text-muted-foreground">
        Loading…
      </div>
    );
  }
  return status === 'authed' ? <Outlet /> : <Navigate to="/login" replace />;
}

export function RequireAdmin() {
  const user = useAuthStore((s) => s.user);
  return user?.role === 'admin' ? <Outlet /> : <Navigate to="/" replace />;
}
