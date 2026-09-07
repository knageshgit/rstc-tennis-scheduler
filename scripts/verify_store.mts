/**
 * Checks the event store: code generation, the schedule shape guard that
 * decides what the server is willing to keep, and the read/write behaviour
 * itself driven against an in-memory Redis.
 *
 * The fake is worth the fifty lines. Under Blob the storage logic was a pile
 * of pure pathname encoding, so it could be tested directly but the parts that
 * actually talked to the network never were. Here the logic lives in Redis
 * semantics instead, so the only way to test it honestly is to implement those
 * semantics and run the real functions through them, no account required.
 *
 * Run with: npx tsx scripts/verify_store.mts
 */
import { generateSchedule, type Player, type Schedule } from "../lib/scheduler";
import { matchKey, type Scores } from "../lib/scoring";
import {
  CURRENT_KEY,
  createEvent,
  eventKey,
  getCurrentEventId,
  getEvent,
  getScores,
  isStoreConfigured,
  isValidEventId,
  isValidScheduleShape,
  newEventId,
  normalizeEventId,
  scoresKey,
  setCurrentEvent,
  setScore,
  __setStoreClientForTests,
  type StoreClient,
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

// ---- an in-memory Redis ----------------------------------------------------
/**
 * Enough of Redis to run the store against, matching the behaviours the store
 * actually leans on: `set` with `nx` refuses an occupied key, `hgetall` of a
 * missing key is null, deleting the last field removes the hash, and values go
 * through JSON exactly as the Upstash client serialises them.
 */
class FakeRedis implements StoreClient {
  strings = new Map<string, string>();
  hashes = new Map<string, Map<string, string>>();
  ttl = new Map<string, number>();

  async get<T>(key: string): Promise<T | null> {
    const raw = this.strings.get(key);
    return raw === undefined ? null : (JSON.parse(raw) as T);
  }
  async set(key: string, value: unknown, opts?: { nx?: true; ex?: number }) {
    if (opts?.nx && this.strings.has(key)) return null;
    this.strings.set(key, JSON.stringify(value));
    if (opts?.ex) this.ttl.set(key, opts.ex);
    return "OK";
  }
  async del(...keys: string[]) {
    let n = 0;
    for (const k of keys) {
      if (this.strings.delete(k) || this.hashes.delete(k)) n += 1;
      this.ttl.delete(k);
    }
    return n;
  }
  async hget<T>(key: string, field: string): Promise<T | null> {
    const raw = this.hashes.get(key)?.get(field);
    return raw === undefined ? null : (JSON.parse(raw) as T);
  }
  async hgetall<T extends Record<string, unknown>>(key: string): Promise<T | null> {
    const h = this.hashes.get(key);
    if (!h || h.size === 0) return null;
    return Object.fromEntries([...h].map(([f, v]) => [f, JSON.parse(v)])) as T;
  }
  async hset(key: string, kv: Record<string, unknown>) {
    let h = this.hashes.get(key);
    if (!h) this.hashes.set(key, (h = new Map()));
    for (const [f, v] of Object.entries(kv)) h.set(f, JSON.stringify(v));
    return Object.keys(kv).length;
  }
  async hdel(key: string, ...fields: string[]) {
    const h = this.hashes.get(key);
    if (!h) return 0;
    let n = 0;
    for (const f of fields) if (h.delete(f)) n += 1;
    if (h.size === 0) this.hashes.delete(key);
    return n;
  }
  async expire(key: string, seconds: number, mode?: "XX" | "NX") {
    const live = this.strings.has(key) || this.hashes.has(key);
    if (!live) return 0;
    // The conditional forms the store relies on: XX only refreshes a key that
    // already has an expiry, NX only sets one on a key that has none.
    if (mode === "XX" && !this.ttl.has(key)) return 0;
    if (mode === "NX" && this.ttl.has(key)) return 0;
    this.ttl.set(key, seconds);
    return 1;
  }
  async persist(key: string) {
    const live = this.strings.has(key) || this.hashes.has(key);
    if (!live || !this.ttl.has(key)) return 0;
    this.ttl.delete(key);
    return 1;
  }
  /** Write straight into a hash, to plant values the store did not produce. */
  plant(key: string, field: string, raw: string) {
    let h = this.hashes.get(key);
    if (!h) this.hashes.set(key, (h = new Map()));
    h.set(field, raw);
  }
}

const redis = new FakeRedis();
__setStoreClientForTests(redis);

const eq = (label: string, got: unknown, want: unknown) => {
  const s = (v: unknown) => JSON.stringify(v);
  check(label, s(got) === s(want), `got      ${s(got)}\n     expected ${s(want)}`);
};

check("an injected client counts as configured", isStoreConfigured());

// ---- publishing and reading back -------------------------------------------
const ev = await createEvent("Trial", ["Shorebird 1", "Dolphin 1"], real);
check("publishing returns a usable code", isValidEventId(ev.id));
check("the event is stored under its own key", redis.strings.has(eventKey(ev.id)));
check("a published event expires eventually", (redis.ttl.get(eventKey(ev.id)) ?? 0) > 0);

const back = await getEvent(ev.id);
check("a published event reads back", back !== null);
eq("the schedule survives storage unchanged", back?.schedule, JSON.parse(JSON.stringify(real)));
eq("the title survives storage", back?.title, "Trial");
eq("the court names survive storage", back?.courtNames, ["Shorebird 1", "Dolphin 1"]);

const other = await createEvent("Second", [], real);
check("two events get different codes", other.id !== ev.id);
check("an unknown code reads as nothing", (await getEvent("ZZZZZZ")) === null);

// A record whose schedule is corrupt must read as absent, not reach the page.
redis.strings.set(eventKey("BADBAD"), JSON.stringify({ id: "BADBAD", schedule: { nope: 1 } }));
check("a corrupt record reads as nothing", (await getEvent("BADBAD")) === null);

// Collision: the first codes it tries are taken, so it must keep trying.
{
  const before = redis.strings.size;
  // Refuse the next two codes, whatever they turn out to be.
  let refusals = 2;
  const realSet = redis.set.bind(redis);
  redis.set = async (key, value, opts) => {
    if (opts?.nx && refusals > 0) {
      refusals -= 1;
      return null;
    }
    return realSet(key, value, opts);
  };
  const survived = await createEvent("After collisions", [], real);
  check("a colliding code is retried, not overwritten", isValidEventId(survived.id));
  check("the collision path still stores exactly one event", redis.strings.size === before + 1);

  refusals = 99;
  let threw = false;
  try {
    await createEvent("Never lands", [], real);
  } catch {
    threw = true;
  }
  check("giving up on collisions raises rather than returning a broken event", threw);
  redis.set = realSet;
}

// ---- scores ----------------------------------------------------------------
eq("a fresh event has no scores", await getScores(ev.id), {} as Scores);

await setScore(ev.id, 3, 2, 5);
eq("a score reads back", await getScores(ev.id), { r3c2: 5 } as Scores);
check("scoring refreshes the event's expiry", (redis.ttl.get(scoresKey(ev.id)) ?? 0) > 0);

// Every legal value, including the two ends people get wrong.
for (const g of [0, 1, 4, 7, 8]) {
  await setScore(ev.id, 1, 1, g);
  const s = await getScores(ev.id);
  check(`a score of ${g} round-trips`, s.r1c1 === g, JSON.stringify(s));
}

// The reason this design exists: a whole round reported at the same instant.
{
  const burst = await createEvent("Burst", [], real);
  await Promise.all([1, 2, 3, 4, 5, 6].map((c) => setScore(burst.id, 2, c, c)));
  const s = await getScores(burst.id);
  check("six courts reporting together all survive", Object.keys(s).length === 6, JSON.stringify(s));
  eq(
    "each court keeps its own value",
    s,
    Object.fromEntries([1, 2, 3, 4, 5, 6].map((c) => [matchKey(2, c), c]))
  );
}

// Correcting and clearing.
await setScore(ev.id, 1, 1, 6);
eq("a correction replaces the old value", (await getScores(ev.id)).r1c1, 6);
await setScore(ev.id, 1, 1, null);
check("clearing leaves the match unscored", !("r1c1" in (await getScores(ev.id))));
await setScore(ev.id, 1, 1, 0);
eq("scoring zero is not the same as clearing", (await getScores(ev.id)).r1c1, 0);
await setScore(ev.id, 1, 1, null);
await setScore(ev.id, 1, 1, 7);
eq("re-entering after a clear brings the score back", (await getScores(ev.id)).r1c1, 7);
check("clearing a match that was never scored is harmless", (await setScore(ev.id, 9, 9, null)) === undefined);

// Junk in the hash is dropped rather than trusted.
{
  const j = await createEvent("Junk", [], real);
  await setScore(j.id, 1, 1, 5);
  redis.plant(scoresKey(j.id), "court1", "5"); // not a match key
  redis.plant(scoresKey(j.id), "r1c2", "9"); // past 8 games
  redis.plant(scoresKey(j.id), "r1c3", "-1"); // negative
  redis.plant(scoresKey(j.id), "r1c4", "2.5"); // not a whole number
  redis.plant(scoresKey(j.id), "r1c5", '"soon"'); // not a number at all
  eq("only the legal score survives a hash full of junk", await getScores(j.id), { r1c1: 5 });

  // Upstash may hand back a number or its string form depending on the value;
  // both have to be accepted or scores would silently vanish.
  redis.plant(scoresKey(j.id), "r2c1", '"6"');
  eq("a string-encoded score is still read", (await getScores(j.id)).r2c1, 6);
}

// Events must not be able to read each other's scores.
{
  const a = await createEvent("A", [], real);
  const b = await createEvent("B", [], real);
  await setScore(a.id, 1, 1, 8);
  eq("one event's scores stay out of another's", await getScores(b.id), {} as Scores);
  eq("and its own are intact", await getScores(a.id), { r1c1: 8 } as Scores);
}

// ---- the club link ---------------------------------------------------------
check("nothing published means nothing shown", (await getCurrentEventId()) === null);

await setCurrentEvent(ev.id);
eq("the club link points at what was published", await getCurrentEventId(), ev.id);

await setCurrentEvent(other.id);
eq("publishing again moves the link", await getCurrentEventId(), other.id);
check("moving the link overwrites in place", redis.strings.has(CURRENT_KEY));

await setCurrentEvent(null);
check("taking the link down empties the root page", (await getCurrentEventId()) === null);

await setCurrentEvent(ev.id);
eq("re-publishing after a take-down puts the link back", await getCurrentEventId(), ev.id);

redis.strings.set(CURRENT_KEY, JSON.stringify("nope"));
check("a malformed pointer reads as nothing published", (await getCurrentEventId()) === null);

// ---- an unconfigured deployment --------------------------------------------
__setStoreClientForTests(null);
const hadEnv = Boolean(
  process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN
);
if (!hadEnv) {
  check("with no credentials the store reports itself unconfigured", !isStoreConfigured());
  check("and the root page quietly shows nothing", (await getCurrentEventId()) === null);
  let threw = false;
  try {
    await createEvent("x", [], real);
  } catch {
    threw = true;
  }
  check("and publishing fails loudly rather than silently", threw);
} else {
  console.log("skip credentials are set in this environment, so the unconfigured path is untested");
}

console.log(failures ? `\n${failures} failure(s)` : "\nAll store checks passed.");
process.exit(failures ? 1 : 0);
