/**
 * The results archive: one row per finished tournament, kept for good.
 *
 * A published event already lives at a permanent code, so in principle the club
 * could keep a list of links by hand. What they cannot do by hand is answer
 * "what have we played this season", which is what a members page wants, so the
 * archive is a small denormalised index: date, what kind of mixer it was, who
 * won, and the code to open the full leaderboard.
 *
 * Denormalised on purpose. The obvious design keeps only the codes and reads
 * each event to render the page, but that makes one page view cost two Redis
 * commands per tournament and grow every week. v7 was forced off Vercel Blob by
 * exactly that mistake: a per-poll `list()` on the read path burned a monthly
 * quota in one afternoon. A summary written once at archive time makes the
 * whole page a single `HGETALL`, no matter how many seasons accumulate.
 *
 * The cost of denormalising is staleness: correct a score after archiving and
 * the summary still shows the old champion. Re-archiving recomputes it, which
 * is why the admin page offers that rather than hiding the button once a
 * tournament is in.
 *
 * Everything here is pure. The Redis side lives in `lib/store`.
 */
import { FORMATS, type Format, type Schedule } from "./scheduler";
import { leaderboards, type PlayerScore, type Scores } from "./scoring";

/** One place on a podium. */
export interface Standing {
  /** 1, 2 or 3. Players level on games share a place, so this can repeat. */
  rank: number;
  name: string;
  games: number;
}

/** What the results table shows for one finished tournament. */
export interface ArchiveEntry {
  /** The event code, so the row can link to its leaderboard. */
  id: string;
  /**
   * The day it was played, as `YYYY-MM-DD`.
   *
   * A plain date string, not a timestamp, because this is a calendar date and
   * never a moment: the club plays on a Saturday morning, and an epoch would
   * have to be rendered back through a timezone to say so. It also sorts
   * correctly as text, which is all the ordering the table needs. The organiser
   * sets it, defaulting to the day the schedule was published, because a
   * schedule is often generated the evening before.
   */
  date: string;
  /** What the organiser called the mixer; may be empty. */
  title: string;
  format: Format;
  players: number;
  rounds: number;
  courts: number;
  /** Whoever finished top of the overall table. Plural on a tie. */
  champions: string[];
  /** Games won by the champion, so the row means something on its own. */
  championGames: number;
  /**
   * The top three men and the top three women, which is how the club has
   * always reported a mixer.
   *
   * Stored rather than recomputed on the results page, for the same reason as
   * everything else in this row: the page reads the archive and nothing else.
   * Written by every version from v8.1; a row filed before that has none, and
   * the page falls back to the overall champion until it is re-archived.
   */
  podium?: { men: Standing[]; women: Standing[] };
  /** Were all the matches scored when this was archived? */
  complete: boolean;
  /** Matches scored / matches scheduled, at archive time. */
  entered: number;
  total: number;
  archivedAt: number;
}

/**
 * How a format is named to members, who do not know the internal words.
 *
 * Read off `FORMATS` rather than restated here, so the results page and the
 * organiser's format picker can never end up calling the same draw two things.
 */
export function formatLabel(format: Format): string {
  return FORMATS.find((f) => f.value === format)?.label ?? format;
}

/** A `YYYY-MM-DD` string this module would accept back. */
export function isValidDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  // Rules out 2026-02-31 and friends: the parsed date has to be the same day
  // the string claims, which a rolled-over date is not.
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * The date part of a timestamp, in UTC.
 *
 * Only a fallback for when the organiser does not pick a date. The admin page
 * sends one taken from the browser, which is the timezone the club is actually
 * in; the server has no business guessing that.
 */
export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The players placing first, second or third in one table.
 *
 * Ties share a place, so this can return more than three names - four players
 * level on second all placed second, and dropping one of them because a list
 * was capped at three would be wrong. The cap is there only to stop a table
 * where nobody has scored from returning the entire roster.
 */
function podium(rows: PlayerScore[]): Standing[] {
  return rows
    .filter((r) => r.rank <= 3 && r.games > 0)
    .slice(0, 8)
    .map((r) => ({ rank: r.rank, name: r.name, games: r.games }));
}

/**
 * Read a tournament's final standing into a row for the archive.
 *
 * Ties share the top rank, so "champions" is a list; `rankTable` has already
 * done that work and marked every joint winner rank 1.
 */
export function summarize(
  ev: { id: string; title: string; createdAt: number; schedule: Schedule; courtNames?: string[] },
  scores: Scores,
  date: string,
  now: number = Date.now()
): ArchiveEntry {
  const board = leaderboards(ev.schedule, scores);
  const winners = board.all.filter((r) => r.rank === 1 && r.games > 0);
  const courts = new Set<number>();
  for (const rnd of ev.schedule.rounds) for (const m of rnd.matches) courts.add(m.court);

  return {
    id: ev.id,
    date: isValidDate(date) ? date : isoDate(ev.createdAt),
    title: ev.title ?? "",
    format: ev.schedule.format ?? "open",
    players: ev.schedule.players.length,
    rounds: ev.schedule.rounds.length,
    courts: courts.size,
    champions: winners.map((r) => r.name),
    championGames: winners[0]?.games ?? 0,
    podium: { men: podium(board.men), women: podium(board.women) },
    complete: board.complete,
    entered: board.entered,
    total: board.total,
    archivedAt: now,
  };
}

/** Is this something we wrote, and can still render a row from? */
export function isArchiveEntry(v: unknown): v is ArchiveEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Partial<ArchiveEntry>;
  return (
    typeof e.id === "string" &&
    isValidDate(e.date) &&
    typeof e.format === "string" &&
    typeof e.players === "number" &&
    Array.isArray(e.champions)
  );
}

/**
 * Newest first, which is the order a results page is read in.
 *
 * Two mixers can share a date (a morning and an afternoon draw), so the archive
 * timestamp breaks the tie, and the code breaks that in turn to keep the order
 * stable across reloads rather than left to the hash's iteration order.
 */
export function sortArchive(entries: ArchiveEntry[]): ArchiveEntry[] {
  return [...entries].sort(
    (a, b) =>
      b.date.localeCompare(a.date) ||
      b.archivedAt - a.archivedAt ||
      a.id.localeCompare(b.id)
  );
}

/** Group the archive by year, for a table that spans seasons. */
export function bySeason(entries: ArchiveEntry[]): { year: string; entries: ArchiveEntry[] }[] {
  const years = new Map<string, ArchiveEntry[]>();
  for (const e of sortArchive(entries)) {
    const year = e.date.slice(0, 4);
    years.set(year, [...(years.get(year) ?? []), e]);
  }
  return [...years].map(([year, list]) => ({ year, entries: list }));
}
