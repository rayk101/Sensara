import { getDb, isMongoEnabled } from "@/lib/mongodb";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    if (!isMongoEnabled()) return Response.json({ ready: false }, { status: 503 });
    await (await getDb()).command({ ping: 1 });
    return Response.json({ ready: true }, { headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ ready: false }, { status: 503 }); }
}
