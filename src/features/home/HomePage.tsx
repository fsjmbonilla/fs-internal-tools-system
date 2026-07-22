import { Link, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { logoutUser } from '@/features/auth/api';
import { useAuthStore } from '@/features/auth/authStore';

export function HomePage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">FS Internal System</h1>
      <p className="text-sm text-muted-foreground">
        Signed in as {user?.displayName} ({user?.email})
      </p>
      <div className="flex gap-2">
        {user?.role === 'admin' && (
          <Button asChild variant="secondary">
            <Link to="/admin">Administration</Link>
          </Button>
        )}
        <Button
          variant="outline"
          onClick={async () => {
            await logoutUser();
            navigate('/login');
          }}
        >
          Sign out
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Messaging arrives in Phase 2.</p>
    </main>
  );
}
