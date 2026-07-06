import { WS_URL } from '@/config';
import type { WsEnvelope, WsEventType } from '@/types/api';

type Listener = (data: any) => void;

const PING_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;
/** No pong for this long = half-open socket; force-close so reconnect kicks in. */
const PONG_TIMEOUT_MS = PING_INTERVAL_MS * 2 + 5_000;

/**
 * Connection to the backend's /ws endpoint: receives server pushes
 * (transfer offers, presence) and relays WebRTC signaling to the peer
 * device. One instance lives for the whole logged-in session.
 */
class ZapWs {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1000;
  private token: string | null = null;
  private deviceId: string | null = null;
  private shouldRun = false;
  private lastPong = 0;

  connect(token: string, deviceId: string) {
    this.token = token;
    this.deviceId = deviceId;
    this.shouldRun = true;
    this.open();
  }

  disconnect() {
    this.shouldRun = false;
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Update the token used for reconnects after a refresh. */
  updateToken(token: string) {
    this.token = token;
  }

  send(type: string, data: Record<string, unknown>) {
    if (this.connected) {
      this.ws!.send(JSON.stringify({ type, data }));
    }
  }

  /** Subscribe to a server event; returns an unsubscribe function. */
  on(type: WsEventType | 'ws.connected' | 'ws.disconnected', listener: Listener): () => void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
    return () => this.listeners.get(type)?.delete(listener);
  }

  private emit(type: string, data: any) {
    this.listeners.get(type)?.forEach((l) => l(data));
  }

  private open() {
    if (!this.token || !this.deviceId) return;
    this.ws = new WebSocket(`${WS_URL}/ws?token=${this.token}&deviceId=${this.deviceId}`);

    this.ws.onopen = () => {
      this.backoffMs = 1000;
      this.lastPong = Date.now();
      this.emit('ws.connected', {});
      this.pingTimer = setInterval(() => {
        // a silently dropped connection (network handoff, NAT timeout) never
        // fires onclose — detect it by the missing pongs and close ourselves
        if (Date.now() - this.lastPong > PONG_TIMEOUT_MS) {
          console.warn('[ws] no pong, closing half-open socket');
          this.ws?.close();
          return;
        }
        this.send('ping', {});
      }, PING_INTERVAL_MS);
    };

    this.ws.onmessage = (event) => {
      try {
        const envelope: WsEnvelope = JSON.parse(event.data as string);
        if (envelope.type === 'pong') {
          this.lastPong = Date.now();
          return;
        }
        this.emit(envelope.type, envelope.data);
      } catch {
        // ignore malformed frames
      }
    };

    this.ws.onclose = () => {
      this.clearTimers();
      this.emit('ws.disconnected', {});
      if (this.shouldRun) {
        // jitter so many clients don't reconnect in lockstep after a backend restart
        const delay = this.backoffMs * (0.5 + Math.random() * 0.5);
        this.reconnectTimer = setTimeout(() => this.open(), delay);
        this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
      }
    };

    this.ws.onerror = () => {
      // onclose fires afterwards and handles the reconnect
    };
  }

  private clearTimers() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.reconnectTimer = null;
  }
}

export const zapWs = new ZapWs();
