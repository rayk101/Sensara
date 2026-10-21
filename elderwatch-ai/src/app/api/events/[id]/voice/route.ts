import { withAuth } from "@/lib/platform/auth";
import { incidentSpeech, recordVoicePlayback } from "@/lib/platform/voice";
type Context = { params: Promise<{ id: string }> };
export const POST = withAuth(async (_req: Request, context: Context) => new Response(Buffer.from(await incidentSpeech((await context.params).id)), { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "private, no-store" } }));
export const PATCH = withAuth(async (req: Request, context: Context) => {
  await recordVoicePlayback((await context.params).id, (await req.json()).status); return Response.json({ recorded: true });
});
