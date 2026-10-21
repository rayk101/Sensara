import { withAuth } from "@/lib/platform/auth";
import { retryNotification } from "@/lib/platform/notifications";
export const POST = withAuth(async (_req: Request, context: { params: Promise<{ id: string }> }) => {
  await retryNotification((await context.params).id); return Response.json({ queued: true });
});
