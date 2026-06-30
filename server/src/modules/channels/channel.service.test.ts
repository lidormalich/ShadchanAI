import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChannelStatus } from '@shadchanai/shared';
import { NotFoundError, BusinessRuleError } from '../../utils/errors.js';

// ── Hoisted mocks for every collaborator the service imports ──
const h = vi.hoisted(() => ({
  channelMgr: { findById: vi.fn() },
  Channel: { deleteOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(undefined) })) },
  ChatMapping: { deleteMany: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(undefined) })) },
  auditMock: vi.fn().mockResolvedValue(undefined),
  publishMock: vi.fn(),
  getChannelClient: vi.fn(),
  stopChannelClient: vi.fn().mockResolvedValue(undefined),
  startChannelClient: vi.fn(),
  logoutChannelClient: vi.fn().mockResolvedValue(undefined),
  describeAllSessions: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../models/index.js', () => ({ Channel: h.Channel, ChatMapping: h.ChatMapping }));
vi.mock('../../services/whatsapp/whatsapp.service.js', () => ({ channels: h.channelMgr }));
vi.mock('../../services/audit.service.js', () => ({ audit: (...a: unknown[]) => h.auditMock(...a) }));
vi.mock('../../services/realtime/realtime.service.js', () => ({
  publishRealtimeEvent: (...a: unknown[]) => h.publishMock(...a),
}));
vi.mock('../../services/whatsapp/chat-discovery.service.js', () => ({ discoverChats: vi.fn() }));
vi.mock('../../services/whatsapp/providers/baileys/baileys.client.js', () => ({
  getChannelClient: (...a: unknown[]) => h.getChannelClient(...a),
  stopChannelClient: (...a: unknown[]) => h.stopChannelClient(...a),
  startChannelClient: (...a: unknown[]) => h.startChannelClient(...a),
  logoutChannelClient: (...a: unknown[]) => h.logoutChannelClient(...a),
  describeAllSessions: (...a: unknown[]) => h.describeAllSessions(...a),
}));
vi.mock('../../services/whatsapp/instance.lock.js', () => ({
  forceReleaseChannelLock: vi.fn(),
  inspectChannelLock: vi.fn(),
  INSTANCE_ID: 'test-instance',
}));

import { getChannel, deleteChannelSafely, startSession } from './channel.service.js';

const PERFORMER = '507f1f77bcf86cd799439012';
const fakeChannel = (over: Record<string, unknown> = {}) => ({
  _id: '507f1f77bcf86cd799439011',
  channelId: 'ch-1',
  status: ChannelStatus.DISCONNECTED,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.stopChannelClient.mockResolvedValue(undefined);
});

describe('getChannel', () => {
  it('throws NotFoundError when the channel is missing', async () => {
    h.channelMgr.findById.mockResolvedValue(null);
    await expect(getChannel('ch-x')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('returns a secret-stripped view when found', async () => {
    h.channelMgr.findById.mockResolvedValue(fakeChannel({
      role: 'match_sending', accountDisplayName: 'A', phoneNumber: '+972', provider: 'baileys',
      connectionHealth: 'healthy', webhookStatus: 'verified', createdAt: new Date(), updatedAt: new Date(),
      tokenRef: 'SECRET',
    }));
    const view = await getChannel('ch-1');
    expect(view.channelId).toBe('ch-1');
    expect((view as unknown as Record<string, unknown>)['tokenRef']).toBeUndefined();
  });
});

describe('deleteChannelSafely', () => {
  it('throws NotFoundError when the channel does not exist', async () => {
    h.channelMgr.findById.mockResolvedValue(null);
    await expect(deleteChannelSafely('ch-x', PERFORMER)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses to delete a channel that is still in an unsafe status', async () => {
    h.channelMgr.findById.mockResolvedValue(fakeChannel({ status: ChannelStatus.ACTIVE }));
    await expect(deleteChannelSafely('ch-1', PERFORMER))
      .rejects.toMatchObject({ name: 'BusinessRuleError', details: { code: 'channel_not_safe_to_delete' } });
    expect(h.Channel.deleteOne).not.toHaveBeenCalled();
  });

  it('refuses to delete while a live Baileys client is still registered', async () => {
    h.channelMgr.findById.mockResolvedValue(fakeChannel({ status: ChannelStatus.DISCONNECTED }));
    h.getChannelClient.mockReturnValue({ status: {} });
    await expect(deleteChannelSafely('ch-1', PERFORMER))
      .rejects.toMatchObject({ details: { code: 'session_still_running' } });
    expect(h.Channel.deleteOne).not.toHaveBeenCalled();
  });

  it('deletes mappings + channel and audits when safe', async () => {
    h.channelMgr.findById.mockResolvedValue(fakeChannel({ status: ChannelStatus.SUSPENDED }));
    h.getChannelClient.mockReturnValue(undefined);

    await deleteChannelSafely('ch-1', PERFORMER);

    expect(h.ChatMapping.deleteMany).toHaveBeenCalledWith({ channelId: 'ch-1' });
    expect(h.Channel.deleteOne).toHaveBeenCalledWith({ channelId: 'ch-1' });
    expect(h.auditMock).toHaveBeenCalledTimes(1);
    expect(h.publishMock).toHaveBeenCalledWith('channel.updated', expect.objectContaining({ transition: 'delete' }));
  });
});

describe('startSession', () => {
  it('throws NotFoundError for an unknown channel', async () => {
    h.channelMgr.findById.mockResolvedValue(null);
    await expect(startSession('ch-x', PERFORMER)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('starts the client, audits and publishes on success', async () => {
    h.channelMgr.findById.mockResolvedValue(fakeChannel());
    h.startChannelClient.mockResolvedValue({ status: { state: 'connecting' } });

    const status = await startSession('ch-1', PERFORMER);

    expect(h.startChannelClient).toHaveBeenCalledTimes(1);
    expect(status).toEqual({ state: 'connecting' });
    expect(h.auditMock).toHaveBeenCalledTimes(1);
    expect(h.publishMock).toHaveBeenCalledWith('channel.updated', expect.objectContaining({ transition: 'session_start' }));
  });
});
