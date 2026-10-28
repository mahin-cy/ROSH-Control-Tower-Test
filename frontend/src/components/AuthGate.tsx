import { useEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Navigate, useLocation } from 'react-router';
import type { Role } from '@roshai/shared';

import { apiRequest } from '@/lib/api-client';
import { useAuthStore } from '@/store/auth-store';

interface MeResponse {
  email: string;
  role: Role;
}

// Real gating: calls GET /api/v1/auth/me, redirects to /login if no valid
// session, and optionally checks a required role for admin-only routes.
export function AuthGate({ children, requireRole }: { children: ReactNode; requireRole?: Role }) {
  const location = useLocation();
  const setUser = useAuthStore((s) => s.setUser);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => apiRequest<MeResponse>('/api/v1/auth/me'),
    retry: false
  });

  useEffect(() => {
    if (data) setUser(data);
  }, [data, setUser]);

  if (isLoading) {
    return <div className="text-muted-foreground p-8 text-sm">Loading…</div>;
  }

  if (isError || !data) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (requireRole && data.role !== requireRole) {
    return (
      <div className="p-8">
        <h1 className="text-xl font-semibold">Forbidden</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          You don&apos;t have permission to view this page.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
