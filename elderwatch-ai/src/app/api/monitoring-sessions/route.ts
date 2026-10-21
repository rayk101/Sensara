import { withAuth } from "@/lib/platform/auth";
import { startSession } from "@/lib/platform/sessions";
export const POST = withAuth(async (req: Request) => Response.json(await startSession(await req.json()), { status: 201 }));
