"use client";

/**
 * The organiser's controls for one tournament: take the whole record away, and
 * moderate what members have posted to it.
 *
 * These sit together because they answer the same question, "what is on this
 * mixer and what do I want to do about it". Both work on whichever event is on
 * the club link, and take a code by hand for anything else.
 */
import { useEffect, useState } from "react";

import { buildTournamentBundle, type BundleEvent, type BundleProgress } from "@/lib/bundle";
import { fmtWhen, type ChatMessage } from "@/lib/chat";
import { isValidEventId, normalizeEventId } from "@/lib/eventid";
import { MAX_PHOTOS_PER_EVENT, fmtBytes, type PhotoMeta } from "@/lib/photos";

interface Loaded {
  code: string;
  event: BundleEvent | null;
  photos: PhotoMeta[];
  messages: ChatMessage[];
}

export default function TournamentAdmin({ liveId }: { liveId: string | null }) {
  const [code, setCode] = useState(liveId ?? "");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState("");
  const [progress, setProgress] = useState<BundleProgress | null>(null);
  /** Bumped to re-read everything after something is deleted. */
  const [version, setVersion] = useState(0);

  const clean = normalizeEventId(code);
  const valid = isValidEventId(clean);

  useEffect(() => {
    if (!valid) return;
    let cancelled = false;
    (async () => {
      const get = async <T,>(path: string): Promise<T | null> => {
        try {
          const res = await fetch(path, { cache: "no-store" });
          return res.ok ? ((await res.json()) as T) : null;
        } catch {
          return null;
        }
      };
      const [ev, ph, ch] = await Promise.all([
        get<BundleEvent & { error?: string }>(`/api/events/${clean}`),
        get<{ photos: PhotoMeta[] }>(`/api/events/${clean}/photos`),
        get<{ messages: ChatMessage[] }>(`/api/events/${clean}/chat`),
      ]);
      if (cancelled) return;
      const event = ev && ev.id && ev.schedule ? (ev as BundleEvent) : null;
      setLoaded({
        code: clean,
        event,
        photos: ph?.photos ?? [],
        messages: ch?.messages ?? [],
      });
      setError(event ? "" : "No event with that code.");
    })();
    return () => {
      cancelled = true;
    };
  }, [clean, valid, version]);

  const data = loaded && loaded.code === clean ? loaded : null;

  async function download() {
    if (!data?.event || busy) return;
    setBusy("bundle");
    setError("");
    try {
      const { blob, filename } = await buildTournamentBundle(data.event, setProgress);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
      setProgress(null);
    }
  }

  async function remove(kind: "photo" | "message" | "chat", which?: string) {
    setBusy(which ?? kind);
    setError("");
    try {
      const path = kind === "photo" ? "photos" : "chat";
      const body =
        kind === "photo" ? { photo: which } : kind === "message" ? { message: which } : { all: true };
      const res = await fetch(`/api/events/${clean}/${path}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || "That could not be removed.");
      setVersion((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
      setConfirming("");
    }
  }

  const photoBytes = (data?.photos ?? []).reduce((sum, p) => sum + (p.bytes || 0), 0);

  return (
    <section className="mx-auto w-full max-w-5xl px-4 pb-12">
      <div className="rounded-xl border border-black/10 p-5 dark:border-white/15">
        <h2 className="font-semibold">Tournament record</h2>
        <p className="mt-1 text-xs opacity-60">
          Take the complete record of a mixer away as a folder of files, and take down anything
          members have posted to it.
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
          <button
            onClick={download}
            disabled={!data?.event || busy !== ""}
            className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-40"
          >
            {busy === "bundle" ? "Preparing…" : "Download everything (.zip)"}
          </button>
          {data?.event && (
            <p className="text-xs opacity-60">
              {data.event.title || "untitled"} · {data.event.schedule.players.length} players ·{" "}
              {data.photos.length}/{MAX_PHOTOS_PER_EVENT} photos ({fmtBytes(photoBytes)}) ·{" "}
              {data.messages.length} messages
            </p>
          )}
        </div>

        {progress && (
          <div className="mt-3">
            <div className="h-1.5 overflow-hidden rounded-full bg-black/10 dark:bg-white/15">
              <div
                className="h-full rounded-full bg-emerald-600 transition-all"
                style={{ width: `${Math.round(progress.done * 100)}%` }}
              />
            </div>
            <p className="mt-1 text-xs opacity-60">{progress.step}…</p>
          </div>
        )}

        <p className="mt-3 text-xs opacity-50">
          The zip holds an Excel workbook of every round and score, the leaderboards as CSV, the
          chat as plain text, every photo as an ordinary JPEG, and a raw JSON copy. It opens
          without this app, which is the point of keeping it.
        </p>

        {error && (
          <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">
            {error}
          </p>
        )}

        {/* ---- photos ---- */}
        {data && data.photos.length > 0 && (
          <>
            <h3 className="mt-6 text-sm font-semibold">Photos</h3>
            <ul className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">
              {data.photos.map((p) => (
                <li key={p.id} className="text-center">
                  <div className="relative aspect-square overflow-hidden rounded-lg bg-black/5 dark:bg-white/10">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/events/${clean}/photos/${p.id}?size=thumb`}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  </div>
                  <p className="mt-1 truncate text-[10px] opacity-60">{p.by || "unsigned"}</p>
                  {/* Two presses, because there is no undo and the thumbnails
                      sit close together on a phone. */}
                  {confirming === p.id ? (
                    <span className="flex justify-center gap-2 text-[11px]">
                      <button
                        onClick={() => remove("photo", p.id)}
                        disabled={busy !== ""}
                        className="font-semibold text-red-700 underline disabled:opacity-40 dark:text-red-400"
                      >
                        {busy === p.id ? "deleting…" : "really delete"}
                      </button>
                      <button onClick={() => setConfirming("")} className="opacity-60 underline">
                        no
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => setConfirming(p.id)}
                      className="text-[11px] underline opacity-50 hover:opacity-100"
                    >
                      delete
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}

        {/* ---- chat ---- */}
        {data && data.messages.length > 0 && (
          <>
            <div className="mt-6 flex items-baseline justify-between gap-3">
              <h3 className="text-sm font-semibold">Chat</h3>
              {confirming === "chat" ? (
                <span className="flex gap-2 text-xs">
                  <button
                    onClick={() => remove("chat")}
                    disabled={busy !== ""}
                    className="font-semibold text-red-700 underline disabled:opacity-40 dark:text-red-400"
                  >
                    {busy === "chat" ? "clearing…" : "really clear the whole chat"}
                  </button>
                  <button onClick={() => setConfirming("")} className="opacity-60 underline">
                    no
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => setConfirming("chat")}
                  className="text-xs underline opacity-50 hover:opacity-100"
                >
                  clear the whole chat
                </button>
              )}
            </div>
            <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto rounded-lg border border-black/10 p-3 text-sm dark:border-white/15">
              {data.messages.map((m) => (
                <li key={m.id} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0">
                    <span className="font-medium">{m.by}</span>{" "}
                    <span className="text-xs opacity-50">{fmtWhen(m.at)}</span>{" "}
                    <span className="break-words whitespace-pre-wrap">{m.text}</span>
                  </span>
                  {confirming === m.id ? (
                    <span className="flex shrink-0 gap-2 text-[11px]">
                      <button
                        onClick={() => remove("message", m.id)}
                        disabled={busy !== ""}
                        className="font-semibold text-red-700 underline disabled:opacity-40 dark:text-red-400"
                      >
                        {busy === m.id ? "deleting…" : "really delete"}
                      </button>
                      <button onClick={() => setConfirming("")} className="opacity-60 underline">
                        no
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => setConfirming(m.id)}
                      className="shrink-0 text-[11px] underline opacity-50 hover:opacity-100"
                    >
                      delete
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}

        {data?.event && data.photos.length === 0 && data.messages.length === 0 && (
          <p className="mt-4 text-sm opacity-60">
            Nothing has been posted to this mixer yet. The download still works.
          </p>
        )}
      </div>
    </section>
  );
}
