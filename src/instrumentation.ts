export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startScheduler } = await import("@/lib/scheduler");
    const { restartAllFcfsWatchers } = await import("@/lib/engine/fcfs");
    startScheduler();
    await restartAllFcfsWatchers();
    console.log("✅ MintBot scheduler + FCFS watchers registered");
  }
}
