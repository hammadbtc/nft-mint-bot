export function phaseHasEligibleWallet(results: Array<{ status: string } | undefined>): boolean {
  return results.some((result) => result?.status === "eligible");
}

export function phaseIsRunnable(status: string): boolean {
  return status === "live" || status === "upcoming";
}
