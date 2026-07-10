import { API_URL } from '@/config';
import type {
  ApiError,
  AuthResponse,
  BatchResponse,
  DevicePlatform,
  DeviceResponse,
  FileMeta,
  FriendPresence,
  FriendResponse,
  PairingCodeResponse,
  TransferResponse,
  UserResponse,
} from '@/types/api';
import * as storage from './storage';

const ACCESS_KEY = 'zapfile.accessToken';
const REFRESH_KEY = 'zapfile.refreshToken';

let accessToken: string | null = null;
let refreshToken: string | null = null;
let onSessionExpired: (() => void) | null = null;

export class RequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function setSessionExpiredHandler(handler: () => void) {
  onSessionExpired = handler;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export async function loadTokens(): Promise<boolean> {
  accessToken = await storage.getItem(ACCESS_KEY);
  refreshToken = await storage.getItem(REFRESH_KEY);
  return !!refreshToken;
}

export async function saveTokens(access: string, refresh: string): Promise<void> {
  accessToken = access;
  refreshToken = refresh;
  await storage.setItem(ACCESS_KEY, access);
  await storage.setItem(REFRESH_KEY, refresh);
}

export async function clearTokens(): Promise<void> {
  accessToken = null;
  refreshToken = null;
  await storage.deleteItem(ACCESS_KEY);
  await storage.deleteItem(REFRESH_KEY);
}

async function rawRequest<T>(path: string, method: string, body?: unknown, token?: string | null): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = (json as ApiError | null)?.message ?? `Request failed (${res.status})`;
    throw new RequestError(res.status, message);
  }
  return json as T;
}

/** Refreshes the access token once; returns false if the session is truly dead. */
let refreshInFlight: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  // several requests 401 together after a wake — they must share one refresh,
  // or the losers' rotated-away tokens would log the user out
  if (refreshInFlight) return refreshInFlight;
  if (!refreshToken) return false;
  refreshInFlight = (async () => {
    try {
      const auth = await rawRequest<AuthResponse>('/auth/refresh', 'POST', { refreshToken });
      await saveTokens(auth.accessToken, auth.refreshToken);
      return true;
    } catch (e) {
      // only a rejected token kills the session — a network blip must not
      if (e instanceof RequestError && (e.status === 401 || e.status === 403)) {
        await clearTokens();
        onSessionExpired?.();
      }
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/** Authenticated request with a single automatic refresh-and-retry on 401. */
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  try {
    return await rawRequest<T>(path, method, body, accessToken);
  } catch (e) {
    if (e instanceof RequestError && e.status === 401 && (await tryRefresh())) {
      return rawRequest<T>(path, method, body, accessToken);
    }
    throw e;
  }
}

// --- auth ---

export async function register(email: string, password: string, displayName: string): Promise<AuthResponse> {
  const auth = await rawRequest<AuthResponse>('/auth/register', 'POST', { email, password, displayName });
  await saveTokens(auth.accessToken, auth.refreshToken);
  return auth;
}

export async function login(email: string, password: string): Promise<AuthResponse> {
  const auth = await rawRequest<AuthResponse>('/auth/login', 'POST', { email, password });
  await saveTokens(auth.accessToken, auth.refreshToken);
  return auth;
}

// --- users ---

export const getMe = () => request<UserResponse>('/users/me');

/** Permanently deletes the account server-side; password re-confirmed by the backend. */
export const deleteAccount = (password: string) => request<void>('/users/me', 'DELETE', { password });

// --- devices ---

export const listDevices = () => request<DeviceResponse[]>('/devices');

export const registerDevice = (deviceName: string, platform: DevicePlatform, fcmToken?: string) =>
  request<DeviceResponse>('/devices', 'POST', { deviceName, platform, fcmToken });

export const updateDevice = (id: string, patch: { deviceName?: string; fcmToken?: string }) =>
  request<DeviceResponse>(`/devices/${id}`, 'PATCH', patch);

// --- friends ---

export const listFriends = () => request<FriendResponse[]>('/friends');
export const generatePairingCode = () => request<PairingCodeResponse>('/friends/code', 'POST');
export const redeemPairingCode = (code: string) =>
  request<FriendResponse>('/friends/requests', 'POST', { code });
export const requestFriendByEmail = (email: string) =>
  request<FriendResponse>('/friends/requests', 'POST', { email });
export const listFriendRequests = () => request<FriendResponse[]>('/friends/requests');
export const acceptFriendRequest = (id: string) =>
  request<FriendResponse>(`/friends/requests/${id}/accept`, 'POST');
export const declineFriendRequest = (id: string) =>
  request<FriendResponse>(`/friends/requests/${id}/decline`, 'POST');
export const friendPresence = () => request<FriendPresence[]>('/presence/friends');

// --- transfers ---

export const createTransfer = (senderDeviceId: string, receiverUserId: string, files: FileMeta[]) =>
  request<BatchResponse>('/transfers', 'POST', { senderDeviceId, receiverUserId, files });
export const acceptBatch = (batchId: string, receiverDeviceId: string) =>
  request<BatchResponse>(`/transfers/batch/${batchId}/accept`, 'POST', { receiverDeviceId });
export const declineBatch = (batchId: string) =>
  request<BatchResponse>(`/transfers/batch/${batchId}/decline`, 'POST');
export const cancelBatch = (batchId: string) =>
  request<BatchResponse>(`/transfers/batch/${batchId}/cancel`, 'POST');
export const transferHistory = () => request<TransferResponse[]>('/transfers');
export const completeTransfer = (id: string) => request<TransferResponse>(`/transfers/${id}/complete`, 'POST');
export const failTransfer = (id: string) => request<TransferResponse>(`/transfers/${id}/fail`, 'POST');
export const resumeTransfer = (id: string) => request<TransferResponse>(`/transfers/${id}/resume`, 'POST');
