import { withAuth, ApiError } from "@/lib/platform/auth";
import { getVideoClipById } from "@/lib/db/videoClips";
import { linkVideoClipToEvent } from "@/lib/db/events";
export const PATCH = withAuth(async (req: Request, context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const { clipId } = await req.json();
  const clip = typeof clipId === "string" ? await getVideoClipById(clipId) : null;
  if (!clip || clip.eventId !== id || clip.uploadStatus !== "uploaded") throw new ApiError(404, "Verified incident clip not found");
  return Response.json(await linkVideoClipToEvent(id, clipId, clip));
});
