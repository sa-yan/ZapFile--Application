import { Directory, File, Paths } from 'expo-file-system';
import {
  readAsStringAsync,
  StorageAccessFramework as SAF,
  writeAsStringAsync,
} from 'expo-file-system/legacy';
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
import { useTransfers } from '@/store/transfers';
import type { TransferResponse } from '@/types/api';

// Peer-to-peer file bytes over a WebRTC data channel. The backend only
// relays the SDP/ICE signaling (see SignalingHandler.java); once the
// channel is up, data flows phone-to-phone.
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
}

const sessions = new Map<string, Session>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    try {
      s.pc.close();
    } catch {}
    sessions.delete(transferId);
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

function createPeer(transferId: string): RTCPeerConnection {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const session: Session = { pc, pendingCandidates: [], remoteSet: false, acked: 0 };
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
    if (pc.connectionState === 'failed') {
      fail(transferId, 'peer connection failed');
    }
  });

  return pc;
}

async function setRemote(transferId: string, sdp: any) {
  const session = sessions.get(transferId);
  if (!session) return;
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

  const pc = createPeer(transfer.id);
  const channel = pc.createDataChannel('file');
  channel.binaryType = 'arraybuffer';

  on(channel, 'open', () => {
    pumpFile(channel, transfer, uri).catch((e) =>
      fail(transfer.id, e instanceof Error ? e.message : 'send failed'),
    );
  });

  on(channel, 'message', (event) => {
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

  const offer = await pc.createOffer({});
  await pc.setLocalDescription(offer);
  zapWs.send('signal.sdp-offer', { transferId: transfer.id, sdp: offer });
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
        if (stalledMs >= 15_000) {
          throw new Error(`no acks from receiver for 15s (sent ${sent}, acked ${sessions.get(transfer.id)?.acked ?? 0})`);
        }
      }
      if (!sessions.get(transfer.id)) throw new Error('session closed mid-send');
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
/** Base64 copy holds the file in memory; skip enormous files. */
const MAX_PUBLIC_COPY_BYTES = 128 * 1024 * 1024;

/**
 * Copies every received file into the user's Downloads folder so it shows up
 * in the Files app. The first call opens Android's picker pointed at
 * Downloads — the user confirms once; afterwards copies are silent.
 */
async function saveToDownloads(
  uri: string,
  fileName: string,
  mimeType: string | null,
  size: number,
): Promise<boolean> {
  if (Platform.OS !== 'android' || size > MAX_PUBLIC_COPY_BYTES) return false;
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
    const base64 = await readAsStringAsync(uri, { encoding: 'base64' });
    await writeAsStringAsync(dest, base64, { encoding: 'base64' });
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
  on(channel, 'message', async (event: { data: unknown }) => {
    try {
      if (typeof event.data === 'string') {
        const msg = JSON.parse(event.data);
        if (msg.kind === 'meta') {
          console.log(`[transfer ${transferId}] meta received: ${msg.fileName} (${msg.fileSize} bytes)`);
          meta = msg;
          const dir = new Directory(Paths.document, 'received');
          try {
            dir.create({ intermediates: true });
          } catch {} // already exists
          file = new File(dir, `${transferId}-${msg.fileName}`);
          try {
            file.create({ overwrite: true });
          } catch {}
          handle = file.open();
        } else if (msg.kind === 'done') {
          handle?.close();
          handle = null;
          const doneFile = file;
          const doneMeta = meta;
          if (doneMeta && doneFile) {
            const inGallery = await saveToGallery(doneFile.uri, doneMeta.mimeType);
            // everything also lands in the user's Downloads folder
            const inDownloads = await saveToDownloads(
              doneFile.uri,
              doneMeta.fileName,
              doneMeta.mimeType,
              doneMeta.fileSize,
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
              t.id === transferId ? { ...t, status: 'IN_PROGRESS', bytesTransferred: received } : t,
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
  const pc = createPeer(data.transferId);
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

zapWs.on('signal.ice-candidate', (data: { transferId: string; candidate: any }) => {
  const session = sessions.get(data.transferId);
  if (!session) return;
  if (session.remoteSet) {
    session.pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
  } else {
    session.pendingCandidates.push(data.candidate);
  }
});
