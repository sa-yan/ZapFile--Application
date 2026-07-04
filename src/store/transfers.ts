import { create } from 'zustand';

import * as api from '@/lib/api';
import { zapWs } from '@/lib/ws';
import { useAuth } from '@/store/auth';
import type { FileMeta, TransferResponse } from '@/types/api';

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

export const useTransfers = create<TransfersState>((set, get) => ({
  transfers: [],
  localFiles: {},
  receivedFiles: {},
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const transfers = await api.transferHistory();
      set({ transfers, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : 'Could not load transfers' });
    }
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
    set({ error: null });
    try {
      await api.acceptBatch(batchId, deviceId);
      await get().refresh();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Could not accept the transfer' });
    }
  },

  declineOffer: async (batchId) => {
    set({ error: null });
    try {
      await api.declineBatch(batchId);
      await get().refresh();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Could not decline the transfer' });
    }
  },

  cancelOffer: async (batchId) => {
    set({ error: null });
    try {
      await api.cancelBatch(batchId);
      await get().refresh();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Could not cancel the transfer' });
    }
  },
}));

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

for (const event of REFETCH_EVENTS) {
  zapWs.on(event, () => {
    useTransfers.getState().refresh();
  });
}

// Progress is high-frequency: patch in place instead of refetching.
zapWs.on('transfer.progress', (data: { transferId: string; bytesTransferred: number }) => {
  useTransfers.setState((s) => ({
    transfers: s.transfers.map((t) =>
      t.id === data.transferId ? { ...t, bytesTransferred: data.bytesTransferred } : t,
    ),
  }));
});

zapWs.on('ws.connected', () => {
  useTransfers.getState().refresh();
});
