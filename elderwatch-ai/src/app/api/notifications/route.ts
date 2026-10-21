import { withAuth } from "@/lib/platform/auth";
import { listNotifications } from "@/lib/platform/notifications";
export const GET = withAuth(async () => Response.json({ notifications: await listNotifications() }));
