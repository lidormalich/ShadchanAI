// ═══════════════════════════════════════════════════════════
// API client — wraps fetch with envelope handling and auth.
// All service modules go through here so error shape is uniform.
// ═══════════════════════════════════════════════════════════

import { ApiError, type ApiEnvelope } from '@/types/api';

const API_BASE = '/api';

function getAuthHeaders(): HeadersInit {
  const token = localStorage.getItem('auth_token');
  if (token) return { Authorization: `Bearer ${token}` };
  // Dev fallback — backend accepts X-Dev-User in development
  const devUser = localStorage.getItem('dev_user');
  if (devUser) return { 'X-Dev-User': devUser };
  return {};
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, unknown>;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: Record<string, unknown>): string {
  const url = new URL(`${API_BASE}${path}`, window.location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.pathname + (url.search ? url.search : '');
}

export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<{ data: T; meta?: ApiEnvelope['meta'] }> {
  const res = await fetch(buildUrl(path, opts.query), {
    method: opts.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...getAuthHeaders(),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });

  // 204 No Content
  if (res.status === 204) return { data: undefined as unknown as T };

  let envelope: ApiEnvelope<T>;
  try {
    envelope = (await res.json()) as ApiEnvelope<T>;
  } catch {
    throw new ApiError(res.status, 'parse_error', 'Invalid JSON response');
  }

  if (!res.ok || !envelope.success) {
    throw new ApiError(
      res.status,
      envelope.error?.code ?? 'unknown_error',
      envelope.error?.message ?? `Request failed (${res.status})`,
      envelope.error?.details,
    );
  }

  return { data: envelope.data as T, meta: envelope.meta };
}

// Convenience helpers
export const api = {
  get: <T>(p: string, query?: Record<string, unknown>) => apiRequest<T>(p, { method: 'GET', query }),
  post: <T>(p: string, body?: unknown) => apiRequest<T>(p, { method: 'POST', body }),
  patch: <T>(p: string, body?: unknown) => apiRequest<T>(p, { method: 'PATCH', body }),
  put: <T>(p: string, body?: unknown) => apiRequest<T>(p, { method: 'PUT', body }),
  del: <T>(p: string) => apiRequest<T>(p, { method: 'DELETE' }),
};
