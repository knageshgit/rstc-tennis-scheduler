"use client";

/**
 * Photo moderation, which is the counterweight to letting anyone upload.
 *
 * Adding a photo is open to whoever has the club link, so the club needs one
 * person who can take one down: a bad shot, somebody who asked not to be in it,
 * or something that should never have been posted. That is this panel, and it
 * is the only place a delete button exists.
 *
 * It works on whichever mixer is on the club link, because that is the one
 * members are pointing a camera at, and takes a code by hand for anything else.
 */
import { useEffect, useState } from "react";

import { isValidEventId, normalizeEventId } from "@/lib/eventid";
import { MAX_PHOTOS_PER_EVENT, fmtBytes, type PhotoMeta } from "@/lib/photos";

export default function PhotoAdmin({ liveId }: { liveId: string | null }) {
  const [code, setCode] = useState(liveId ?? "");
  // Tagged with the code they belong to, so typing a new code cannot leave the
  // previous mixer's thumbnails on screen under it while the fetch is in flight.
  const [loaded, setLoaded] = useState<{ code: string; photos: PhotoMeta[] } | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState("");

  const clean = normalizeEventId(code);
  const valid = isValidEventId(clean);

  // The fetch runs inside the effect rather than through a callback the effect
  // calls, so nothing is set until the response is in hand, and a code typed
  // while an older request is still in flight cannot have its result applied.
  useEffect(() => {
    if (!valid) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/events/${clean}/photos`, { cache: "no-store" });
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) throw new Error(body.error || "Could not load the photos.");
        setLoaded({ code: clean, photos: body.photos ?? [] });
        setError("");
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoaded({ code: clean, photos: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
    // Deleting updates the list straight from its own response, so there is
    // nothing else that needs to re-run this.
  }, [clean, valid]);

  async function remove(photo: string) {
    setBusy(photo);
    setError("");
    try {
      const res = await fetch(`/api/events/${clean}/photos`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ photo }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "That photo could not be removed.");
      setLoaded({ code: clean, photos: body.photos ?? [] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
      setConfirming("");
    }
  }

  const photos = loaded && loaded.code === clean ? loaded.photos : null;
  const used = (photos ?? []).reduce((sum, p) => sum + (p.bytes || 0), 0);

  return (
    <section className="mx-auto w-full max-w-5xl px-4 pb-12">
      <div className="rounded-xl border border-black/10 p-5 dark:border-white/15">
        <h2 className="font-semibold">Photos</h2>
        <p className="mt-1 text-xs opacity-60">
          Anyone with the club link can add a photo from the Photos tab, the same as entering a
          score. This is where one comes down again. Deleting is permanent.
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
          {photos && (
            <p className="text-xs opacity-60">
              {photos.length} of {MAX_PHOTOS_PER_EVENT} photos · {fmtBytes(used)} stored
            </p>
          )}
        </div>

        {error && (
          <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">
            {error}
          </p>
        )}

        {photos && photos.length === 0 && (
          <p className="mt-4 text-sm opacity-60">No photos on this mixer.</p>
        )}

        {photos && photos.length > 0 && (
          <ul className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-6">
            {photos.map((p) => (
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
                {/* Two presses to delete, because there is no undo and the
                    thumbnails sit close together on a phone. */}
                {confirming === p.id ? (
                  <span className="flex justify-center gap-2 text-[11px]">
                    <button
                      onClick={() => remove(p.id)}
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
        )}
      </div>
    </section>
  );
}
