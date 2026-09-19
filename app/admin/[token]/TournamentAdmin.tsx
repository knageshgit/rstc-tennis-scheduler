"use client";

/**
 * The organizer's controls for one tournament: rename it, see how far the
 * draw makes people walk, take the whole record away, and moderate what
 * members have posted to it.
 *
 * These sit together because they answer the same question, "what is on this
 * mixer and what do I want to do about it". Both work on whichever event is on
 * the club link, and take a code by hand for anything else.
 */
import { useEffect, useState } from "react";

import { buildTournamentBundle, type BundleEvent, type BundleProgress } from "@/lib/bundle";
import { fmtWhen, type ChatMessage } from "@/lib/chat";
import { isValidEventId, normalizeEventId } from "@/lib/eventid";
import {
  courtName,
  playerTravel,
  travelSummary,
  type Schedule,
} from "@/lib/scheduler";
import { fmtBytes, type PhotoMeta } from "@/lib/photos";
import { drawQuality, fmtLevel } from "@/lib/quality";
import {
  MIN_COURT_RATINGS,
  fmtStars,
  summarizeSurvey,
  type Ratings,
  type Tally,
} from "@/lib/survey";

interface Loaded {
  code: string;
  event: BundleEvent | null;
  photos: PhotoMeta[];
  messages: ChatMessage[];
  ratings: Ratings;
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
  /** The name box, seeded from whatever the event is currently called. */
  const [title, setTitle] = useState("");
  /** The play date box, seeded from the event; "" when none is set. */
  const [playDate, setPlayDate] = useState("");
  /**
   * Which tournament the "Saved" line belongs to, or null for none showing.
   *
   * The code rather than a boolean, so the confirmation survives the reload
   * that renaming triggers but disappears the moment the organizer types a
   * different event code. A flag cleared on reload was wiped before it could
   * be read; one never cleared would follow you to the next tournament.
   */
  const [renamedCode, setRenamedCode] = useState<string | null>(null);

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
      const [ev, ph, ch, sv] = await Promise.all([
        get<BundleEvent & { error?: string }>(`/api/events/${clean}`),
        get<{ photos: PhotoMeta[] }>(`/api/events/${clean}/photos`),
        get<{ messages: ChatMessage[] }>(`/api/events/${clean}/chat`),
        get<{ ratings: Ratings }>(`/api/events/${clean}/survey`),
      ]);
      if (cancelled) return;
      const event = ev && ev.id && ev.schedule ? (ev as BundleEvent) : null;
      setTitle(event?.title ?? "");
      setPlayDate(event?.date ?? "");
      setLoaded({
        code: clean,
        event,
        photos: ph?.photos ?? [],
        messages: ch?.messages ?? [],
        ratings: sv?.ratings ?? {},
      });
      setError(event ? "" : "No event with that code.");
    })();
    return () => {
      cancelled = true;
    };
  }, [clean, valid, version]);


  const data = loaded && loaded.code === clean ? loaded : null;

  /**
   * Give the tournament its proper name, without touching anything else.
   *
   * The event is reloaded afterwards rather than patched in place, so the
   * label beside the download button and the disabled state of this button
   * both come from what the server actually stored.
   */
  async function rename() {
    if (!data?.event || busy) return;
    setBusy("rename");
    setError("");
    try {
      const res = await fetch("/api/admin/rename", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The date goes too: "" clears it, which is a real choice.
        body: JSON.stringify({ id: data.code, title: title.trim(), date: playDate }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Could not rename that event.");
      setRenamedCode(data.code);
      setVersion((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

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
              {data.photos.length} photos ({fmtBytes(photoBytes)}) ·{" "}
              {data.messages.length} messages
            </p>
          )}
        </div>

        {data?.event && (
          <div className="mt-4 rounded-lg border border-black/10 p-3 dark:border-white/15">
            <label className="flex flex-col gap-1 text-sm">
              <span className="opacity-70">Tournament name</span>
              <input
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setRenamedCode(null);
                }}
                maxLength={120}
                placeholder="Tennis mixer"
                className="w-full max-w-md rounded-lg border border-black/15 bg-transparent px-3 py-2 dark:border-white/20"
              />
            </label>
            <label className="mt-3 flex flex-col gap-1 text-sm">
              <span className="opacity-70">Date played</span>
              <input
                type="date"
                value={playDate}
                onChange={(e) => {
                  setPlayDate(e.target.value);
                  setRenamedCode(null);
                }}
                className="w-44 rounded-lg border border-black/15 bg-transparent px-3 py-2 dark:border-white/20"
              />
            </label>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <button
                onClick={rename}
                disabled={
                  busy !== "" ||
                  (title.trim() === (data.event.title ?? "").trim() &&
                    playDate === (data.event.date ?? ""))
                }
                className="rounded-lg bg-black/80 px-3 py-1.5 text-sm font-medium text-white hover:bg-black disabled:opacity-40 dark:bg-white/85 dark:text-black dark:hover:bg-white"
              >
                {busy === "rename" ? "Saving…" : "Save name and date"}
              </button>
              {renamedCode === data.code && (
                <span className="text-xs text-emerald-700 dark:text-emerald-400">
                  Saved. Members see it on their next refresh.
                </span>
              )}
            </div>
            <p className="mt-2 text-xs opacity-50">
              Changes the name and date only. The draw, the scores, the code and
              everything members have posted stay exactly as they are. The date
              shows after the name on the members&apos; page.
            </p>
          </div>
        )}

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

        {data?.event && <MovementTable schedule={data.event.schedule} />}
        {data?.event && <QualityPanel schedule={data.event.schedule} ratings={data.ratings} />}

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

/**
 * Who the draw makes walk, and how far.
 *
 * The scheduler already works to keep people where they are - that is what the
 * travel costs in `lib/scheduler` are for - but until now nothing showed the
 * organizer the result, so a draw that happened to march one player across the
 * club five times looked exactly like one that did not. This is that check,
 * per player, before anyone is standing on a court.
 *
 * Alphabetical, so an organizer can find a player by name. Anyone with two or
 * more venue changes is still highlighted, so a bad deal stands out anyway.
 */
function MovementTable({ schedule }: { schedule: Schedule }) {
  const [open, setOpen] = useState(false);
  const names = schedule.courtNames ?? [];
  const rows = [...playerTravel(schedule)].sort((a, b) => a.name.localeCompare(b.name));
  const totals = travelSummary(schedule);

  return (
    <div className="mt-4 rounded-lg border border-black/10 p-3 dark:border-white/15">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-baseline justify-between gap-3 text-left"
      >
        <span className="text-sm font-semibold">Player movement</span>
        <span className="text-xs opacity-60">
          {totals.drives} venue change{totals.drives === 1 ? "" : "s"} ·{" "}
          {totals.neverDrive} of {schedule.players.length} never change venue ·{" "}
          {totals.walks} court swap{totals.walks === 1 ? "" : "s"}{" "}
          <span className="opacity-70">{open ? "▲" : "▼"}</span>
        </span>
      </button>

      {open && (
        <>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-black/10 text-left text-xs uppercase tracking-wide opacity-60 dark:border-white/15">
                  <th className="py-2 pr-2">Player</th>
                  {schedule.rounds.map((r) => (
                    <th key={r.number} className="py-2 pr-2">
                      R{r.number}
                    </th>
                  ))}
                  <th className="py-2 pr-2 text-right whitespace-nowrap"># Venue Changes</th>
                  <th className="py-2 text-right">Swaps</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr
                    key={t.index}
                    className="border-b border-black/5 dark:border-white/10"
                  >
                    <td className="py-2 pr-2 whitespace-nowrap">{t.name}</td>
                    {t.byRound.map((court, i) => (
                      <td
                        key={i}
                        className={`py-2 pr-2 text-xs whitespace-nowrap ${
                          court === null ? "opacity-30" : "opacity-80"
                        }`}
                      >
                        {court === null ? "bye" : courtName(court, names)}
                      </td>
                    ))}
                    {/* The column to re-draw for. */}
                    <td
                      className={`py-2 pr-2 text-right tabular-nums ${
                        t.venueChanges >= 2
                          ? "font-semibold text-amber-700 dark:text-amber-400"
                          : t.venueChanges === 0
                            ? "opacity-30"
                            : "font-semibold"
                      }`}
                    >
                      {t.venueChanges}
                    </td>
                    {/* Court swaps inside one venue. Shown for completeness,
                        greyed, because they are not venue changes. */}
                    <td className="py-2 text-right tabular-nums opacity-40">
                      {t.walks || "–"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs opacity-50">
            A venue change is Dolphin to Shorebird, say. Swapping between two
            courts at the same venue is a few steps, so it is counted separately
            under Swaps and is not a venue change. Sitting out between two
            matches on the same court is bridged over, not counted either. Two
            or more venue changes is highlighted.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * How evenly matched the draw is, in NTRP levels, beside how the players rated
 * it. Collapsed like Player movement.
 *
 * Tournament figures first, then one row per round; tap a round for its
 * courts. The star columns are the survey's, so a round that was tight on paper
 * and still rated poorly (or the reverse) shows up side by side. A single
 * court's stars wait for MIN_COURT_RATINGS answers, even here: the organizer
 * knows who was on each court, so a two-rating average would give an answer
 * away just as it would to a member.
 */
function QualityPanel({ schedule, ratings }: { schedule: Schedule; ratings: Ratings }) {
  const [open, setOpen] = useState(false);
  const [round, setRound] = useState<number | null>(null);
  const names = schedule.courtNames ?? [];
  const q = drawQuality(schedule);
  const survey = summarizeSurvey(schedule, ratings);

  return (
    <div className="mt-4 rounded-lg border border-black/10 p-3 dark:border-white/15">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-baseline justify-between gap-3 text-left"
      >
        <span className="text-sm font-semibold">Match quality</span>
        <span className="text-xs tabular-nums opacity-60">
          avg spread {fmtLevel(q.avgSpread)} · avg gap {fmtLevel(q.avgGap)} · widest{" "}
          {fmtLevel(q.widest)} <span className="opacity-70">{open ? "▲" : "▼"}</span>
        </span>
      </button>
      {open && (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <QStat label="Lowest" value={fmtLevel(q.low)} />
            <QStat label="Highest" value={fmtLevel(q.high)} />
            <QStat label="Average" value={fmtLevel(q.avg)} />
            <QStat label="Tennis rated" value={starText(survey.matches)} />
          </dl>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="border-b border-black/10 text-left text-xs uppercase tracking-wide opacity-60 dark:border-white/15">
                  <th className="py-2 pr-2">Round</th>
                  <th className="py-2 pr-2 text-right">Lowest</th>
                  <th className="py-2 pr-2 text-right">Highest</th>
                  <th className="py-2 pr-2 text-right">Average</th>
                  <th className="py-2 pr-2 text-right whitespace-nowrap">Avg spread</th>
                  <th className="py-2 pr-2 text-right whitespace-nowrap">Avg gap</th>
                  <th className="py-2 pr-2 text-right">Widest</th>
                  <th className="py-2 text-right">Stars</th>
                </tr>
              </thead>
              <tbody>
                {q.rounds.map((r) => {
                  const t = survey.rounds.find((x) => x.round === r.round);
                  const shown = round === r.round;
                  return [
                    <tr
                      key={r.round}
                      onClick={() => setRound(shown ? null : r.round)}
                      className="cursor-pointer border-b border-black/5 hover:bg-black/[0.03] dark:border-white/10 dark:hover:bg-white/5"
                    >
                      <td className="py-2 pr-2 font-medium whitespace-nowrap">
                        <span className="mr-1 text-xs opacity-50">{shown ? "▾" : "▸"}</span>
                        Round {r.round}
                      </td>
                      <td className="py-2 pr-2 text-right">{fmtLevel(r.low)}</td>
                      <td className="py-2 pr-2 text-right">{fmtLevel(r.high)}</td>
                      <td className="py-2 pr-2 text-right">{fmtLevel(r.avg)}</td>
                      <td className="py-2 pr-2 text-right font-semibold">{fmtLevel(r.avgSpread)}</td>
                      <td className="py-2 pr-2 text-right">{fmtLevel(r.avgGap)}</td>
                      <td className="py-2 pr-2 text-right">{fmtLevel(r.widest)}</td>
                      <td className="py-2 text-right whitespace-nowrap">{starText(t)}</td>
                    </tr>,
                    ...(shown
                      ? r.matches.map((m) => {
                          const mt = t?.matches.find((x) => x.court === m.court);
                          return (
                            <tr
                              key={`${r.round}-${m.court}`}
                              className="border-b border-black/5 bg-black/[0.02] text-xs dark:border-white/10 dark:bg-white/[0.03]"
                            >
                              <td className="py-1.5 pr-2 pl-5 whitespace-nowrap opacity-70">
                                {courtName(m.court, names)}
                              </td>
                              <td className="py-1.5 pr-2 text-right">{fmtLevel(m.low)}</td>
                              <td className="py-1.5 pr-2 text-right">{fmtLevel(m.high)}</td>
                              <td className="py-1.5 pr-2 text-right">{fmtLevel(m.avg)}</td>
                              <td className="py-1.5 pr-2 text-right">{fmtLevel(m.spread)}</td>
                              <td className="py-1.5 pr-2 text-right">{fmtLevel(m.gap)}</td>
                              <td className="py-1.5 pr-2" />
                              <td className="py-1.5 text-right whitespace-nowrap">
                                {mt && mt.count > 0 && mt.count < MIN_COURT_RATINGS
                                  ? "too few"
                                  : starText(mt)}
                              </td>
                            </tr>
                          );
                        })
                      : []),
                  ];
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs opacity-50">
            Levels are NTRP. Lowest and Highest are the lowest and highest rated
            players on court, Average the mean of the four, Spread Highest minus
            Lowest. Team gap is the difference between the two teams&apos; levels
            (a team&apos;s level being the mean of its partners, as shown beside
            each team). Tap a round for its courts. Stars are the survey&apos;s,
            and a court&apos;s own stars need {MIN_COURT_RATINGS} ratings.
          </p>
        </>
      )}
    </div>
  );
}

function QStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-black/[0.03] p-2 dark:bg-white/5">
      <dt className="text-xs uppercase tracking-wide opacity-60">{label}</dt>
      <dd className="mt-0.5 font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

/** "3.8 (12)" for a tally with answers, a dash for one without. */
function starText(t?: Tally): string {
  return t && t.count > 0 ? `${fmtStars(t.avg)} (${t.count})` : "–";
}
