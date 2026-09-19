"use client";

/**
 * What a club member sees: one published mixer, in tabs.
 *
 *   Schedule     who is on which court, a round at a time
 *   Results      the score for each match, the box to enter it, and how the
 *                round was rated, a round at a time
 *   Leaderboard  games won, ranked, overall and by gender, sortable
 *   Survey       rate your own matches, and the day, out of five stars
 *
 * Up to v5 this screen was reached only by a per-event link and opened straight
 * onto score entry. Members were really arriving to answer "where am I playing?"
 * first, so the schedule now leads, with a "find me" picker that pulls one
 * person's day out of a wall of twenty-four names.
 *
 * Anyone with the link may enter any court's result, which is deliberate: at a
 * club mixer whoever finishes first types the score in, and chasing per-court
 * logins would cost more than it protects. Generating and publishing are the
 * parts that are gated, over in /admin.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import {
  FORMATS,
  courtName,
  drawLabel,
  playerTravel,
  teamAvg,
  type Match,
  type Schedule,
} from "@/lib/scheduler";
import { drawQuality, fmtLevel, type LevelStats } from "@/lib/quality";
import Byes from "./Byes";
import Logo from "./Logo";
import Chat from "./Chat";
import Photos from "./Photos";
import {
  GAMES_PER_MATCH,
  leaderboards,
  matchKey,
  readScore,
  type PlayerScore,
  type Scores,
} from "@/lib/scoring";
import {
  MAX_STARS,
  MIN_COURT_RATINGS,
  fmtStars,
  matchesFor,
  overallKey,
  progressFor,
  ratingKey,
  starBar,
  summarizeSurvey,
  type Ratings,
  type Tally,
} from "@/lib/survey";

interface EventData {
  id: string;
  title: string;
  createdAt: number;
  /** The day it is played, `YYYY-MM-DD`, once the organizer has set it. */
  date?: string;
  courtNames: string[];
  schedule: Schedule;
  scores: Scores;
}

/** Per-match save state, so a phone on a weak signal can see what happened. */
type SaveState = "saving" | "saved" | "error";

type Tab = "schedule" | "results" | "board" | "survey" | "photos" | "chat";

const POLL_MS = 10_000;
const COURT_FILTER_KEY = "tennis-scorer-court";
/** Remembered by name, not index: next week's schedule renumbers everybody. */
const ME_KEY = "tennis-scorer-me";

/**
 * "Saturday, Sep. 19" from "2026-09-19", or "Sat, Sep. 19" with `weekday`
 * "short". The month takes a period only when it is actually shortened, so May
 * stays "May". Parsed and printed as UTC: the string is a calendar day with no
 * timezone, and shifting it would show the day before to anyone west of London.
 */
function playDay(iso: string, weekday: "long" | "short" = "long"): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const part = (o: Intl.DateTimeFormatOptions) =>
    d.toLocaleDateString("en-US", { ...o, timeZone: "UTC" });
  const short = part({ month: "short" });
  const month = short === part({ month: "long" }) ? short : `${short}.`;
  return `${part({ weekday })}, ${month} ${d.getUTCDate()}`;
}

/** Wall-clock read, kept out of the component so it stays free of impure calls. */
function nowMs(): number {
  return Date.now();
}

export default function EventView({
  id,
  /**
   * Which tab to open on. The archive links straight to the leaderboard, since
   * somebody arriving from the results page has already said what they want to
   * see; everywhere else the schedule leads, because a member opening the club
   * link is asking where they are playing.
   */
  initialTab = "schedule",
}: {
  id: string;
  initialTab?: Tab;
}) {
  const [data, setData] = useState<EventData | null>(null);
  const [scores, setScores] = useState<Scores>({});
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<Tab>(initialTab);
  const [saveState, setSaveState] = useState<Record<string, SaveState>>({});
  const [courtFilter, setCourtFilter] = useState<number | "all">("all");
  const [meName, setMeName] = useState<string>("");
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [ratings, setRatings] = useState<Ratings>({});
  const [ratingState, setRatingState] = useState<Record<string, SaveState>>({});
  /**
   * The round on show, one for the whole page, so switching from Schedule to
   * Results to Survey keeps you on the round you were looking at. Null until
   * the event loads, then set once to the round in progress.
   */
  const [round, setRound] = useState<number | null>(null);

  // Scores the user has just set but which the server has not confirmed yet.
  // Polling must not yank a value back out from under someone mid-entry, so
  // these win over the polled copy until their write lands.
  const pending = useRef<Set<string>>(new Set());
  /** The same guard for ratings, which poll on their own timer. */
  const pendingRatings = useRef<Set<string>>(new Set());

  // ---- load and poll -------------------------------------------------------
  const loadAll = useCallback(async () => {
    const res = await fetch(`/api/events/${id}`, { cache: "no-store" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Could not load event ${id}.`);
    }
    const ev: EventData = await res.json();
    setData(ev);
    setScores(ev.scores ?? {});
    // Set once, on first load only. Moving it on as later scores arrive would
    // switch rounds under someone who is reading one.
    setRound((r) => r ?? openingRound(ev.schedule, ev.scores ?? {}));
    setLastSync(nowMs());

    // A second call rather than another field on the event payload. Ratings
    // are wanted by two tabs out of six, and the event payload is on the
    // critical path of the page every member opens on arrival.
    try {
      const rres = await fetch(`/api/events/${id}/survey`, { cache: "no-store" });
      if (rres.ok) {
        const body: { ratings: Ratings } = await rres.json();
        setRatings(body.ratings ?? {});
      }
    } catch {
      // Nothing rated yet as far as this phone knows; the poll will catch up.
    }
  }, [id]);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        await loadAll();
      } catch (e) {
        if (live) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [loadAll]);

  useEffect(() => {
    if (!data) return;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch(`/api/events/${id}/scores`, { cache: "no-store" });
        if (!res.ok) return;
        const body: { scores: Scores } = await res.json();
        setScores((mine) => {
          const merged = { ...body.scores };
          // Keep anything still in flight from this device.
          for (const key of pending.current) {
            if (key in mine) merged[key] = mine[key];
            else delete merged[key];
          }
          return merged;
        });
        setLastSync(nowMs());
      } catch {
        // A dropped poll is not worth showing; the next one will catch up.
      }
    };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [data, id]);

  /**
   * Ratings poll on the same clock as the scores, but only while a tab that
   * shows them is open.
   *
   * The gallery and the chat already work this way, and here it is a cost
   * decision as much as a tidiness one: v7 was thrown off Vercel Blob by a
   * read path that ran on every poll from every phone. Eighteen phones sitting
   * on the Schedule tab have no use for the survey, so they do not ask for it.
   */
  useEffect(() => {
    if (!data) return;
    if (tab !== "survey" && tab !== "results") return;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch(`/api/events/${id}/survey`, { cache: "no-store" });
        if (!res.ok) return;
        const body: { ratings: Ratings } = await res.json();
        setRatings((mine) => {
          const merged = { ...body.ratings };
          // Anything this phone has in flight wins, exactly as scores do.
          for (const key of pendingRatings.current) {
            if (key in mine) merged[key] = mine[key];
            else delete merged[key];
          }
          return merged;
        });
      } catch {
        // A dropped poll is not worth showing; the next one will catch up.
      }
    };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [data, id, tab]);

  // The remembered court and player can only be read after hydration:
  // localStorage does not exist on the server, and seeding it into the initial
  // state would make the server and client markup disagree. So it is
  // deliberately a post-mount state update, which is what this rule warns
  // about in general.
  useEffect(() => {
    try {
      const savedCourt = localStorage.getItem(COURT_FILTER_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (savedCourt) setCourtFilter(savedCourt === "all" ? "all" : Number(savedCourt));
      const savedMe = localStorage.getItem(ME_KEY);
      if (savedMe) setMeName(savedMe);
    } catch {
      // Private browsing; both simply start unset.
    }
  }, []);

  function chooseCourt(v: number | "all") {
    setCourtFilter(v);
    remember(COURT_FILTER_KEY, String(v));
  }

  function chooseMe(name: string) {
    setMeName(name);
    remember(ME_KEY, name);
  }

  function remember(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Nothing to do; the choice simply will not be remembered.
    }
  }

  // ---- saving --------------------------------------------------------------
  async function save(round: number, court: number, games: number | null) {
    const key = matchKey(round, court);
    // Show it immediately; the network catches up behind.
    setScores((s) => {
      const next = { ...s };
      if (games === null) delete next[key];
      else next[key] = games;
      return next;
    });
    pending.current.add(key);
    setSaveState((s) => ({ ...s, [key]: "saving" }));
    try {
      const res = await fetch(`/api/events/${id}/scores`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ round, court, games }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Save failed.");
      }
      const body: { scores: Scores } = await res.json();
      pending.current.delete(key);
      setScores(body.scores);
      setSaveState((s) => ({ ...s, [key]: "saved" }));
      setLastSync(nowMs());
    } catch {
      pending.current.delete(key);
      setSaveState((s) => ({ ...s, [key]: "error" }));
    }
  }

  /**
   * Record one star rating, optimistically.
   *
   * `round` and `court` are omitted for the end-of-day question about the
   * tournament itself, which is the one rating every player can give whether
   * or not they were on a court that round.
   */
  async function saveRating(
    player: number,
    stars: number | null,
    at?: { round: number; court: number }
  ) {
    const key = at ? ratingKey(at.round, at.court, player) : overallKey(player);
    setRatings((r) => {
      const next = { ...r };
      if (stars === null) delete next[key];
      else next[key] = stars;
      return next;
    });
    pendingRatings.current.add(key);
    setRatingState((s) => ({ ...s, [key]: "saving" }));
    try {
      const res = await fetch(`/api/events/${id}/survey`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ player, stars, ...(at ?? {}) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Save failed.");
      }
      pendingRatings.current.delete(key);
      setRatingState((s) => ({ ...s, [key]: "saved" }));
    } catch {
      pendingRatings.current.delete(key);
      setRatingState((s) => ({ ...s, [key]: "error" }));
    }
  }

  async function downloadExcel() {
    if (!data) return;
    const { buildScheduleWorkbook } = await import("@/lib/excel");
    const buf = await buildScheduleWorkbook(data.schedule, data.courtNames, scores, ratings);
    const blob = new Blob([buf], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tennis_results_${data.id}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const board = useMemo(
    () => (data ? leaderboards(data.schedule, scores) : null),
    [data, scores]
  );

  const survey = useMemo(
    () => (data ? summarizeSurvey(data.schedule, ratings) : null),
    [data, ratings]
  );

  const courtsInPlay = useMemo(() => {
    if (!data) return [];
    const set = new Set<number>();
    for (const rnd of data.schedule.rounds) for (const m of rnd.matches) set.add(m.court);
    return [...set].sort((a, b) => a - b);
  }, [data]);

  // The remembered name is matched back to a seat in *this* schedule, so a
  // member who was here last week is still found, and one who is not playing
  // today simply comes back unmatched.
  const meIndex = useMemo(() => {
    if (!data || !meName) return -1;
    return data.schedule.players.findIndex((p) => p.name === meName);
  }, [data, meName]);

  if (loadError) {
    return (
      <main className="mx-auto max-w-md p-6">
        <h1 className="text-lg font-semibold">Event {id}</h1>
        <p className="mt-3 rounded-lg bg-red-50 p-4 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">
          {loadError}
        </p>
        <p className="mt-3 text-xs opacity-60">
          Check the code with whoever set up the event, or ask them for the link again.
        </p>
      </main>
    );
  }

  if (!data || !board) {
    return <main className="mx-auto max-w-md p-6 text-sm opacity-60">Loading event {id}…</main>;
  }

  const s = data.schedule;
  const names = data.courtNames?.length ? data.courtNames : s.courtNames;
  const roundNumbers = s.rounds.map((r) => r.number);
  const current = s.rounds.find((r) => r.number === round) ?? s.rounds[0];

  return (
    <main className="mx-auto w-full max-w-3xl p-4 pb-24 sm:p-6">
      <header className="mb-4">
        <div className="flex items-center justify-between gap-3">
          {/* The badge sits to the left of the mixer name, and the pair take
              the width; the code stays pinned to the right. min-w-0 lets a long
              mixer name truncate rather than shove the code off the screen. */}
          <div className="flex min-w-0 items-center gap-2.5">
            <Logo />
            {/* The app's name leads, bold and blue, with the day's mixer under
                it in plain black (white on a dark phone). Sized so the pair is
                no taller than the badge beside it. */}
            <div className="min-w-0">
              <p className="text-xl font-extrabold leading-none tracking-tight text-blue-600 dark:text-blue-400">
                MatchPoint
              </p>
              {/* The name truncates on a narrow phone; the date never does. */}
              <h1 className="mt-1 flex min-w-0 items-baseline gap-1.5 text-base font-semibold leading-tight text-black dark:text-white">
                <span className="truncate">{data.title || "Tennis mixer"}</span>
                {data.date && (
                  <span className="shrink-0 text-sm font-normal opacity-60">
                    {/* Short weekday on a phone, so the name gets the room. */}
                    · <span className="sm:hidden">{playDay(data.date, "short")}</span>
                    <span className="hidden sm:inline">{playDay(data.date)}</span>
                  </span>
                )}
              </h1>
            </div>
          </div>
          <span className="shrink-0 rounded bg-black/5 px-2 py-0.5 font-mono text-xs tracking-widest dark:bg-white/10">
            {data.id}
          </span>
        </div>
        <p className="mt-1 text-xs opacity-60">
          {FORMATS.find((f) => f.value === s.format)?.label} · {s.players.length} players ·{" "}
          {s.rounds.length} rounds · every match is {GAMES_PER_MATCH} games
          {/* Said once at the top as well as per round, so nobody is surprised
              to find themselves off a court partway down the page. */}
          {s.layout.byesPerRound > 0 &&
            ` · ${s.layout.byesPerRound} sitting out each round`}
        </p>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/10 dark:bg-white/15">
          <div
            className="h-full rounded-full bg-emerald-600 transition-all"
            style={{ width: `${board.total ? (100 * board.entered) / board.total : 0}%` }}
          />
        </div>
        <p className="mt-1 text-xs opacity-60">
          {board.entered} of {board.total} matches scored
          {board.complete ? " - all in ✓" : ""}
          {lastSync ? ` · updated ${new Date(lastSync).toLocaleTimeString()}` : ""}
        </p>
      </header>

      <div className="mb-4 flex gap-2">
        <TabButton active={tab === "schedule"} onClick={() => setTab("schedule")}>
          Schedule
        </TabButton>
        <TabButton active={tab === "results"} onClick={() => setTab("results")}>
          Results
        </TabButton>
        <TabButton active={tab === "board"} onClick={() => setTab("board")}>
          <span className="sm:hidden">Board</span>
          <span className="hidden sm:inline">Leaderboard</span>
        </TabButton>
        <TabButton active={tab === "survey"} onClick={() => setTab("survey")}>
          Survey
        </TabButton>
        <TabButton active={tab === "photos"} onClick={() => setTab("photos")}>
          Photos
        </TabButton>
        <TabButton active={tab === "chat"} onClick={() => setTab("chat")}>
          Chat
        </TabButton>
      </div>

      {tab === "schedule" && (
        <ScheduleView
          schedule={s}
          names={names}
          scores={scores}
          meIndex={meIndex}
          meName={meName}
          onChooseMe={chooseMe}
          round={current.number}
          onRound={setRound}
        />
      )}

      {tab === "results" && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
            <label className="opacity-70" htmlFor="court-filter">
              Show
            </label>
            <select
              id="court-filter"
              value={String(courtFilter)}
              onChange={(e) =>
                chooseCourt(e.target.value === "all" ? "all" : Number(e.target.value))
              }
              className="rounded-lg border border-black/15 bg-transparent px-2 py-1.5 dark:border-white/20"
            >
              <option value="all">All courts</option>
              {courtsInPlay.map((c) => (
                <option key={c} value={c}>
                  {courtName(c, names)} only
                </option>
              ))}
            </select>
            <span className="text-xs opacity-50">Remembered on this phone.</span>
          </div>

          <RoundTabs
            rounds={roundNumbers}
            value={current.number}
            onChange={setRound}
            done={(n) => {
              const rnd = s.rounds.find((r) => r.number === n);
              const shown = rnd?.matches.filter(
                (m) => courtFilter === "all" || m.court === courtFilter
              );
              return !!shown?.length && shown.every((m) => readScore(scores, n, m.court) !== null);
            }}
          />
          {(() => {
            const rnd = current;
            const matches = rnd.matches
              .filter((m) => courtFilter === "all" || m.court === courtFilter)
              .sort((a, b) => a.court - b.court);
            return (
              <section className="mb-5">
                {matches.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-black/15 p-3 text-sm opacity-60 dark:border-white/20">
                    No match on{" "}
                    {courtFilter === "all" ? "any court" : courtName(courtFilter, names)} in
                    Round {rnd.number}.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {matches.map((m) => (
                      <MatchRow
                        key={m.court}
                        label={courtName(m.court, names)}
                        draw={s.format === "same" ? drawLabel(m) : ""}
                        teamA={`${s.players[m.teamA[0]].name} & ${s.players[m.teamA[1]].name}`}
                        teamB={`${s.players[m.teamB[0]].name} & ${s.players[m.teamB[1]].name}`}
                        levelA={teamAvg(s, m.teamA)}
                        levelB={teamAvg(s, m.teamB)}
                        games={readScore(scores, rnd.number, m.court)}
                        state={saveState[matchKey(rnd.number, m.court)]}
                        onChange={(g) => save(rnd.number, m.court, g)}
                      />
                    ))}
                  </div>
                )}
                {/* How the round was rated, under the scores it is about.
                    Only when somebody has rated it. */}
                {survey && <RoundRating tally={survey.rounds.find((r) => r.round === rnd.number)} />}
                {/* Shown whatever the court filter is: filtering to one court
                    must not hide who is not on a court at all. */}
                <Byes schedule={s} byes={rnd.byes} meIndex={meIndex} />
              </section>
            );
          })()}
          {survey && (
            <SurveySummary
              survey={survey}
              players={s.players.length}
              onOpenSurvey={() => setTab("survey")}
            />
          )}
        </>
      )}

      {tab === "board" && (
        <LeaderboardView
          board={board}
          onDownload={downloadExcel}
          hasByes={s.layout.byesPerRound > 0}
        />
      )}

      {tab === "survey" && (
        <SurveyView
          schedule={s}
          names={names}
          ratings={ratings}
          survey={survey}
          saveState={ratingState}
          meIndex={meIndex}
          meName={meName}
          onChooseMe={chooseMe}
          onRate={saveRating}
          round={current.number}
          onRound={setRound}
        />
      )}

      {/* Mounted only while it is the open tab: the gallery polls and fetches
          images, and none of that should run behind the scoreboard. */}
      {tab === "photos" && <Photos eventId={id} meName={meName || undefined} />}

      {/* Mounted only while open, like the gallery: it polls, and that should
          not run behind the scoreboard. */}
      {tab === "chat" && <Chat eventId={id} meName={meName || undefined} />}

      {/* The way back to previous mixers. Kept to a footer line because the
          question this page exists to answer is about today. */}
      <footer className="mt-8 border-t border-black/10 pt-4 text-xs opacity-60 dark:border-white/15">
        <Link href="/results" className="underline underline-offset-2">
          Past tournament results
        </Link>
      </footer>
    </main>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded-lg px-1.5 py-2 text-xs font-medium transition-colors sm:px-3 sm:text-sm ${
        active
          ? "bg-emerald-700 text-white"
          : "bg-black/5 hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * The round a member most likely wants on arrival: the first one with a match
 * still unscored, which during a mixer is the one being played. Once every
 * score is in, the day is read from the top.
 */
function openingRound(s: Schedule, scores: Scores): number {
  const open = s.rounds.find((r) =>
    r.matches.some((m) => readScore(scores, r.number, m.court) === null)
  );
  return (open ?? s.rounds[0])?.number ?? 1;
}

/**
 * One tab per round, so a page shows a single round's box at a time instead of
 * every round stacked down the screen.
 *
 * Underlined rather than filled, so it reads as a second level under the pill
 * tabs at the top. Each button draws its own piece of the base line, since a
 * shared border under a scrolling row needs a negative margin that makes the
 * row scroll vertically too. The buttons share the width equally and never shrink below
 * their label; a mixer with more rounds than fit scrolls sideways instead.
 * `extra` adds one tab after the rounds (the Survey's end-of-day question),
 * selected with the value 0, which no real round uses.
 */
function RoundTabs({
  rounds,
  value,
  onChange,
  done,
  extra,
}: {
  rounds: number[];
  value: number;
  onChange: (round: number) => void;
  /** Rounds to tick: scored on Results, rated on the Survey. */
  done?: (round: number) => boolean;
  extra?: { label: string; done?: boolean };
}) {
  const items = [
    ...rounds.map((n) => ({ value: n, label: `Round ${n}`, done: done?.(n) ?? false })),
    ...(extra ? [{ value: 0, label: extra.label, done: extra.done ?? false }] : []),
  ];
  return (
    <div
      role="tablist"
      aria-label="Rounds"
      className="mb-3 flex overflow-x-auto"
    >
      {items.map((it) => {
        const active = it.value === value;
        return (
          <button
            key={it.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(it.value)}
            className={`min-w-fit flex-1 whitespace-nowrap border-b-2 px-1.5 py-2 text-xs font-medium transition-colors sm:px-3 sm:text-sm ${
              active
                ? "border-emerald-600 text-emerald-700 dark:text-emerald-400"
                : "border-black/10 opacity-60 hover:opacity-100 dark:border-white/15"
            }`}
          >
            {it.label}
            {it.done && (
              <span className="ml-1 text-emerald-600 dark:text-emerald-400" aria-label="done">
                ✓
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---- schedule --------------------------------------------------------------
/**
 * The draw, read-only, one round at a time. The point of this tab is the
 * question a member actually arrives with, so picking a name puts that
 * person's whole day in one strip at the top, and the round below narrows to
 * just their match. "Everyone" shows every court in the round.
 */
function ScheduleView({
  schedule: s,
  names,
  scores,
  meIndex,
  meName,
  onChooseMe,
  round,
  onRound,
}: {
  schedule: Schedule;
  names: string[];
  scores: Scores;
  meIndex: number;
  meName: string;
  onChooseMe: (name: string) => void;
  round: number;
  onRound: (round: number) => void;
}) {
  const roster = useMemo(
    () =>
      s.players
        .map((p, i) => ({ name: p.name, i }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [s.players]
  );

  const isMine = (m: Match) =>
    meIndex >= 0 && [...m.teamA, ...m.teamB].includes(meIndex);

  // Where the chosen player is each round, byes included.
  const myDay = useMemo(() => {
    if (meIndex < 0) return [];
    return s.rounds.map((rnd) => {
      const m = rnd.matches.find((mm) => [...mm.teamA, ...mm.teamB].includes(meIndex));
      return { round: rnd.number, court: m ? courtName(m.court, names) : null };
    });
  }, [s.rounds, meIndex, names]);

  /**
   * How much walking the day asks of this player.
   *
   * Read off the same function the organizer's movement table uses, so the
   * number a player sees on their own strip is the number the organizer sees
   * in the row beside their name.
   */
  const myMoves = useMemo(
    () => (meIndex < 0 ? null : playerTravel(s)[meIndex] ?? null),
    [s, meIndex]
  );

  // A name may be remembered from a previous mixer that this one does not
  // include, which is worth saying rather than silently ignoring.
  const notPlaying = meName !== "" && meIndex < 0;

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <label className="opacity-70" htmlFor="me">
          Find me
        </label>
        <select
          id="me"
          value={meIndex >= 0 ? meName : ""}
          onChange={(e) => onChooseMe(e.target.value)}
          className="rounded-lg border border-black/15 bg-transparent px-2 py-1.5 dark:border-white/20"
        >
          <option value="">Everyone</option>
          {roster.map((r) => (
            <option key={r.i} value={r.name}>
              {r.name}
            </option>
          ))}
        </select>
        <span className="text-xs opacity-50">Remembered on this phone.</span>
      </div>

      {notPlaying && (
        <p className="mb-4 rounded-lg bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {meName} is not on today&apos;s roster. Pick a name from the list, or ask the
          organizer.
        </p>
      )}

      {myDay.length > 0 && (
        <div className="mb-5 rounded-xl border border-emerald-700/30 bg-emerald-50/50 p-3 dark:bg-emerald-950/20">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <h2 className="text-sm font-semibold">{meName}&apos;s day</h2>
            {/* The bare number. A player wants to know whether the draw marches
                them across the club; any gloss on the end of it is the
                organizer's business, and the breakdown lives in the movement
                table behind the admin gate. */}
            {myMoves && (
              <p className="text-xs">
                <span className="opacity-60"># Venue Changes:</span>{" "}
                <span className="font-semibold">{myMoves.venueChanges}</span>
              </p>
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {/* Each stop on the day doubles as a way to open that round. */}
            {myDay.map((d) => (
              <button
                key={d.round}
                type="button"
                onClick={() => onRound(d.round)}
                className={`rounded-lg px-2.5 py-1.5 text-xs ${
                  d.round === round ? "ring-2 ring-emerald-600" : ""
                } ${
                  d.court
                    ? "bg-white/70 dark:bg-white/10"
                    : "bg-black/5 opacity-60 dark:bg-white/5"
                }`}
              >
                <span className="opacity-60">R{d.round}</span>{" "}
                <span className="font-medium">{d.court ?? "sitting out"}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <RoundTabs rounds={s.rounds.map((r) => r.number)} value={round} onChange={onRound} />

      {(() => {
        const rnd = s.rounds.find((r) => r.number === round) ?? s.rounds[0];
        const me = meIndex >= 0;
        // A chosen player sees only their own match; everyone else sees the
        // whole round. A player sitting this round out has no match, so the
        // sitting-out block below is their answer.
        const matches = [...rnd.matches]
          .filter((m) => !me || isMine(m))
          .sort((a, b) => a.court - b.court);
        const sittingOut = me && rnd.byes.includes(meIndex);
        return (
          <section className="mb-5">
            <div className="space-y-2">
              {matches.map((m) => {
                const games = readScore(scores, rnd.number, m.court);
                const mine = isMine(m);
                return (
                  <div
                    key={m.court}
                    className={`rounded-xl border p-3 ${
                      mine
                        ? "border-emerald-600/60 bg-emerald-50/60 dark:bg-emerald-950/25"
                        : "border-black/10 dark:border-white/15"
                    }`}
                  >
                    <div className="mb-1.5 flex items-center justify-between text-xs">
                      <span className="font-medium opacity-70">
                        {courtName(m.court, names)}
                        {s.format === "same" && ` · ${drawLabel(m)}`}
                      </span>
                      {games === null ? (
                        <span className="opacity-40">not played yet</span>
                      ) : (
                        <span className="tabular-nums opacity-70">
                          {games} - {GAMES_PER_MATCH - games}
                        </span>
                      )}
                    </div>
                    <TeamLine
                      schedule={s}
                      team={m.teamA}
                      meIndex={meIndex}
                      won={games !== null && games > GAMES_PER_MATCH - games}
                    />
                    <div className="my-1 text-xs opacity-40">v</div>
                    <TeamLine
                      schedule={s}
                      team={m.teamB}
                      meIndex={meIndex}
                      won={games !== null && GAMES_PER_MATCH - games > games}
                    />
                  </div>
                );
              })}
            </div>
            {(!me || sittingOut) && <Byes schedule={s} byes={rnd.byes} meIndex={meIndex} />}
          </section>
        );
      })()}
    </section>
  );
}

function TeamLine({
  schedule: s,
  team,
  meIndex,
  won,
}: {
  schedule: Schedule;
  team: number[];
  meIndex: number;
  won: boolean;
}) {
  return (
    <div className={`text-sm ${won ? "font-semibold" : ""}`}>
      {team.map((i, k) => (
        <span key={i}>
          <span className={i === meIndex ? "rounded bg-emerald-600/20 px-1 font-semibold" : ""}>
            {s.players[i].name}
          </span>
          {k === 0 ? " & " : ""}
        </span>
      ))}{" "}
      <TeamLevel level={teamAvg(s, team as [number, number])} />
    </div>
  );
}

/**
 * A team's level in parentheses after the names: the mean of the two
 * partners' ratings (see `teamAvg`). Muted and never bold, so it reads as a
 * note on the team rather than part of a winning score.
 */
function TeamLevel({ level }: { level: number }) {
  return <span className="text-xs font-normal tabular-nums opacity-50">({level})</span>;
}

/** One match: two teams and the games each won, which always add up to 8. */
function MatchRow({
  label,
  draw,
  teamA,
  teamB,
  levelA,
  levelB,
  games,
  state,
  onChange,
}: {
  label: string;
  draw: string;
  teamA: string;
  teamB: string;
  levelA: number;
  levelB: number;
  games: number | null;
  state?: SaveState;
  onChange: (games: number | null) => void;
}) {
  const a = games;
  const b = games === null ? null : GAMES_PER_MATCH - games;
  return (
    <div className="rounded-xl border border-black/10 p-3 dark:border-white/15">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="font-medium opacity-70">
          {label}
          {draw && ` · ${draw}`}
        </span>
        <span className="opacity-60">
          {state === "saving" && "saving…"}
          {state === "saved" && <span className="text-emerald-600 dark:text-emerald-400">saved ✓</span>}
          {state === "error" && (
            <span className="text-red-600 dark:text-red-400">not saved - tap again</span>
          )}
        </span>
      </div>
      <div className="grid grid-cols-[1fr_auto] items-center gap-2">
        <span className={`text-sm ${a !== null && b !== null && a > b ? "font-semibold" : ""}`}>
          {teamA} <TeamLevel level={levelA} />
        </span>
        <GamesPicker
          value={a}
          onChange={(v) => onChange(v)}
          label={`Games won by ${teamA}`}
        />
        <span className={`text-sm ${a !== null && b !== null && b > a ? "font-semibold" : ""}`}>
          {teamB} <TeamLevel level={levelB} />
        </span>
        <GamesPicker
          value={b}
          onChange={(v) => onChange(v === null ? null : GAMES_PER_MATCH - v)}
          label={`Games won by ${teamB}`}
        />
      </div>
      {games !== null && (
        <button
          onClick={() => onChange(null)}
          className="mt-2 text-xs underline opacity-50 hover:opacity-80"
        >
          clear this score
        </button>
      )}
    </div>
  );
}

/**
 * A 0-8 picker rather than a free text box: it cannot produce a number that is
 * not a legal score, and it needs no keyboard on a phone.
 */
function GamesPicker({
  value,
  onChange,
  label,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  label: string;
}) {
  return (
    <select
      aria-label={label}
      value={value === null ? "" : String(value)}
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      className={`w-20 rounded-lg border px-2 py-2 text-center text-base tabular-nums ${
        value === null
          ? "border-dashed border-black/25 opacity-60 dark:border-white/30"
          : "border-black/15 font-semibold dark:border-white/20"
      } bg-transparent`}
    >
      <option value="">–</option>
      {Array.from({ length: GAMES_PER_MATCH + 1 }, (_, i) => (
        <option key={i} value={i}>
          {i}
        </option>
      ))}
    </select>
  );
}

// ---- leaderboard -----------------------------------------------------------
function LeaderboardView({
  board,
  onDownload,
  hasByes,
}: {
  board: ReturnType<typeof leaderboards>;
  onDownload: () => void;
  hasByes: boolean;
}) {
  const [which, setWhich] = useState<"all" | "men" | "women">("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "rank",
    dir: "asc",
  });
  const rows = board[which];

  /**
   * Sorting changes the order of the rows and nothing else.
   *
   * The rank column keeps showing each player's real rank, which is on total
   * games and computed by `rankTable`. Sorting by name and finding yourself
   * numbered 7th is the point: it answers "where did I come" without making
   * the reader scan twenty rows for their own surname. Renumbering 1..n on
   * whatever column was clicked would invent a second, wrong, standing.
   */
  const sorted = useMemo(() => {
    const out = [...rows];
    if (sort.key === "rank") {
      // Already in ranked order from `rankTable`, ties and all.
      return sort.dir === "asc" ? out : out.reverse();
    }
    out.sort((a, b) => {
      const cmp =
        sort.key === "name"
          ? a.name.localeCompare(b.name)
          : a[sort.key] - b[sort.key] || a.name.localeCompare(b.name);
      return sort.dir === "asc" ? cmp : -cmp;
    });
    return out;
  }, [rows, sort]);

  /**
   * Click a column to sort by it; click it again to reverse.
   *
   * A first click sorts the way the column is usually read: names up from A,
   * numbers down from the best, rank from first place. Guessing that once is
   * worth more than making everyone click twice.
   */
  function sortBy(key: SortKey) {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "name" || key === "rank" ? "asc" : "desc" }
    );
  }
  return (
    <section>
      <div className="mb-3 flex gap-2">
        {(["all", "men", "women"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setWhich(k)}
            className={`rounded-lg px-3 py-1.5 text-sm capitalize ${
              which === k
                ? "bg-black/10 font-semibold dark:bg-white/15"
                : "opacity-60 hover:opacity-100"
            }`}
          >
            {k === "all" ? "Open" : k}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Nobody on this roster is marked{" "}
          {which === "men" ? "as a man" : "as a woman"}, so this table is empty.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-black/10 text-left text-xs uppercase tracking-wide opacity-60 dark:border-white/15">
                <SortHeader col="rank" sort={sort} onSort={sortBy}>
                  #
                </SortHeader>
                <SortHeader col="name" sort={sort} onSort={sortBy}>
                  Player
                </SortHeader>
                <SortHeader col="games" sort={sort} onSort={sortBy} right>
                  Games
                </SortHeader>
                <SortHeader col="played" sort={sort} onSort={sortBy} right>
                  Matches
                </SortHeader>
                <SortHeader col="avg" sort={sort} onSort={sortBy} right last>
                  Avg
                </SortHeader>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <LeaderRow key={`${r.index}-${r.name}`} r={r} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-xs opacity-60">
        Tap a column to sort by it, and again to reverse. The # column always
        shows the real placing, whatever the table is sorted by.
      </p>
      {hasByes && (
        <p className="mt-3 text-xs opacity-60">
          Ranking is on total games won. Players who sat out a round had one fewer match to
          win games in, so the Avg column is there to read alongside it.
        </p>
      )}
      {!board.complete && (
        <p className="mt-2 text-xs opacity-60">
          {board.total - board.entered} match
          {board.total - board.entered === 1 ? " is" : "es are"} still unscored, so this is
          not final.
        </p>
      )}

      <button
        onClick={onDownload}
        className="mt-4 w-full rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800"
      >
        ⬇ Download results as Excel
      </button>
    </section>
  );
}

function LeaderRow({ r }: { r: PlayerScore }) {
  const medal = r.rank === 1 ? "🥇" : r.rank === 2 ? "🥈" : r.rank === 3 ? "🥉" : "";
  return (
    <tr className="border-b border-black/5 dark:border-white/10">
      <td className="py-2 pr-2 tabular-nums opacity-70">{r.rank}</td>
      <td className="py-2 pr-2">
        {medal && <span className="mr-1">{medal}</span>}
        <span className={r.rank <= 3 ? "font-semibold" : ""}>{r.name}</span>
        <span className="ml-2 text-xs opacity-40">{r.level}</span>
      </td>
      <td className="py-2 pr-2 text-right font-semibold tabular-nums">{r.games}</td>
      <td className="py-2 pr-2 text-right tabular-nums opacity-70">{r.played}</td>
      <td className="py-2 text-right tabular-nums opacity-70">
        {r.played ? r.avg.toFixed(1) : "–"}
      </td>
    </tr>
  );
}

/** Which column the leaderboard is sorted by. */
type SortKey = "rank" | "name" | "games" | "played" | "avg";

/**
 * A leaderboard column header that sorts.
 *
 * A real `<button>` inside the `<th>` rather than a click handler on the cell,
 * so the column is reachable by keyboard and announces itself; `aria-sort`
 * tells a screen reader which way the table is currently ordered.
 */
function SortHeader({
  col,
  sort,
  onSort,
  right,
  last,
  children,
}: {
  col: SortKey;
  sort: { key: SortKey; dir: "asc" | "desc" };
  onSort: (key: SortKey) => void;
  right?: boolean;
  last?: boolean;
  children: React.ReactNode;
}) {
  const active = sort.key === col;
  return (
    <th
      className={`py-2 ${last ? "" : "pr-2"} ${right ? "text-right" : "text-left"}`}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(col)}
        className={`inline-flex items-center gap-1 uppercase tracking-wide ${
          active ? "font-semibold opacity-100" : "hover:opacity-100"
        }`}
      >
        {children}
        {/* A fixed-width marker, so switching column does not shuffle the
            header widths and jog the whole table sideways. */}
        <span aria-hidden className={`w-2 text-[0.6rem] ${active ? "" : "opacity-0"}`}>
          {sort.dir === "asc" ? "▲" : "▼"}
        </span>
      </button>
    </th>
  );
}

// ---- the survey ------------------------------------------------------------
/**
 * Five tappable stars.
 *
 * Tapping the star a rating already sits on clears it, which is the only way
 * back from a mis-tap on a phone; there is no separate clear button to find.
 * The targets are deliberately large: this is filled in courtside, standing
 * up, often in sunshine.
 */
function StarPicker({
  value,
  onChange,
  label,
  state,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  label: string;
  state?: SaveState;
}) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label={label}>
      {Array.from({ length: MAX_STARS }, (_, i) => i + 1).map((n) => {
        const on = value !== null && n <= value;
        return (
          <button
            key={n}
            type="button"
            aria-label={`${n} star${n === 1 ? "" : "s"}`}
            aria-pressed={on}
            onClick={() => onChange(value === n ? null : n)}
            className={`px-0.5 text-2xl leading-none transition-transform active:scale-90 ${
              on ? "text-amber-500" : "opacity-25 hover:opacity-50"
            }`}
          >
            {on ? "★" : "☆"}
          </button>
        );
      })}
      {state === "saving" && <span className="ml-1 text-xs opacity-50">saving…</span>}
      {state === "error" && (
        <span className="ml-1 text-xs text-red-600 dark:text-red-400">not saved</span>
      )}
    </div>
  );
}

/**
 * The Rate pane: your own matches, then the day.
 *
 * It asks who you are first, for the same reason the Schedule tab does, and
 * remembers it in the same place. Without a name there is nothing sensible to
 * show: the question is not "rate the tennis" in the abstract, it is "rate the
 * four matches you played", and which four depends entirely on who is asking.
 */
function SurveyRate({
  schedule,
  names,
  ratings,
  survey,
  saveState,
  meIndex,
  meName,
  onChooseMe,
  onRate,
  round,
  onRound,
}: {
  schedule: Schedule;
  names: string[];
  ratings: Ratings;
  /** Everyone's ratings, folded. Null only before the event has loaded. */
  survey: ReturnType<typeof summarizeSurvey> | null;
  saveState: Record<string, SaveState>;
  meIndex: number;
  meName: string;
  onChooseMe: (name: string) => void;
  onRate: (player: number, stars: number | null, at?: { round: number; court: number }) => void;
  round: number;
  onRound: (round: number) => void;
}) {
  // The end-of-day question is its own tab after the rounds. Kept here rather
  // than in the page-wide round, which the Schedule and Results tabs share and
  // which has no "overall" to show.
  const [overallOpen, setOverallOpen] = useState(false);

  if (meIndex < 0) {
    return (
      <section>
        <h2 className="text-sm font-semibold">Rate your matches</h2>
        <p className="mt-2 text-sm opacity-70">
          Pick your name and you will get your own card for each round, plus one
          question about the day as a whole. Nobody sees who gave which rating.
        </p>
        <select
          aria-label="Who are you?"
          value={meName}
          onChange={(e) => onChooseMe(e.target.value)}
          className="mt-4 w-full rounded-lg border border-black/15 bg-transparent px-3 py-2.5 text-base dark:border-white/20"
        >
          <option value="">Who are you?</option>
          {[...schedule.players]
            .map((p, i) => ({ name: p.name, i }))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(({ name, i }) => (
              <option key={i} value={name}>
                {name}
              </option>
            ))}
        </select>
        {meName && (
          <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            {meName} is not on today&apos;s roster, so there are no matches to rate.
          </p>
        )}
      </section>
    );
  }

  const mine = matchesFor(schedule, meIndex);
  const { rated, total } = progressFor(schedule, ratings, meIndex);
  const overall = ratings[overallKey(meIndex)] ?? null;

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">
          Rating as <span className="font-bold">{meName}</span>
        </h2>
        <button
          type="button"
          onClick={() => onChooseMe("")}
          className="text-xs underline underline-offset-2 opacity-60 hover:opacity-100"
        >
          not me
        </button>
      </div>

      <p className="mb-4 text-xs opacity-60">
        {rated} of {total} match{total === 1 ? "" : "es"} rated. Pick a round, tap a
        star to rate, tap it again to undo. The last tab is the day as a whole. Ratings are anonymous and save as you go, and once
        you have rated a round you will see how everyone else found it, updating
        as they answer.
      </p>

      <RoundTabs
        rounds={schedule.rounds.map((r) => r.number)}
        value={overallOpen ? 0 : round}
        onChange={(n) => {
          setOverallOpen(n === 0);
          if (n !== 0) onRound(n);
        }}
        done={(n) =>
          mine.some(
            (m) => m.round === n && ratings[ratingKey(n, m.court, meIndex)] !== undefined
          )
        }
        extra={{ label: "Overall", done: overall !== null }}
      />

      {!overallOpen &&
        (() => {
          const slot = mine.find((m) => m.round === round);
          if (!slot) {
            return (
              <p className="rounded-xl border border-dashed border-black/15 p-3 text-sm opacity-60 dark:border-white/20">
                You sat out Round {round}, so there is nothing to rate here.
              </p>
            );
          }
          const { court } = slot;
          const key = ratingKey(round, court, meIndex);
          const match = schedule.rounds
            .find((r) => r.number === round)
            ?.matches.find((m) => m.court === court);
          // Which side of the net this player was on decides who their partner
          // was. Taking the other three in team order would name an opponent
          // as the partner for everybody drawn on team B.
          const onA = match ? match.teamA.includes(meIndex) : false;
          const partner = match
            ? (onA ? match.teamA : match.teamB).find((i) => i !== meIndex)
            : undefined;
          const against = match ? (onA ? match.teamB : match.teamA) : [];
          return (
            <div className="rounded-xl border border-black/10 p-3 dark:border-white/15">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-semibold">Round {round}</span>
                <span className="text-xs opacity-60">{courtName(court, names)}</span>
              </div>
              {/* Who was on court, so a player has something to remember the
                  round by other than its number. */}
              {partner !== undefined && match && (
                <p className="mt-0.5 truncate text-xs opacity-50">
                  with {schedule.players[partner]?.name} (
                  {teamAvg(schedule, onA ? match.teamA : match.teamB)}) v{" "}
                  {against.map((i) => schedule.players[i]?.name).join(" & ")} (
                  {teamAvg(schedule, onA ? match.teamB : match.teamA)})
                </p>
              )}
              <div className="mt-2">
                <StarPicker
                  label={`Round ${round} on ${courtName(court, names)}`}
                  value={ratings[key] ?? null}
                  state={saveState[key]}
                  onChange={(v) => onRate(meIndex, v, { round, court })}
                />
              </div>
              {/* How the round is going, but only once this player has had
                  their say. Showing the average first would anchor the answer
                  to it, and the number would stop measuring what people
                  thought and start measuring what they saw. */}
              <RoundSoFar
                round={round}
                tally={survey?.rounds.find((r) => r.round === round)}
                revealed={ratings[key] !== undefined}
              />
            </div>
          );
        })()}

      {/* The tournament as a whole, which is a different question from the
          mean of the matches: a day can be more or less than its tennis. */}
      {overallOpen && (
        <div className="rounded-xl border border-emerald-600/30 bg-emerald-50/50 p-4 dark:bg-emerald-950/20">
          <h3 className="text-sm font-semibold">The tournament overall</h3>
          <p className="mt-0.5 text-xs opacity-60">
            Everything together: the draw, the organization, the morning.
          </p>
          <div className="mt-2">
            <StarPicker
              label="The tournament overall"
              value={overall}
              state={saveState[overallKey(meIndex)]}
              onChange={(v) => onRate(meIndex, v)}
            />
          </div>
          <RoundSoFar
            round={0}
            tally={survey?.overall}
            revealed={overall !== null}
            label="Everyone so far"
          />
        </div>
      )}
    </section>
  );
}

/** One round's mean rating, shown under that round's scores. */
function RoundRating({ tally }: { tally?: Tally }) {
  if (!tally || tally.count === 0) return null;
  return (
    <p className="mt-2 text-xs opacity-60">
      <span className="text-amber-500">{starBar(tally.avg)}</span>{" "}
      {fmtStars(tally.avg)} from {tally.count} rating{tally.count === 1 ? "" : "s"}
    </p>
  );
}

/**
 * The survey at the foot of the Results tab: the two headline numbers.
 *
 * Kept to the two means and their counts. The per-round detail sits under
 * each round's tab, and a second copy of it here would be a table nobody
 * reads.
 */
function SurveySummary({
  survey,
  players,
  onOpenSurvey,
}: {
  survey: ReturnType<typeof summarizeSurvey>;
  players: number;
  onOpenSurvey: () => void;
}) {
  const nothing = survey.matches.count === 0 && survey.overall.count === 0;
  return (
    <section className="mt-6 rounded-xl border border-black/10 p-4 dark:border-white/15">
      <h2 className="text-sm font-semibold">Survey</h2>
      {nothing ? (
        <p className="mt-1 text-sm opacity-70">
          Nobody has rated anything yet.{" "}
          <button
            type="button"
            onClick={onOpenSurvey}
            className="underline underline-offset-2"
          >
            Rate your matches
          </button>
          .
        </p>
      ) : (
        <>
          <dl className="mt-2 grid grid-cols-2 gap-4">
            <div>
              <dt className="text-xs uppercase tracking-wide opacity-60">The tennis</dt>
              <dd className="mt-0.5">
                <span className="text-amber-500">{starBar(survey.matches.avg)}</span>{" "}
                <span className="font-semibold tabular-nums">
                  {fmtStars(survey.matches.avg)}
                </span>
                <span className="ml-1 text-xs opacity-60">
                  · {survey.matches.count} rating{survey.matches.count === 1 ? "" : "s"}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide opacity-60">The tournament</dt>
              <dd className="mt-0.5">
                {survey.overall.count === 0 ? (
                  <span className="text-sm opacity-50">not rated yet</span>
                ) : (
                  <>
                    <span className="text-amber-500">{starBar(survey.overall.avg)}</span>{" "}
                    <span className="font-semibold tabular-nums">
                      {fmtStars(survey.overall.avg)}
                    </span>
                    <span className="ml-1 text-xs opacity-60">
                      · {survey.overall.count}
                    </span>
                  </>
                )}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-xs opacity-60">
            {survey.responders} of {players} players have had their say.{" "}
            <button
              type="button"
              onClick={onOpenSurvey}
              className="underline underline-offset-2"
            >
              Add yours
            </button>
            .
          </p>
        </>
      )}
    </section>
  );
}

/**
 * How everyone else found this round, shown once you have rated it yourself.
 *
 * The reveal is deliberately gated on the reader's own answer. An average
 * sitting above an empty row of stars is an anchor: people converge on the
 * number in front of them, and a survey that does that is measuring its own
 * display rather than the tennis. Rate first, then compare.
 *
 * `count` of 1 says the reader is the only person in yet, so it reports that
 * rather than presenting their own rating back to them as a consensus.
 */
function RoundSoFar({
  round,
  tally,
  revealed,
  label,
}: {
  round: number;
  tally?: Tally;
  revealed: boolean;
  label?: string;
}) {
  if (!revealed) {
    return (
      <p className="mt-2 text-xs opacity-40">
        Rate it to see how {label ? "everyone else" : "the round"} went.
      </p>
    );
  }
  if (!tally || tally.count === 0) return null;
  if (tally.count === 1) {
    return <p className="mt-2 text-xs opacity-50">You are the first to rate this.</p>;
  }
  return (
    <p className="mt-2 text-xs opacity-70">
      {label ?? `Round ${round} so far`}:{" "}
      <span className="text-amber-500">{starBar(tally.avg)}</span>{" "}
      <span className="font-semibold tabular-nums">{fmtStars(tally.avg)}</span>
      <span className="opacity-70"> from {tally.count} ratings</span>
    </p>
  );
}

/**
 * The Survey tab: two panes, rating and reading.
 *
 * Player's is one player's own card for each round, a round at a time, plus
 * the day overall. Everyone is the whole club's answer, round by round and
 * court by court. They are the same data from opposite
 * ends, which is why they are sub-tabs of one tab rather than two tabs in the
 * top bar: the top bar answers "what do you want to do", and both of these are
 * the survey.
 *
 * Not folded into the Leaderboard, either, though it was the other candidate.
 * The leaderboard ranks people on games won; this rates matches on how good
 * they were to play. Putting a star average in a column beside a games total
 * invites reading one as a component of the other, and they measure nothing in
 * common: the best player can have the dullest afternoon.
 */
function SurveyView(props: {
  schedule: Schedule;
  names: string[];
  ratings: Ratings;
  survey: ReturnType<typeof summarizeSurvey> | null;
  saveState: Record<string, SaveState>;
  meIndex: number;
  meName: string;
  onChooseMe: (name: string) => void;
  onRate: (player: number, stars: number | null, at?: { round: number; court: number }) => void;
  round: number;
  onRound: (round: number) => void;
}) {
  const [pane, setPane] = useState<"rate" | "all">("rate");
  const { survey, schedule, names, round, onRound } = props;
  const answers = survey ? survey.matches.count + survey.overall.count : 0;

  return (
    <section>
      <div className="mb-4 flex gap-2">
        {(["rate", "all"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setPane(k)}
            className={`rounded-lg px-3 py-1.5 text-sm ${
              pane === k
                ? "bg-black/10 font-semibold dark:bg-white/15"
                : "opacity-60 hover:opacity-100"
            }`}
          >
            {k === "rate" ? "Player's" : "Everyone"}
            {/* The count is the reason to look, so it goes on the tab. */}
            {k === "all" && answers > 0 && (
              <span className="ml-1.5 text-xs opacity-60">{answers}</span>
            )}
          </button>
        ))}
      </div>

      {pane === "rate" ? (
        <SurveyRate {...props} />
      ) : (
        <SurveyResults
          survey={survey}
          schedule={schedule}
          names={names}
          round={round}
          onRound={onRound}
        />
      )}
    </section>
  );
}

/**
 * The whole club's answer: two headline numbers, then every round and court.
 *
 * Court rows are held back until three people on that court have rated it.
 * Four players share a court, so with two ratings in and one of them your own
 * the average gives up the other person's answer exactly - in a club of
 * eighteen who all know each other, that is not anonymous. Three is the point
 * where an individual score stops being recoverable from the mean.
 */
function SurveyResults({
  survey,
  schedule,
  names,
  round,
  onRound,
}: {
  survey: ReturnType<typeof summarizeSurvey> | null;
  schedule: Schedule;
  names: string[];
  round: number;
  onRound: (round: number) => void;
}) {
  if (!survey) return null;
  // The draw's NTRP levels, shown beside the stars. They exist before anyone
  // has rated anything, so the pane renders them even while it is empty.
  const quality = drawQuality(schedule);
  const nothing = survey.matches.count === 0 && survey.overall.count === 0;

  const rated = survey.rounds.filter((r) => r.count > 0);
  const best = rated.length
    ? rated.reduce((a, b) => (b.avg > a.avg ? b : a))
    : null;
  const worst = rated.length
    ? rated.reduce((a, b) => (b.avg < a.avg ? b : a))
    : null;

  return (
    <div>
      {nothing && (
        <p className="mb-3 rounded-lg bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Nobody has rated anything yet. Ratings appear here as they come in.
        </p>
      )}
      <dl className="grid grid-cols-2 gap-3">
        <Headline
          label="The tournament"
          tally={survey.overall}
          hint="the end-of-day question"
        />
        <Headline
          label="The tennis"
          tally={survey.matches}
          hint="every match rating pooled"
        />
      </dl>

      <p className="mt-3 text-xs opacity-60">
        {survey.responders} of {schedule.players.length} players have rated
        something. Updates as answers come in.
      </p>
      <LevelsLine label="NTRP levels, every match" stats={quality} />

      <h3 className="mt-6 mb-2 text-sm font-semibold">Round by round</h3>
      <RoundTabs
        rounds={survey.rounds.map((r) => r.round)}
        value={round}
        onChange={onRound}
      />
      <div className="space-y-2">
        {survey.rounds.filter((r) => r.round === round).map((r) => (
          <div
            key={r.round}
            className="rounded-xl border border-black/10 p-3 dark:border-white/15"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-semibold">
                Round {r.round}
                {/* Only worth calling out once there is a spread to call out. */}
                {rated.length > 1 && best && worst && best.avg !== worst.avg && (
                  <>
                    {r.round === best.round && (
                      <span className="ml-2 text-xs font-normal text-emerald-700 dark:text-emerald-400">
                        best round
                      </span>
                    )}
                    {r.round === worst.round && (
                      <span className="ml-2 text-xs font-normal opacity-50">
                        lowest rated
                      </span>
                    )}
                  </>
                )}
              </span>
              {r.count === 0 ? (
                <span className="text-xs opacity-40">not rated yet</span>
              ) : (
                <span className="text-sm">
                  <span className="text-amber-500">{starBar(r.avg)}</span>{" "}
                  <span className="font-semibold tabular-nums">{fmtStars(r.avg)}</span>
                  <span className="ml-1 text-xs opacity-50">· {r.count}</span>
                </span>
              )}
            </div>

            {(() => {
              const rq = quality.rounds.find((x) => x.round === r.round);
              return rq ? <LevelsLine label="NTRP levels" stats={rq} /> : null;
            })()}

            {/* Every court, rated or not: its levels are known from the draw,
                and the stars fill in as the answers arrive. */}
            <ul className="mt-2 space-y-1">
              {r.matches.map((m) => {
                const mq = quality.rounds
                  .find((x) => x.round === r.round)
                  ?.matches.find((x) => x.court === m.court);
                return (
                  <li
                    key={m.court}
                    className="grid grid-cols-[1fr_auto_auto] items-baseline gap-x-3 text-xs"
                  >
                    <span className="truncate opacity-60">{courtName(m.court, names)}</span>
                    <span className="tabular-nums opacity-60">
                      {mq && (
                        <>
                          {fmtLevel(mq.low)} to {fmtLevel(mq.high)} · avg {fmtLevel(mq.avg)}
                        </>
                      )}
                    </span>
                    {m.count >= MIN_COURT_RATINGS ? (
                      <span className="shrink-0">
                        <span className="text-amber-500">{starBar(m.avg)}</span>{" "}
                        <span className="tabular-nums">{fmtStars(m.avg)}</span>
                        <span className="ml-1 opacity-40">· {m.count}</span>
                      </span>
                    ) : (
                      <span
                        className="shrink-0 opacity-30"
                        title="Shown once three people on this court have rated it, so no single answer can be worked out from the average."
                      >
                        {m.count === 0 ? "–" : "too few yet"}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      <p className="mt-4 text-xs opacity-50">
        A court shows its own star average once three of its four players have
        rated it. Below that the average would give away an individual answer.
        Levels are NTRP: Lowest and Highest are the lowest and highest rated
        players on court, and Average is the mean of the four.
      </p>
    </div>
  );
}

/** "NTRP levels · Lowest 3.00 · Highest 4.00 · Average 3.45", for a round or the day. */
function LevelsLine({ label, stats }: { label: string; stats: LevelStats }) {
  return (
    <p className="mt-2 text-xs tabular-nums">
      <span className="opacity-60">{label}:</span> Lowest{" "}
      <span className="font-semibold">{fmtLevel(stats.low)}</span> · Highest{" "}
      <span className="font-semibold">{fmtLevel(stats.high)}</span> · Average{" "}
      <span className="font-semibold">{fmtLevel(stats.avg)}</span>
    </p>
  );
}

/** One of the two big numbers at the top of the Everyone pane. */
function Headline({
  label,
  tally,
  hint,
}: {
  label: string;
  tally: Tally;
  hint: string;
}) {
  return (
    <div className="rounded-xl border border-black/10 p-3 dark:border-white/15">
      <dt className="text-xs uppercase tracking-wide opacity-60">{label}</dt>
      <dd className="mt-1">
        {tally.count === 0 ? (
          <span className="text-sm opacity-40">not rated yet</span>
        ) : (
          <>
            <div className="text-amber-500">{starBar(tally.avg)}</div>
            <div className="mt-0.5">
              <span className="text-xl font-bold tabular-nums">{fmtStars(tally.avg)}</span>
              <span className="ml-1.5 text-xs opacity-50">
                from {tally.count}
              </span>
            </div>
          </>
        )}
        <div className="mt-1 text-xs opacity-40">{hint}</div>
      </dd>
    </div>
  );
}
