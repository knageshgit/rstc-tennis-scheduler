/**
 * How evenly matched the draw is, in NTRP levels: per match, per round, and
 * for the whole tournament.
 *
 * Pure: a schedule in, numbers out. The organizer page, the generator preview,
 * the Survey tab, the Excel workbook and the results archive all read these,
 * so a court can never be "0.35" on one page and "0.4" on another.
 *
 * The words, as shown everywhere:
 *
 *   Lowest / Highest  the lowest and highest rated player on court
 *   Average           the mean of the four players' levels
 *   Spread            Highest minus Lowest, on one court
 *   Team gap          the difference between the two teams' levels, where a
 *                     team's level is the mean of its two partners (the number
 *                     shown in parentheses beside every team)
 *
 * A round's Lowest and Highest are the extremes across all its courts; its
 * Average, Avg spread and Avg gap are means over its courts; Widest is its
 * largest single-court spread. The tournament figures are the same, taken over
 * every match.
 *
 * The team gap here is on team means, so it agrees with the numbers members
 * see. The scheduler's own cost works on team sums (`teamGap`), which is twice
 * this; that is internal and deliberately left alone.
 */
import { round2, teamAvg, type Match, type Schedule } from "./scheduler";

export interface LevelStats {
  low: number;
  high: number;
  avg: number;
}

export interface MatchQuality extends LevelStats {
  round: number;
  court: number;
  spread: number;
  gap: number;
}

export interface RoundQuality extends LevelStats {
  round: number;
  matches: MatchQuality[];
  avgSpread: number;
  avgGap: number;
  widest: number;
}

export interface Quality extends LevelStats {
  rounds: RoundQuality[];
  /** Matches in the whole draw. */
  matches: number;
  avgSpread: number;
  avgGap: number;
  widest: number;
}

/** Team gap on team means: |(a1 + a2)/2 - (b1 + b2)/2|. */
export function teamGapAvg(s: Schedule, m: Match): number {
  return round2(Math.abs(teamAvg(s, m.teamA) - teamAvg(s, m.teamB)));
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function matchQuality(s: Schedule, round: number, m: Match): MatchQuality {
  const levels = [...m.teamA, ...m.teamB].map((i) => s.players[i].level);
  const low = Math.min(...levels);
  const high = Math.max(...levels);
  return {
    round,
    court: m.court,
    low,
    high,
    avg: round2(mean(levels)),
    spread: round2(high - low),
    gap: teamGapAvg(s, m),
  };
}

/** Fold a set of matches into the shared summary fields. */
function fold(ms: MatchQuality[]): LevelStats & { avgSpread: number; avgGap: number; widest: number } {
  if (!ms.length) return { low: 0, high: 0, avg: 0, avgSpread: 0, avgGap: 0, widest: 0 };
  return {
    low: Math.min(...ms.map((m) => m.low)),
    high: Math.max(...ms.map((m) => m.high)),
    // Every court holds four players, so the mean of court means is the mean
    // over every player-slot in play.
    avg: round2(mean(ms.map((m) => m.avg))),
    avgSpread: round2(mean(ms.map((m) => m.spread))),
    avgGap: round2(mean(ms.map((m) => m.gap))),
    widest: Math.max(...ms.map((m) => m.spread)),
  };
}

export function drawQuality(s: Schedule): Quality {
  const rounds: RoundQuality[] = s.rounds.map((rnd) => {
    const matches = [...rnd.matches]
      .sort((a, b) => a.court - b.court)
      .map((m) => matchQuality(s, rnd.number, m));
    return { round: rnd.number, matches, ...fold(matches) };
  });
  const all = rounds.flatMap((r) => r.matches);
  return { rounds, matches: all.length, ...fold(all) };
}

/** Two decimals, always, so a column of levels lines up. */
export function fmtLevel(x: number): string {
  return x.toFixed(2);
}
