// Server-side only: credentials and the fixed recipient never enter the client bundle.
import type { SafetyEvent } from "./types";

export function isPhotonConfigured(): boolean {
  return !!(process.env.SPECTRUM_PROJECT_ID && process.env.SPECTRUM_PROJECT_SECRET &&
    /^\+[1-9]\d{7,14}$/.test(process.env.CAREGIVER_PHONE_NUMBER ?? ""));
}

export function photonErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.includes("Target not allowed for this project")) {
    return "Photon rejected this recipient. Enroll the exact phone number used by iMessage in your Photon project's Users page.";
  }
  return "Photon could not send the message. Check the project and enrolled iMessage number.";
}

export async function sendPhotonMessage(body: string): Promise<void> {
  if (!isPhotonConfigured()) throw new Error("Photon is not configured");
  const [{ Spectrum }, { imessage }] = await Promise.all([
    import("@spectrum-ts/core"), import("@spectrum-ts/imessage"),
  ]);
  const app = await Spectrum({
    projectId: process.env.SPECTRUM_PROJECT_ID!,
    projectSecret: process.env.SPECTRUM_PROJECT_SECRET!,
    providers: [imessage.config()],
    signal: AbortSignal.timeout(15_000),
    telemetry: false,
    options: { logLevel: "error" },
  });
  try {
    const provider = imessage(app);
    const recipient = await provider.user(process.env.CAREGIVER_PHONE_NUMBER!);
    const conversation = await provider.space.create(recipient);
    await conversation.send(body);
  } finally {
    await app.stop();
  }
}

// One process-local cooldown per resident/event, including in-flight requests.
// Failed sends release the reservation; successful sends are suppressed for 2 minutes.
export function createPhotonAlertSender(send: (body: string) => Promise<void>, now = Date.now) {
  const sentAt = new Map<string, number>();
  const pending = new Set<string>();
  return async (event: SafetyEvent): Promise<void> => {
    if (event.severity !== "urgent") return;
    const key = `${event.residentId}:${event.eventType}`;
    const time = now();
    for (const [id, timestamp] of sentAt) {
      if (time - timestamp >= 120_000) sentAt.delete(id);
    }
    if (pending.has(key) || sentAt.has(key)) return;
    pending.add(key);
    try {
      await send(`Sensara DEMO urgent alert: ${event.eventType.replace(/_/g, " ")}. Open the Sensara dashboard to review. Prototype only.`);
      sentAt.set(key, now());
    } finally {
      pending.delete(key);
    }
  };
}

const sendAlert = createPhotonAlertSender(sendPhotonMessage);

export async function sendUrgentPhotonAlert(event: SafetyEvent): Promise<void> {
  if (!isPhotonConfigured()) return;
  try {
    await sendAlert(event);
  } catch (error) {
    // Do not log SDK errors: they may contain credentials or private message data.
    console.error("[Photon]", photonErrorMessage(error));
  }
}
