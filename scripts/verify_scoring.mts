/**
 * Checks the scoring tally and the All / Men / Women leaderboards.
 * Run with: npx tsx scripts/verify_scoring.mts
 */
import { generateSchedule, type Player, type Schedule } from "../lib/scheduler";
import {
  GAMES_PER_MATCH,
  isValidGames,
  leaderboards,
  matchKey,
  missingByRound,
  parseMatchKey,
  rankTable,
  readScore,
  scoreProgress,
  tally,
  type PlayerScore,
  type Scores,
} from "../lib/scoring";

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) console.log(`ok   ${label}`);
  else {
    failures += 1;
    console.log(`FAIL ${label}${detail ? `\n     ${detail}` : ""}`);
  }
}
function eq(label: string, got: unknown, want: unknown) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  check(label, a === b, `got      ${a}\n     expected ${b}`);
}

// ---- keys and validation ---------------------------------------------------
eq("matchKey", matchKey(3, 2), "r3c2");
eq("parseMatchKey round-trips", parseMatchKey("r3c2"), { round: 3, court: 2 });
eq("parseMatchKey rejects junk", parseMatchKey("court2"), null);
check("0 games is valid", isValidGames(0));
check("8 games is valid", isValidGames(GAMES_PER_MATCH));
check("9 games is rejected", !isValidGames(9));
check("-1 games is rejected", !isValidGames(-1));
check("half a game is rejected", !isValidGames(4.5));
check("a numeric string is rejected", !isValidGames("5"));
check("undefined is rejected", !isValidGames(undefined));

// ---- a hand-built schedule with known answers ------------------------------
// 4 players, 1 court, 2 rounds. Every game is accounted for by hand.
const four: Player[] = [
  { name: "Ann", level: 3.5, gender: "F" },
  { name: "Bob", level: 3.5, gender: "M" },
  { name: "Cy", level: 3.5, gender: "M" },
  { name: "Dee", level: 3.5, gender: "F" },
];
const tiny: Schedule = {
  players: four,
  rounds: [
    { number: 1, matches: [{ court: 1, teamA: [0, 1], teamB: [2, 3] }], byes: [] },
    { number: 2, matches: [{ court: 1, teamA: [0, 2], teamB: [1, 3] }], byes: [] },
  ],
  cost: 0,
  travel: 0,
  format: "open",
  layout: {
    format: "open", courtsUsed: 1, menCourts: 0, womenCourts: 0,
    men: 2, women: 2, menPlaying: 2, womenPlaying: 2,
    playing: 4, byesPerRound: 0, menByes: 0, womenByes: 0,
  },
  courtNames: ["Court 1"],
};

// Round 1: Ann & Bob win 5-3. Round 2: Ann & Cy lose 2-6.
const s1: Scores = { r1c1: 5, r2c1: 2 };
const t1 = tally(tiny, s1);
const by = (rows: PlayerScore[], name: string) => rows.find((r) => r.name === name)!;

eq("Ann's games (5 + 2)", by(t1, "Ann").games, 7);
eq("Bob's games (5 + 6)", by(t1, "Bob").games, 11);
eq("Cy's games (3 + 2)", by(t1, "Cy").games, 5);
eq("Dee's games (3 + 6)", by(t1, "Dee").games, 9);
check(
  "every game is handed to exactly one player",
  t1.reduce((n, r) => n + r.games, 0) === 2 * 2 * GAMES_PER_MATCH,
  `total ${t1.reduce((n, r) => n + r.games, 0)}`
);
eq("Ann won one and lost one", [by(t1, "Ann").wins, by(t1, "Ann").losses], [1, 1]);
eq("Bob won both", [by(t1, "Bob").wins, by(t1, "Bob").losses], [2, 0]);
eq("played counts scored matches", by(t1, "Ann").played, 2);
eq("average is games per match", by(t1, "Bob").avg, 5.5);

// A drawn match is a tie, not a win.
const drawn = tally(tiny, { r1c1: 4, r2c1: 4 });
eq("4-4 is a tie for both sides", [by(drawn, "Ann").ties, by(drawn, "Cy").ties], [2, 2]);
eq("a tie is not a win", by(drawn, "Ann").wins, 0);

// ---- unscored matches ------------------------------------------------------
const partial = tally(tiny, { r1c1: 5 });
eq("an unscored match is not played", by(partial, "Ann").played, 1);
eq("an unscored match still counts as scheduled", by(partial, "Ann").scheduled, 2);
eq("an unscored match adds no games", by(partial, "Ann").games, 5);
eq("average ignores unscored matches", by(partial, "Ann").avg, 5);
eq("progress before any scores", scoreProgress(tiny, {}), {
  entered: 0, total: 2, complete: false,
});
eq("progress halfway", scoreProgress(tiny, { r1c1: 5 }), {
  entered: 1, total: 2, complete: false,
});
eq("progress when finished", scoreProgress(tiny, s1), {
  entered: 2, total: 2, complete: true,
});
eq("no games before anything is entered", tally(tiny, {}).every((r) => r.games === 0), true);
eq("a player with no scores averages 0, not NaN", tally(tiny, {})[0].avg, 0);
eq("missing rounds are listed", missingByRound(tiny, { r1c1: 5 }), [
  { round: 2, missing: [1] },
]);
eq("nothing missing when complete", missingByRound(tiny, s1), []);

// A malformed stored value is treated as not-yet-scored, never as 0 games.
eq("out-of-range score is ignored", readScore({ r1c1: 99 } as Scores, 1, 1), null);
eq("a 0 score is a real score, not a blank", readScore({ r1c1: 0 }, 1, 1), 0);

// ---- ranking ---------------------------------------------------------------
const mk = (name: string, games: number, played: number, gender = ""): PlayerScore => ({
  index: 0, name, level: 3.5, gender: gender as PlayerScore["gender"],
  games, played, scheduled: played, byes: 0,
  avg: played ? games / played : 0, wins: 0, losses: 0, ties: 0, rank: 0,
});

const ranked = rankTable([mk("Cy", 22, 5), mk("Ann", 27, 5), mk("Bob", 24, 5)]);
eq("ranked by total games", ranked.map((r) => r.name), ["Ann", "Bob", "Cy"]);
eq("ranks are 1..n", ranked.map((r) => r.rank), [1, 2, 3]);

// Level on games: same rank, and the next player skips a place.
const tied = rankTable([mk("Ann", 24, 5), mk("Bob", 24, 4), mk("Cy", 20, 5)]);
eq("players level on games share a rank", tied.map((r) => r.rank), [1, 1, 3]);
eq("the fewer-matches player is listed first within the tie",
  tied.map((r) => r.name), ["Bob", "Ann", "Cy"]);

// The bye case from the brief: fewer matches, still ranked on the total.
const withBye = rankTable([mk("Ann", 27, 5), mk("Ivy", 23, 4), mk("Bob", 24, 5)]);
eq("a bye does not change the ranking rule",
  withBye.map((r) => [r.name, r.rank]), [["Ann", 1], ["Bob", 2], ["Ivy", 3]]);
check("but the average shows why", by(withBye, "Ivy").avg > by(withBye, "Bob").avg);

// ---- the three tables ------------------------------------------------------
const lb = leaderboards(tiny, s1);
eq("the All table holds everyone", lb.all.length, 4);
eq("the Men table holds only men", lb.men.map((r) => r.name), ["Bob", "Cy"]);
eq("the Women table holds only women", lb.women.map((r) => r.name), ["Dee", "Ann"]);
eq("each table is ranked from 1", [lb.all[0].rank, lb.men[0].rank, lb.women[0].rank], [1, 1, 1]);
eq("the men's ranks are its own, not the overall ones",
  lb.men.map((r) => r.rank), [1, 2]);
eq("totals carry across tables unchanged",
  by(lb.men, "Bob").games, by(lb.all, "Bob").games);
eq("progress rides along with the tables", [lb.entered, lb.total, lb.complete], [2, 2, true]);

// Players with no gender appear only in the All table.
const noGender: Schedule = { ...tiny, players: four.map((p) => ({ ...p, gender: "" as const })) };
const lb2 = leaderboards(noGender, s1);
eq("ungendered players are in All", lb2.all.length, 4);
eq("ungendered players are in neither gender table", [lb2.men.length, lb2.women.length], [0, 0]);

// ---- against real generated schedules --------------------------------------
function roster(n: number): Player[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `P${i + 1}`,
    level: 3 + ((i * 7) % 11) / 10,
    gender: (i % 2 === 0 ? "M" : "F") as const,
  }));
}
for (const [n, format] of [
  [24, "open"], [25, "open"], [16, "mixed"], [20, "same"], [13, "open"],
] as const) {
  const s = generateSchedule(roster(n), { numRounds: 5, format, seed: 7 });
  // Score every match, varying the result so totals differ between players.
  const scores: Scores = {};
  let k = 0;
  for (const rnd of s.rounds) {
    for (const m of rnd.matches) scores[matchKey(rnd.number, m.court)] = k++ % (GAMES_PER_MATCH + 1);
  }
  const rows = tally(s, scores);
  const label = `${n} players, ${format}`;

  const awarded = rows.reduce((t, r) => t + r.games, 0);
  const expected = scoreProgress(s, scores).total * 2 * GAMES_PER_MATCH;
  eq(`${label}: all games are awarded`, awarded, expected);

  const playedRows = rows.reduce((t, r) => t + r.played, 0);
  eq(`${label}: matches played is 4 per scored match`, playedRows, expected / GAMES_PER_MATCH / 2 * 4);

  check(`${label}: nobody exceeds 8 games a match`,
    rows.every((r) => r.games <= r.played * GAMES_PER_MATCH));
  check(`${label}: wins + losses + ties equals matches played`,
    rows.every((r) => r.wins + r.losses + r.ties === r.played));
  check(`${label}: scheduled matches plus byes equals the rounds`,
    rows.every((r) => r.scheduled + r.byes === s.rounds.length),
    rows.filter((r) => r.scheduled + r.byes !== s.rounds.length)
      .map((r) => `${r.name} ${r.scheduled}+${r.byes}`).join(", "));

  const board = leaderboards(s, scores);
  eq(`${label}: All plus nobody missing`, board.all.length, n);
  eq(`${label}: Men and Women partition the roster`,
    board.men.length + board.women.length, n);
  check(`${label}: All is in non-increasing game order`,
    board.all.every((r, i) => i === 0 || board.all[i - 1].games >= r.games));
  check(`${label}: rank never decreases down the table`,
    board.all.every((r, i) => i === 0 || board.all[i - 1].rank <= r.rank));
  check(`${label}: equal games means equal rank`,
    board.all.every((r, i) =>
      i === 0 || board.all[i - 1].games !== r.games || board.all[i - 1].rank === r.rank));

  // Half-scored: the tables must still be coherent mid-event.
  const half: Scores = {};
  Object.entries(scores).forEach(([key, v], i) => { if (i % 2 === 0) half[key] = v; });
  const mid = leaderboards(s, half);
  eq(`${label}: half-scored progress`, mid.entered, Object.keys(half).length);
  check(`${label}: half-scored is not complete`, !mid.complete);
  check(`${label}: half-scored totals are consistent`,
    mid.all.every((r) => r.games <= r.played * GAMES_PER_MATCH && r.played <= r.scheduled));
}

console.log(failures ? `\n${failures} failure(s)` : "\nAll scoring checks passed.");
process.exit(failures ? 1 : 0);
