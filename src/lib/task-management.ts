export function mintTaskMutationError(status: string, hasAttempt: boolean): string | null {
  if (status !== "pending") return "Only pending, unsigned mint tasks can be changed";
  if (hasAttempt) return "This task has transaction history and must be retained for recovery and audit";
  return null;
}
