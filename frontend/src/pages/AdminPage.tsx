import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { AdminUserSummary, Role } from '@roshai/shared';

import { apiRequest, ApiError } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

// Role Management UI: lets an existing Admin promote/demote any user
// (including operators auto-provisioned by their first Entra login)
// without needing DB access — see CLAUDE.md "Auth" for why role stays
// DB-driven rather than sourced from the OIDC provider.
export function AdminPage() {
  const queryClient = useQueryClient();

  const { data: users, isLoading } = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => apiRequest<AdminUserSummary[]>('/api/v1/admin/users')
  });

  const roleMutation = useMutation({
    mutationFn: ({ id, role }: { id: string; role: Role }) =>
      apiRequest<AdminUserSummary>(`/api/v1/admin/users/${id}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role })
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      // Covers self-demotion: requireAdmin re-checks role fresh on every
      // request (see auth-guard.ts), so a demoted admin's access is
      // already gone server-side the moment this resolves — without this,
      // AuthGate's cached ['auth', 'me'] result would keep this page
      // rendering as if nothing changed until the next action confusingly
      // 403s. Cheap to always refetch, whether or not it was your own row.
      queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
    }
  });

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Admin</h1>

      {roleMutation.isError && (
        <p className="text-destructive text-sm" role="alert">
          Failed to change role:{' '}
          {roleMutation.error instanceof ApiError
            ? roleMutation.error.message
            : 'Something went wrong'}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Users</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-muted-foreground text-sm">Loading…</p>
          ) : !users || users.length === 0 ? (
            <p className="text-muted-foreground text-sm">No users yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Email</th>
                    <th className="py-2 pr-4 font-medium">Name</th>
                    <th className="py-2 pr-4 font-medium">Role</th>
                    <th className="py-2 pr-4 font-medium">Joined</th>
                    <th className="py-2 pr-4 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => {
                    const nextRole: Role = user.role === 'ADMIN' ? 'OPERATOR' : 'ADMIN';
                    return (
                      <tr key={user.id} className="border-b last:border-0">
                        <td className="py-2 pr-4 font-medium">{user.email}</td>
                        <td className="py-2 pr-4">{user.name ?? '—'}</td>
                        <td className="py-2 pr-4">
                          <Badge variant={user.role === 'ADMIN' ? 'default' : 'secondary'}>
                            {user.role}
                          </Badge>
                        </td>
                        <td className="py-2 pr-4">
                          {new Date(user.createdAt).toLocaleDateString()}
                        </td>
                        <td className="py-2 pr-4 text-right">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={roleMutation.isPending}
                            onClick={() => roleMutation.mutate({ id: user.id, role: nextRole })}
                          >
                            Make {nextRole === 'ADMIN' ? 'Admin' : 'Operator'}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
