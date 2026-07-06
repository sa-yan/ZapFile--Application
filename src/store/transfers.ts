import { create } from 'zustand';

import * as api from '@/lib/api';
import { loadJson, saveJson } from '@/lib/json-store';
import { zapWs } from '@/lib/ws';
import { useAuth } from '@/store/auth';
import type { FileMeta, TransferResponse } from '@/types/api';

const LOCAL_FILES_STORE = 'local-files.json';
const RECEIVED_FILES_STORE = 'received-files.json';

/** One batch = one offer: the unit the user accepts or declines. */
export interface Batch {
  batchId: string;
  transfers: TransferResponse[];
}

export interface PickedFile extends FileMeta {
  /** Local content/file URI from the document picker. */
  uri: string;
}

export interface ReceivedFile {
  uri: string;
  fileName: string;
  mimeType: string | null;
  /** true if a copy was saved to the device gallery */
  inGallery?: boolean;
  /** true if a copy was saved to the user-picked downloads folder */
  inDownloads?: boolean;
}

interface TransfersState {
  /** Full history from GET /transfers, newest first. */
  transfers: TransferResponse[];
  /** transferId -> local URI of a file we offered (sender side, this session only). */
  localFiles: Record<string, string>;
  /** transferId -> file that finished downloading (receiver side, this session only). */
  receivedFiles: Record<string, ReceivedFile>;
  loading: boolean;
  error: string | null;

  refresh: () => Promise<void>;
  sendFiles: (receiverUserId: string, files: PickedFile[]) => Promise<void>;
  acceptOffer: (batchId: string) => Promise<void>;
  declineOffer: (batchId: string) => Promise<void>;
  cancelOffer: (batchId: string) => Promise<void>;
}

function groupByBatch(transfers: TransferResponse[]): Batch[] {
  const byId = new Map<string, TransferResponse[]>();
  for (const t of transfers) {
    if (!byId.has(t.batchId)) byId.set(t.batchId, []);
    byId.get(t.batchId)!.push(t);
  }
  return [...byId.entries()].map(([batchId, ts]) => ({ batchId, transfers: ts }));
}

// These build fresh arrays, so memoize their results in components (useMemo)
// instead of passing them to useTransfers() as selectors.

/** Offers sent to me that I haven't answered yet. */
export function incomingOffers(transfers: TransferResponse[], myUserId: string): Batch[] {
  return groupByBatch(
    transfers.filter((t) => t.status === 'OFFERED' && t.receiverUserId === myUserId),
  );
}

/** Offers I sent that the other side hasn't answered yet. */
export function outgoingOffers(transfers: TransferResponse[], myUserId: string): Batch[] {
  return groupByBatch(
    transfers.filter((t) => t.status === 'OFFERED' && t.senderUserId === myUserId),
  );
}

const TERMINAL = new Set<TransferResponse['status']>([
  'COMPLETED',
  'DECLINED',
  'CANCELLED',
  'FAILED',
]);

type SetState = (fn: (s: TransfersState) => Partial<TransfersState>) => void;

function setBatchStatus(set: SetState, batchId: string, status: TransferResponse['status']) {
  set((s) => ({
    error: null,
    transfers: s.transfers.map((t) => (t.batchId === batchId ? { ...t, status } : t)),
  }));
}

let refreshInFlight: Promise<void> | null = null;

async function doRefresh() {
  const { setState: set } = useTransfers;
  set({ loading: true, error: null });
  try {
    const transfers = await api.transferHistory();
    // The server can briefly lag behind what this device already knows
    // (final progress / complete calls still in flight), so never move a
    // transfer backwards: keep local terminal statuses and higher byte
    // counts until the server catches up.
    set((s) => ({
      transfers: transfers.map((t) => {
        const local = s.transfers.find((x) => x.id === t.id);
        if (!local) return t;
        return {
          ...t,
          status: TERMINAL.has(local.status) && !TERMINAL.has(t.status) ? local.status : t.status,
          bytesTransferred: Math.max(t.bytesTransferred, local.bytesTransferred),
        };
      }),
      loading: false,
    }));
  } catch (e) {
    set({ loading: false, error: e instanceof Error ? e.message : 'Could not load transfers' });
  }
}

export const useTransfers = create<TransfersState>((set, get) => ({
  transfers: [],
  localFiles: loadJson<Record<string, string>>(LOCAL_FILES_STORE) ?? {},
  receivedFiles: loadJson<Record<string, ReceivedFile>>(RECEIVED_FILES_STORE) ?? {},
  loading: false,
  error: null,

  refresh: async () => {
    // concurrent callers (WS event bursts, multi-store reconnect) share one fetch
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      try {
        await doRefresh();
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  },

  sendFiles: async (receiverUserId, files) => {
    const deviceId = useAuth.getState().deviceId;
    if (!deviceId) throw new Error('Device is not registered yet');
    const batch = await api.createTransfer(
      deviceId,
      receiverUserId,
      files.map(({ fileName, fileSize, mimeType }) => ({ fileName, fileSize, mimeType })),
    );
    // remember which local file backs each created transfer, so the engine
    // can stream it once the receiver accepts (matched by name, in order)
    const unmatched = [...files];
    const localFiles = { ...get().localFiles };
    for (const t of batch.transfers) {
      const i = unmatched.findIndex((f) => f.fileName === t.fileName);
      if (i >= 0) {
        localFiles[t.id] = unmatched[i].uri;
        unmatched.splice(i, 1);
      }
    }
    set({ localFiles });
    await get().refresh();
  },

  acceptOffer: async (batchId) => {
    const deviceId = useAuth.getState().deviceId;
    if (!deviceId) return;
    // optimistic: swap the offer card for the progress row immediately
    setBatchStatus(set, batchId, 'ACCEPTED');
    try {
      await api.acceptBatch(batchId, deviceId);
      await get().refresh();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Could not accept the transfer' });
      await get().refresh(); // revert the optimistic change
    }
  },

  declineOffer: async (batchId) => {
    setBatchStatus(set, batchId, 'DECLINED');
    try {
      await api.declineBatch(batchId);
      await get().refresh();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Could not decline the transfer' });
      await get().refresh();
    }
  },

  cancelOffer: async (batchId) => {
    setBatchStatus(set, batchId, 'CANCELLED');
    try {
      await api.cancelBatch(batchId);
      await get().refresh();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Could not cancel the transfer' });
      await get().refresh();
    }
  },
}));

// Persist the file maps so received files stay openable (and pending sends
// stay resumable) across app restarts.
useTransfers.subscribe((state, prev) => {
  if (state.localFiles !== prev.localFiles) saveJson(LOCAL_FILES_STORE, state.localFiles);
  if (state.receivedFiles !== prev.receivedFiles) {
    saveJson(RECEIVED_FILES_STORE, state.receivedFiles);
  }
});

// The server pushes a transfer.* event to both sides on every state change;
// the REST list stays the single source of truth, the push just tells us when
// to refetch.
const REFETCH_EVENTS = [
  'transfer.offer',
  'transfer.accepted',
  'transfer.declined',
  'transfer.cancelled',
  'transfer.completed',
  'transfer.failed',
  'transfer.resumed',
] as const;

// A batch offer fans out into one event per transfer — coalesce the burst
// into a single refetch instead of hammering GET /transfers.
let refetchTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRefetch() {
  if (refetchTimer) return;
  refetchTimer = setTimeout(() => {
    refetchTimer = null;
    useTransfers.getState().refresh();
  }, 300);
}

for (const event of REFETCH_EVENTS) {
  zapWs.on(event, scheduleRefetch);
}

// Progress is high-frequency: patch in place instead of refetching.
// The sender's relayed progress runs ahead of the receiver's own byte count
// (SEND_WINDOW flow control), and both write here — never move backwards,
// and ignore late pushes once the transfer is terminal.
zapWs.on('transfer.progress', (data: { transferId: string; bytesTransferred: number }) => {
  useTransfers.setState((s) => ({
    transfers: s.transfers.map((t) =>
      t.id === data.transferId && !TERMINAL.has(t.status)
        ? { ...t, bytesTransferred: Math.max(t.bytesTransferred, data.bytesTransferred) }
        : t,
    ),
  }));
});

zapWs.on('ws.connected', () => {
  useTransfers.getState().refresh();
});
