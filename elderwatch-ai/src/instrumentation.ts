export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NOTIFICATION_WORKER_ENABLED === "true") {
    const { startWorker } = await import("./lib/platform/worker");
    startWorker();
  }
}
