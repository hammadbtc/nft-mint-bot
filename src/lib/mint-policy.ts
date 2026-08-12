import type { MintPhase } from "@/lib/adapters/types";

export function selectExecutionPhase(phases: MintPhase[]): MintPhase {
  const live = phases.find((phase) => phase.status === "live");
  if (live) return live;
  const upcoming = phases
    .filter((phase) => phase.status === "upcoming" && phase.startsAt && Number.isFinite(Date.parse(phase.startsAt)))
    .sort((a, b) => Date.parse(a.startsAt!) - Date.parse(b.startsAt!))[0];
  if (upcoming) return upcoming;
  throw new Error("The reviewed mint has ended or has no runnable phase");
}

export function recoveredJobStatus(kind: "approval" | "mint", transactionConfirmed: boolean): "pending" | "completed" | "failed" {
  if (!transactionConfirmed) return "failed";
  return kind === "approval" ? "pending" : "completed";
}
