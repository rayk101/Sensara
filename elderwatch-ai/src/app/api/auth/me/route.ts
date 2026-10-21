import { withAuth, currentActor } from "@/lib/platform/auth";
export const GET = withAuth(async () => Response.json(currentActor()));
