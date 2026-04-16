import { api } from './client';

export interface SettingRow {
  key: string;
  type: 'number';
  min: number;
  max: number;
  default: number;
  description: string;
  value: number;
}

export const settingsApi = {
  list: () => api.get<SettingRow[]>('/settings'),
  update: (key: string, value: unknown) =>
    api.patch<{ key: string; value: number }>(`/settings/${encodeURIComponent(key)}`, { value }),
};
