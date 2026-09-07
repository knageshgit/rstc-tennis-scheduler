"use client";

/**
 * The organiser's control over the results archive.
 *
 * Archiving is a separate act from publishing, and usually a separate day: the
 * schedule goes up on Friday evening, the mixer is scored on Saturday morning,
 * and somebody closes it out afterwards. So this panel does not depend on
 * having generated anything in this browser session. It offers whatever is on
 * the club link, and takes a code by hand for anything else.
 *
 * It also has to be undoable. The club is trialling the app with simulated
 * results, and an archive that could only be added to would fill up with
 * practice runs they had no way to clear.
 */
import { useState } from "react";
import Link from "next/link";

import { formatLabel, isoDate, type ArchiveEntry } from "@/lib/archive";
import { isValidEventId, normalizeEventId } from "@/lib/eventid";

export default function ArchivePanel({
  liveId,
  initial,
}: {
  liveId: string | null;
  initial: ArchiveEntry[];
}) {
  const [archive, setArchive] = useState<ArchiveEntry[]>(initial);
  const [code, setCode] = useState(liveId ?? "");
  // Today in the organiser's own timezone, which is the club's. The server
  // cannot work this out: it runs in UTC and would date a Saturday evening
  // mixer on the west coast as Sunday.
  const [date, setDate] = useState(() => isoDate(Date.now() - new Date().getTimezoneOffset() * 60000));
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const clean = normalizeEventId(code);
  const already = archive.find((e) => e.id === clean);

  async function send(method: "POST" | "DELETE", id: string, body?: { date: string }) {
    setBusy(id);
    setError("");
    setNote("");
    try {
      const res = await fetch("/api/admin/archive", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, ...body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "That did not work.");
      setArchive(data.archive ?? []);
      if (method === "POST") {
        const entry = data.entry as ArchiveEntry | undefined;
        setNote(
          entry && !entry.complete
            ? `Archived, but only ${entry.entered} of ${entry.total} matches were scored. The results page marks it partial.`
            : "Archived. It is on the results page now."
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="mx-auto w-full max-w-5xl px-4 pb-12">
      <div className="rounded-xl border border-black/10 p-5 dark:border-white/15">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-semibold">Results archive</h2>
          <Link
            href="/results"
            target="_blank"
            className="text-xs underline opacity-70 hover:opacity-100"
          >
            see the members&rsquo; page ↗
          </Link>
        </div>
        <p className="mt-1 text-xs opacity-60">
          File a tournament here once it is over and every score is in. It then appears on{" "}
          <span className="font-mono">/results</span>, which is the page to link from the club
          website. Archiving also stops an event expiring, so the leaderboard stays readable
          for good.
        </p>

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="text-xs">
            <span className="block opacity-60">Event code</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="ABC234"
              maxLength={12}
              className="mt-1 w-32 rounded-lg border border-black/15 px-2 py-1.5 font-mono tracking-widest dark:border-white/20 dark:bg-transparent"
            />
          </label>
          <label className="text-xs">
            {/* The day it was played, which is often not the day it was
                published, and never the day it is archived. */}
            <span className="block opacity-60">Date played</span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="mt-1 rounded-lg border border-black/15 px-2 py-1.5 dark:border-white/20 dark:bg-transparent"
            />
          </label>
          <button
            onClick={() => send("POST", clean, { date })}
            disabled={!isValidEventId(clean) || busy !== ""}
            className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-40"
          >
            {busy === clean ? "Filing…" : already ? "Update this entry" : "Archive it"}
          </button>
          {liveId && clean !== liveId && (
            <button
              onClick={() => setCode(liveId)}
              className="text-xs underline opacity-60 hover:opacity-100"
            >
              use the live mixer ({liveId})
            </button>
          )}
        </div>

        {already && (
          <p className="mt-2 text-xs opacity-60">
            {clean} is already archived, under {already.date}. Filing it again recomputes the
            winner from the scores as they stand now.
          </p>
        )}
        {error && (
          <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">
            {error}
          </p>
        )}
        {note && <p className="mt-3 text-sm text-emerald-700 dark:text-emerald-400">{note}</p>}

        {archive.length > 0 && (
          <table className="mt-5 w-full text-sm">
            <thead>
              <tr className="border-b border-black/15 text-left text-xs uppercase tracking-wide opacity-60 dark:border-white/20">
                <th className="py-2 pr-3 font-medium">Date</th>
                <th className="py-2 pr-3 font-medium">Mixer</th>
                <th className="py-2 pr-3 font-medium">Format</th>
                <th className="py-2 pr-3 font-medium">Code</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {archive.map((e) => (
                <tr key={e.id} className="border-b border-black/5 last:border-0 dark:border-white/10">
                  <td className="py-2 pr-3 whitespace-nowrap tabular-nums">{e.date}</td>
                  <td className="py-2 pr-3">
                    {e.title || <span className="opacity-40">untitled</span>}
                    {!e.complete && (
                      <span className="ml-1 text-xs opacity-50">
                        ({e.entered}/{e.total} scored)
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3">{formatLabel(e.format)}</td>
                  <td className="py-2 pr-3 font-mono text-xs tracking-widest">{e.id}</td>
                  <td className="py-2 text-right whitespace-nowrap">
                    <button
                      onClick={() => send("DELETE", e.id)}
                      disabled={busy !== ""}
                      className="text-xs underline opacity-50 hover:opacity-100 disabled:opacity-30"
                    >
                      {busy === e.id ? "removing…" : "remove"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
