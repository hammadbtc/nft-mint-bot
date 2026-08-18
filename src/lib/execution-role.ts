export type ExecutionRole = "web" | "worker" | "combined";

export function executionRole(value = process.env.MINTBOT_EXECUTION_ROLE): ExecutionRole {
  const normalized = value?.trim().toLowerCase() || "combined";
  if (normalized === "web" || normalized === "worker" || normalized === "combined") return normalized;
  throw new Error("MINTBOT_EXECUTION_ROLE must be web, worker, or combined");
}

export function runsExecutionWorker(role = executionRole()): boolean {
  return role === "worker" || role === "combined";
}

export function servesWeb(role = executionRole()): boolean {
  return role === "web" || role === "combined";
}
