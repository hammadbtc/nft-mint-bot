import { executionRole, runsExecutionWorker } from "@/lib/execution-role";
import { schedulerStatus, startScheduler, stopScheduler } from "@/lib/scheduler";

const role = executionRole();
if (!runsExecutionWorker(role)) throw new Error("The worker entrypoint requires MINTBOT_EXECUTION_ROLE=worker or combined");

startScheduler();
console.log(`✅ MintBot execution worker started (${role})`);

const statusInterval = setInterval(() => {
  const status = schedulerStatus();
  if (!status.healthy) console.error("MintBot execution worker is unhealthy", status);
}, 10_000);

function shutdown(signal: string): void {
  console.log(`MintBot execution worker received ${signal}`);
  clearInterval(statusInterval);
  stopScheduler();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
