/**
 * Core scheduling engine for the tennis doubles mixer (TypeScript port).
 *
 * Tournament formats:
 *  - "open"  : any two players may partner. Courts are grouped by level only.
 *  - "mixed" : every team is one man + one woman (each court is 2M + 2F).
 *  - "same"  : same-gender doubles. Men's teams only face men's teams and
 *              women's teams only face women's teams, so each court holds
 *              four players of the same gender. Courts are split between the
 *              two draws (e.g. 12 men + 12 women -> 3 men's + 3 women's courts).
 *
 * Rules that hold in every format:
 *  - Doubles: 4 players per court, 2 per team.
 *  - Up to 6 courts; up to 24 players play at once. More may register and
 *    rotate through byes.
 *  - HARD: no two players are teammates more than once across all rounds.
 *  - OBJECTIVE: every court holds four similar-level players (competitive
 *    matches) and the two teams on a court have near-equal combined rating.
 *  - Byes rotate fairly. In the gendered formats they rotate within each
 *    gender's own pool, since a man cannot fill a woman's slot.
 *
 * The search is a randomized construction with many restarts; for these sizes
 * thousands of restarts run in well under a second in the browser.
 */

export const MAX_COURTS = 6;
export const PLAYERS_PER_COURT = 4;
export const MAX_ON_COURT = MAX_COURTS * PLAYERS_PER_COURT; // 24 play at once
export const MAX_PLAYERS = 40; // registered cap; extras rotate through byes

// Default facility court names, in court order (court 1..6).
export const DEFAULT_COURT_NAMES = [
  "Shorebird 1",
  "Shorebird 2",
  "Dolphin 1",
  "Dolphin 2",
  "Preserve 1",
  "Preserve 2",
];

/** Resolve a 1-indexed court number to its display name. */
export function courtName(court: number, names: string[] = DEFAULT_COURT_NAMES): string {
  return names[court - 1]?.trim() || `Court ${court}`;
}

export type Gender = "M" | "F" | "";

/** Tournament format. */
export type Format = "open" | "mixed" | "same";

export const FORMATS: { value: Format; label: string; blurb: string }[] = [
  {
    value: "open",
    label: "Open doubles",
    blurb: "Any two players may partner. Courts grouped purely by rating.",
  },
  {
    value: "mixed",
    label: "Mixed doubles",
    blurb: "Every team is one man + one woman. Each court is 2 men and 2 women.",
  },
  {
    value: "same",
    label: "Same-gender doubles",
    blurb: "Men vs men and women vs women. Courts are split between the two draws.",
  },
];

/** Formats that require every player's gender to be known. */
export function formatNeedsGender(format: Format): boolean {
  return format === "mixed" || format === "same";
}

export interface Player {
  name: string;
  level: number;
  gender?: Gender;
}

export interface Match {
  court: number; // 1-indexed within the round
  teamA: [number, number]; // player indices
  teamB: [number, number];
  /** Which draw this court belongs to; set only in the "same" format. */
  group?: "M" | "F";
}

export interface Round {
  number: number;
  matches: Match[];
  byes: number[];
}

/** How the roster maps onto courts each round, given the format. */
export interface Layout {
  format: Format;
  courtsUsed: number;
  /** Courts given to each draw; "same" format only (0 otherwise). */
  menCourts: number;
  womenCourts: number;
  /** Head counts on the roster. */
  men: number;
  women: number;
  /** How many of each play per round. */
  menPlaying: number;
  womenPlaying: number;
  playing: number;
  byesPerRound: number;
  menByes: number;
  womenByes: number;
}

export interface Schedule {
  players: Player[];
  rounds: Round[];
  cost: number;
  /** Total travel cost of the court assignment; see optimizeCourts. */
  travel: number;
  format: Format;
  layout: Layout;
  /** Court names the travel optimisation was done against. */
  courtNames: string[];
}

export interface ScheduleOptions {
  numRounds?: number;
  seed?: number;
  numCourts?: number;
  format?: Format;
  restarts?: number;
  /** Court names, used to work out which courts share a venue. */
  courtNames?: string[];
  /**
   * Minimise how far players travel between rounds (default true). Set false
   * to get the pre-v4 behaviour, where a court number was just a group's rank
   * by rating; the verification scripts use it as a baseline.
   */
  travelPolish?: boolean;
}

export interface PlayerStat {
  name: string;
  level: number;
  gender: Gender;
  matches: number;
  byes: number;
  partners: string[];
  opponents: string[];
  /** Court played each round, 1-indexed; null for a bye. */
  courtsByRound: (number | null)[];
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

function clampCourts(numCourts: number): number {
  return Math.max(1, Math.min(MAX_COURTS, Math.floor(numCourts)));
}

function countGenders(players: Player[]): { men: number; women: number; unknown: number } {
  let men = 0;
  let women = 0;
  for (const p of players) {
    if (p.gender === "M") men += 1;
    else if (p.gender === "F") women += 1;
  }
  return { men, women, unknown: players.length - men - women };
}

/**
 * Work out how many courts each draw gets and how many players sit out, for a
 * given roster / court count / format. Exported so the UI can show the same
 * numbers before a schedule is generated. Throws ScheduleError when the
 * combination cannot produce a single full court.
 */
export function computeLayout(
  players: Player[],
  numCourts: number,
  format: Format
): Layout {
  const courts = clampCourts(numCourts);
  const n = players.length;
  const { men, women, unknown } = countGenders(players);

  const base = { format, men, women, menCourts: 0, womenCourts: 0 };

  if (format === "open") {
    const playing = Math.min(
      PLAYERS_PER_COURT * Math.floor(n / PLAYERS_PER_COURT),
      courts * PLAYERS_PER_COURT
    );
    if (playing < PLAYERS_PER_COURT) {
      throw new ScheduleError(
        `With ${n} player(s) and ${courts} court(s), no full doubles court can be formed.`
      );
    }
    return {
      ...base,
      courtsUsed: playing / PLAYERS_PER_COURT,
      menPlaying: 0,
      womenPlaying: 0,
      playing,
      byesPerRound: n - playing,
      menByes: 0,
      womenByes: 0,
    };
  }

  if (unknown > 0) {
    const label = format === "mixed" ? "Mixed doubles" : "Same-gender doubles";
    throw new ScheduleError(
      `${label} needs every player marked M or F; ${unknown} player(s) have no gender set.`
    );
  }

  if (format === "mixed") {
    // Each court needs exactly 2 men and 2 women.
    const courtsUsed = Math.min(courts, Math.floor(men / 2), Math.floor(women / 2));
    if (courtsUsed < 1) {
      throw new ScheduleError(
        `Mixed doubles needs at least 2 men and 2 women; got ${men} men and ${women} women.`
      );
    }
    const menPlaying = courtsUsed * 2;
    const womenPlaying = courtsUsed * 2;
    return {
      ...base,
      courtsUsed,
      menPlaying,
      womenPlaying,
      playing: menPlaying + womenPlaying,
      byesPerRound: n - menPlaying - womenPlaying,
      menByes: men - menPlaying,
      womenByes: women - womenPlaying,
    };
  }

  // "same": each court is four players of one gender. Split the available
  // courts between the two draws so neither side sits out much more than the
  // other.
  let mc = Math.floor(men / PLAYERS_PER_COURT);
  let wc = Math.floor(women / PLAYERS_PER_COURT);
  if (mc + wc < 1) {
    throw new ScheduleError(
      `Same-gender doubles needs at least 4 men or 4 women on one side; ` +
        `got ${men} men and ${women} women.`
    );
  }
  const byeRate = (count: number, c: number) =>
    count === 0 ? 0 : (count - PLAYERS_PER_COURT * c) / count;
  while (mc + wc > courts) {
    const worstIfDropMen =
      mc > 0 ? Math.max(byeRate(men, mc - 1), byeRate(women, wc)) : Infinity;
    const worstIfDropWomen =
      wc > 0 ? Math.max(byeRate(men, mc), byeRate(women, wc - 1)) : Infinity;
    if (worstIfDropMen <= worstIfDropWomen) mc -= 1;
    else wc -= 1;
  }
  const menPlaying = mc * PLAYERS_PER_COURT;
  const womenPlaying = wc * PLAYERS_PER_COURT;
  return {
    ...base,
    courtsUsed: mc + wc,
    menCourts: mc,
    womenCourts: wc,
    menPlaying,
    womenPlaying,
    playing: menPlaying + womenPlaying,
    byesPerRound: n - menPlaying - womenPlaying,
    menByes: men - menPlaying,
    womenByes: women - womenPlaying,
  };
}

/**
 * A player who takes the court R times needs R distinct partners. Check that
 * the pool a player draws partners from is big enough, so an impossible setup
 * fails with a clear message instead of an exhausted search.
 */
function validateRounds(
  numRounds: number,
  format: "mixed" | "same",
  layout: Layout
): void {
  const { men, women } = layout;
  const maxRoundsFor = (count: number, playing: number) =>
    count === 0 ? 0 : Math.ceil((numRounds * playing) / count);

  if (format === "mixed") {
    // Partners always come from the other gender's pool.
    const menRounds = maxRoundsFor(men, layout.menPlaying);
    const womenRounds = maxRoundsFor(women, layout.womenPlaying);
    if (women < menRounds || men < womenRounds) {
      throw new ScheduleError(
        `Mixed doubles gives each player only opposite-gender partners, and ` +
          `${men} men / ${women} women cannot supply that many unique partners ` +
          `over ${numRounds} rounds. Reduce rounds or add players.`
      );
    }
    return;
  }

  if (layout.menCourts > 0) {
    const r = maxRoundsFor(men, layout.menPlaying);
    if (men - 1 < r) {
      throw new ScheduleError(
        `With ${men} men, the men's draw cannot give everyone ${r} unique ` +
          `partners over ${numRounds} rounds. Reduce rounds or add men.`
      );
    }
  }
  if (layout.womenCourts > 0) {
    const r = maxRoundsFor(women, layout.womenPlaying);
    if (women - 1 < r) {
      throw new ScheduleError(
        `With ${women} women, the women's draw cannot give everyone ${r} unique ` +
          `partners over ${numRounds} rounds. Reduce rounds or add women.`
      );
    }
  }
}

function pickByes(
  pool: number[],
  numByes: number,
  byeCounts: number[],
  rng: () => number
): number[] {
  if (numByes <= 0) return [];
  const order = [...pool];
  shuffleInPlace(order, rng); // random tie-break
  order.sort((a, b) => byeCounts[a] - byeCounts[b]); // fewest byes first
  return order.slice(0, numByes); // sit those who've sat least
}

function jitterSort(
  members: number[],
  levels: number[],
  jitter: number,
  rng: () => number
): number[] {
  return members
    .map((i) => ({ i, key: levels[i] + (rng() * 2 - 1) * jitter }))
    .sort((x, y) => x.key - y.key)
    .map((x) => x.i);
}

/**
 * Carve a level-sorted pool into courts of 2 men + 2 women. Walks the pool
 * from the lowest level up: each court is anchored by the next unassigned
 * player and filled from the nearest players in level whose gender slot is
 * still open.
 */
function mixedGroups(order: number[], players: Player[]): number[][] | null {
  const pool = [...order];
  const groups: number[][] = [];
  while (pool.length) {
    const anchor = pool.shift() as number;
    const need: Record<string, number> = { M: 2, F: 2 };
    const ag = players[anchor].gender;
    if (ag !== "M" && ag !== "F") return null;
    need[ag] -= 1;
    const grp = [anchor];
    for (let i = 0; i < pool.length && grp.length < PLAYERS_PER_COURT; ) {
      const g = players[pool[i]].gender ?? "";
      if (need[g] > 0) {
        need[g] -= 1;
        grp.push(pool[i]);
        pool.splice(i, 1);
      } else {
        i += 1;
      }
    }
    if (grp.length < PLAYERS_PER_COURT) return null;
    groups.push(grp);
  }
  return groups;
}

/** One pool of players to be carved into courts, optionally tagged as a draw. */
interface Pool {
  label?: "M" | "F";
  members: number[];
}

function buildRound(
  players: Player[],
  pools: Pool[],
  format: Format,
  usedPairs: Set<string>,
  rng: () => number
): Match[] | null {
  const levels = players.map((p) => p.level);
  const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  // In mixed doubles a legal team is exactly one man and one woman.
  const allowTeam =
    format === "mixed"
      ? (a: number, b: number) => players[a].gender !== players[b].gender
      : () => true;

  for (let attempt = 0; attempt < 40; attempt++) {
    const jitter = 0.15 + 0.08 * attempt;

    const groups: { label?: "M" | "F"; members: number[] }[] = [];
    let formed = true;
    for (const pool of pools) {
      const order = jitterSort(pool.members, levels, jitter, rng);
      if (format === "mixed") {
        const gs = mixedGroups(order, players);
        if (gs === null) {
          formed = false;
          break;
        }
        for (const g of gs) groups.push({ members: g });
      } else {
        for (let k = 0; k < order.length; k += PLAYERS_PER_COURT) {
          groups.push({ label: pool.label, members: order.slice(k, k + PLAYERS_PER_COURT) });
        }
      }
    }
    if (!formed) continue;

    const matches: Match[] = [];
    const roundPairs: string[] = [];
    let ok = true;

    for (let g = 0; g < groups.length; g++) {
      const grp = [...groups[g].members].sort((a, b) => levels[a] - levels[b]);
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
        if (!allowTeam(t1[0], t1[1]) || !allowTeam(t2[0], t2[1])) continue;
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
      matches.push({
        court: g + 1,
        teamA: best.t1,
        teamB: best.t2,
        ...(groups[g].label ? { group: groups[g].label } : {}),
      });
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

// ---- travel between courts -------------------------------------------------
/**
 * The venue a court sits at, derived from its name by dropping a trailing
 * number: "Shorebird 1" and "Shorebird 2" are both at "Shorebird", while
 * "Dolphin 1" is somewhere else entirely. Courts named without a number, or a
 * whole facility named "Court 1".."Court 6", collapse to one venue, which is
 * the right answer for a club whose courts are all side by side.
 */
export function venueOf(name: string): string {
  const trimmed = (name ?? "").trim();
  const stripped = trimmed.replace(/[\s#\-_.]*\d+\s*$/, "").trim();
  return (stripped || trimmed).toLowerCase();
}

/** What it costs a player to move between two courts for their next match. */
export const STAY_COST = 0; // same court again
export const WALK_COST = 1; // the other court at the same venue
export const DRIVE_COST = 12; // a different venue: not walkable

/** Square matrix of move costs between the courts in play (0-indexed). */
function travelWeights(courtNames: string[], courts: number): number[][] {
  const venues = Array.from({ length: courts }, (_, i) =>
    venueOf(courtName(i + 1, courtNames))
  );
  return venues.map((va, a) =>
    venues.map((vb, b) => {
      if (a === b) return STAY_COST;
      return va === vb ? WALK_COST : DRIVE_COST;
    })
  );
}

const permCache = new Map<number, number[][]>();
function permutations(n: number): number[][] {
  const hit = permCache.get(n);
  if (hit) return hit;
  const out: number[][] = [];
  const cur: number[] = [];
  const used = new Array(n).fill(false);
  const rec = () => {
    if (cur.length === n) {
      out.push([...cur]);
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      rec();
      cur.pop();
      used[i] = false;
    }
  };
  rec();
  permCache.set(n, out);
  return out;
}

/** Exact minimum-cost assignment of k groups to k courts. k is at most 6. */
function bestAssignment(cost: number[][]): number[] {
  const k = cost.length;
  let bestPerm = cost.map((_, i) => i);
  let bestCost = Infinity;
  for (const perm of permutations(k)) {
    let c = 0;
    for (let g = 0; g < k; g++) c += cost[g][perm[g]];
    if (c < bestCost) {
      bestCost = c;
      bestPerm = perm;
    }
  }
  return bestPerm;
}

/**
 * Renumber each round's courts so players move as little as possible between
 * rounds, preferring to leave them on the court they are already standing on
 * and, failing that, at the venue they are already at.
 *
 * This costs nothing in match quality. Which physical court a given four
 * players use has no bearing on who they play or how close their ratings are,
 * so the level grouping, the partner history and the schedule cost are all
 * untouched; only the court label attached to each match changes.
 *
 * A forward pass places each round against where players already are, then
 * optional sweeps re-place each round against both its neighbours. Mutates
 * `rounds` and returns the total travel cost.
 */
function optimizeCourts(rounds: Round[], w: number[][], sweeps: number): number {
  const R = rounds.length;
  if (R === 0) return 0;

  // assign[r][g] = 0-indexed court given to round r's group g. Starts from the
  // courts the rounds already carry, so this can only ever improve on them.
  const assign: number[][] = rounds.map((rnd) => rnd.matches.map((m) => m.court - 1));
  // at[r] = player -> court index for round r (players on a bye are absent).
  const at: Map<number, number>[] = rounds.map(() => new Map());
  const place = (r: number) => {
    const m = new Map<number, number>();
    rounds[r].matches.forEach((match, g) => {
      for (const p of allIndices(match)) m.set(p, assign[r][g]);
    });
    at[r] = m;
  };
  for (let r = 0; r < R; r++) place(r);

  // The court a player last used before round r, and next uses after it, so a
  // bye does not lose their place.
  const before = (p: number, r: number): number => {
    for (let q = r - 1; q >= 0; q--) {
      const c = at[q].get(p);
      if (c !== undefined) return c;
    }
    return -1;
  };
  const after = (p: number, r: number): number => {
    for (let q = r + 1; q < R; q++) {
      const c = at[q].get(p);
      if (c !== undefined) return c;
    }
    return -1;
  };

  const solveRound = (r: number, useNext: boolean) => {
    const k = rounds[r].matches.length;
    if (k === 0) return;
    const cost = rounds[r].matches.map((match) => {
      const row = new Array<number>(k).fill(0);
      for (const p of allIndices(match)) {
        const prev = before(p, r);
        const next = useNext ? after(p, r) : -1;
        for (let c = 0; c < k; c++) {
          if (prev >= 0) row[c] += w[prev][c];
          if (next >= 0) row[c] += w[c][next];
        }
      }
      return row;
    });
    assign[r] = bestAssignment(cost);
    place(r);
  };

  const total = (): number => {
    let t = 0;
    const last = new Map<number, number>();
    for (let r = 0; r < R; r++) {
      for (const [p, c] of at[r]) {
        const prev = last.get(p);
        if (prev !== undefined) t += w[prev][c];
        last.set(p, c);
      }
    }
    return t;
  };

  // A greedy pass, and each sweep after it, is a heuristic that can overshoot,
  // so keep the best arrangement seen rather than whatever the last pass left.
  let bestTotal = total();
  let bestAssign = assign.map((row) => [...row]);
  const keepIfBetter = () => {
    const t = total();
    if (t < bestTotal) {
      bestTotal = t;
      bestAssign = assign.map((row) => [...row]);
      return true;
    }
    return false;
  };

  for (let r = 0; r < R; r++) solveRound(r, false);
  keepIfBetter();
  for (let i = 0; i < sweeps; i++) {
    for (let r = 0; r < R; r++) solveRound(r, true);
    if (!keepIfBetter()) break; // converged, or drifting the wrong way
  }

  for (let r = 0; r < R; r++) {
    rounds[r].matches.forEach((match, g) => {
      match.court = bestAssign[r][g] + 1;
    });
  }
  return bestTotal;
}

/** Total travel cost of a schedule as its courts currently stand. */
function totalTravel(rounds: Round[], w: number[][]): number {
  let t = 0;
  const last = new Map<number, number>();
  for (const rnd of rounds) {
    for (const m of rnd.matches) {
      for (const p of allIndices(m)) {
        const prev = last.get(p);
        if (prev !== undefined) t += w[prev][m.court - 1];
        last.set(p, m.court - 1);
      }
    }
  }
  return t;
}

/**
 * Swap equally rated players between courts within a round whenever it
 * shortens somebody's trip.
 *
 * Two players on the same rating are interchangeable as far as the objective
 * is concerned: after the swap every court holds the same multiset of ratings
 * it held before, so court spread and team gap - and therefore the schedule
 * cost - come out bit for bit identical. That makes this a free way to leave
 * people on the court they are already standing on. Swaps that would repeat a
 * partnership, or break a format's gender rule, are rejected.
 *
 * Mutates `s.rounds` and returns the travel cost it settled on.
 */
function reduceTravelBySwaps(s: Schedule, w: number[][], passes: number): number {
  const { players, rounds, format } = s;
  const key = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const pairCount = new Map<string, number>();
  const bump = (a: number, b: number, d: number) => {
    const k = key(a, b);
    pairCount.set(k, (pairCount.get(k) ?? 0) + d);
  };
  for (const rnd of rounds) {
    for (const m of rnd.matches) {
      bump(m.teamA[0], m.teamA[1], 1);
      bump(m.teamB[0], m.teamB[1], 1);
    }
  }

  type Slot = { mi: number; team: "teamA" | "teamB"; si: number };
  const locate = (rnd: Round): Map<number, Slot> => {
    const at = new Map<number, Slot>();
    rnd.matches.forEach((m, mi) => {
      for (const team of ["teamA", "teamB"] as const) {
        m[team].forEach((p, si) => at.set(p, { mi, team, si }));
      }
    });
    return at;
  };

  let best = totalTravel(rounds, w);
  for (let pass = 0; pass < passes; pass++) {
    let improved = false;
    for (const rnd of rounds) {
      const at = locate(rnd);
      const onCourt = [...at.keys()];
      for (let x = 0; x < onCourt.length; x++) {
        for (let y = x + 1; y < onCourt.length; y++) {
          const p = onCourt[x];
          const q = onCourt[y];
          if (players[p].level !== players[q].level) continue;
          // Gendered formats fix how many men and women each court holds, so
          // only a like-for-like swap keeps the court legal.
          if (format !== "open" && players[p].gender !== players[q].gender) continue;
          const sp = at.get(p) as Slot;
          const sq = at.get(q) as Slot;
          if (sp.mi === sq.mi) continue; // same court: nobody travels differently

          const mp = rnd.matches[sp.mi];
          const mq = rnd.matches[sq.mi];
          const partnerOfP = mp[sp.team][1 - sp.si];
          const partnerOfQ = mq[sq.team][1 - sq.si];
          // The swap would create these two teams; neither may already exist.
          if ((pairCount.get(key(q, partnerOfP)) ?? 0) > 0) continue;
          if ((pairCount.get(key(p, partnerOfQ)) ?? 0) > 0) continue;

          mp[sp.team][sp.si] = q;
          mq[sq.team][sq.si] = p;
          const t = totalTravel(rounds, w);
          if (t < best) {
            best = t;
            improved = true;
            bump(p, partnerOfP, -1);
            bump(q, partnerOfQ, -1);
            bump(q, partnerOfP, 1);
            bump(p, partnerOfQ, 1);
            at.set(p, sq);
            at.set(q, sp);
          } else {
            mp[sp.team][sp.si] = p;
            mq[sq.team][sq.si] = q;
          }
        }
      }
    }
    if (!improved) break;
  }
  return best;
}

// ---- public API ------------------------------------------------------------
export function generateSchedule(
  players: Player[],
  opts: ScheduleOptions = {}
): Schedule {
  const {
    numRounds = 5,
    seed,
    numCourts = MAX_COURTS,
    format = "open",
    restarts = 6000,
    courtNames = DEFAULT_COURT_NAMES,
    travelPolish = true,
  } = opts;

  const n = players.length;
  if (n > MAX_PLAYERS) {
    throw new ScheduleError(`Too many players: ${n}. The cap is ${MAX_PLAYERS}.`);
  }
  if (n < PLAYERS_PER_COURT) {
    throw new ScheduleError(
      `Need at least ${PLAYERS_PER_COURT} players to form a doubles match; got ${n}.`
    );
  }

  const layout = computeLayout(players, numCourts, format);

  if (format === "open") {
    const maxRounds = Math.ceil((numRounds * layout.playing) / n);
    if (n - 1 < maxRounds) {
      throw new ScheduleError(
        `With ${n} players you cannot give everyone ${maxRounds} unique partners ` +
          `(only ${n - 1} other players exist). Reduce rounds or add players.`
      );
    }
  } else {
    validateRounds(numRounds, format, layout);
  }

  const allIdx = players.map((_, i) => i);
  const menIdx = allIdx.filter((i) => players[i].gender === "M");
  const womenIdx = allIdx.filter((i) => players[i].gender === "F");

  const weights = travelWeights(courtNames, layout.courtsUsed);
  const masterRng = makeRng(seed ?? Math.floor(Math.random() * 2 ** 31));
  let best: Schedule | null = null;

  for (let r = 0; r < restarts; r++) {
    const rng = makeRng(Math.floor(masterRng() * 2 ** 31));
    const usedPairs = new Set<string>();
    const byeCounts = new Array(n).fill(0);
    const rounds: Round[] = [];
    let failed = false;

    for (let round = 1; round <= numRounds; round++) {
      let byes: number[];
      let pools: Pool[];

      if (format === "open") {
        byes = pickByes(allIdx, n - layout.playing, byeCounts, rng);
        const out = new Set(byes);
        pools = [{ members: allIdx.filter((i) => !out.has(i)) }];
      } else if (format === "mixed") {
        byes = [
          ...pickByes(menIdx, layout.menByes, byeCounts, rng),
          ...pickByes(womenIdx, layout.womenByes, byeCounts, rng),
        ];
        const out = new Set(byes);
        pools = [{ members: [...menIdx, ...womenIdx].filter((i) => !out.has(i)) }];
      } else {
        byes = [
          ...pickByes(menIdx, layout.menByes, byeCounts, rng),
          ...pickByes(womenIdx, layout.womenByes, byeCounts, rng),
        ];
        const out = new Set(byes);
        pools = [];
        if (layout.menCourts > 0) {
          pools.push({ label: "M", members: menIdx.filter((i) => !out.has(i)) });
        }
        if (layout.womenCourts > 0) {
          pools.push({ label: "F", members: womenIdx.filter((i) => !out.has(i)) });
        }
      }

      for (const i of byes) byeCounts[i] += 1;
      byes.sort((a, b) => a - b);

      const matches = buildRound(players, pools, format, usedPairs, rng);
      if (matches === null) {
        failed = true;
        break;
      }
      rounds.push({ number: round, matches, byes });
    }

    if (failed) continue;

    const cost = scheduleCost(players, rounds);
    if (best !== null && cost > best.cost) continue; // worse matches; never trade quality
    // Same match quality: settle it on how far players have to walk or drive.
    // A single forward pass keeps the inner loop cheap; the winner gets the
    // full treatment once the search is over.
    const travel = travelPolish ? optimizeCourts(rounds, weights, 0) : 0;
    if (best === null || cost < best.cost || travel < best.travel) {
      best = { players, rounds, cost, travel, format, layout, courtNames };
      if (cost === 0 && travel === 0) break;
    }
  }

  if (best === null) {
    throw new ScheduleError(
      "Could not build a schedule without repeating partners. Try fewer rounds or a different roster size."
    );
  }

  // Travel polish on the winner only. Neither step may change match quality:
  // swaps preserve every court's ratings, and re-lettering courts cannot touch
  // who plays whom. The cost is re-checked below to keep that honest.
  let travel = travelPolish ? optimizeCourts(best.rounds, weights, 4) : totalTravel(best.rounds, weights);
  for (let i = 0; travelPolish && i < 4; i++) {
    reduceTravelBySwaps(best, weights, 4);
    const t = optimizeCourts(best.rounds, weights, 4);
    if (t >= travel) {
      travel = Math.min(travel, t);
      break;
    }
    travel = t;
  }
  best.travel = totalTravel(best.rounds, weights);
  if (best.travel > travel) {
    throw new ScheduleError(
      `Internal error: travel polish reported ${travel} but left ${best.travel}.`
    );
  }

  const finalCost = scheduleCost(players, best.rounds);
  if (finalCost !== best.cost) {
    throw new ScheduleError(
      `Internal error: travel optimisation changed match quality ` +
        `(${best.cost} -> ${finalCost}).`
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

/** Human label for which draw a court belongs to ("" outside same-gender play). */
export function drawLabel(m: Match): string {
  if (m.group === "M") return "Men";
  if (m.group === "F") return "Women";
  return "";
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
    const courtsByRound: (number | null)[] = [];
    let matches = 0;
    let byes = 0;
    for (const rnd of s.rounds) {
      if (rnd.byes.includes(idx)) byes += 1;
      let playedOn: number | null = null;
      for (const m of rnd.matches) {
        const inA = m.teamA.includes(idx);
        const inB = m.teamB.includes(idx);
        if (inA || inB) {
          matches += 1;
          playedOn = m.court;
          const team = inA ? m.teamA : m.teamB;
          const other = inA ? m.teamB : m.teamA;
          for (const j of team) if (j !== idx) partners.push(s.players[j].name);
          for (const j of other) opponents.push(s.players[j].name);
        }
      }
      courtsByRound.push(playedOn);
    }
    return {
      name: p.name,
      level: p.level,
      gender: p.gender ?? "",
      matches,
      byes,
      partners,
      opponents,
      courtsByRound,
    };
  });
}

/** How much moving around the finished schedule asks of the players. */
export interface TravelSummary {
  /** Court-to-court transitions across the whole event (byes bridged over). */
  transitions: number;
  /** Transitions where the player stayed on the same court. */
  stays: number;
  /** Transitions to the other court at the same venue. */
  walks: number;
  /** Transitions to a different venue: the ones worth avoiding. */
  drives: number;
  /** Players who never leave the court they started on. */
  neverMove: number;
  /** Players who never have to change venue. */
  neverDrive: number;
  /** Average venue changes per player. */
  drivesPerPlayer: number;
  /** Venue name for each court in play, in court order. */
  venues: string[];
}

export function travelSummary(s: Schedule): TravelSummary {
  const names = s.courtNames ?? DEFAULT_COURT_NAMES;
  const venues = Array.from({ length: s.layout.courtsUsed }, (_, i) =>
    courtName(i + 1, names)
  );
  const venueKey = venues.map(venueOf);

  // The courts each player used, in round order, byes skipped.
  const trail: number[][] = s.players.map(() => []);
  for (const rnd of s.rounds) {
    for (const m of rnd.matches) {
      for (const p of [m.teamA[0], m.teamA[1], m.teamB[0], m.teamB[1]]) {
        trail[p].push(m.court - 1);
      }
    }
  }

  let transitions = 0;
  let stays = 0;
  let walks = 0;
  let drives = 0;
  let neverMove = 0;
  let neverDrive = 0;
  for (const courts of trail) {
    if (courts.length === 0) continue;
    let moved = false;
    let drove = false;
    for (let i = 1; i < courts.length; i++) {
      const a = courts[i - 1];
      const b = courts[i];
      transitions += 1;
      if (a === b) stays += 1;
      else if (venueKey[a] === venueKey[b]) {
        walks += 1;
        moved = true;
      } else {
        drives += 1;
        moved = true;
        drove = true;
      }
    }
    if (!moved) neverMove += 1;
    if (!drove) neverDrive += 1;
  }

  return {
    transitions,
    stays,
    walks,
    drives,
    neverMove,
    neverDrive,
    drivesPerPlayer: s.players.length ? drives / s.players.length : 0,
    venues: venueKey,
  };
}

export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
