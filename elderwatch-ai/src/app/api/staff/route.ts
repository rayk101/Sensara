import { withAuth, requireAdmin } from "@/lib/platform/auth";
import { getCaregivers, saveCaregiver } from "@/lib/platform/settings";
export const GET = withAuth(async () => { requireAdmin(); return Response.json({ staff: await getCaregivers() }); });
export const POST = withAuth(async (req: Request) => Response.json(await saveCaregiver(await req.json()), { status: 201 }));
