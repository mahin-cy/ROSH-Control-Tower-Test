import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router';
import { loginRequestSchema, type LoginRequest, type Role } from '@roshai/shared';

import { apiRequest, ApiError } from '@/lib/api-client';
import { useAuthStore } from '@/store/auth-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface LoginResponse {
  email: string;
  role: Role;
}

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const setUser = useAuthStore((s) => s.setUser);

  const {
    register,
    handleSubmit,
    formState: { errors }
  } = useForm<LoginRequest>({ resolver: zodResolver(loginRequestSchema) });

  const mutation = useMutation({
    mutationFn: (values: LoginRequest) =>
      apiRequest<LoginResponse>('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify(values)
      }),
    onSuccess: (data) => {
      setUser(data);
      const from = (location.state as { from?: { pathname: string; search: string } } | null)?.from;
      navigate(from ? `${from.pathname}${from.search}` : '/vehicles', { replace: true });
    }
  });

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>RoshAI Control Tower</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={handleSubmit((values) => mutation.mutate(values))}
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" autoComplete="username" {...register('email')} />
              {errors.email && <p className="text-destructive text-sm">{errors.email.message}</p>}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                {...register('password')}
              />
              {errors.password && (
                <p className="text-destructive text-sm">{errors.password.message}</p>
              )}
            </div>
            {mutation.isError && (
              <p className="text-destructive text-sm">
                {mutation.error instanceof ApiError
                  ? mutation.error.message
                  : 'Something went wrong'}
              </p>
            )}
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>

          <div className="my-4 flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="text-muted-foreground text-xs">or</span>
            <div className="h-px flex-1 bg-border" />
          </div>

          {/* Real top-level navigation, not a router Link or fetch — the
              OIDC flow requires a full-page redirect to Entra and back. */}
          <Button variant="outline" className="w-full" asChild>
            <a href="/api/v1/auth/oidc/login">Sign in with Microsoft</a>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
