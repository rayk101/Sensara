import { getDb, isMongoEnabled } from "../mongodb";
import { getSafetyEvent } from "../db/events";
import { ApiError } from "./auth";
export async function updateVideoState(id: string, status: string, error?: string) {
  if (!["recording", "captured", "uploading", "partial", "unavailable", "failed"].includes(status)) throw new ApiError(400, "Invalid capture state");
  const event = await getSafetyEvent(id);
  if (!event || event.severity !== "urgent") throw new ApiError(404, "Urgent incident not found");
  if (event.workflow?.video.status === "available") return;
  const value = { status, updatedAt: new Date().toISOString(), ...(error ? { error: String(error).slice(0, 200) } : {}) };
  if (!isMongoEnabled()) { if (event.workflow) event.workflow.video = value; }
  else await (await getDb()).collection("safety_events").updateOne({ idempotencyKey: event.idempotencyKey, "workflow.video.status": { $ne: "available" } }, { $set: { "workflow.video": value } });
}
