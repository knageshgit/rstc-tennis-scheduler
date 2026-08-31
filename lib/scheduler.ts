/**
 * Core scheduling engine for the tennis doubles mixer (TypeScript port).
 *
 * Rules:
 *  - Doubles: 4 players per court, 2 per team.
 *  - Up to 6 courts; up to 24 players play at once. More may register and
 *    rotate through byes.
 *  - HARD: no two players are teammates more than once across all rounds.
 *  - OBJECTIVE: every court holds four similar-level players (competitive
 *    matches) and the two teams on a court have near-equal combined rating.
 *  - Byes rotate fairly when the active roster is not a multiple of 4.
 *
 * The search is a randomized construction with many restarts; for these sizes
 * thousands of restarts run in well under a second in the browser.
 */

export const MAX_COURTS = 6;
export const PLAYERS_PER_COURT = 4;
export const MAX_ON_COURT = MAX_COURTS * PLAYERS_PER_COURT; // 24 play at once
export const MAX_PLAYERS = 40; // registered cap; extras rotate through byes

export interface Player {
  name: string;
  level: number;
}

export interface Match {
  court: number; // 1-indexed within the round
  teamA: [number, number]; // player indices
  teamB: [number, number];
}

export interface Round {
  number: number;
  matches: Match[];
  byes: number[];
}

export interface Schedule {
  players: Player[];
  rounds: Round[];
  cost: number;
}

export interface PlayerStat {
  name: string;
  level: number;
  matches: number;
  byes: number;
  partners: string[];
  opponents: string[];
}

export class ScheduleError extends Error {}

// ---- seeded RNG (mulberry32) ----------------------------------------------
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ---- structural helpers ----------------------------------------------------
function allIndices(m: Match): number[] {
  return [m.teamA[0], m.teamA[1], m.teamB[0], m.teamB[1]];
}

function activeCount(n: number): number {
  return Math.min(
    PLAYERS_PER_COURT * Math.floor(n / PLAYERS_PER_COURT),
    MAX_ON_COURT
  );
}

function validate(players: Player[], numRounds: number): void {
  const n = players.length;
  if (n > MAX_PLAYERS) {
    throw new ScheduleError(`Too many players: ${n}. The cap is ${MAX_PLAYERS}.`);
  }
  if (n < PLAYERS_PER_COURT) {
    throw new ScheduleError(
      `Need at least ${PLAYERS_PER_COURT} players to form a doubles match; got ${n}.`
    );
  }
  if (n - 1 < numRounds) {
    throw new ScheduleError(
      `With ${n} players you cannot give everyone ${numRounds} unique partners ` +
        `(only ${n - 1} other players exist). Reduce rounds or add players.`
    );
  }
}

function chooseByes(
  n: number,
  active: number,
  byeCounts: number[],
  rng: () => number
): number[] {
  const numByes = n - active;
  if (numByes === 0) return [];
  const order = Array.from({ length: n }, (_, i) => i);
  shuffleInPlace(order, rng); // random tie-break
  order.sort((a, b) => byeCounts[a] - byeCounts[b]); // fewest byes first
  return order.slice(0, numByes).sort((a, b) => a - b); // sit those who've sat least
}

function buildRound(
  players: Player[],
  active: number[],
  usedPairs: Set<string>,
  rng: () => number
): Match[] | null {
  const levels = players.map((p) => p.level);
  const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

  for (let attempt = 0; attempt < 40; attempt++) {
    const jitter = 0.15 + 0.08 * attempt;
    const jittered = active.map((i) => ({
      i,
      key: levels[i] + (rng() * 2 - 1) * jitter,
    }));
    jittered.sort((x, y) => x.key - y.key);
    const order = jittered.map((x) => x.i);

    const groups: number[][] = [];
    for (let k = 0; k < order.length; k += PLAYERS_PER_COURT) {
      groups.push(order.slice(k, k + PLAYERS_PER_COURT));
    }

    const matches: Match[] = [];
    const roundPairs: string[] = [];
    let ok = true;

    for (let g = 0; g < groups.length; g++) {
      const grp = [...groups[g]].sort((a, b) => levels[a] - levels[b]);
      const [a, b, c, d] = grp;
      const splits: [[number, number], [number, number]][] = [
        [[a, b], [c, d]],
        [[a, c], [b, d]],
        [[a, d], [b, c]],
      ];
      let best:
        | { gap: number; t1: [number, number]; t2: [number, number]; p1: string; p2: string }
        | null = null;
      for (const [t1, t2] of splits) {
        const p1 = pairKey(t1[0], t1[1]);
        const p2 = pairKey(t2[0], t2[1]);
        if (usedPairs.has(p1) || usedPairs.has(p2)) continue;
        const gap = Math.abs(
          levels[t1[0]] + levels[t1[1]] - (levels[t2[0]] + levels[t2[1]])
        );
        if (best === null || gap < best.gap) best = { gap, t1, t2, p1, p2 };
      }
      if (best === null) {
        ok = false;
        break;
      }
      matches.push({ court: g + 1, teamA: best.t1, teamB: best.t2 });
      roundPairs.push(best.p1, best.p2);
    }

    if (ok) {
      for (const p of roundPairs) usedPairs.add(p);
      return matches;
    }
  }
  return null;
}

function scheduleCost(players: Player[], rounds: Round[]): number {
  const levels = players.map((p) => p.level);
  let cost = 0;
  for (const rnd of rounds) {
    for (const m of rnd.matches) {
      const idxs = allIndices(m);
      const grp = idxs.map((i) => levels[i]);
      const spread = Math.max(...grp) - Math.min(...grp);
      const gap = Math.abs(
        levels[m.teamA[0]] + levels[m.teamA[1]] - (levels[m.teamB[0]] + levels[m.teamB[1]])
      );
      cost += spread * 10 + gap;
    }
  }
  return cost;
}

// ---- public API ------------------------------------------------------------
export function generateSchedule(
  players: Player[],
  numRounds = 5,
  seed?: number,
  restarts = 6000
): Schedule {
  validate(players, numRounds);

  const n = players.length;
  const active_n = activeCount(n);
  const masterRng = makeRng(seed ?? Math.floor(Math.random() * 2 ** 31));

  let best: Schedule | null = null;

  for (let r = 0; r < restarts; r++) {
    const rng = makeRng(Math.floor(masterRng() * 2 ** 31));
    const usedPairs = new Set<string>();
    const byeCounts = new Array(n).fill(0);
    const rounds: Round[] = [];
    let failed = false;

    for (let round = 1; round <= numRounds; round++) {
      const byes = chooseByes(n, active_n, byeCounts, rng);
      for (const i of byes) byeCounts[i] += 1;
      const byeSet = new Set(byes);
      const active: number[] = [];
      for (let i = 0; i < n; i++) if (!byeSet.has(i)) active.push(i);

      const matches = buildRound(players, active, usedPairs, rng);
      if (matches === null) {
        failed = true;
        break;
      }
      rounds.push({ number: round, matches, byes });
    }

    if (failed) continue;

    const cost = scheduleCost(players, rounds);
    if (best === null || cost < best.cost) {
      best = { players, rounds, cost };
      if (cost === 0) break;
    }
  }

  if (best === null) {
    throw new ScheduleError(
      "Could not build a schedule without repeating partners. Try fewer rounds or a different roster size."
    );
  }

  const repeats = partnerRepeats(best);
  if (repeats.length) {
    throw new ScheduleError(
      `Internal error: repeated partnerships slipped through: ${JSON.stringify(repeats)}`
    );
  }
  return best;
}

// ---- reporting helpers -----------------------------------------------------
export function teamLevel(s: Schedule, team: [number, number]): number {
  return s.players[team[0]].level + s.players[team[1]].level;
}

export function courtSpread(s: Schedule, m: Match): number {
  const levels = allIndices(m).map((i) => s.players[i].level);
  return Math.max(...levels) - Math.min(...levels);
}

export function courtAvg(s: Schedule, m: Match): number {
  const levels = allIndices(m).map((i) => s.players[i].level);
  return levels.reduce((x, y) => x + y, 0) / 4;
}

export function teamGap(s: Schedule, m: Match): number {
  return Math.abs(teamLevel(s, m.teamA) - teamLevel(s, m.teamB));
}

export function partnerRepeats(s: Schedule): [string, string][] {
  const seen = new Set<string>();
  const repeats: [string, string][] = [];
  for (const rnd of s.rounds) {
    for (const m of rnd.matches) {
      for (const team of [m.teamA, m.teamB]) {
        const key = team[0] < team[1] ? `${team[0]}-${team[1]}` : `${team[1]}-${team[0]}`;
        if (seen.has(key)) {
          repeats.push([s.players[team[0]].name, s.players[team[1]].name]);
        }
        seen.add(key);
      }
    }
  }
  return repeats;
}

export function playerStats(s: Schedule): PlayerStat[] {
  return s.players.map((p, idx) => {
    const partners: string[] = [];
    const opponents: string[] = [];
    let matches = 0;
    let byes = 0;
    for (const rnd of s.rounds) {
      if (rnd.byes.includes(idx)) byes += 1;
      for (const m of rnd.matches) {
        const inA = m.teamA.includes(idx);
        const inB = m.teamB.includes(idx);
        if (inA || inB) {
          matches += 1;
          const team = inA ? m.teamA : m.teamB;
          const other = inA ? m.teamB : m.teamA;
          for (const j of team) if (j !== idx) partners.push(s.players[j].name);
          for (const j of other) opponents.push(s.players[j].name);
        }
      }
    }
    return { name: p.name, level: p.level, matches, byes, partners, opponents };
  });
}

export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
