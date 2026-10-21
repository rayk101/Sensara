import { withAuth, ApiError } from "@/lib/platform/auth";
import { submitDetection } from "@/lib/platform/incidents";
import { monitoringState } from "@/lib/platform/monitoring";
export const GET = withAuth(async () => Response.json({ patients: await monitoringState() }));
export const POST = withAuth(async (req: Request) => {
  const body = await req.json();
  if (!["live_camera", "multi_feed_demo"].includes(body.source)) throw new ApiError(400, "Unsupported observation source");
  return Response.json({ event: await submitDetection(body) });
});
