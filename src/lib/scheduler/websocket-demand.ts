export const WEBSOCKET_WAKE_LEAD_MS = 60 * 60 * 1_000;

export type WebSocketDemandJob = {
  dryRun: boolean;
  status: string;
  scheduledAt: string | null;
};

/** Decide from persisted job state whether the expensive block subscription is
 * launch-critical. Pending jobs without an authoritative time stay connected;
 * timed jobs wake at T-60m; armed/running/confirming work holds the connection
 * until it reaches a terminal state. */
export function webSocketDemandForJobs(
  jobs: WebSocketDemandJob[],
  now = Date.now(),
  wakeLeadMs = WEBSOCKET_WAKE_LEAD_MS,
): boolean {
  return jobs.some((job) => {
    if (job.dryRun) return false;
    if (["armed", "running", "confirming"].includes(job.status)) return true;
    if (job.status !== "pending") return false;
    if (!job.scheduledAt) return true;
    const scheduledAt = Date.parse(job.scheduledAt);
    return !Number.isFinite(scheduledAt) || scheduledAt <= now + wakeLeadMs;
  });
}
