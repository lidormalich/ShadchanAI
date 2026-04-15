import { api } from './client';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  roles: string[];
  lastLoginAt?: string;
}

export interface LoginResult {
  token: string;
  expiresIn: string;
  user: AuthUser;
}

export const authApi = {
  login: (body: { email: string; password: string }) =>
    api.post<LoginResult>('/auth/login', body),
  me: () => api.get<AuthUser>('/auth/me'),
  bootstrap: (body: { email: string; password: string; name: string }) =>
    api.post<{ bootstrapped: boolean; user: AuthUser }>('/auth/bootstrap', body),
  changePassword: (body: { currentPassword: string; newPassword: string }) =>
    api.post<void>('/auth/change-password', body),
};
