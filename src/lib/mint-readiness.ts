export type ReadinessCheck = { key: string; status: "pass" | "warn" | "fail"; detail: string };

export function summarizeReadiness(checks: ReadinessCheck[]) {
  const failed = checks.filter((item) => item.status === "fail");
  const warnings = checks.filter((item) => item.status === "warn");
  return { status: failed.length ? "blocked" as const : warnings.length ? "warning" as const : "ready" as const, failed: failed.length, warnings: warnings.length };
}

