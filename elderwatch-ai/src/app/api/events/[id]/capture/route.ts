import { withAuth } from "@/lib/platform/auth";
import { updateVideoState } from "@/lib/platform/workflows";
export const PATCH = withAuth(async (req: Request, context: { params: Promise<{ id: string }> }) => {
  const { status, error } = await req.json(); await updateVideoState((await context.params).id, status, error); return Response.json({ updated: true });
});
