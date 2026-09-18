/**
 * The post-match survey: how good was the tennis, in stars.
 *
 * The club can already say who won. What it could not say is whether the draw
 * was any *fun* - whether the levels were close enough that a match was worth
 * playing. A mixer that produces a clean leaderboard out of five lopsided
 * matches has failed at the thing it exists for, and nothing in the scores
 * shows that. So every player rates each match they played, 1 to 5 stars, and
 * the tournament once at the end.
 *
 * Ratings are per player per match, not per match. A court holds four people
 * and a 6-2 is a different afternoon depending on which side of it you were on;
 * asking only whoever typed the score in would record one of those four views
 * and call it the match. The cost is more entries - five rounds of eighteen
 * players is ninety - which is why the aggregation below is an average and a
 * count, never a list of who said what.
 *
 * Nothing here identifies a rater to anyone but themselves. A rating is stored
 * against a player index so that the same phone can change its mind, and the
 * summaries expose counts and means only. Eighteen players is a small enough
 * room that named criticism of a draw would be read as criticism of the people
 * in it.
 *
 * Like `scoring` and `archive`, this module is pure: no I/O, no knowledge of
 * how ratings are stored or transported. The Redis side lives in `lib/store`.
 */
import type { Schedule } from "./scheduler";

/** The ends of the scale. One star is playable, five is the reason to come. */
export const MIN_STARS = 1;
export const MAX_STARS = 5;

/**
 * Every rating standing for one event, keyed by what was rated and by whom.
 *
 * Two shapes of key share the one map, distinguished by their prefix:
 *
 *     r3c2:7     player 7 rated round 3, court 2
 *     overall:7  player 7 rated the tournament
 *
 * One map rather than two because they are written by the same screen, read by
 * the same poll, and archived as one object. The prefixes keep them apart
 * without a second Redis key or a second round trip.
 */
export type Ratings = Record<string, number>;

/** Key for one player's rating of one match. */
export function ratingKey(round: number, court: number, player: number): string {
  return `r${round}c${court}:${player}`;
}

/** Key for one player's rating of the tournament as a whole. */
export function overallKey(player: number): string {
  return `overall:${player}`;
}

/** Parse a match rating key, or null if it is not one. */
export function parseRatingKey(
  key: string
): { round: number; court: number; player: number } | null {
  const m = /^r(\d+)c(\d+):(\d+)$/.exec(key);
  if (!m) return null;
  return { round: Number(m[1]), court: Number(m[2]), player: Number(m[3]) };
}

/** Parse an overall rating key, or null if it is not one. */
export function parseOverallKey(key: string): { player: number } | null {
  const m = /^overall:(\d+)$/.exec(key);
  return m ? { player: Number(m[1]) } : null;
}

/** Is this a star count we will store: a whole number of 1..5. */
export function isValidStars(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= MIN_STARS && v <= MAX_STARS;
}

/** Is this a key either of the two parsers would accept? */
export function isRatingKey(key: string): boolean {
  return parseRatingKey(key) !== null || parseOverallKey(key) !== null;
}

/** A mean and the number of ratings behind it. */
export interface Tally {
  /** How many ratings went into `avg`. Zero means nobody has rated yet. */
  count: number;
  /** The mean, or 0 when `count` is 0. Read one without the other at your peril. */
  avg: number;
}

/** One match's ratings, within a round. */
export interface MatchTally extends Tally {
  court: number;
}

/** One round's ratings, and the matches inside it. */
export interface RoundTally extends Tally {
  round: number;
  matches: MatchTally[];
}

/** Everything the Results tab and the archive row need. */
export interface SurveySummary {
  /** Per round, in schedule order. */
  rounds: RoundTally[];
  /** Every per-match rating pooled, which is the "how was the tennis" number. */
  matches: Tally;
  /** The separate end-of-day question, which is not the same thing. */
  overall: Tally;
  /** How many distinct players left at least one rating of any kind. */
  responders: number;
}

/**
 * Ratings a single court needs before its own average is shown anywhere.
 *
 * Four players share a court, so with two ratings in and one of them yours the
 * mean hands back the other person's answer. Three is where an individual score
 * stops being recoverable. Round and tournament averages are not held back.
 */
export const MIN_COURT_RATINGS = 3;

/** Build a `Tally` from a list of star counts. */
function tally(stars: number[]): Tally {
  if (!stars.length) return { count: 0, avg: 0 };
  return {
    count: stars.length,
    avg: stars.reduce((sum, n) => sum + n, 0) / stars.length,
  };
}

/**
 * Fold every rating into per-match, per-round and overall means.
 *
 * Driven by the schedule rather than by the ratings map, so a round nobody
 * rated still appears with a count of 0 and the Results tab can say "no
 * ratings yet" in the right place. Ratings whose key points at a match that is
 * not on this schedule are ignored: a stale entry from a corrected draw should
 * not invent a round.
 */
export function summarizeSurvey(s: Schedule, ratings: Ratings): SurveySummary {
  /** Stars for one match, gathered by round and court. */
  const byMatch = new Map<string, number[]>();
  const overall: number[] = [];
  const responders = new Set<number>();

  for (const [key, value] of Object.entries(ratings)) {
    if (!isValidStars(value)) continue;
    const match = parseRatingKey(key);
    if (match) {
      const at = `${match.round}:${match.court}`;
      byMatch.set(at, [...(byMatch.get(at) ?? []), value]);
      responders.add(match.player);
      continue;
    }
    const all = parseOverallKey(key);
    if (all) {
      overall.push(value);
      responders.add(all.player);
    }
  }

  const rounds: RoundTally[] = [];
  const everyMatchStar: number[] = [];
  for (const rnd of s.rounds) {
    const matches: MatchTally[] = [];
    const roundStars: number[] = [];
    for (const m of [...rnd.matches].sort((a, b) => a.court - b.court)) {
      const stars = byMatch.get(`${rnd.number}:${m.court}`) ?? [];
      matches.push({ court: m.court, ...tally(stars) });
      roundStars.push(...stars);
    }
    everyMatchStar.push(...roundStars);
    rounds.push({ round: rnd.number, matches, ...tally(roundStars) });
  }

  return {
    rounds,
    matches: tally(everyMatchStar),
    overall: tally(overall),
    responders: responders.size,
  };
}

/**
 * The matches one player is down to play, in schedule order.
 *
 * The survey tab asks a player about their own afternoon and nothing else, so
 * this is what it renders. Byes are simply absent: there is no match to rate.
 */
export function matchesFor(
  s: Schedule,
  player: number
): { round: number; court: number }[] {
  const out: { round: number; court: number }[] = [];
  for (const rnd of s.rounds) {
    for (const m of rnd.matches) {
      if ([...m.teamA, ...m.teamB].includes(player)) {
        out.push({ round: rnd.number, court: m.court });
      }
    }
  }
  return out;
}

/** How many of this player's matches they have rated, out of how many played. */
export function progressFor(
  s: Schedule,
  ratings: Ratings,
  player: number
): { rated: number; total: number } {
  const mine = matchesFor(s, player);
  const rated = mine.filter((m) =>
    isValidStars(ratings[ratingKey(m.round, m.court, player)])
  ).length;
  return { rated, total: mine.length };
}

/**
 * A mean rating for display: one decimal, because two would claim a precision
 * that eighteen opinions do not have.
 */
export function fmtStars(avg: number): string {
  return avg.toFixed(1);
}

/**
 * A row of five characters showing a mean to the nearest half star.
 *
 * Text rather than an icon font or an SVG so it renders identically in the
 * app, in the archive table, and in a copied-and-pasted WhatsApp message.
 */
export function starBar(avg: number): string {
  const halves = Math.round(avg * 2);
  let out = "";
  for (let i = 1; i <= MAX_STARS; i++) {
    if (halves >= i * 2) out += "★";
    else if (halves === i * 2 - 1) out += "⯨";
    else out += "☆";
  }
  return out;
}
