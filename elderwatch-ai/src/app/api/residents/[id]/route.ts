import { withAuth } from "@/lib/platform/auth";
import { getResidentById, saveResident } from "@/lib/db/residents";
type Context = { params: Promise<{ id: string }> };
export const GET = withAuth(async (_req: Request, context: Context) => {
  const patient = await getResidentById((await context.params).id);
  return patient ? Response.json(patient) : Response.json({ error: "Patient not found" }, { status: 404 });
});
export const PATCH = withAuth(async (req: Request, context: Context) => Response.json(await saveResident(await req.json(), (await context.params).id)));
