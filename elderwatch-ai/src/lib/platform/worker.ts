import { asActor, systemActor } from "./auth";
import { processNotifications } from "./notifications";
import { expireSessions } from "./sessions";
const state = globalThis as typeof globalThis & { sensaraWorker?: ReturnType<typeof setInterval>; sensaraWorkerBusy?: boolean };
export function startWorker() {
  if (state.sensaraWorker) return;
  state.sensaraWorker = setInterval(() => {
    if (state.sensaraWorkerBusy) return;
    state.sensaraWorkerBusy = true;
    void asActor(systemActor, async () => {
      try { await expireSessions(); await processNotifications(); }
      catch { console.error("[Sensara worker] Storage or provider processing unavailable; will retry next poll."); }
      finally { state.sensaraWorkerBusy = false; }
    });
  }, 3000);
  state.sensaraWorker.unref();
}
