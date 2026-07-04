// Mirrors the backend DTOs (com.sayan.zapfile.*Dtos).

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  userId: string;
  displayName: string;
}

export interface UserResponse {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export type DevicePlatform = 'ANDROID' | 'IOS';

export interface DeviceResponse {
  id: string;
  deviceName: string;
  platform: DevicePlatform;
  createdAt: string;
  lastSeenAt: string;
}

export type FriendshipStatus = 'PENDING' | 'ACCEPTED' | 'BLOCKED';

export interface FriendResponse {
  friendshipId: string;
  userId: string;
  displayName: string;
  status: FriendshipStatus;
  since: string;
}

export interface PairingCodeResponse {
  code: string;
  expiresAt: string;
}

export interface FriendPresence {
  userId: string;
  displayName: string;
  online: boolean;
}

export type TransferStatus =
  | 'OFFERED'
  | 'ACCEPTED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'DECLINED'
  | 'CANCELLED'
  | 'FAILED';

export type TransferMode = 'P2P' | 'RELAY';

export interface TransferResponse {
  id: string;
  batchId: string;
  senderUserId: string;
  senderDisplayName: string;
  senderDeviceId: string;
  receiverUserId: string;
  receiverDisplayName: string;
  receiverDeviceId: string | null;
  fileName: string;
  fileSize: number;
  mimeType: string | null;
  status: TransferStatus;
  mode: TransferMode;
  bytesTransferred: number;
  createdAt: string;
  updatedAt: string;
}

export interface BatchResponse {
  batchId: string;
  transfers: TransferResponse[];
}

export interface FileMeta {
  fileName: string;
  fileSize: number;
  mimeType?: string;
}

export interface ApiError {
  status: number;
  error: string;
  message: string;
  timestamp: string;
}

/** Server -> client WebSocket events on /ws. */
export type WsEventType =
  | 'transfer.offer'
  | 'transfer.accepted'
  | 'transfer.declined'
  | 'transfer.cancelled'
  | 'transfer.completed'
  | 'transfer.failed'
  | 'transfer.resumed'
  | 'transfer.progress'
  | 'signal.sdp-offer'
  | 'signal.sdp-answer'
  | 'signal.ice-candidate'
  | 'presence.update'
  | 'pong'
  | 'error';

export interface WsEnvelope {
  type: WsEventType;
  data: any;
}
