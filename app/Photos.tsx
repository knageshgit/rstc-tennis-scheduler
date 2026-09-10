"use client";

/**
 * The Photos tab: take a picture at the mixer, and everyone sees it.
 *
 * Capture is a plain file input with `capture="environment"`, not a live camera
 * stream. That is deliberate. It opens the phone's own camera app, which people
 * already know how to use, needs no permission prompt of ours, works on every
 * phone at the club including the old ones, and falls back to the photo roll on
 * a laptop with no extra code. A getUserMedia viewfinder would be more code, a
 * worse camera, and one more thing to break on somebody's handset.
 *
 * Uploads run one at a time. Somebody selecting eight photos at once on club
 * wifi should see them land one by one rather than have eight large requests
 * fight each other and time out together.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { preparePhoto } from "@/lib/photo-capture";
import { MAX_PHOTOS_PER_EVENT, type PhotoMeta } from "@/lib/photos";

interface Queued {
  key: string;
  name: string;
  state: "working" | "failed";
  error?: string;
}

export default function Photos({
  eventId,
  /** The name the member picked on the Schedule tab, if any. Signs their photos. */
  meName,
}: {
  eventId: string;
  meName?: string;
}) {
  const [photos, setPhotos] = useState<PhotoMeta[] | null>(null);
  const [queue, setQueue] = useState<Queued[]>([]);
  const [open, setOpen] = useState<PhotoMeta | null>(null);
  const [loadError, setLoadError] = useState("");
  // Two inputs rather than one, because the only difference that matters is the
  // `capture` attribute: with it the phone goes straight to the camera, without
  // it the phone offers the photo library. One input cannot be both, and which
  // one somebody wants is not something the page can guess.
  const cameraInput = useRef<HTMLInputElement>(null);
  const libraryInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/photos`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Could not load the photos.");
      setPhotos(body.photos ?? []);
      setLoadError("");
    } catch (e) {
      setPhotos((p) => p ?? []);
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [eventId]);

  useEffect(() => {
    load();
    // Someone else's photo should appear without a reload, but a gallery is not
    // a scoreboard: a slower poll than the scores tab is plenty, and every one
    // of these is a database read shared by everyone with the page open.
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, [load]);

  // Escape closes the opened photo, which is what a lightbox is expected to do.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function onFiles(list: FileList | null, from: HTMLInputElement | null) {
    if (!list?.length) return;
    const files = [...list];
    // Clear the input straight away, so choosing the same photo twice in a row
    // still fires a change event.
    if (from) from.value = "";

    for (const file of files) {
      const key = `${file.name}-${file.lastModified}-${Math.random()}`;
      setQueue((q) => [...q, { key, name: file.name, state: "working" }]);
      try {
        const prepared = await preparePhoto(file);
        const res = await fetch(`/api/events/${eventId}/photos`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            full: prepared.full,
            thumb: prepared.thumb,
            type: prepared.type,
            width: prepared.width,
            height: prepared.height,
            by: meName,
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || "That photo could not be saved.");
        setPhotos((p) => [...(p ?? []), body.photo as PhotoMeta]);
        setQueue((q) => q.filter((item) => item.key !== key));
      } catch (e) {
        setQueue((q) =>
          q.map((item) =>
            item.key === key
              ? { ...item, state: "failed", error: e instanceof Error ? e.message : String(e) }
              : item
          )
        );
      }
    }
  }

  const count = photos?.length ?? 0;
  const full = count >= MAX_PHOTOS_PER_EVENT;

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          onClick={() => cameraInput.current?.click()}
          disabled={full}
          className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:opacity-40 dark:bg-blue-600 dark:hover:bg-blue-500"
        >
          📷 Take a photo
        </button>
        <button
          onClick={() => libraryInput.current?.click()}
          disabled={full}
          className="inline-flex items-center gap-2 rounded-xl border border-blue-600/40 px-4 py-2.5 text-sm font-semibold text-blue-700 transition hover:bg-blue-600 hover:text-white disabled:opacity-40 dark:border-blue-400/40 dark:text-blue-300 dark:hover:bg-blue-600 dark:hover:text-white"
        >
          🖼️ Upload
        </button>
        {/* `capture` sends a phone straight to the camera. A laptop has no
            camera to send it to and shows the file picker either way, so both
            buttons still do something sensible there. */}
        <input
          ref={cameraInput}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(e) => onFiles(e.target.files, e.target)}
          className="hidden"
        />
        {/* No `capture`, so this offers the photo library, and takes several at
            once: pictures from earlier in the morning arrive in a batch. */}
        <input
          ref={libraryInput}
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => onFiles(e.target.files, e.target)}
          className="hidden"
        />
        <p className="w-full text-xs opacity-60 sm:w-auto">
          {full
            ? `This mixer has reached its limit of ${MAX_PHOTOS_PER_EVENT} photos.`
            : `Take one now, or add pictures you already have. Everyone with this link can see them. ${count} of ${MAX_PHOTOS_PER_EVENT} used.`}
        </p>
      </div>

      {queue.length > 0 && (
        <ul className="mb-4 space-y-2">
          {queue.map((item) => (
            <li
              key={item.key}
              className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-xs ${
                item.state === "failed"
                  ? "bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-200"
                  : "bg-black/[0.04] dark:bg-white/[0.06]"
              }`}
            >
              <span className="truncate">
                {item.state === "working" ? "Uploading" : "Could not upload"} {item.name}
              </span>
              {item.state === "failed" ? (
                <button
                  onClick={() => setQueue((q) => q.filter((i) => i.key !== item.key))}
                  className="shrink-0 underline opacity-70 hover:opacity-100"
                >
                  dismiss
                </button>
              ) : (
                <span className="shrink-0 opacity-60">working…</span>
              )}
            </li>
          ))}
          {queue.some((i) => i.state === "failed") && (
            <li className="px-3 text-xs opacity-70">
              {queue.find((i) => i.state === "failed")?.error}
            </li>
          )}
        </ul>
      )}

      {loadError && (
        <p className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">
          {loadError}
        </p>
      )}

      {photos === null ? (
        <p className="text-sm opacity-60">Loading photos…</p>
      ) : photos.length === 0 ? (
        <div className="rounded-xl border border-dashed border-black/15 p-8 text-center dark:border-white/20">
          <div className="text-3xl">📷</div>
          <p className="mt-2 text-sm font-medium">No photos yet</p>
          <p className="mt-1 text-xs opacity-60">
            Take the first one. It appears here for everyone at the mixer.
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
          {photos.map((p) => (
            <li key={p.id}>
              <button
                onClick={() => setOpen(p)}
                className="group relative block aspect-square w-full overflow-hidden rounded-lg bg-black/5 dark:bg-white/10"
                aria-label={p.by ? `Photo by ${p.by}` : "Photo"}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/events/${eventId}/photos/${p.id}?size=thumb`}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover transition group-hover:scale-105"
                />
                {p.by && (
                  <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/70 to-transparent px-1.5 pt-4 pb-1 text-left text-[10px] text-white">
                    {p.by}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black/95 p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setOpen(null)}
        >
          <div className="flex items-center justify-between gap-3 text-white">
            <span className="truncate text-xs opacity-80">
              {open.by ? `${open.by} · ` : ""}
              {new Date(open.at).toLocaleString()}
            </span>
            <button
              onClick={() => setOpen(null)}
              className="rounded-lg border border-white/30 px-3 py-1 text-xs font-medium"
            >
              Close
            </button>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/events/${eventId}/photos/${open.id}`}
            alt={open.by ? `Photo by ${open.by}` : "Photo from the mixer"}
            className="mt-3 min-h-0 flex-1 object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </section>
  );
}
