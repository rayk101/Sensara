import { withAuth } from "@/lib/platform/auth";
import { isS3Configured } from "@/lib/s3";
import { prepareUpload } from "@/lib/platform/uploads";
import { getSettings } from "@/lib/platform/settings";
export const dynamic = "force-dynamic";
export const GET = withAuth(async () => Response.json({ s3Configured: isS3Configured() && (await getSettings()).recordingEnabled }));
export const POST = withAuth(async (req: Request) => Response.json(await prepareUpload(await req.json())));
