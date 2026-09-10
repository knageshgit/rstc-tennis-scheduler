"use client";

/**
 * What a club member sees: one published mixer, in three tabs.
 *
 *   Schedule     who is on which court, every round
 *   Results      the score for each match, and the box to enter it
 *   Leaderboard  games won, ranked, overall and by gender
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
  type Match,
  type Schedule,
} from "@/lib/scheduler";
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

interface EventData {
  id: string;
  title: string;
  createdAt: number;
  courtNames: string[];
  schedule: Schedule;
  scores: Scores;
}

/** Per-match save state, so a phone on a weak signal can see what happened. */
type SaveState = "saving" | "saved" | "error";

type Tab = "schedule" | "results" | "board" | "photos" | "chat";

const POLL_MS = 10_000;
const COURT_FILTER_KEY = "tennis-scorer-court";
/** Remembered by name, not index: next week's schedule renumbers everybody. */
const ME_KEY = "tennis-scorer-me";

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

  // Scores the user has just set but which the server has not confirmed yet.
  // Polling must not yank a value back out from under someone mid-entry, so
  // these win over the polled copy until their write lands.
  const pending = useRef<Set<string>>(new Set());

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
    setLastSync(nowMs());
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

  async function downloadExcel() {
    if (!data) return;
    const { buildScheduleWorkbook } = await import("@/lib/excel");
    const buf = await buildScheduleWorkbook(data.schedule, data.courtNames, scores);
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

  return (
    <main className="mx-auto max-w-3xl p-4 pb-24 sm:p-6">
      <header className="mb-4">
        <div className="flex items-center justify-between gap-3">
          {/* The badge sits to the left of the mixer name, and the pair take
              the width; the code stays pinned to the right. min-w-0 lets a long
              mixer name truncate rather than shove the code off the screen. */}
          <div className="flex min-w-0 items-center gap-2.5">
            <Logo />
            <h1 className="truncate text-lg font-semibold">{data.title || "Tennis mixer"}</h1>
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

          {s.rounds.map((rnd) => {
            const matches = rnd.matches
              .filter((m) => courtFilter === "all" || m.court === courtFilter)
              .sort((a, b) => a.court - b.court);
            if (!matches.length) return null;
            const done = matches.every(
              (m) => readScore(scores, rnd.number, m.court) !== null
            );
            return (
              <section key={rnd.number} className="mb-5">
                <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                  Round {rnd.number}
                  {done && <span className="text-emerald-600 dark:text-emerald-400">✓</span>}
                </h2>
                <div className="space-y-2">
                  {matches.map((m) => (
                    <MatchRow
                      key={m.court}
                      label={courtName(m.court, names)}
                      draw={s.format === "same" ? drawLabel(m) : ""}
                      teamA={`${s.players[m.teamA[0]].name} & ${s.players[m.teamA[1]].name}`}
                      teamB={`${s.players[m.teamB[0]].name} & ${s.players[m.teamB[1]].name}`}
                      games={readScore(scores, rnd.number, m.court)}
                      state={saveState[matchKey(rnd.number, m.court)]}
                      onChange={(g) => save(rnd.number, m.court, g)}
                    />
                  ))}
                </div>
                {/* Shown whatever the court filter is: filtering to one court
                    must not hide who is not on a court at all. */}
                <Byes schedule={s} byes={rnd.byes} meIndex={meIndex} />
              </section>
            );
          })}
        </>
      )}

      {tab === "board" && (
        <LeaderboardView
          board={board}
          onDownload={downloadExcel}
          hasByes={s.layout.byesPerRound > 0}
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

// ---- schedule --------------------------------------------------------------
/**
 * The draw, read-only. The point of this tab is the question a member actually
 * arrives with, so picking a name puts that person's whole day in one strip at
 * the top and marks their match in every round below.
 */
function ScheduleView({
  schedule: s,
  names,
  scores,
  meIndex,
  meName,
  onChooseMe,
}: {
  schedule: Schedule;
  names: string[];
  scores: Scores;
  meIndex: number;
  meName: string;
  onChooseMe: (name: string) => void;
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
          organiser.
        </p>
      )}

      {myDay.length > 0 && (
        <div className="mb-5 rounded-xl border border-emerald-700/30 bg-emerald-50/50 p-3 dark:bg-emerald-950/20">
          <h2 className="text-sm font-semibold">{meName}&apos;s day</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {myDay.map((d) => (
              <span
                key={d.round}
                className={`rounded-lg px-2.5 py-1.5 text-xs ${
                  d.court
                    ? "bg-white/70 dark:bg-white/10"
                    : "bg-black/5 opacity-60 dark:bg-white/5"
                }`}
              >
                <span className="opacity-60">R{d.round}</span>{" "}
                <span className="font-medium">{d.court ?? "sitting out"}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {s.rounds.map((rnd) => (
        <section key={rnd.number} className="mb-5">
          <h2 className="mb-2 text-sm font-semibold">Round {rnd.number}</h2>
          <div className="space-y-2">
            {[...rnd.matches]
              .sort((a, b) => a.court - b.court)
              .map((m) => {
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
          <Byes schedule={s} byes={rnd.byes} meIndex={meIndex} />
        </section>
      ))}
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
      ))}
    </div>
  );
}

/** One match: two teams and the games each won, which always add up to 8. */
function MatchRow({
  label,
  draw,
  teamA,
  teamB,
  games,
  state,
  onChange,
}: {
  label: string;
  draw: string;
  teamA: string;
  teamB: string;
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
          {teamA}
        </span>
        <GamesPicker
          value={a}
          onChange={(v) => onChange(v)}
          label={`Games won by ${teamA}`}
        />
        <span className={`text-sm ${a !== null && b !== null && b > a ? "font-semibold" : ""}`}>
          {teamB}
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
  const rows = board[which];
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
                <th className="py-2 pr-2">#</th>
                <th className="py-2 pr-2">Player</th>
                <th className="py-2 pr-2 text-right">Games</th>
                <th className="py-2 pr-2 text-right">Played</th>
                <th className="py-2 text-right">Avg</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <LeaderRow key={`${r.index}-${r.name}`} r={r} />
              ))}
            </tbody>
          </table>
        </div>
      )}

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
