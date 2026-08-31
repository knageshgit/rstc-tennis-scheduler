// Verify the TS scheduler invariants on a synthetic 25-player roster.
// Run: npx tsx scripts/verify.mts
import {
  generateSchedule,
  partnerRepeats,
  playerStats,
  courtSpread,
  teamGap,
  MAX_ON_COURT,
  PLAYERS_PER_COURT,
  type Player,
} from "../lib/scheduler.ts";

// Synthetic roster (no real people): ratings weighted toward the middle, like a club.
const LEVELS = [2.5, 3.0, 3.5, 4.0, 4.5, 5.0];
function makeRoster(n: number, seed = 1): Player[] {
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  return Array.from({ length: n }, (_, i) => ({
    name: `Player ${String(i + 1).padStart(2, "0")}`,
    level: LEVELS[Math.floor(rand() * LEVELS.length)],
  }));
}

const players = makeRoster(25);
const s = generateSchedule(players, 5, 2026);

const repeats = partnerRepeats(s);
if (repeats.length) throw new Error("REPEATED PARTNERS: " + JSON.stringify(repeats));

const active =
  PLAYERS_PER_COURT * Math.floor(Math.min(players.length, MAX_ON_COURT) / PLAYERS_PER_COURT);
for (const rnd of s.rounds) {
  if (rnd.matches.length !== active / PLAYERS_PER_COURT)
    throw new Error("wrong court count r" + rnd.number);
  const seen = new Set<number>();
  for (const m of rnd.matches)
    for (const i of [...m.teamA, ...m.teamB]) {
      if (seen.has(i)) throw new Error("double-booked r" + rnd.number);
      seen.add(i);
    }
  if (seen.size + rnd.byes.length !== players.length)
    throw new Error("count mismatch r" + rnd.number);
}

const stats = playerStats(s);
const byeCounts = stats.map((x) => x.byes);
if (Math.max(...byeCounts) - Math.min(...byeCounts) > 1) throw new Error("unfair byes");
for (const st of stats)
  if (new Set(st.partners).size !== st.partners.length)
    throw new Error(st.name + " repeat partner");

const spreads: number[] = [];
const gaps: number[] = [];
for (const rnd of s.rounds)
  for (const m of rnd.matches) {
    spreads.push(courtSpread(s, m));
    gaps.push(teamGap(s, m));
  }
const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

console.log("Players:", players.length, "| Rounds:", s.rounds.length);
console.log("Repeated partnerships:", repeats.length);
console.log(
  "Avg court spread:",
  avg(spreads).toFixed(2),
  "| Avg team gap:",
  avg(gaps).toFixed(2),
  "| Max spread:",
  Math.max(...spreads).toFixed(1)
);
console.log("Byes per player (spread):", Math.min(...byeCounts), "-", Math.max(...byeCounts));
console.log("\nAll invariants passed ✓");
