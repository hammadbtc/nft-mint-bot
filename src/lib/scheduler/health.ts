const DEFAULT_STALE_AFTER_MS = 30_000;

export const WORKER_HEARTBEAT_KEY = "execution_worker_heartbeat";

export type WorkerRuntimeHeartbeat = {
  at: string;
  armedTimers: number;
  revalidationTimers: number;
  blockWatcherHealthy: boolean;
};

export function parseWorkerRuntimeHeartbeat(value: string | null | undefined): WorkerRuntimeHeartbeat | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<WorkerRuntimeHeartbeat>;
    if (!parsed.at || !Number.isFinite(Date.parse(parsed.at))) return null;
    return {
      at: parsed.at,
      armedTimers: Number.isSafeInteger(parsed.armedTimers) ? parsed.armedTimers! : 0,
      revalidationTimers: Number.isSafeInteger(parsed.revalidationTimers) ? parsed.revalidationTimers! : 0,
      blockWatcherHealthy: parsed.blockWatcherHealthy !== false,
    };
  } catch {
    return Number.isFinite(Date.parse(value)) ? { at: value, armedTimers: 0, revalidationTimers: 0, blockWatcherHealthy: true } : null;
  }
}

export function schedulerHeartbeatFresh(
  running: boolean,
  lastTickAt: string | null,
  now = Date.now(),
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
): boolean {
  if (!running || !lastTickAt) return false;
  const heartbeat = parseWorkerRuntimeHeartbeat(lastTickAt);
  const lastTickMs = Date.parse(heartbeat?.at || lastTickAt);
  return Number.isFinite(lastTickMs) && now - lastTickMs >= 0 && now - lastTickMs <= staleAfterMs;
}
