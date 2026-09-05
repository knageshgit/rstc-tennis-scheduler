/**
 * Measures the court-travel optimisation: does it cut player movement, and
 * does it leave match quality untouched? Run: npx tsx scripts/verify_travel.mts
 */
import {
  DEFAULT_COURT_NAMES,
  DRIVE_COST,
  WALK_COST,
  type Format,
  type Player,
  courtSpread,
  generateSchedule,
  teamGap,
  travelSummary,
  venueOf,
} from "../lib/scheduler";

function roster(n: number): Player[] {
  const levels = [2.5, 3.0, 3.0, 3.5, 3.5, 3.5, 4.0, 4.0, 4.5];
  return Array.from({ length: n }, (_, i) => ({
    name: `P${i + 1}`,
    level: levels[i % levels.length],
    gender: (i % 2 === 0 ? "M" : "F") as "M" | "F",
  }));
}

// venueOf
const venueChecks: [string, string][] = [
  ["Shorebird 1", "shorebird"],
  ["Shorebird 2", "shorebird"],
  ["Dolphin 1", "dolphin"],
  ["Preserve 2", "preserve"],
  ["Court 3", "court"],
  ["Back Court", "back court"],
  ["Court-4", "court"],
  ["12", "12"],
];
let failures = 0;
for (const [name, want] of venueChecks) {
  const got = venueOf(name);
  if (got !== want) {
    failures += 1;
    console.log(`FAIL venueOf(${JSON.stringify(name)}) = ${got}, want ${want}`);
  }
}
console.log(`venueOf: ${venueChecks.length - failures}/${venueChecks.length} ok\n`);

const quality = (s: ReturnType<typeof generateSchedule>) => {
  const sp: number[] = [];
  const gp: number[] = [];
  for (const r of s.rounds)
    for (const m of r.matches) {
      sp.push(courtSpread(s, m));
      gp.push(teamGap(s, m));
    }
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  return { spread: avg(sp), gap: avg(gp), cost: s.cost };
};

/**
 * Travel under the old scheme, where a group's court number was just its rank
 * by level within the round. Rebuilt here so the improvement can be measured.
 */
function baseline(players: Player[], fmt: Format) {
  return generateSchedule(players, {
    numRounds: 5,
    numCourts: 6,
    format: fmt,
    seed: 12345,
    courtNames: DEFAULT_COURT_NAMES,
    travelPolish: false,
  });
}

console.log(
  "roster fmt    cost  spread  gap   |  drives before -> after   stays  never-drive   ms"
);
for (const n of [16, 20, 24, 25, 28]) {
  for (const fmt of ["open", "mixed", "same"] as Format[]) {
    const players = roster(n);
    const t0 = Date.now();
    let s;
    try {
      s = generateSchedule(players, {
        numRounds: 5,
        numCourts: 6,
        format: fmt,
        seed: 12345,
        courtNames: DEFAULT_COURT_NAMES,
      });
    } catch (e) {
      console.log(`${n} ${fmt}: ${(e as Error).message.slice(0, 60)}`);
      continue;
    }
    const ms = Date.now() - t0;
    const q = quality(s);
    const t = travelSummary(s);
    const bs = baseline(players, fmt);
    const b = travelSummary(bs);
    const bq = quality(bs);
    // The whole point: travel must never get worse, and quality must never
    // change at all.
    if (bq.cost !== q.cost) {
      failures += 1;
      console.log(`FAIL ${n} ${fmt}: travel work changed cost ${bq.cost} -> ${q.cost}`);
    }
    const weigh = (x: typeof b) => x.walks * WALK_COST + x.drives * DRIVE_COST;
    if (weigh(t) > weigh(b)) {
      failures += 1;
      console.log(
        `FAIL ${n} ${fmt}: travel got worse, ${weigh(b)} -> ${weigh(t)} ` +
          `(drives ${b.drives} -> ${t.drives}, walks ${b.walks} -> ${t.walks})`
      );
    }
    console.log(
      `${String(n).padEnd(6)} ${fmt.padEnd(6)} ${String(q.cost).padStart(5)}  ` +
        `${q.spread.toFixed(2).padStart(5)}  ${q.gap.toFixed(2).padStart(4)}  |  ` +
        `${String(b.drives).padStart(11)} -> ${String(t.drives).padEnd(7)} ` +
        `${String(b.stays + "->" + t.stays).padStart(9)}  ` +
        `${String(b.neverDrive + "->" + t.neverDrive + "/" + n).padStart(11)}  ${String(ms).padStart(4)}`
    );
  }
}

// Quality must be identical with and without court optimisation: the same seed
// must give the same cost, since assignment only renames courts.
console.log("\nSanity: every player is on exactly one court per round.");
const s = generateSchedule(roster(24), {
  numRounds: 5,
  numCourts: 6,
  format: "open",
  seed: 7,
});
for (const r of s.rounds) {
  const courts = r.matches.map((m) => m.court).sort((a, b) => a - b);
  const uniq = new Set(courts);
  if (uniq.size !== courts.length) {
    failures += 1;
    console.log(`FAIL round ${r.number} reuses a court: ${courts.join(",")}`);
  }
  if (Math.min(...courts) < 1 || Math.max(...courts) > s.layout.courtsUsed) {
    failures += 1;
    console.log(`FAIL round ${r.number} court out of range: ${courts.join(",")}`);
  }
  const seen = new Set<number>();
  for (const m of r.matches)
    for (const p of [m.teamA[0], m.teamA[1], m.teamB[0], m.teamB[1]]) {
      if (seen.has(p)) {
        failures += 1;
        console.log(`FAIL player ${p} twice in round ${r.number}`);
      }
      seen.add(p);
    }
}
console.log(failures ? `\n${failures} failure(s)` : "\nAll travel checks passed.");
process.exit(failures ? 1 : 0);
