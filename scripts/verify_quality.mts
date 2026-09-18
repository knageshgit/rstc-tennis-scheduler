// Checks lib/quality.ts: per-match, per-round and whole-draw NTRP statistics,
// against a hand-worked example and then against every roster shape.
import { drawQuality, fmtLevel, teamGapAvg } from "../lib/quality.ts";
import {
  courtSpread,
  generateSchedule,
  teamGap,
  type Format,
  type Player,
  type Schedule,
} from "../lib/scheduler.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`FAIL ${msg}`);
    failures += 1;
  }
};
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// ---- a hand-worked draw ----------------------------------------------------
// Round 1: court 1 is 3.0+3.2 v 3.5+3.5, court 2 is 4.0+4.0 v 4.0+4.5.
// Round 2: one court, 3.0+4.5 v 3.2+3.5; players 3 to 6 sit out.
const players = [3.0, 3.2, 3.5, 3.5, 4.0, 4.0, 4.0, 4.5].map((level, i) => ({
  name: `P${i}`,
  level,
  gender: "M" as const,
}));
const hand = {
  players,
  rounds: [
    {
      number: 1,
      matches: [
        { court: 1, teamA: [0, 1], teamB: [2, 3] },
        { court: 2, teamA: [4, 5], teamB: [6, 7] },
      ],
      byes: [],
    },
    { number: 2, matches: [{ court: 1, teamA: [0, 7], teamB: [1, 2] }], byes: [3, 4, 5, 6] },
  ],
} as unknown as Schedule;

const q = drawQuality(hand);
const [r1, r2] = q.rounds;
const [c1, c2] = r1.matches;
check(c1.low === 3.0 && c1.high === 3.5, `court 1 low/high ${c1.low}/${c1.high}`);
check(near(c1.avg, 3.3), `court 1 average ${c1.avg}`);
check(near(c1.spread, 0.5), `court 1 spread ${c1.spread}`);
// Team means 3.1 and 3.5: the gap members can read off the parentheses.
check(near(c1.gap, 0.4), `court 1 team gap ${c1.gap}`);
check(near(c2.avg, 4.13), `court 2 average ${c2.avg} (4.125 to two places)`);
check(near(c2.gap, 0.25), `court 2 team gap ${c2.gap}`);
check(r1.low === 3.0 && r1.high === 4.5, `round 1 low/high ${r1.low}/${r1.high}`);
check(near(r1.avgSpread, 0.5), `round 1 avg spread ${r1.avgSpread}`);
check(near(r1.widest, 0.5), `round 1 widest ${r1.widest}`);
check(near(r2.matches[0].spread, 1.5), `round 2 spread ${r2.matches[0].spread}`);
check(near(r2.matches[0].gap, 0.4), `round 2 gap ${r2.matches[0].gap}`);
check(q.matches === 3, `match count ${q.matches}`);
check(q.low === 3.0 && q.high === 4.5, `draw low/high ${q.low}/${q.high}`);
check(near(q.avgSpread, 0.83), `draw avg spread ${q.avgSpread}`);
check(near(q.widest, 1.5), `draw widest ${q.widest}`);
check(fmtLevel(3.1) === "3.10", "levels print to two places");

// ---- every roster shape ----------------------------------------------------
const LEVELS = [2.5, 3.0, 3.25, 3.5, 3.8, 4.0, 4.5];
function roster(n: number, seed: number): Player[] {
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  return Array.from({ length: n }, (_, i) => ({
    name: `X${i}`,
    level: LEVELS[Math.floor(rand() * LEVELS.length)],
    gender: i % 2 ? ("F" as const) : ("M" as const),
  }));
}
let draws = 0;
for (const format of ["open", "mixed", "same"] as Format[]) {
  for (const n of [8, 12, 17, 18, 24]) {
    let s: Schedule;
    try {
      s = generateSchedule(roster(n, n * 7), { numRounds: 5, seed: n, format });
    } catch {
      continue; // a roster the scheduler refuses, e.g. too few of one gender
    }
    const dq = drawQuality(s);
    draws += 1;
    const label = `${format}/${n}`;
    check(dq.matches === s.rounds.reduce((k, r) => k + r.matches.length, 0), `${label}: match count`);
    for (const rq of dq.rounds) {
      const rnd = s.rounds.find((r) => r.number === rq.round)!;
      for (const mq of rq.matches) {
        const m = rnd.matches.find((x) => x.court === mq.court)!;
        check(near(mq.spread, Math.round(courtSpread(s, m) * 100) / 100), `${label}: spread agrees`);
        // Team gap on means is half the scheduler's gap on sums, give or take
        // the 0.01 from rounding each team's mean to the figure members see.
        check(Math.abs(mq.gap - teamGap(s, m) / 2) <= 0.01 + 1e-9, `${label}: gap is half the sum gap`);
        check(near(mq.gap, teamGapAvg(s, m)), `${label}: teamGapAvg agrees`);
        check(mq.low <= mq.avg && mq.avg <= mq.high, `${label}: average between extremes`);
      }
      check(rq.widest >= rq.avgSpread - 1e-9, `${label}: widest is at least the average`);
      check(rq.low <= rq.avg && rq.avg <= rq.high, `${label}: round average between extremes`);
    }
    check(dq.widest === Math.max(...dq.rounds.map((r) => r.widest)), `${label}: widest is the max`);
  }
}

if (failures) {
  console.error(`\n${failures} quality check(s) FAILED`);
  process.exit(1);
}
console.log(`All quality checks passed (${draws} generated draws plus a hand-worked one).`);
