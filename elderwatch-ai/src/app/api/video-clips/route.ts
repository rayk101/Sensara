import { withAuth, ApiError } from "@/lib/platform/auth";
import { completeUpload } from "@/lib/platform/uploads";
import { getVideoClipsByResident } from "@/lib/db/videoClips";
export const dynamic = "force-dynamic";
export const POST = withAuth(async (req: Request) => Response.json(await completeUpload(await req.json()), { status: 201 }));
export const GET = withAuth(async (req: Request) => {
  const id = new URL(req.url).searchParams.get("residentId");
  if (!id) throw new ApiError(400, "residentId is required");
  return Response.json({ clips: await getVideoClipsByResident(id) });
});
