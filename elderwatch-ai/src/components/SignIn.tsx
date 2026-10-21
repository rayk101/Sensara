"use client";
import { useState } from "react";
export default function SignIn() {
  const [error, setError] = useState("");
  return <main className="mx-auto max-w-sm p-8"><h1 className="mb-4 text-xl font-semibold">Sign in to Sensara</h1><form className="flex flex-col gap-3" onSubmit={async e => {
    e.preventDefault(); const form = new FormData(e.currentTarget); setError("");
    try { const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: form.get("id"), password: form.get("password") }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error); window.location.reload();
    } catch (err) { setError(err instanceof Error ? err.message : "Sign-in failed"); }
  }}><label>Staff ID<input className="block w-full rounded border p-2" name="id" autoComplete="username" required /></label><label>Password<input className="block w-full rounded border p-2" name="password" type="password" autoComplete="current-password" required /></label><button className="rounded bg-sensara-forest-700 p-2 text-white">Sign in</button><p role="alert">{error}</p></form></main>;
}
