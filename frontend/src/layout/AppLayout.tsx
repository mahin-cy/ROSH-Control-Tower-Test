import { Link, NavLink, Outlet, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { cn } from '@/lib/utils';
import { apiRequest } from '@/lib/api-client';
import { useAuthStore } from '@/store/auth-store';
import { Button } from '@/components/ui/button';

export function AppLayout() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);

  const navItems = [
    { to: '/vehicles', label: 'PDIs' },
    { to: '/history', label: 'History' },
    ...(user?.role === 'ADMIN' ? [{ to: '/admin', label: 'Admin' }] : [])
  ];

  const logout = useMutation({
    mutationFn: () => apiRequest('/api/v1/auth/logout', { method: 'POST' }),
    onSettled: () => {
      setUser(null);
      queryClient.removeQueries({ queryKey: ['auth', 'me'] });
      navigate('/login', { replace: true });
    }
  });

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
          <Link to="/" className="font-semibold">
            RoshAI Control Tower
          </Link>
          <nav className="flex gap-4">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    'text-muted-foreground hover:text-foreground text-sm',
                    isActive && 'text-foreground font-medium'
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          {user && (
            <div className="ml-auto flex items-center gap-3">
              <span className="text-muted-foreground text-sm">
                {user.email} · {user.role}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => logout.mutate()}
                disabled={logout.isPending}
              >
                Log out
              </Button>
            </div>
          )}
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
