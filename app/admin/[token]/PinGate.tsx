"use client";

/**
 * The PIN box shown when the secret path is right but this device has not been
 * unlocked yet.
 *
 * The PIN never reaches the browser: it is checked on the server, which answers
 * with an httpOnly cookie. So the worst this component can leak is whatever the
 * organiser types into it. On success it refreshes rather than navigating,
 * because the same URL now renders the generator.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function PinGate({ token }: { token: string }) {
  const router = useRouter();
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/admin/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, pin }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "That PIN is not right.");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPin("");
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-sm flex-col justify-center px-4">
      <h1 className="text-xl font-bold">🎾 Organiser</h1>
      <p className="mt-2 text-sm opacity-70">
        Enter the organiser PIN to build and publish a schedule. This device will stay
        unlocked for a month.
      </p>

      <form onSubmit={submit} className="mt-6">
        <label htmlFor="pin" className="text-sm font-medium">
          PIN
        </label>
        <input
          id="pin"
          type="password"
          inputMode="numeric"
          autoComplete="current-password"
          autoFocus
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          className="mt-1 w-full rounded-lg border border-black/15 bg-transparent px-3 py-2.5 text-lg tracking-[0.3em] dark:border-white/20"
        />
        <button
          type="submit"
          disabled={busy || !pin}
          className="mt-3 w-full rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
        >
          {busy ? "Checking…" : "Unlock"}
        </button>
      </form>

      {error && (
        <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </p>
      )}

      <p className="mt-8 text-xs opacity-50">
        Looking for the schedule or the leaderboard?{" "}
        <Link href="/" className="underline">
          The club page is here.
        </Link>
      </p>
    </main>
  );
}
