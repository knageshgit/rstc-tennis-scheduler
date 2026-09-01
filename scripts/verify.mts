// Verify the TS scheduler invariants across all three tournament formats.
// Run: npx tsx scripts/verify.mts
import {
  FORMATS,
  computeLayout,
  generateSchedule,
  partnerRepeats,
  playerStats,
  courtSpread,
  teamGap,
  courtName,
  DEFAULT_COURT_NAMES,
  PLAYERS_PER_COURT,
  type Format,
  type Player,
  type Schedule,
} from "../lib/scheduler.ts";

// Synthetic roster (no real people): ratings weighted toward the middle, like a club.
const LEVELS = [2.5, 3.0, 3.5, 4.0, 4.5, 5.0];
function makeRoster(men: number, women: number, seed = 1): Player[] {
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const out: Player[] = [];
  for (let i = 0; i < men; i++)
    out.push({ name: `Man ${i + 1}`, level: LEVELS[Math.floor(rand() * LEVELS.length)], gender: "M" });
  for (let i = 0; i < women; i++)
    out.push({ name: `Woman ${i + 1}`, level: LEVELS[Math.floor(rand() * LEVELS.length)], gender: "F" });
  return out;
}

let failures = 0;
function check(cond: boolean, msg: string) {
  if (!cond) {
    failures += 1;
    console.error(`   FAIL: ${msg}`);
  }
}

function verify(s: Schedule, players: Player[], format: Format, numCourts: number) {
  const layout = s.layout;

  check(partnerRepeats(s).length === 0, "repeated partnerships");

  for (const rnd of s.rounds) {
    check(
      rnd.matches.length === layout.courtsUsed,
      `round ${rnd.number}: ${rnd.matches.length} courts, expected ${layout.courtsUsed}`
    );
    check(layout.courtsUsed <= numCourts, "used more courts than allowed");

    // no player appears twice in a round, and byes + players covers everyone
    const seen = new Set<number>();
    for (const m of rnd.matches) {
      for (const i of [...m.teamA, ...m.teamB]) {
        check(!seen.has(i), `player ${i} twice in round ${rnd.number}`);
        seen.add(i);
      }
      const g = [...m.teamA, ...m.teamB].map((i) => players[i].gender);
      if (format === "mixed") {
        check(
          players[m.teamA[0]].gender !== players[m.teamA[1]].gender &&
            players[m.teamB[0]].gender !== players[m.teamB[1]].gender,
          `round ${rnd.number} court ${m.court}: team is not 1 man + 1 woman`
        );
        check(
          g.filter((x) => x === "M").length === 2 && g.filter((x) => x === "F").length === 2,
          `round ${rnd.number} court ${m.court}: court is not 2M + 2F`
        );
      }
      if (format === "same") {
        check(
          new Set(g).size === 1,
          `round ${rnd.number} court ${m.court}: mixed genders on a same-gender court`
        );
        check(m.group === g[0], `round ${rnd.number} court ${m.court}: wrong draw label`);
      }
    }
    check(seen.size === layout.playing, `round ${rnd.number}: wrong number on court`);
    for (const b of rnd.byes) check(!seen.has(b), `bye player ${b} also playing`);
    check(
      seen.size + rnd.byes.length === players.length,
      `round ${rnd.number}: players unaccounted for`
    );
  }

  // Byes must rotate fairly *within each gender pool* for gendered formats.
  const stats = playerStats(s);
  const pools =
    format === "open"
      ? [stats]
      : [stats.filter((p) => p.gender === "M"), stats.filter((p) => p.gender === "F")];
  for (const pool of pools) {
    if (pool.length === 0) continue;
    const byes = pool.map((p) => p.byes);
    check(
      Math.max(...byes) - Math.min(...byes) <= 1,
      `unfair byes within a pool: min ${Math.min(...byes)} max ${Math.max(...byes)}`
    );
  }
}

const cases: { format: Format; men: number; women: number; courts: number; rounds: number; note: string }[] = [
  { format: "open", men: 13, women: 12, courts: 6, rounds: 5, note: "25 players, all 6 courts" },
  { format: "open", men: 12, women: 12, courts: 6, rounds: 5, note: "24 players, no byes" },
  { format: "open", men: 5, women: 5, courts: 2, rounds: 4, note: "small roster" },
  { format: "mixed", men: 12, women: 12, courts: 6, rounds: 5, note: "12M/12W, perfect fit" },
  { format: "mixed", men: 14, women: 10, courts: 6, rounds: 5, note: "uneven, men rotate byes" },
  { format: "mixed", men: 8, women: 8, courts: 6, rounds: 5, note: "fewer players than courts" },
  { format: "mixed", men: 4, women: 10, courts: 3, rounds: 5, note: "small men's pool" },
  { format: "same", men: 12, women: 12, courts: 6, rounds: 5, note: "12M/12W -> 3+3 courts" },
  { format: "same", men: 16, women: 16, courts: 6, rounds: 5, note: "over capacity, courts split evenly" },
  { format: "same", men: 20, women: 8, courts: 6, rounds: 5, note: "lopsided roster" },
  { format: "same", men: 13, women: 12, courts: 6, rounds: 5, note: "odd men out rotate" },
  { format: "same", men: 10, women: 3, courts: 4, rounds: 5, note: "too few women for a court" },
];

for (const c of cases) {
  const players = makeRoster(c.men, c.women, 7);
  const label = `${c.format.padEnd(5)} ${c.men}M/${c.women}W  ${c.courts} courts  ${c.rounds} rounds`;
  try {
    const t0 = Date.now();
    const s = generateSchedule(players, {
      numRounds: c.rounds,
      seed: 2026,
      numCourts: c.courts,
      format: c.format,
    });
    const ms = Date.now() - t0;
    const before = failures;
    verify(s, players, c.format, c.courts);
    const spreads: number[] = [];
    const gaps: number[] = [];
    for (const rnd of s.rounds)
      for (const m of rnd.matches) {
        spreads.push(courtSpread(s, m));
        gaps.push(teamGap(s, m));
      }
    const avg = (a: number[]) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(2);
    const status = failures === before ? "ok " : "BAD";
    console.log(
      `${status} ${label}  (${c.note})\n` +
        `      ${s.layout.courtsUsed} courts, ${s.layout.playing} on court, ` +
        `${s.layout.byesPerRound} bye/round, avgSpread=${avg(spreads)} avgGap=${avg(gaps)}, ${ms}ms`
    );
  } catch (e) {
    failures += 1;
    console.error(`BAD ${label}  (${c.note})\n      threw: ${(e as Error).message}`);
  }
}

// --- expected-failure cases: bad setups must raise a clear error -------------
const badCases: { name: string; run: () => void }[] = [
  {
    name: "mixed doubles with unset genders",
    run: () =>
      void generateSchedule(
        [
          { name: "A", level: 3.5, gender: "M" },
          { name: "B", level: 3.5, gender: "F" },
          { name: "C", level: 3.5, gender: "" },
          { name: "D", level: 3.5, gender: "F" },
        ],
        { format: "mixed", numRounds: 1, numCourts: 1 }
      ),
  },
  {
    name: "mixed doubles with only 1 woman",
    run: () => void generateSchedule(makeRoster(10, 1), { format: "mixed", numCourts: 3 }),
  },
  {
    name: "same-gender doubles with 3M/3W (no full court)",
    run: () => void generateSchedule(makeRoster(3, 3), { format: "same", numCourts: 3 }),
  },
  {
    // 5 men on 1 court over 5 rounds IS feasible (each sits once, plays 4, and
    // has exactly 4 possible partners). 6 rounds is not.
    name: "same-gender doubles, 6 rounds with only 5 men",
    run: () =>
      void generateSchedule(makeRoster(5, 0), { format: "same", numCourts: 1, numRounds: 6 }),
  },
  {
    name: "mixed doubles, 5 rounds with only 2 men and 3 women",
    run: () =>
      void generateSchedule(makeRoster(2, 3), { format: "mixed", numCourts: 3, numRounds: 5 }),
  },
];

// The feasible edge case above must actually succeed.
try {
  const s = generateSchedule(makeRoster(5, 0), { format: "same", numCourts: 1, numRounds: 5 });
  verify(s, makeRoster(5, 0), "same", 1);
  console.log("ok  5 men, 1 court, 5 rounds (tight but feasible)");
} catch (e) {
  failures += 1;
  console.error(`BAD 5 men / 1 court / 5 rounds should succeed: ${(e as Error).message}`);
}
for (const bc of badCases) {
  try {
    bc.run();
    failures += 1;
    console.error(`BAD ${bc.name}: expected an error, got a schedule`);
  } catch (e) {
    console.log(`ok  rejects ${bc.name}\n      "${(e as Error).message}"`);
  }
}

// --- layout preview must agree with what the engine produces ----------------
for (const c of cases) {
  const players = makeRoster(c.men, c.women, 7);
  try {
    const l = computeLayout(players, c.courts, c.format);
    const s = generateSchedule(players, {
      numRounds: c.rounds,
      seed: 2026,
      numCourts: c.courts,
      format: c.format,
    });
    check(
      l.courtsUsed === s.layout.courtsUsed && l.byesPerRound === s.layout.byesPerRound,
      `layout preview disagrees with schedule for ${c.format} ${c.men}M/${c.women}W`
    );
  } catch {
    /* covered above */
  }
}

console.log(
  `\nFormats: ${FORMATS.map((f) => f.value).join(", ")}  |  ` +
    `court 1 = ${courtName(1, DEFAULT_COURT_NAMES)}  |  ${PLAYERS_PER_COURT} per court`
);
if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll checks passed.");
