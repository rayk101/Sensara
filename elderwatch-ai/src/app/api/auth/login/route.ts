import { authenticatePassword, checkOrigin, signSession } from "@/lib/platform/auth";
const attempts = new Map<string, { count: number; until: number }>();
export async function POST(req: Request) {
  try {
    checkOrigin(req);
    const body = await req.json();
    if (typeof body.id !== "string" || typeof body.password !== "string" || body.id.length > 100 || body.password.length > 256) return Response.json({ error: "Invalid credentials" }, { status: 400 });
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
    if (attempts.size > 1000) return Response.json({ error: "Try again later" }, { status: 429 });
    const entry = attempts.get(body.id) ?? { count: 0, until: now + 300_000 };
    if (++entry.count > 10) return Response.json({ error: "Try again in five minutes" }, { status: 429 });
    attempts.set(body.id, entry);
    const actor = authenticatePassword(body.id, body.password);
    if (!actor) return Response.json({ error: "Invalid credentials" }, { status: 401 });
    const secure = new URL(req.url).protocol === "https:" || !!process.env.RAILWAY_ENVIRONMENT_ID;
    return Response.json({ user: actor }, { headers: { "Set-Cookie": `sensara_session=${signSession(actor)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure ? "; Secure" : ""}`, "Cache-Control": "no-store" } });
  } catch { return Response.json({ error: "Sign-in unavailable" }, { status: 503 }); }
}
