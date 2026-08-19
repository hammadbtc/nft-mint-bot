import { safeErrorMessage } from "@/lib/safety";

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 15_000;
const STALE_AFTER_MS = 30_000;

export type BlockWatcherStatus = {
  configured: boolean;
  configuredProviders: number;
  activeProvider: string | null;
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

function envUrls(name: string): string[] {
  return (process.env[name] || "").split(",").map((value) => value.trim()).filter(Boolean);
}

export function webSocketProviderLabel(rawUrl: string): string {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    if (hostname.endsWith("alchemy.com")) return "Alchemy";
    if (hostname.endsWith("drpc.org")) return "dRPC";
    if (hostname.endsWith("quiknode.pro")) return "QuickNode";
    if (hostname.endsWith("chainstack.com")) return "Chainstack";
  } catch { /* sanitized fallback below */ }
  return "Custom WebSocket provider";
}

export function robinhoodWebSocketUrls(): string[] {
  const independent = [
    ...envUrls("ROBINHOOD_WS_URLS"),
    ...envUrls("ROBINHOOD_WS_URL"),
    ...envUrls("ROBINHOOD_DRPC_WS_URL"),
    ...envUrls("ROBINHOOD_QUICKNODE_WS_URL"),
    ...envUrls("ROBINHOOD_CHAINSTACK_WS_URL"),
  ];
  const key = process.env.ALCHEMY_API_KEY?.trim();
  const alchemy = key && key.length > 10 ? `wss://robinhood-mainnet.g.alchemy.com/v2/${key}` : null;
  return [...new Set([...independent, ...(alchemy ? [alchemy] : [])])];
}

/** Legacy single-URL accessor retained for callers outside the scheduler. */
export function robinhoodWebSocketUrl(): string | null {
  return robinhoodWebSocketUrls()[0] || null;
}

/** Standard eth_subscribe newHeads watcher. The official raw Nitro sequencer
 * feed is intended for a full node, so MintBot uses a production provider WS
 * here and retains its bounded HTTP readiness probe as failover. */
export class BlockWatcher {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  private connectedAt: number | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private readonly urls: string[];
  private nextProvider = 0;
  private statusValue: BlockWatcherStatus = {
    configured: false, configuredProviders: 0, activeProvider: null,
    connected: false, lastBlockAt: null,
    lastBlockNumber: null, lastError: null, reconnects: 0,
  };

  constructor(urls: string | string[] | null, private readonly onBlock: (blockNumber: number) => void) {
    this.urls = [...new Set(Array.isArray(urls) ? urls.filter(Boolean) : urls ? [urls] : [])];
    this.statusValue.configured = this.urls.length > 0;
    this.statusValue.configuredProviders = this.urls.length;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.staleTimer ||= setInterval(() => this.disconnectIfStale(), 10_000);
    if (this.urls.length) this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.reconnectTimer = null;
    this.staleTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.statusValue.connected = false;
    this.statusValue.activeProvider = null;
    this.connectedAt = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "worker stopping");
  }

  status(): BlockWatcherStatus { return { ...this.statusValue }; }

  private connect(): void {
    if (this.stopped || !this.urls.length) return;
    const url = this.urls[this.nextProvider % this.urls.length];
    this.nextProvider = (this.nextProvider + 1) % this.urls.length;
    this.statusValue.activeProvider = webSocketProviderLabel(url);
    let socket: WebSocket;
    try { socket = new WebSocket(url); }
    catch (error) { this.scheduleReconnect(error); return; }
    this.socket = socket;
    socket.onopen = () => {
      this.statusValue.connected = true;
      this.connectedAt = Date.now();
      this.statusValue.lastBlockAt = null;
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
      this.connectedAt = null;
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

  private disconnectIfStale(): void {
    if (!this.statusValue.connected || !this.socket || !this.connectedAt) return;
    const lastHeadAt = this.statusValue.lastBlockAt ? Date.parse(this.statusValue.lastBlockAt) : this.connectedAt;
    if (Date.now() - lastHeadAt <= STALE_AFTER_MS) return;
    this.statusValue.lastError = "Provider WebSocket stopped delivering fresh blocks";
    this.socket.close(4000, "stale block stream");
  }
}
