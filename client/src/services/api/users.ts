import { api } from './client';

export interface DirectoryUser {
  id: string;
  name: string;
  email?: string;
  roles?: string[];
  isActive?: boolean;
}

export const usersApi = {
  list: () => api.get<DirectoryUser[]>('/users'),
};
