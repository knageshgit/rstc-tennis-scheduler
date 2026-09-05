/**
 * Checks the pure parts of the event store: code generation and the schedule
 * shape guard that decides what the server is willing to keep.
 * Run with: npx tsx scripts/verify_store.mts
 */
import { generateSchedule, type Player, type Schedule } from "../lib/scheduler";
import {
  isValidEventId,
  isValidScheduleShape,
  newEventId,
  normalizeEventId,
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

console.log(failures ? `\n${failures} failure(s)` : "\nAll store checks passed.");
process.exit(failures ? 1 : 0);
