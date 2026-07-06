import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { StorageAccessFramework as SAF } from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';

import * as storage from '@/lib/storage';
import {
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
} from 'react-native-webrtc';

import * as api from '@/lib/api';
import { zapWs } from '@/lib/ws';
import { WS_URL } from '@/config';
import { useAuth } from '@/store/auth';
import { useTransfers } from '@/store/transfers';
import type { TransferResponse } from '@/types/api';

// Peer-to-peer file bytes over a WebRTC data channel. The backend only
// relays the SDP/ICE signaling (see SignalingHandler.java); once the
// channel is up, data flows phone-to-phone. With STUN-only ICE, symmetric
// and carrier-grade NAT can't be punched — when the peer connection fails
// (or never connects in time), both sides fall back to the backend's
// /relay WebSocket (RelayHandler.java), which forwards frames verbatim.
// The channel protocol below is identical on both pipes.
//
// Channel protocol (ordered + reliable, the data channel default):
//   sender -> receiver: {"kind":"meta",...} JSON, then binary chunks, then {"kind":"done"}
//   receiver -> sender: {"kind":"ack","received":N} as bytes land,
//                       {"kind":"received"} after the file is safely on disk
//
// Flow control is ack-based: react-native-webrtc's bufferedAmount is only
// updated by async native events (and lags reality), so polling it can stall
// forever. Instead the sender never runs more than SEND_WINDOW bytes ahead
// of the receiver's last ack.

const CHUNK_BYTES = 32 * 1024;
const SEND_WINDOW = 1024 * 1024;
/** Receiver acks every this many bytes. */
const ACK_EVERY = 8 * CHUNK_BYTES;
const PROGRESS_EVERY_MS = 400;
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
/** Give ICE this long to produce a connection before falling back to the relay. */
const RELAY_FALLBACK_AFTER_MS = 20_000;
/** How long the relay waits for the peer device to join before giving up. */
const RELAY_PEER_JOIN_TIMEOUT_MS = 60_000;

interface Meta {
  kind: 'meta';
  fileName: string;
  fileSize: number;
  mimeType: string | null;
}

interface Session {
  pc: RTCPeerConnection;
  /** ICE candidates that arrived before the remote description was set. */
  pendingCandidates: unknown[];
  remoteSet: boolean;
  /** Sender side: bytes the receiver has confirmed writing. */
  acked: number;
  role: 'sender' | 'receiver';
  /** Sender context, kept so the transfer can restart over the relay. */
  transfer?: TransferResponse;
  uri?: string;
  relay?: RelayChannel;
  fallbackTimer?: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, Session>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The peer controls fileName; never let it influence the on-disk path.
function sanitizeFileName(name: unknown): string {
  const base = String(name ?? '')
    .split(/[/\\]/)
    .pop()!
    .replace(/[\x00-\x1f:*?"<>|]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200);
  return base || 'received-file';
}

// react-native-webrtc's EventTarget types come from event-target-shim, which
// this TS setup fails to resolve — register handlers through this shim instead.
const on = (target: unknown, event: string, handler: (e: any) => void) =>
  (target as { addEventListener: (e: string, h: (e: any) => void) => void }).addEventListener(
    event,
    handler,
  );

function cleanup(transferId: string) {
  const s = sessions.get(transferId);
  if (s) {
    // delete first: the relay's close event must see the session as gone
    sessions.delete(transferId);
    if (s.fallbackTimer) clearTimeout(s.fallbackTimer);
    try {
      s.pc.close();
    } catch {}
    s.relay?.close();
  }
}

async function fail(transferId: string, reason: string) {
  console.warn(`[transfer ${transferId}] failed: ${reason}`);
  cleanup(transferId);
  try {
    await api.failTransfer(transferId);
  } catch {}
  useTransfers.getState().refresh();
}

function createPeer(transferId: string, role: Session['role']): RTCPeerConnection {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const session: Session = { pc, pendingCandidates: [], remoteSet: false, acked: 0, role };
  sessions.set(transferId, session);

  on(pc, 'icecandidate', (event) => {
    if (event.candidate) {
      zapWs.send('signal.ice-candidate', {
        transferId,
        candidate: event.candidate.toJSON(),
      });
    }
  });

  on(pc, 'connectionstatechange', () => {
    const s = sessions.get(transferId);
    if (!s || s.relay) return;
    if (pc.connectionState === 'connected') {
      if (s.fallbackTimer) {
        clearTimeout(s.fallbackTimer);
        s.fallbackTimer = undefined;
      }
    } else if (pc.connectionState === 'failed') {
      switchToRelay(transferId);
    }
  });

  // ICE can also hang without ever reaching "failed" — fall back on a timer too
  session.fallbackTimer = setTimeout(() => {
    const s = sessions.get(transferId);
    if (s && !s.relay && pc.connectionState !== 'connected') {
      switchToRelay(transferId);
    }
  }, RELAY_FALLBACK_AFTER_MS);

  return pc;
}

// --- relay fallback ---

/**
 * Presents the backend's /relay WebSocket with the same surface pumpFile
 * and receiveChannel use on an RTCDataChannel (send / addEventListener /
 * readyState), so the transfer code runs unchanged over either pipe.
 * "open" fires once BOTH devices have joined the relay; peer protocol
 * frames (tagged "kind") pass through, server control frames (tagged
 * "type") are consumed here.
 */
class RelayChannel {
  private ws: WebSocket;
  private handlers = new Map<string, Set<(e: any) => void>>();
  readyState: 'connecting' | 'open' | 'closed' = 'connecting';
  binaryType = 'arraybuffer';

  constructor(transferId: string, token: string, deviceId: string) {
    this.ws = new WebSocket(
      `${WS_URL}/relay?token=${token}&deviceId=${deviceId}&transferId=${transferId}`,
    );
    (this.ws as any).binaryType = 'arraybuffer';
    let peerReady = false;
    this.ws.onmessage = (event) => {
      if (typeof event.data !== 'string') {
        this.emit('message', { data: event.data });
        return;
      }
      let msg: any;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'relay.ready' || msg.type === 'relay.peer-joined') {
        peerReady = peerReady || msg.type === 'relay.peer-joined' || msg.peerConnected === true;
        if (peerReady && this.readyState === 'connecting') {
          this.readyState = 'open';
          this.emit('open', {});
        }
      } else if (msg.type === 'relay.peer-left' || msg.type === 'error') {
        this.close();
      } else if (msg.kind) {
        this.emit('message', { data: event.data });
      }
    };
    this.ws.onclose = () => this.close();
    this.ws.onerror = () => {}; // onclose follows
  }

  addEventListener(event: string, handler: (e: any) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }

  private emit(event: string, e: any) {
    this.handlers.get(event)?.forEach((h) => h(e));
  }

  send(data: string | Uint8Array) {
    this.ws.send(data as any);
  }

  close() {
    if (this.readyState !== 'closed') {
      this.readyState = 'closed';
      this.emit('close', {});
    }
    try {
      this.ws.close();
    } catch {}
  }
}

function switchToRelay(transferId: string) {
  const session = sessions.get(transferId);
  if (!session || session.relay) return;

  const token = api.getAccessToken();
  const deviceId = useAuth.getState().deviceId;
  if (!token || !deviceId) {
    fail(transferId, 'peer connection failed and no credentials for relay');
    return;
  }

  console.log(`[transfer ${transferId}] P2P failed, falling back to server relay`);
  if (session.fallbackTimer) clearTimeout(session.fallbackTimer);
  try {
    session.pc.close();
  } catch {}
  // the transfer restarts from byte 0 over the relay
  session.acked = 0;

  const relay = new RelayChannel(transferId, token, deviceId);
  session.relay = relay;

  session.fallbackTimer = setTimeout(() => {
    if (relay.readyState === 'connecting') relay.close();
  }, RELAY_PEER_JOIN_TIMEOUT_MS);

  relay.addEventListener('open', () => {
    const s = sessions.get(transferId);
    if (s?.fallbackTimer) {
      clearTimeout(s.fallbackTimer);
      s.fallbackTimer = undefined;
    }
  });
  relay.addEventListener('close', () => {
    // cleanup() deletes the session before closing the relay, so a normal
    // teardown doesn't re-enter here
    if (sessions.has(transferId)) fail(transferId, 'relay connection closed');
  });

  if (session.role === 'sender') {
    if (!session.transfer || !session.uri) {
      fail(transferId, 'relay fallback missing sender context');
      return;
    }
    wireSenderChannel(relay, session.transfer, session.uri);
  } else {
    receiveChannel(relay, transferId);
  }
}

async function setRemote(transferId: string, sdp: any) {
  const session = sessions.get(transferId);
  if (!session || session.relay) return; // relay took over; pc is closed
  await session.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  session.remoteSet = true;
  for (const c of session.pendingCandidates) {
    await session.pc.addIceCandidate(new RTCIceCandidate(c as any)).catch(() => {});
  }
  session.pendingCandidates = [];
}

// --- sender ---

async function startSending(transfer: TransferResponse) {
  const uri = useTransfers.getState().localFiles[transfer.id];
  if (!uri) {
    // e.g. the app restarted since the offer was created and we lost the URI
    await fail(transfer.id, 'local file no longer known');
    return;
  }

  const pc = createPeer(transfer.id, 'sender');
  const session = sessions.get(transfer.id)!;
  session.transfer = transfer;
  session.uri = uri;
  const channel = pc.createDataChannel('file');
  channel.binaryType = 'arraybuffer';
  wireSenderChannel(channel, transfer, uri);

  const offer = await pc.createOffer({});
  await pc.setLocalDescription(offer);
  zapWs.send('signal.sdp-offer', { transferId: transfer.id, sdp: offer });
}

/** Sender-side channel wiring, shared by the data channel and the relay. */
function wireSenderChannel(channel: any, transfer: TransferResponse, uri: string) {
  on(channel, 'open', () => {
    pumpFile(channel, transfer, uri).catch((e) => {
      const s = sessions.get(transfer.id);
      if (!s) return; // torn down (cancel/fail/complete) — state already handled
      if (s.relay && channel !== s.relay) return; // superseded by relay fallback
      fail(transfer.id, e instanceof Error ? e.message : 'send failed');
    });
  });

  on(channel, 'message', (event: { data: unknown }) => {
    if (typeof event.data !== 'string') {
      console.log(`[transfer ${transfer.id}] sender got unexpected binary message`);
      return;
    }
    try {
      const msg = JSON.parse(event.data);
      if (msg.kind === 'ack') {
        console.log(`[transfer ${transfer.id}] ack received: ${msg.received}`);
        const session = sessions.get(transfer.id);
        if (session) session.acked = msg.received;
      } else if (msg.kind === 'received') {
        console.log(`[transfer ${transfer.id}] receiver confirmed, closing`);
        // mark done locally right away; the transfer.completed push follows
        useTransfers.setState((s) => ({
          transfers: s.transfers.map((t) =>
            t.id === transfer.id ? { ...t, status: 'COMPLETED' } : t,
          ),
        }));
        cleanup(transfer.id);
        useTransfers.getState().refresh();
      }
    } catch {}
  });
}

async function pumpFile(channel: any, transfer: TransferResponse, uri: string) {
  const file = new File(uri);
  const size = file.size;
  const meta: Meta = {
    kind: 'meta',
    fileName: transfer.fileName,
    fileSize: size,
    mimeType: transfer.mimeType,
  };
  channel.send(JSON.stringify(meta));

  const handle = file.open();
  let sent = 0;
  let lastProgress = 0;
  console.log(`[transfer ${transfer.id}] channel open, sending ${size} bytes`);
  try {
    while (sent < size) {
      // never run more than SEND_WINDOW ahead of the receiver's acks
      let stalledMs = 0;
      while (sent - (sessions.get(transfer.id)?.acked ?? 0) > SEND_WINDOW) {
        await sleep(20);
        stalledMs += 20;
        const stalled = sessions.get(transfer.id);
        // session gone = cancel/fail/complete already handled the state
        if (!stalled) return;
        if (stalled.relay && channel !== stalled.relay) return; // superseded by relay fallback
        if (stalledMs >= 15_000) {
          if (!stalled.relay) {
            // acks stopped flowing over P2P — try the relay before giving up
            switchToRelay(transfer.id);
            return;
          }
          throw new Error(`no acks from receiver for 15s (sent ${sent}, acked ${stalled.acked})`);
        }
      }
      const session = sessions.get(transfer.id);
      if (!session) return; // cancel/fail/complete already handled the state
      if (session.relay && channel !== session.relay) return; // superseded by relay fallback
      const chunk = handle.readBytes(Math.min(CHUNK_BYTES, size - sent));
      if (chunk.length === 0) break;
      channel.send(chunk);
      sent += chunk.length;

      const now = Date.now();
      if (now - lastProgress > PROGRESS_EVERY_MS || sent >= size) {
        lastProgress = now;
        // server persists this and relays it to the receiver
        zapWs.send('transfer.progress', { transferId: transfer.id, bytesTransferred: sent });
        useTransfers.setState((s) => ({
          transfers: s.transfers.map((t) =>
            t.id === transfer.id ? { ...t, status: 'IN_PROGRESS', bytesTransferred: sent } : t,
          ),
        }));
      }
    }
  } finally {
    handle.close();
  }
  channel.send(JSON.stringify({ kind: 'done' }));
  // keep the session open until the receiver acks with "received"
}

const DOWNLOADS_DIR_KEY = 'zapfile.downloadsDirUri';
const COPY_CHUNK_BYTES = 256 * 1024;

/**
 * Copies every received file into the user's Downloads folder so it shows up
 * in the Files app. The first call opens Android's picker pointed at
 * Downloads — the user confirms once; afterwards copies are silent.
 * Streamed in chunks: SAF content:// URIs support WriteOnly handles, so the
 * file never has to fit in JS memory.
 */
async function saveToDownloads(
  uri: string,
  fileName: string,
  mimeType: string | null,
): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  try {
    let dir = await storage.getItem(DOWNLOADS_DIR_KEY);
    if (!dir) {
      const perm = await SAF.requestDirectoryPermissionsAsync(
        SAF.getUriForDirectoryInRoot('Download'),
      );
      if (!perm.granted) return false;
      dir = perm.directoryUri;
      await storage.setItem(DOWNLOADS_DIR_KEY, dir);
    }
    const dest = await SAF.createFileAsync(dir, fileName, mimeType ?? 'application/octet-stream');
    const src = new File(uri).open(FileMode.ReadOnly);
    const dst = new File(dest).open(FileMode.WriteOnly);
    try {
      let remaining = src.size ?? 0;
      while (remaining > 0) {
        const chunk = src.readBytes(Math.min(COPY_CHUNK_BYTES, remaining));
        if (chunk.length === 0) break;
        dst.writeBytes(chunk);
        remaining -= chunk.length;
      }
    } finally {
      src.close();
      dst.close();
    }
    return true;
  } catch (e) {
    console.warn('downloads save failed:', e instanceof Error ? e.message : e);
    // permission may have been revoked — forget the folder so we re-ask next time
    await storage.deleteItem(DOWNLOADS_DIR_KEY).catch(() => {});
    return false;
  }
}

/** Copies received photos/videos into the device gallery. Best-effort. */
async function saveToGallery(uri: string, mimeType: string | null): Promise<boolean> {
  if (!mimeType || !(mimeType.startsWith('image/') || mimeType.startsWith('video/'))) {
    return false;
  }
  try {
    const perm = await MediaLibrary.requestPermissionsAsync(true); // writeOnly
    if (!perm.granted) return false;
    await MediaLibrary.Asset.create(uri);
    return true;
  } catch (e) {
    console.warn('gallery save failed:', e instanceof Error ? e.message : e);
    return false;
  }
}

// --- receiver ---

function receiveChannel(channel: any, transferId: string) {
  let meta: Meta | null = null;
  let file: File | null = null;
  let handle: ReturnType<File['open']> | null = null;
  let received = 0;
  let lastAck = 0;

  channel.binaryType = 'arraybuffer';
  // if the pipe dies (cancel, peer gone), don't leak the write handle
  on(channel, 'close', () => {
    try {
      handle?.close();
    } catch {}
    handle = null;
  });
  on(channel, 'message', async (event: { data: unknown }) => {
    try {
      if (typeof event.data === 'string') {
        const msg = JSON.parse(event.data);
        if (msg.kind === 'meta') {
          console.log(`[transfer ${transferId}] meta received: ${msg.fileName} (${msg.fileSize} bytes)`);
          if (!Number.isSafeInteger(msg.fileSize) || msg.fileSize < 0) {
            throw new Error(`bad fileSize in meta: ${msg.fileSize}`);
          }
          meta = { ...msg, fileName: sanitizeFileName(msg.fileName) };
          const dir = new Directory(Paths.document, 'received');
          try {
            dir.create({ intermediates: true });
          } catch {} // already exists
          file = new File(dir, `${transferId}-${meta!.fileName}`);
          try {
            file.create({ overwrite: true });
          } catch {}
          handle = file.open();
        } else if (msg.kind === 'done') {
          handle?.close();
          handle = null;
          const doneFile = file;
          const doneMeta = meta;
          // a short write must never be reported (and saved) as a success
          if (!doneMeta || received !== doneMeta.fileSize) {
            throw new Error(
              `incomplete file: got ${received} of ${doneMeta?.fileSize ?? '?'} bytes`,
            );
          }
          if (doneMeta && doneFile) {
            const inGallery = await saveToGallery(doneFile.uri, doneMeta.mimeType);
            // everything also lands in the user's Downloads folder
            const inDownloads = await saveToDownloads(
              doneFile.uri,
              doneMeta.fileName,
              doneMeta.mimeType,
            );
            useTransfers.setState((s) => ({
              receivedFiles: {
                ...s.receivedFiles,
                [transferId]: {
                  uri: doneFile.uri,
                  fileName: doneMeta.fileName,
                  mimeType: doneMeta.mimeType,
                  inGallery,
                  inDownloads,
                },
              },
            }));
          }
          console.log(`[transfer ${transferId}] file received (${received} bytes), completing`);
          useTransfers.setState((s) => ({
            transfers: s.transfers.map((t) =>
              t.id === transferId ? { ...t, status: 'COMPLETED', bytesTransferred: received } : t,
            ),
          }));
          channel.send(JSON.stringify({ kind: 'received' }));
          // the bytes are on disk — a flaky complete call must not fail the transfer
          let completed = false;
          for (let attempt = 0; attempt < 3 && !completed; attempt++) {
            try {
              await api.completeTransfer(transferId);
              completed = true;
            } catch (e) {
              console.warn(
                `[transfer ${transferId}] complete attempt ${attempt + 1} failed:`,
                e instanceof Error ? e.message : e,
              );
              await sleep(1000);
            }
          }
          cleanup(transferId);
          useTransfers.getState().refresh();
        }
      } else {
        // binary chunk
        if (!handle) return;
        handle.writeBytes(new Uint8Array(event.data as ArrayBuffer));
        received += (event.data as ArrayBuffer).byteLength;
        if (received - lastAck >= ACK_EVERY || (meta && received >= meta.fileSize)) {
          lastAck = received;
          console.log(`[transfer ${transferId}] sending ack: ${received} (state ${channel.readyState})`);
          channel.send(JSON.stringify({ kind: 'ack', received }));
          useTransfers.setState((s) => ({
            transfers: s.transfers.map((t) =>
              t.id === transferId
                ? // relayed sender progress may already be ahead — don't step back
                  { ...t, status: 'IN_PROGRESS', bytesTransferred: Math.max(t.bytesTransferred, received) }
                : t,
            ),
          }));
        }
      }
    } catch (e) {
      handle?.close();
      fail(transferId, e instanceof Error ? e.message : 'receive failed');
    }
  });
}

async function onSdpOffer(data: { transferId: string; sdp: any }) {
  const existing = sessions.get(data.transferId);
  if (existing?.relay) return; // already transferring over the relay
  if (existing) cleanup(data.transferId); // stale earlier attempt
  const pc = createPeer(data.transferId, 'receiver');
  on(pc, 'datachannel', (event) => {
    receiveChannel(event.channel, data.transferId);
  });
  await setRemote(data.transferId, data.sdp);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  zapWs.send('signal.sdp-answer', { transferId: data.transferId, sdp: answer });
}

// --- wiring ---

// Sender side: the accept push is the cue to dial the peer.
zapWs.on('transfer.accepted', (data: any) => {
  const myDevices = useTransfers.getState().localFiles;
  const transfers: TransferResponse[] = data?.transfers ?? (data?.id ? [data] : []);
  for (const t of transfers) {
    if (myDevices[t.id]) {
      startSending(t).catch((e) =>
        fail(t.id, e instanceof Error ? e.message : 'could not start sending'),
      );
    }
  }
});

zapWs.on('signal.sdp-offer', (data) => {
  onSdpOffer(data).catch((e) =>
    fail(data.transferId, e instanceof Error ? e.message : 'could not answer offer'),
  );
});

zapWs.on('signal.sdp-answer', (data: { transferId: string; sdp: any }) => {
  setRemote(data.transferId, data.sdp).catch((e) =>
    fail(data.transferId, e instanceof Error ? e.message : 'bad answer'),
  );
});

// On (re)connect, deal with accepted transfers this sender never started —
// e.g. the receiver accepted while our app was closed. Resume the ones whose
// file we still know; fail the orphans so they don't sit at 0% forever.
zapWs.on('ws.connected', async () => {
  try {
    await useTransfers.getState().refresh();
  } catch {}
  const me = useAuth.getState().user?.userId;
  if (!me) return;
  const { transfers, localFiles } = useTransfers.getState();
  for (const t of transfers) {
    const stuck =
      (t.status === 'ACCEPTED' || t.status === 'IN_PROGRESS') &&
      t.senderUserId === me &&
      !sessions.has(t.id);
    if (!stuck) continue;
    if (localFiles[t.id]) {
      console.log(`[transfer ${t.id}] resuming pending send after reconnect`);
      startSending(t).catch((e) =>
        fail(t.id, e instanceof Error ? e.message : 'could not resume sending'),
      );
    } else {
      fail(t.id, 'local file no longer known (stale transfer)');
    }
  }
});

// Cancel/decline/fail must tear down a live session, or bytes keep flowing
// until the file ends. Two hooks: the WS push (fast path, covers the remote
// side) and a store subscription (covers the local optimistic cancel and the
// reconnect refetch). COMPLETED is deliberately NOT handled here — the done/
// received handshake tears those down itself, and killing the channel on the
// receiver's optimistic COMPLETED write would cut off its final frame.
const STOP_STATUSES = new Set<TransferResponse['status']>(['CANCELLED', 'DECLINED', 'FAILED']);

function stopSession(transferId: string, why: string) {
  if (!sessions.has(transferId)) return;
  console.log(`[transfer ${transferId}] stopping session (${why})`);
  cleanup(transferId);
}

for (const event of ['transfer.cancelled', 'transfer.declined', 'transfer.failed'] as const) {
  zapWs.on(event, (data: any) => {
    const transfers: any[] = data?.transfers ?? (data?.id ? [data] : []);
    for (const t of transfers) stopSession(t.id, event);
    if (typeof data?.transferId === 'string') stopSession(data.transferId, event);
  });
}

useTransfers.subscribe((state) => {
  for (const t of state.transfers) {
    if (STOP_STATUSES.has(t.status)) stopSession(t.id, t.status);
  }
});

zapWs.on('signal.ice-candidate', (data: { transferId: string; candidate: any }) => {
  const session = sessions.get(data.transferId);
  if (!session || session.relay) return;
  if (session.remoteSet) {
    session.pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
  } else {
    session.pendingCandidates.push(data.candidate);
  }
});
