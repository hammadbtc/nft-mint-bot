const DEFAULT_STALE_AFTER_MS = 30_000;

export const WORKER_HEARTBEAT_KEY = "execution_worker_heartbeat";

export function schedulerHeartbeatFresh(
  running: boolean,
  lastTickAt: string | null,
  now = Date.now(),
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
): boolean {
  if (!running || !lastTickAt) return false;
  const lastTickMs = Date.parse(lastTickAt);
  return Number.isFinite(lastTickMs) && now - lastTickMs >= 0 && now - lastTickMs <= staleAfterMs;
}
