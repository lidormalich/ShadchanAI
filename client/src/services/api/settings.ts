import { api } from './client';

export type SettingValue = number | boolean | string;

export interface SettingRow {
  key: string;
  type: 'number' | 'boolean' | 'enum' | 'string';
  min?: number;
  max?: number;
  options?: string[];
  default: SettingValue;
  description: string;
  value: SettingValue;
}

export const settingsApi = {
  list: () => api.get<SettingRow[]>('/settings'),
  update: (key: string, value: unknown) =>
    api.patch<{ key: string; value: SettingValue }>(`/settings/${encodeURIComponent(key)}`, { value }),
};
