import { checkOrigin } from "@/lib/platform/auth";
export async function POST(req: Request) {
  try { checkOrigin(req); } catch { return Response.json({ error: "Forbidden" }, { status: 403 }); }
  return Response.json({ signedOut: true }, { headers: { "Set-Cookie": "sensara_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" } });
}
