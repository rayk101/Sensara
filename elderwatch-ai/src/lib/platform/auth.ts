import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, timingSafeEqual, scryptSync } from "node:crypto";

export interface Actor { id: string; name: string; role: "admin" | "caregiver" | "viewer"; patientIds: string[] }
interface StaffCredential extends Actor { passwordHash: string; active?: boolean }
export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
const context = new AsyncLocalStorage<Actor>();
export const systemActor: Actor = { id: "system", name: "System", role: "admin", patientIds: [] };
export const currentActor = () => context.getStore() ?? systemActor;
export const asActor = <T>(actor: Actor, action: () => T): T => context.run(actor, action);
export function assertPatient(id: string) {
  const actor = currentActor();
  if (actor.role !== "admin" && !actor.patientIds.includes(id)) throw new ApiError(404, "Patient not found");
}
export function patientScope(field = "residentId"): Record<string, unknown> {
  const actor = currentActor();
  return actor.role === "admin" ? {} : { [field]: { $in: actor.patientIds } };
}
export function requireAdmin() {
  if (currentActor().role !== "admin") throw new ApiError(403, "Administrator access required");
}
function credentials(): StaffCredential[] {
  try { const value = JSON.parse(process.env.STAFF_ACCOUNTS_JSON ?? "[]"); return Array.isArray(value) ? value : []; }
  catch { return []; }
}
function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function authenticatePassword(id: string, password: string): Actor | null {
  const user = credentials().find(u => u.id === id && u.active !== false);
  const [salt, hash] = (user?.passwordHash ?? "invalid:invalid").split(":");
  const derived = scryptSync(password, salt, 64).toString("hex");
  if (!user || !safeEqual(derived, hash ?? "")) return null;
  return { id: user.id, name: user.name, role: user.role, patientIds: user.patientIds };
}
export function signSession(actor: Actor) {
  const secret = process.env.AUTH_SESSION_SECRET;
  if (!secret || secret.length < 32) throw new ApiError(503, "Authentication is not configured");
  const payload = Buffer.from(JSON.stringify({ id: actor.id, expires: Date.now() + 8 * 3600_000 })).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}
export function requestActor(req: Request): Actor {
  const host = new URL(req.url).hostname;
  if (process.env.LOCAL_DEMO_MODE === "true" && !process.env.RAILWAY_ENVIRONMENT_ID &&
      ["localhost", "127.0.0.1", "[::1]"].includes(host)) {
    return { id: "demo-caregiver", name: "Demo Caregiver", role: "admin", patientIds: [] };
  }
  const token = req.headers.get("cookie")?.split(";").map(v => v.trim()).find(v => v.startsWith("sensara_session="))?.slice(16);
  const [payload, signature] = token?.split(".") ?? [];
  const secret = process.env.AUTH_SESSION_SECRET;
  if (!payload || !signature || !secret || secret.length < 32) throw new ApiError(401, "Sign in required");
  if (!safeEqual(signature, createHmac("sha256", secret).update(payload).digest("base64url"))) throw new ApiError(401, "Sign in required");
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    const user = credentials().find(u => u.id === data.id && u.active !== false);
    if (!user || data.expires <= Date.now() || !["admin", "caregiver", "viewer"].includes(user.role) || !Array.isArray(user.patientIds)) throw new Error();
    return { id: user.id, name: user.name, role: user.role, patientIds: user.patientIds };
  } catch { throw new ApiError(401, "Sign in required"); }
}
export function checkOrigin(req: Request) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  const origin = req.headers.get("origin");
  const url = new URL(req.url);
  const localHost = req.headers.get("host");
  const localOrigin = localHost && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(localHost) ? `${url.protocol}//${localHost}` : null;
  const allowed = process.env.APP_ORIGIN || url.origin;
  if (req.headers.get("sec-fetch-site") === "cross-site" || (origin && origin !== allowed && !(process.env.LOCAL_DEMO_MODE === "true" && !process.env.RAILWAY_ENVIRONMENT_ID && origin === localOrigin))) {
    throw new ApiError(403, "Cross-origin request denied");
  }
}
export function withAuth<A extends unknown[]>(handler: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      const req = args[0] as Request;
      checkOrigin(req);
      const actor = requestActor(req);
      if (process.env.NODE_ENV === "production" && !process.env.MONGODB_URI) throw new ApiError(503, "Persistent database is not configured");
      if (actor.role === "viewer" && !["GET", "HEAD"].includes(req.method)) throw new ApiError(403, "Read-only account");
      return await asActor(actor, async () => {
        const id = new URL(req.url).searchParams.get("residentId");
        if (id) assertPatient(id);
        if (req.headers.get("content-type")?.includes("application/json")) {
          const body = await req.clone().json().catch(() => null);
          if (typeof body?.residentId === "string") assertPatient(body.residentId);
        }
        const response = await handler(...args);
        response.headers.set("Cache-Control", "private, no-store");
        response.headers.set("X-Content-Type-Options", "nosniff");
        return response;
      });
    } catch (error) {
      return Response.json({ error: error instanceof ApiError ? error.message : "Request failed" }, { status: error instanceof ApiError ? error.status : 500 });
    }
  };
}
