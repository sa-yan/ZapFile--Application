import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { create } from 'zustand';

import * as api from '@/lib/api';
import { getPushToken } from '@/lib/notifications';
import * as storage from '@/lib/storage';
import { zapWs } from '@/lib/ws';

const DEVICE_KEY = 'zapfile.deviceId';

interface AuthState {
  /** null until restore() has run once */
  ready: boolean;
  user: { userId: string; displayName: string } | null;
  deviceId: string | null;
  busy: boolean;
  error: string | null;

  restore: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Deletes the account on the server, then clears all local session state. Throws on failure. */
  deleteAccount: (password: string) => Promise<void>;
}

/** Registers this phone as a device (once) and returns its id. */
async function ensureDevice(): Promise<string> {
  const saved = await storage.getItem(DEVICE_KEY);
  if (saved) {
    // make sure the backend still knows this device (DB could have been reset)
    const devices = await api.listDevices();
    if (devices.some((d) => d.id === saved)) {
      attachPushToken(saved);
      return saved;
    }
  }
  const device = await api.registerDevice(
    Device.deviceName ?? `${Platform.OS} device`,
    Platform.OS === 'ios' ? 'IOS' : 'ANDROID',
  );
  await storage.setItem(DEVICE_KEY, device.id);
  attachPushToken(device.id);
  return device.id;
}

/** Best-effort, in the background: login must not wait on the permission prompt. */
function attachPushToken(deviceId: string) {
  getPushToken()
    .then((token) => {
      console.log('push token:', token ?? 'NONE (permission denied or Firebase missing)');
      return token ? api.updateDevice(deviceId, { fcmToken: token }) : null;
    })
    .then((res) => res && console.log('push token attached to device', res.id))
    .catch((e) => console.warn('push token attach failed:', e?.message ?? e));
}

function connectWs(deviceId: string) {
  const token = api.getAccessToken();
  if (token) zapWs.connect(token, deviceId);
}

export const useAuth = create<AuthState>((set) => ({
  ready: false,
  user: null,
  deviceId: null,
  busy: false,
  error: null,

  restore: async () => {
    try {
      const hasSession = await api.loadTokens();
      if (!hasSession) {
        set({ ready: true });
        return;
      }
      const me = await api.getMe(); // also refreshes the access token if stale
      const deviceId = await ensureDevice();
      connectWs(deviceId);
      set({ ready: true, user: { userId: me.id, displayName: me.displayName }, deviceId });
    } catch {
      set({ ready: true }); // stay logged out; tokens were cleared on refresh failure
    }
  },

  login: async (email, password) => {
    set({ busy: true, error: null });
    try {
      const auth = await api.login(email.trim(), password);
      const deviceId = await ensureDevice();
      connectWs(deviceId);
      set({ user: { userId: auth.userId, displayName: auth.displayName }, deviceId, busy: false });
    } catch (e) {
      set({ busy: false, error: e instanceof Error ? e.message : 'Login failed' });
    }
  },

  register: async (email, password, displayName) => {
    set({ busy: true, error: null });
    try {
      const auth = await api.register(email.trim(), password, displayName.trim());
      const deviceId = await ensureDevice();
      connectWs(deviceId);
      set({ user: { userId: auth.userId, displayName: auth.displayName }, deviceId, busy: false });
    } catch (e) {
      set({ busy: false, error: e instanceof Error ? e.message : 'Registration failed' });
    }
  },

  logout: async () => {
    zapWs.disconnect();
    await api.clearTokens();
    set({ user: null, error: null });
  },

  deleteAccount: async (password) => {
    await api.deleteAccount(password); // throws if the password is wrong
    zapWs.disconnect();
    await api.clearTokens();
    // the device row is gone server-side; a future login must register fresh
    await storage.deleteItem(DEVICE_KEY);
    set({ user: null, deviceId: null, error: null });
  },
}));

// if a token refresh ever fails mid-session, drop back to the login screen
api.setSessionExpiredHandler(() => {
  zapWs.disconnect();
  useAuth.setState({ user: null });
});
