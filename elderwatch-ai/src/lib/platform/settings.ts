import { ApiError, requireAdmin } from "./auth";
import { readRecord, writeRecord, listRecords } from "./store";
import { identifier, text } from "./validation";
export interface AppSettings {
  id: "default"; recordingEnabled: boolean; voiceEnabled: boolean; notificationsEnabled: boolean;
  retentionDays: number; reminderPolicy: "none"; dataMode: "demo" | "private"; updatedAt: string;
}
export const defaultSettings: AppSettings = { id: "default", recordingEnabled: true, voiceEnabled: true,
  notificationsEnabled: false, retentionDays: 7, reminderPolicy: "none", dataMode: "private", updatedAt: new Date(0).toISOString() };
export async function getSettings() { return await readRecord<AppSettings>("application_settings", "default") ?? defaultSettings; }
export async function updateSettings(input: Partial<AppSettings>) {
  requireAdmin();
  const prior = await getSettings();
  for (const key of ["recordingEnabled", "voiceEnabled", "notificationsEnabled"] as const) if (input[key] !== undefined && typeof input[key] !== "boolean") throw new ApiError(400, "Invalid preference");
  const retentionDays = input.retentionDays ?? prior.retentionDays;
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) throw new ApiError(400, "Retention must be 1–365 days");
  if (input.dataMode && !["demo", "private"].includes(input.dataMode)) throw new ApiError(400, "Invalid data mode");
  return writeRecord("application_settings", { ...prior, recordingEnabled: input.recordingEnabled ?? prior.recordingEnabled,
    voiceEnabled: input.voiceEnabled ?? prior.voiceEnabled, notificationsEnabled: input.notificationsEnabled ?? prior.notificationsEnabled,
    retentionDays, dataMode: input.dataMode ?? prior.dataMode, updatedAt: new Date().toISOString() });
}
export interface Caregiver {
  id: string; name: string; active: boolean; patientIds: string[];
  channel: "imessage" | "sms" | "email"; destination: string; urgentAlerts: boolean;
}
export const getCaregivers = () => listRecords<Caregiver>("staff");
export async function saveCaregiver(input: Caregiver) {
  requireAdmin();
  const id = identifier(input.id, "staff ID"), name = text(input.name, "staff name");
  if (!["imessage", "sms", "email"].includes(input.channel)) throw new ApiError(400, "Unsupported messaging channel");
  const destination = text(input.destination, "destination");
  if (input.channel === "email" ? !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destination) : !/^\+[1-9]\d{7,14}$/.test(destination)) throw new ApiError(400, "Invalid destination");
  if (!Array.isArray(input.patientIds) || input.patientIds.length > 100 || typeof input.active !== "boolean" || typeof input.urgentAlerts !== "boolean") throw new ApiError(400, "Invalid recipient preferences");
  return writeRecord("staff", { id, name, destination, channel: input.channel, active: input.active, urgentAlerts: input.urgentAlerts, patientIds: input.patientIds.map(v => identifier(v, "patient ID")) });
}
