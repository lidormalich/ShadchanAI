// ═══════════════════════════════════════════════════════════
// Auth context — manages the current user + token lifecycle.
//
// Token is stored in localStorage under `auth_token` (matches
// the backend's Bearer header expectation). On boot, we try
// `/auth/me` to restore a session.
// ═══════════════════════════════════════════════════════════

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { authApi, type AuthUser } from '@/services/api/auth';
import { ApiError } from '@/types/api';

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  hasRole: (role: string) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // ── Bootstrap on mount ───────────────────────────────
  useEffect(() => {
    const token = localStorage.getItem('auth_token');
    if (!token) {
      setLoading(false);
      return;
    }
    authApi.me()
      .then(({ data }) => setUser(data))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          localStorage.removeItem('auth_token');
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const { data } = await authApi.login({ email, password });
    localStorage.setItem('auth_token', data.token);
    setUser(data.user);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('auth_token');
    setUser(null);
    // Full reload so any in-flight query cache is purged
    window.location.href = '/login';
  }, []);

  const hasRole = useCallback((role: string) => user?.roles.includes(role) ?? false, [user]);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, hasRole }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
