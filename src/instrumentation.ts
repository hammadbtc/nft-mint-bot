export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { runsExecutionWorker } = await import("@/lib/execution-role");
    if (!runsExecutionWorker()) {
      console.log("ℹ️ MintBot web role registered without an embedded scheduler");
      return;
    }
    const { startScheduler } = await import("@/lib/scheduler");
    startScheduler();
    console.log("✅ MintBot scheduler registered");
  }
}
