import { asActor, systemActor } from "./auth";
import { processNotifications } from "./notifications";
import { processVoiceWork } from "./voice";
import { expireSessions } from "./sessions";
const state = globalThis as typeof globalThis & { sensaraWorker?: ReturnType<typeof setInterval>; sensaraWorkerBusy?: boolean; sensaraWorkerRun?: () => Promise<unknown> };
// A retained timer must not keep an older voice/storage implementation after a reload.
state.sensaraWorkerRun = () => Promise.all([expireSessions(), processNotifications(), processVoiceWork()]);
export function startWorker() {
  if (state.sensaraWorker) clearInterval(state.sensaraWorker);
  state.sensaraWorker = setInterval(() => {
    if (state.sensaraWorkerBusy) return;
    state.sensaraWorkerBusy = true;
    void asActor(systemActor, async () => {
      try { await state.sensaraWorkerRun?.(); }
      catch { console.error("[Sensara worker] Storage or provider processing unavailable; will retry next poll."); }
      finally { state.sensaraWorkerBusy = false; }
    });
  }, 3000);
  state.sensaraWorker.unref();
}
