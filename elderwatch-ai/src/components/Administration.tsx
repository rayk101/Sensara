"use client";
import { useEffect, useState } from "react";
import type { ResidentProfile } from "@/lib/types";
type Preferences = { recordingEnabled: boolean; voiceEnabled: boolean; notificationsEnabled: boolean; retentionDays: number; dataMode: "demo" | "private" };
export default function Administration({ residents, onSaved }: { residents: ResidentProfile[]; onSaved: () => void }) {
  const [admin, setAdmin] = useState(false);
  const [settings, setSettings] = useState<Preferences | null>(null);
  const [selected, setSelected] = useState("");
  const [message, setMessage] = useState("");
  const patient = residents.find(p => p.id === selected);
  useEffect(() => { void fetch("/api/auth/me").then(r => r.json()).then(u => setAdmin(u.role === "admin")).catch(() => {}); void fetch("/api/settings").then(r => r.json()).then(setSettings).catch(() => {}); }, []);
  if (!admin || !settings) return null;
  const save = async (url: string, body: object, method = "PATCH") => {
    const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error((await response.json()).error ?? "Save failed");
    setMessage("Saved to the database.");
  };
  return <details className="my-4 rounded-xl border bg-white p-4 text-sm"><summary className="cursor-pointer font-semibold">Patient records and integration preferences</summary>
    <p role="status" className="my-2">{message}</p>
    <form onSubmit={async e => { e.preventDefault(); try { await save("/api/settings", settings); } catch (error) { setMessage(String(error)); } }} className="my-3 flex flex-wrap gap-3">
      {(["recordingEnabled", "voiceEnabled", "notificationsEnabled"] as const).map((key, i) => <label key={key}><input type="checkbox" checked={settings[key]} onChange={e => setSettings({ ...settings, [key]: e.target.checked })} /> {["Record incident video", "Generate voice alerts", "Send configured notifications"][i]}</label>)}
      <label>Playback access (days) <input className="w-16 border" type="number" min="1" max="365" value={settings.retentionDays} onChange={e => setSettings({ ...settings, retentionDays: Number(e.target.value) })} /></label>
      <label>External alert content <select className="border" value={settings.dataMode} onChange={e => setSettings({ ...settings, dataMode: e.target.value as Preferences["dataMode"] })}><option value="private">Generic secure-dashboard notice</option><option value="demo">Fictional patient details</option></select></label>
      <button className="rounded border px-3 py-1">Save preferences</button>
    </form>
    <p className="text-xs text-sensara-warm-600">Access expiry does not delete S3 objects. Bucket lifecycle retention is managed in AWS. Reminders are disabled. Use fictional details only in demo mode.</p>
    <label className="mt-4 block">Patient <select className="ml-2 border" value={selected} onChange={e => { setSelected(e.target.value); setMessage(""); }}><option value="">Create patient</option>{residents.map(p => <option key={p.id} value={p.id}>{p.name}{p.active === false ? " (inactive)" : ""}</option>)}</select></label>
    <form key={selected} className="my-3 grid gap-3 sm:grid-cols-3" onSubmit={async e => {
      e.preventDefault(); const form = new FormData(e.currentTarget);
      const body = { id: patient?.id ?? crypto.randomUUID(), name: form.get("name"), room: form.get("room"), age: Number(form.get("age")), mobility: form.get("mobility"), fallRisk: form.get("fallRisk"), careNotes: form.get("careNotes"), active: form.has("active"), monitoringConfig: { recordingEnabled: form.has("recording"), audioEnabled: form.has("audio") } };
      try { await save(patient ? `/api/residents/${patient.id}` : "/api/residents", body, patient ? "PATCH" : "POST"); onSaved(); } catch (error) { setMessage(String(error)); }
    }}>
      <label>Name <input name="name" required maxLength={200} defaultValue={patient?.name} className="block w-full border p-1" /></label>
      <label>Room <input name="room" required maxLength={200} defaultValue={patient?.room} className="block w-full border p-1" /></label>
      <label>Age <input name="age" type="number" min="0" max="130" required defaultValue={patient?.age} className="block w-full border p-1" /></label>
      <label>Mobility <input name="mobility" required defaultValue={patient?.mobility ?? "Independent"} className="block w-full border p-1" /></label>
      <label>Recorded fall risk <select name="fallRisk" defaultValue={patient?.fallRisk ?? "Low"} className="block w-full border p-1"><option>Low</option><option>Medium</option><option>High</option></select></label>
      <label>Care notes <input name="careNotes" maxLength={2000} defaultValue={patient?.careNotes} className="block w-full border p-1" /></label>
      <label><input type="checkbox" name="active" defaultChecked={patient?.active !== false} /> Active patient</label>
      <label><input type="checkbox" name="recording" defaultChecked={patient?.monitoringConfig?.recordingEnabled ?? true} /> Permit incident recording</label>
      <label><input type="checkbox" name="audio" defaultChecked={patient?.monitoringConfig?.audioEnabled ?? false} /> Permit audio monitoring</label>
      <button className="rounded border px-3 py-2">Save patient record</button>
    </form>
  </details>;
}
