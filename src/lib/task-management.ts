export function mintTaskMutationError(status: string, hasAttempt: boolean): string | null {
  if (status !== "pending") return "Only pending, unsigned mint tasks can be changed";
  if (hasAttempt) return "This task has transaction history and must be retained for recovery and audit";
  return null;
}

export function firstTaskPerWallet<T extends { walletId: string }>(tasks: T[]): T[] {
  const selected: T[] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.walletId)) continue;
    seen.add(task.walletId);
    selected.push(task);
  }
  return selected;
}
