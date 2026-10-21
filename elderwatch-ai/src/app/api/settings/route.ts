import { withAuth } from "@/lib/platform/auth";
import { getSettings, updateSettings } from "@/lib/platform/settings";
export const GET = withAuth(async () => Response.json(await getSettings()));
export const PATCH = withAuth(async (req: Request) => Response.json(await updateSettings(await req.json())));
