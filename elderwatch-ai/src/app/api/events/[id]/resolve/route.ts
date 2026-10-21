import { withAuth, currentActor } from "@/lib/platform/auth";
import { transitionIncident } from "@/lib/db/events";
export const PATCH = withAuth(async (_req: Request, context: { params: Promise<{ id: string }> }) => {
  const value = await transitionIncident((await context.params).id, "resolved", currentActor().name);
  return value ? Response.json(value) : Response.json({ error: "Incident not found" }, { status: 404 });
});
