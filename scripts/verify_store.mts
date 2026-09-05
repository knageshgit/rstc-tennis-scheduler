/**
 * Checks the pure parts of the event store: code generation and the schedule
 * shape guard that decides what the server is willing to keep.
 * Run with: npx tsx scripts/verify_store.mts
 */
import { generateSchedule, type Player, type Schedule } from "../lib/scheduler";
import { matchKey, type Scores } from "../lib/scoring";
import {
  foldEntries,
  isValidEventId,
  isValidScheduleShape,
  newEventId,
  normalizeEventId,
  parseEntry,
  scorePath,
  scorePrefix,
  type Entry,
} from "../lib/store";

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) console.log(`ok   ${label}`);
  else {
    failures += 1;
    console.log(`FAIL ${label}${detail ? `\n     ${detail}` : ""}`);
  }
}

// ---- event codes -----------------------------------------------------------
const codes = Array.from({ length: 5000 }, () => newEventId());
check("codes are six characters", codes.every((c) => c.length === 6));
check(
  "codes avoid the characters people mistype (0, 1, I, O)",
  codes.every((c) => !/[01IO]/.test(c)),
  codes.find((c) => /[01IO]/.test(c))
);
check("codes are upper case and alphanumeric", codes.every((c) => /^[0-9A-Z]+$/.test(c)));
check(
  "5000 codes are essentially all distinct",
  new Set(codes).size >= 4995,
  `${new Set(codes).size} unique`
);
check("every generated code validates", codes.every(isValidEventId));

check("a lower-case code is accepted", normalizeEventId("a2b3c4") === "A2B3C4");
check("spaces and dashes are stripped", normalizeEventId(" A2B-3C4 ") === "A2B3C4");
check("excluded characters are dropped", normalizeEventId("A2B0O1I3") === "A2B3");
check("a code of the wrong length is rejected", !isValidEventId("A2B3C"));
check("an empty code is rejected", !isValidEventId(""));
check("a code with an excluded character is rejected", !isValidEventId("A2B3C0"));

// ---- schedule shape guard --------------------------------------------------
function roster(n: number): Player[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `P${i + 1}`,
    level: 3 + (i % 10) / 10,
    gender: (i % 2 === 0 ? "M" : "F") as const,
  }));
}
const real = generateSchedule(roster(24), { numRounds: 5, seed: 4, format: "open" });
check("a real schedule is accepted", isValidScheduleShape(real));
check(
  "a real mixed schedule is accepted",
  isValidScheduleShape(generateSchedule(roster(16), { numRounds: 4, seed: 2, format: "mixed" }))
);

// A JSON round-trip is what actually arrives at the endpoint.
check(
  "a schedule survives JSON and still validates",
  isValidScheduleShape(JSON.parse(JSON.stringify(real)))
);

const clone = (): Schedule => JSON.parse(JSON.stringify(real));
const reject = (label: string, mutate: (s: Schedule) => void) => {
  const s = clone();
  mutate(s);
  check(`rejects ${label}`, !isValidScheduleShape(s));
};

check("rejects null", !isValidScheduleShape(null));
check("rejects a string", !isValidScheduleShape("schedule"));
check("rejects an empty object", !isValidScheduleShape({}));
reject("a player index past the end of the roster", (s) => {
  s.rounds[0].matches[0].teamA[0] = s.players.length;
});
reject("a negative player index", (s) => {
  s.rounds[0].matches[1].teamB[0] = -1;
});
reject("a fractional player index", (s) => {
  s.rounds[0].matches[0].teamA[1] = 1.5 as number;
});
reject("a bye pointing at nobody", (s) => {
  s.rounds[0].byes = [999];
});
reject("a court number of 0", (s) => {
  s.rounds[0].matches[0].court = 0;
});
reject("a court number past the facility", (s) => {
  s.rounds[0].matches[0].court = 7;
});
reject("a team of three", (s) => {
  (s.rounds[0].matches[0].teamA as unknown as number[]).push(3);
});
reject("a player with no name", (s) => {
  s.players[0].name = "   ";
});
reject("a player with a non-numeric level", (s) => {
  s.players[0].level = "3.5" as unknown as number;
});
reject("a player with a NaN level", (s) => {
  s.players[0].level = NaN;
});
reject("an empty roster", (s) => {
  s.players = [];
});
reject("no rounds at all", (s) => {
  s.rounds = [];
});
reject("missing matches", (s) => {
  (s.rounds[0] as unknown as Record<string, unknown>).matches = "none";
});
reject("an absurd roster", (s) => {
  s.players = roster(201);
});
reject("an absurd number of rounds", (s) => {
  s.rounds = Array.from({ length: 21 }, () => s.rounds[0]);
});

// ---- scores encoded in blob pathnames --------------------------------------
// Each score is its own blob and the value lives in the pathname, so a write
// never touches another entry. These checks cover that round trip and the rule
// that the newest entry per match wins.
const EV = "K7M2QP";
/** Compare by value, not by key insertion order, which is not meaningful here. */
const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as object).sort(([a], [b]) => a.localeCompare(b)))
      : val
  );
const eq = (label: string, got: unknown, want: unknown) => {
  check(label, stable(got) === stable(want), `got      ${stable(got)}\n     expected ${stable(want)}`);
};
const entry = (key: string, games: number | null, at: number): Entry => ({ key, games, at });

const path = scorePath(EV, matchKey(3, 2), 5, 1764950400000);
check("a score pathname sits under its event's prefix", path.startsWith(scorePrefix(EV)));
eq("a score pathname round-trips", parseEntry(path, EV), entry("r3c2", 5, 1764950400000));
eq(
  "a cleared score round-trips as null, not 0",
  parseEntry(scorePath(EV, "r1c1", null, 5), EV),
  entry("r1c1", null, 5)
);
eq("a 0-8 score round-trips", parseEntry(scorePath(EV, "r1c1", 0, 5), EV), entry("r1c1", 0, 5));

// Every legal score must survive the round trip, not just a sampled one.
check(
  "every score 0 to 8 round-trips",
  Array.from({ length: 9 }, (_, g) => g).every((g) => {
    const e = parseEntry(scorePath(EV, "r2c3", g, 99), EV);
    return e?.games === g && e.key === "r2c3";
  })
);

// Two writes for different matches produce different pathnames, which is the
// whole reason simultaneous entries cannot collide.
check(
  "different matches never share a pathname",
  scorePath(EV, "r1c1", 5, 100) !== scorePath(EV, "r1c2", 5, 100)
);
check(
  "the same match at different times gets different pathnames",
  scorePath(EV, "r1c1", 5, 100) !== scorePath(EV, "r1c1", 5, 101)
);
check(
  "one event's scores cannot be read as another's",
  parseEntry(scorePath(EV, "r1c1", 5, 100), "AAAAAA") === null ||
    !scorePath(EV, "r1c1", 5, 100).startsWith(scorePrefix("AAAAAA"))
);

check("junk in the prefix is ignored", parseEntry(`${scorePrefix(EV)}garbage`, EV) === null);
check(
  "an out-of-range score in a pathname is ignored",
  parseEntry(`${scorePrefix(EV)}r1c1__9__100`, EV) === null
);
check(
  "a malformed match key is ignored",
  parseEntry(`${scorePrefix(EV)}court1__5__100`, EV) === null
);
check(
  "a non-numeric timestamp is ignored",
  parseEntry(`${scorePrefix(EV)}r1c1__5__soon`, EV) === null
);

eq("no entries means no scores", foldEntries([]), {});
eq(
  "one entry per match",
  foldEntries([entry("r1c1", 5, 10), entry("r1c2", 3, 11)]),
  { r1c1: 5, r1c2: 3 } as Scores
);
eq(
  "the newest entry for a match wins",
  foldEntries([entry("r1c1", 5, 10), entry("r1c1", 2, 20)]),
  { r1c1: 2 } as Scores
);
eq(
  "order in the listing does not matter, only the timestamp",
  foldEntries([entry("r1c1", 2, 20), entry("r1c1", 5, 10)]),
  { r1c1: 2 } as Scores
);
eq(
  "clearing a score leaves the match unscored, not scored zero",
  foldEntries([entry("r1c1", 5, 10), entry("r1c1", null, 20)]),
  {} as Scores
);
eq(
  "re-entering after a clear brings the score back",
  foldEntries([entry("r1c1", 5, 10), entry("r1c1", null, 20), entry("r1c1", 7, 30)]),
  { r1c1: 7 } as Scores
);
eq(
  "a stale value from a slow phone cannot overwrite a newer correction",
  foldEntries([entry("r1c1", 6, 30), entry("r1c1", 4, 12)]),
  { r1c1: 6 } as Scores
);

// A whole round reported at once: six courts, interleaved arbitrarily.
{
  const burst: Entry[] = [];
  for (let c = 1; c <= 6; c++) burst.push(entry(matchKey(2, c), c, 1000 + c));
  const shuffled = [...burst].reverse();
  eq(
    "six courts reporting together all survive",
    foldEntries(shuffled),
    Object.fromEntries(burst.map((e) => [e.key, e.games])) as Scores
  );
  check("every court in the burst is present", Object.keys(foldEntries(shuffled)).length === 6);
}

console.log(failures ? `\n${failures} failure(s)` : "\nAll store checks passed.");
process.exit(failures ? 1 : 0);
