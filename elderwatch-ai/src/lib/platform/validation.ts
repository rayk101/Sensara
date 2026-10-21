import { ApiError } from "./auth";
export function text(value: unknown, name: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ApiError(400, `Invalid ${name}`);
  return value.trim();
}
export function identifier(value: unknown, name = "identifier"): string {
  const result = text(value, name, 100);
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new ApiError(400, `Invalid ${name}`);
  return result;
}
export function isoTime(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new ApiError(400, "Invalid timestamp");
  return new Date(value).toISOString();
}
