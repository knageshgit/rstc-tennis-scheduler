/**
 * Scoring and leaderboards.
 *
 * Every match is a fixed 8 games. A player's score for a match is the number
 * of games their team won, so the two teams on a court always split 8 between
 * them: entering one side's games determines the other's.
 *
 * A player's event total is the sum of the games they won. Players are then
 * ranked in three tables over that one set of numbers: everyone together, the
 * men, and the women.
 *
 * Byes are the wrinkle. When the roster does not divide evenly into courts,
 * some players sit out a round and so have one fewer match in which to win
 * games. Ranking is still on the total, as asked, but every table also carries
 * matches played and games per match so a bye is visible as the reason someone
 * sits lower than their play deserved.
 *
 * This module is pure: it holds no I/O and knows nothing about how scores are
 * stored or transported.
 */
import type { Gender, Schedule } from "./scheduler";

/** Games in one match. Both teams' scores add up to this. */
export const GAMES_PER_MATCH = 8;

/**
 * Entered scores, keyed by match. The value is the games won by team A; team B
 * won `GAMES_PER_MATCH` minus that. A missing key means the match has not been
 * scored yet, which is different from a 0.
 */
export type Scores = Record<string, number>;

/** Key identifying one match within an event. */
export function matchKey(round: number, court: number): string {
  return `r${round}c${court}`;
}

/** Parse a match key back into its round and court, or null if malformed. */
export function parseMatchKey(key: string): { round: number; court: number } | null {
  const m = /^r(\d+)c(\d+)$/.exec(key);
  if (!m) return null;
  return { round: Number(m[1]), court: Number(m[2]) };
}

/** Is `a` a usable games-won value for one team: a whole number of 0..8. */
export function isValidGames(a: unknown): a is number {
  return typeof a === "number" && Number.isInteger(a) && a >= 0 && a <= GAMES_PER_MATCH;
}

/** Games won by team A in this match, or null if it has not been scored. */
export function readScore(scores: Scores, round: number, court: number): number | null {
  const v = scores[matchKey(round, court)];
  return isValidGames(v) ? v : null;
}

/** One row of a leaderboard. */
export interface PlayerScore {
  /** Index into `schedule.players`. */
  index: number;
  name: string;
  level: number;
  gender: Gender;
  /** Total games won across every scored match. */
  games: number;
  /** Matches that have a score entered. */
  played: number;
  /** Matches on the schedule, whether or not they have been scored. */
  scheduled: number;
  /** Rounds this player sits out. */
  byes: number;
  /** Games per match played; 0 before this player has a single score in. */
  avg: number;
  wins: number;
  losses: number;
  ties: number;
  /**
   * Position in this table. Players level on total games share a rank, and the
   * next rank skips accordingly (1, 2, 2, 4).
   */
  rank: number;
}

/** The three tables, plus how much of the event has been scored. */
export interface Leaderboards {
  all: PlayerScore[];
  men: PlayerScore[];
  women: PlayerScore[];
  /** Matches with a score in. */
  entered: number;
  /** Matches on the schedule. */
  total: number;
  complete: boolean;
}

/** How many matches are scheduled, and how many have been scored. */
export function scoreProgress(
  s: Schedule,
  scores: Scores
): { entered: number; total: number; complete: boolean } {
  let entered = 0;
  let total = 0;
  for (const rnd of s.rounds) {
    for (const m of rnd.matches) {
      total += 1;
      if (readScore(scores, rnd.number, m.court) !== null) entered += 1;
    }
  }
  return { entered, total, complete: total > 0 && entered === total };
}

/** Which rounds still have unscored matches, and how many in each. */
export function missingByRound(
  s: Schedule,
  scores: Scores
): { round: number; missing: number[] }[] {
  const out: { round: number; missing: number[] }[] = [];
  for (const rnd of s.rounds) {
    const missing = rnd.matches
      .filter((m) => readScore(scores, rnd.number, m.court) === null)
      .map((m) => m.court)
      .sort((x, y) => x - y);
    if (missing.length) out.push({ round: rnd.number, missing });
  }
  return out;
}

/**
 * Tally every player's games. Returns one row per player in roster order,
 * unranked; `rank` is filled in by `rankTable`.
 */
export function tally(s: Schedule, scores: Scores): PlayerScore[] {
  const rows: PlayerScore[] = s.players.map((p, index) => ({
    index,
    name: p.name,
    level: p.level,
    gender: p.gender ?? "",
    games: 0,
    played: 0,
    scheduled: 0,
    byes: 0,
    avg: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    rank: 0,
  }));

  for (const rnd of s.rounds) {
    for (const i of rnd.byes) if (rows[i]) rows[i].byes += 1;
    for (const m of rnd.matches) {
      const a = readScore(scores, rnd.number, m.court);
      for (const [team, mine] of [
        [m.teamA, a] as const,
        [m.teamB, a === null ? null : GAMES_PER_MATCH - a] as const,
      ]) {
        for (const i of team) {
          const row = rows[i];
          if (!row) continue;
          row.scheduled += 1;
          if (mine === null) continue;
          row.played += 1;
          row.games += mine;
          const theirs = GAMES_PER_MATCH - mine;
          if (mine > theirs) row.wins += 1;
          else if (mine < theirs) row.losses += 1;
          else row.ties += 1;
        }
      }
    }
  }

  for (const row of rows) {
    row.avg = row.played ? row.games / row.played : 0;
  }
  return rows;
}

/**
 * Sort rows into ranked order. Rank is on total games alone, which is the rule
 * asked for; games per match and then name only decide the order in which
 * players who are level on games are listed, never their rank.
 */
export function rankTable(rows: PlayerScore[]): PlayerScore[] {
  const sorted = [...rows].sort(
    (x, y) =>
      y.games - x.games ||
      y.avg - x.avg ||
      y.wins - x.wins ||
      x.name.localeCompare(y.name)
  );
  let rank = 0;
  let prevGames: number | null = null;
  return sorted.map((row, i) => {
    if (prevGames === null || row.games !== prevGames) {
      rank = i + 1;
      prevGames = row.games;
    }
    return { ...row, rank };
  });
}

/** Build the All / Men / Women tables from a schedule and its entered scores. */
export function leaderboards(s: Schedule, scores: Scores): Leaderboards {
  const rows = tally(s, scores);
  const progress = scoreProgress(s, scores);
  return {
    all: rankTable(rows),
    men: rankTable(rows.filter((r) => r.gender === "M")),
    women: rankTable(rows.filter((r) => r.gender === "F")),
    ...progress,
  };
}

/** Format a games-per-match average for display. */
export function fmtAvg(avg: number): string {
  return avg.toFixed(1);
}
