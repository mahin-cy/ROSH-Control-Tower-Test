import { create } from 'zustand';
import type { Role } from '@roshai/shared';

export interface AuthUser {
  email: string;
  role: Role;
}

interface AuthState {
  user: AuthUser | null;
  setUser: (user: AuthUser | null) => void;
}

// Populated from GET /api/v1/auth/me via React Query (see AuthGate) and
// mirrored here so AppLayout's nav can read the current user without
// prop drilling through every route.
export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  setUser: (user) => set({ user })
}));
