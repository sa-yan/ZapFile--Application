import { create } from 'zustand';

import * as api from '@/lib/api';
import { zapWs } from '@/lib/ws';
import type { FriendResponse, PairingCodeResponse } from '@/types/api';

interface FriendsState {
  friends: FriendResponse[];
  /** Incoming requests waiting for accept/decline. */
  requests: FriendResponse[];
  /** userId -> online, fed by REST snapshot + presence.update pushes. */
  online: Record<string, boolean>;
  myCode: PairingCodeResponse | null;
  loading: boolean;
  error: string | null;

  refresh: () => Promise<void>;
  generateCode: () => Promise<void>;
  redeemCode: (code: string) => Promise<void>;
  accept: (friendshipId: string) => Promise<void>;
  decline: (friendshipId: string) => Promise<void>;
}

export const useFriends = create<FriendsState>((set, get) => ({
  friends: [],
  requests: [],
  online: {},
  myCode: null,
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const [friends, requests, presence] = await Promise.all([
        api.listFriends(),
        api.listFriendRequests(),
        api.friendPresence(),
      ]);
      const online: Record<string, boolean> = {};
      for (const p of presence) online[p.userId] = p.online;
      set({ friends, requests, online, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : 'Could not load friends' });
    }
  },

  generateCode: async () => {
    set({ error: null });
    try {
      set({ myCode: await api.generatePairingCode() });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Could not generate a code' });
    }
  },

  redeemCode: async (code) => {
    set({ error: null });
    await api.redeemPairingCode(code.trim().toUpperCase());
    await get().refresh();
  },

  accept: async (friendshipId) => {
    set({ error: null });
    try {
      await api.acceptFriendRequest(friendshipId);
      await get().refresh();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Could not accept the request' });
    }
  },

  decline: async (friendshipId) => {
    set({ error: null });
    try {
      await api.declineFriendRequest(friendshipId);
      await get().refresh();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Could not decline the request' });
    }
  },
}));

// Live presence pushes for the whole session.
zapWs.on('presence.update', (data: { userId: string; online: boolean }) => {
  useFriends.setState((s) => ({ online: { ...s.online, [data.userId]: data.online } }));
});

// Refetch whenever the socket (re)connects: requests/friends may have changed
// while we were offline, and the presence snapshot is stale.
zapWs.on('ws.connected', () => {
  useFriends.getState().refresh();
});
