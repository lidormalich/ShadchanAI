import { api } from './client';

export interface SafeModeStatus {
  outboundEnabled: boolean;
  envEnabled: boolean;
  settingEnabled: boolean;
  reason?: string;
  requireExplicitMapping: boolean;
}

export const safeModeApi = {
  status: () => api.get<SafeModeStatus>('/safe-mode/status'),
};
