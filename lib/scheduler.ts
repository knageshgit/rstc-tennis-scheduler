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
  format: Format;
  layout: Layout;
}

export interface ScheduleOptions {
  numRounds?: number;
  seed?: number;
  numCourts?: number;
  format?: Format;
  restarts?: number;
}

export interface PlayerStat {
  name: string;
  level: number;
  gender: Gender;
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
    if (best === null || cost < best.cost) {
      best = { players, rounds, cost, format, layout };
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
    return {
      name: p.name,
      level: p.level,
      gender: p.gender ?? "",
      matches,
      byes,
      partners,
      opponents,
    };
  });
}

export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
