import { withAuth } from "@/lib/platform/auth";
import { getSession, updateSession } from "@/lib/platform/sessions";
type Context = { params: Promise<{ id: string }> };
export const GET = withAuth(async (_req: Request, context: Context) => Response.json(await getSession((await context.params).id)));
export const PATCH = withAuth(async (req: Request, context: Context) => { const body = await req.json(); return Response.json(await updateSession((await context.params).id, body.status, body.state)); });
