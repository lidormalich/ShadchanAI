// ═══════════════════════════════════════════════════════════
// Shared users directory hook — used by OwnerChip, TaskForm,
// and any other surface that needs to resolve userId → name.
// Single cached fetch per session (via React Query).
// ═══════════════════════════════════════════════════════════

import { useQuery } from '@tanstack/react-query';
import { usersApi, type DirectoryUser } from '@/services/api/users';

export function useUsers() {
  return useQuery({
    queryKey: ['users'],
    queryFn: () => usersApi.list(),
    staleTime: 5 * 60 * 1000, // users directory rarely changes
  });
}

export function useUserById(id?: string): DirectoryUser | undefined {
  const q = useUsers();
  if (!id) return undefined;
  return q.data?.data.find((u) => u.id === id);
}
