import type { MintPhase, MintPhaseEligibility } from "@/lib/adapters/types";

export const MANUAL_OPEN_POLL_MS = 2_500;

export function selectExecutionPhase(phases: MintPhase[]): MintPhase {
  const live = phases.find((phase) => phase.status === "live");
  if (live) return live;
  const upcoming = phases
    .filter((phase) => phase.status === "upcoming" && (phase.manualOpen || (phase.startsAt && Number.isFinite(Date.parse(phase.startsAt)))))
    .sort((a, b) => phaseOrder(a) - phaseOrder(b))[0];
  if (upcoming) return upcoming;
  throw new Error("The reviewed mint has ended or has no runnable phase");
}

export function selectEligibleExecutionPhase(phases: MintPhase[], eligibility: MintPhaseEligibility[]): MintPhase {
  const eligibilityById = new Map(eligibility.map((item) => [item.phaseId, item]));
  const live = phases.filter((phase) => phase.status === "live");
  const upcoming = phases
    .filter((phase) => phase.status === "upcoming" && (phase.manualOpen || (phase.startsAt && Number.isFinite(Date.parse(phase.startsAt)))))
    .sort((a, b) => phaseOrder(a) - phaseOrder(b));
  for (const phase of [...live, ...upcoming]) {
    const result = eligibilityById.get(phase.id);
    if (result?.status === "eligible") return phase;
    if (!result || result.status === "unknown" || result.status === "unsupported") {
      throw new Error(result?.reason || `${phase.name} eligibility could not be verified`);
    }
  }
  const reasons = phases.flatMap((phase) => {
    const result = eligibilityById.get(phase.id);
    return result?.reason ? [`${phase.name}: ${result.reason}`] : [];
  });
  throw new Error(reasons[0] || "No live or upcoming phase is eligible for this wallet");
}

function phaseOrder(phase: MintPhase): number {
  return phase.startsAt && Number.isFinite(Date.parse(phase.startsAt)) ? Date.parse(phase.startsAt) : Number.POSITIVE_INFINITY;
}

export function selectRequestedExecutionPhase(phases: MintPhase[], eligibility: MintPhaseEligibility[], phaseId: string): MintPhase {
  const phase = phases.find((item) => item.id === phaseId);
  if (!phase) throw new Error("The selected mint phase is no longer available");
  const result = eligibility.find((item) => item.phaseId === phaseId);
  if (result?.status !== "eligible") throw new Error(result?.reason || `${phase.name} eligibility could not be verified`);
  if (!["live", "upcoming"].includes(phase.status)) throw new Error(`${phase.name} is not runnable`);
  return phase;
}

/** Return the next conservative poll time for an owner-opened on-chain phase. */
export function manualOpenRetryAt(phase: MintPhase, now = Date.now()): string | null {
  return phase.status === "upcoming" && phase.manualOpen
    ? new Date(now + MANUAL_OPEN_POLL_MS).toISOString()
    : null;
}

export function isTransientRpcReadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code || "") : "";
  return /TIMEOUT|ETIMEDOUT|ECONNRESET|ECONNREFUSED|SERVER_ERROR|NETWORK_ERROR|request\.send|failed to fetch|socket hang up|too many requests|\b429\b/i.test(`${code} ${message}`);
}

export function recoveredJobStatus(kind: "approval" | "mint", transactionConfirmed: boolean): "pending" | "completed" | "failed" {
  if (!transactionConfirmed) return "failed";
  return kind === "approval" ? "pending" : "completed";
}
