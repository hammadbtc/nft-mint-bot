import { safeErrorMessage } from "@/lib/safety";

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 15_000;
const STALE_AFTER_MS = 30_000;

export type BlockWatcherStatus = {
  configured: boolean;
  connected: boolean;
  lastBlockAt: string | null;
  lastBlockNumber: number | null;
  lastError: string | null;
  reconnects: number;
};

export function blockWatcherFresh(status: Pick<BlockWatcherStatus, "configured" | "connected" | "lastBlockAt">, now = Date.now()): boolean {
  if (!status.configured) return true; // bounded HTTP scheduler is the fallback
  if (!status.connected || !status.lastBlockAt) return false;
  const age = now - Date.parse(status.lastBlockAt);
  return Number.isFinite(age) && age >= 0 && age <= STALE_AFTER_MS;
}

export function robinhoodWebSocketUrl(): string | null {
  const explicit = process.env.ROBINHOOD_WS_URL?.trim();
  if (explicit) return explicit;
  const key = process.env.ALCHEMY_API_KEY?.trim();
  return key && key.length > 10 ? `wss://robinhood-mainnet.g.alchemy.com/v2/${key}` : null;
}

/** Standard eth_subscribe newHeads watcher. The official raw Nitro sequencer
 * feed is intended for a full node, so MintBot uses a production provider WS
 * here and retains its bounded HTTP readiness probe as failover. */
export class BlockWatcher {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private reconnectDelay = RECONNECT_MIN_MS;
  private statusValue: BlockWatcherStatus = {
    configured: false, connected: false, lastBlockAt: null,
    lastBlockNumber: null, lastError: null, reconnects: 0,
  };

  constructor(private readonly url: string | null, private readonly onBlock: (blockNumber: number) => void) {
    this.statusValue.configured = Boolean(url);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (this.url) this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.statusValue.connected = false;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "worker stopping");
  }

  status(): BlockWatcherStatus { return { ...this.statusValue }; }

  private connect(): void {
    if (this.stopped || !this.url) return;
    let socket: WebSocket;
    try { socket = new WebSocket(this.url); }
    catch (error) { this.scheduleReconnect(error); return; }
    this.socket = socket;
    socket.onopen = () => {
      this.statusValue.connected = true;
      this.statusValue.lastError = null;
      this.reconnectDelay = RECONNECT_MIN_MS;
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newHeads"] }));
    };
    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as { method?: string; params?: { result?: { number?: string } }; error?: { message?: string } };
        if (payload.error) throw new Error(payload.error.message || "WebSocket subscription failed");
        const raw = payload.method === "eth_subscription" ? payload.params?.result?.number : undefined;
        if (!raw || !/^0x[0-9a-f]+$/i.test(raw)) return;
        const blockNumber = Number(BigInt(raw));
        if (!Number.isSafeInteger(blockNumber)) return;
        this.statusValue.lastBlockAt = new Date().toISOString();
        this.statusValue.lastBlockNumber = blockNumber;
        this.onBlock(blockNumber);
      } catch (error) {
        this.statusValue.lastError = safeErrorMessage(error, "WebSocket message was invalid");
      }
    };
    socket.onerror = () => { this.statusValue.lastError = "Provider WebSocket connection failed"; };
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.statusValue.connected = false;
      if (!this.stopped) this.scheduleReconnect(this.statusValue.lastError || "Provider WebSocket closed");
    };
  }

  private scheduleReconnect(error: unknown): void {
    this.statusValue.connected = false;
    this.statusValue.lastError = safeErrorMessage(error, "Provider WebSocket disconnected");
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(RECONNECT_MAX_MS, this.reconnectDelay * 2);
    this.statusValue.reconnects += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
