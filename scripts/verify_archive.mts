/**
 * Checks the results archive: the pure summary logic, and the store behaviour
 * that keeps a filed tournament from expiring.
 *
 * The interesting test here is the TTL one. Archiving strips the expiry off an
 * event so its leaderboard stays readable for good, but scores can still be
 * corrected afterwards, and `setScore` refreshes the expiry on every write. A
 * plain EXPIRE there would quietly put a 180-day clock back on an archived
 * tournament, and nobody would find out for six months. That is exactly the
 * kind of bug a test has to hold down, because no amount of clicking around
 * will surface it.
 *
 * Run with: npx tsx scripts/verify_archive.mts
 */
import {
  bySeason,
  formatLabel,
  isArchiveEntry,
  isoDate,
  isValidDate,
  sortArchive,
  summarize,
  type ArchiveEntry,
} from "../lib/archive";
import { generateSchedule, type Player } from "../lib/scheduler";
import { matchKey, type Scores } from "../lib/scoring";
import {
  ARCHIVE_KEY,
  archiveEvent,
  createEvent,
  eventKey,
  getArchive,
  getArchiveEntry,
  scoresKey,
  setScore,
  unarchiveEvent,
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
const eq = (label: string, got: unknown, want: unknown) => {
  const j = (v: unknown) => JSON.stringify(v);
  check(label, j(got) === j(want), `got      ${j(got)}\n     expected ${j(want)}`);
};

// ---- format labels ---------------------------------------------------------
eq("open doubles is named for members", formatLabel("open"), "Open doubles");
eq("mixed doubles is named for members", formatLabel("mixed"), "Mixed doubles");
eq("same-gender doubles is named for members", formatLabel("same"), "Same-gender doubles");

// ---- dates -----------------------------------------------------------------
check("a real date is accepted", isValidDate("2026-09-05"));
check("a leap day in a leap year is accepted", isValidDate("2024-02-29"));
check("a leap day in a common year is rejected", !isValidDate("2026-02-29"));
check("the 31st of February is rejected", !isValidDate("2026-02-31"));
check("a 13th month is rejected", !isValidDate("2026-13-01"));
check("a two-digit year is rejected", !isValidDate("26-09-05"));
check("a timestamp is rejected", !isValidDate(1788677593132));
check("an empty string is rejected", !isValidDate(""));
eq("a timestamp reduces to its UTC date", isoDate(Date.UTC(2026, 8, 5, 18, 30)), "2026-09-05");

// ---- summarising a finished tournament -------------------------------------
function roster(n: number): Player[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `P${i + 1}`,
    level: 3 + (i % 10) / 10,
    gender: (i % 2 === 0 ? "M" : "F") as const,
  }));
}
const schedule = generateSchedule(roster(24), { numRounds: 5, seed: 7, format: "mixed" });
const ev = {
  id: "AAA234",
  title: "Saturday mixer",
  createdAt: Date.UTC(2026, 8, 4, 20, 0),
  schedule,
};

// Every match to team A, so the winners are decidable and known.
const full: Scores = {};
for (const rnd of schedule.rounds) for (const m of rnd.matches) full[matchKey(rnd.number, m.court)] = 8;

const done = summarize(ev, full, "2026-09-05", 1_000);
eq("the date the organiser gave is kept", done.date, "2026-09-05");
eq("the format comes off the schedule", done.format, "mixed");
eq("the roster size is recorded", done.players, 24);
eq("the round count is recorded", done.rounds, 5);
eq("the courts in play are counted", done.courts, 6);
check("a fully scored event is marked complete", done.complete);
eq("every match is counted as scored", [done.entered, done.total], [30, 30]);
check("there is at least one champion", done.champions.length >= 1);
check("the champion's games are carried", done.championGames > 0);
check(
  "champions really are top of the table",
  done.champions.length > 0 &&
    done.championGames ===
      Math.max(
        ...schedule.players.map((_, i) =>
          schedule.rounds.reduce(
            (sum, rnd) =>
              sum +
              rnd.matches.reduce(
                (s2, m) => s2 + (m.teamA.includes(i) ? 8 : m.teamB.includes(i) ? 0 : 0),
                0
              ),
            0
          )
        )
      )
);
check("the archive row validates as one", isArchiveEntry(done));

// A tournament closed out with matches still missing.
const partial: Scores = { [matchKey(1, 1)]: 5, [matchKey(1, 2)]: 8 };
const half = summarize(ev, partial, "2026-09-05");
check("a partly scored event is not marked complete", !half.complete);
eq("the scored count is honest", [half.entered, half.total], [2, 30]);
check("a partly scored event still names its leaders", half.champions.length > 0);

// Nothing scored at all: no winner to name.
const none = summarize(ev, {}, "2026-09-05");
eq("an unscored event names nobody", none.champions, []);
eq("and reports no games", none.championGames, 0);

// A bad date falls back to the day it was published rather than throwing.
eq("a malformed date falls back to the publish date", summarize(ev, {}, "not-a-date").date, "2026-09-04");
eq("an empty date falls back too", summarize(ev, {}, "").date, "2026-09-04");

// ---- ordering --------------------------------------------------------------
const row = (id: string, date: string, archivedAt = 0): ArchiveEntry => ({
  ...none,
  id,
  date,
  archivedAt,
});
eq(
  "the archive reads newest first",
  sortArchive([row("A", "2026-01-10"), row("C", "2026-09-05"), row("B", "2026-03-02")]).map(
    (e) => e.id
  ),
  ["C", "B", "A"]
);
eq(
  "two mixers on one day fall back to when they were filed",
  sortArchive([row("A", "2026-09-05", 100), row("B", "2026-09-05", 200)]).map((e) => e.id),
  ["B", "A"]
);
eq(
  "and to the code, so the order never wobbles between reloads",
  sortArchive([row("B", "2026-09-05", 5), row("A", "2026-09-05", 5)]).map((e) => e.id),
  ["A", "B"]
);
eq(
  "seasons group by year, newest first",
  bySeason([row("A", "2025-06-01"), row("B", "2026-09-05"), row("C", "2026-01-04")]).map(
    (s) => [s.year, s.entries.map((e) => e.id)]
  ),
  [
    ["2026", ["B", "C"]],
    ["2025", ["A"]],
  ]
);
check("a row missing its date is dropped, not rendered", !isArchiveEntry({ ...done, date: "" }));
check("a row that is not an object is dropped", !isArchiveEntry("2026-09-05"));

// ---- the store -------------------------------------------------------------
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
}

const redis = new FakeRedis();
__setStoreClientForTests(redis);

const live = await createEvent("Trial mixer", ["Shorebird 1"], schedule);
await setScore(live.id, 1, 1, 6);
check("a live event has an expiry", redis.ttl.has(eventKey(live.id)));
check("so does its scores hash", redis.ttl.has(scoresKey(live.id)));

eq("nothing is archived to begin with", await getArchive(), []);
eq("an unarchived event has no entry", await getArchiveEntry(live.id), null);

const filed = await archiveEvent(live.id, "2026-09-05");
check("archiving returns the row it filed", filed?.id === live.id);
eq("the row lands in the archive hash", redis.hashes.get(ARCHIVE_KEY)?.size, 1);
check("an archived event never expires", !redis.ttl.has(eventKey(live.id)));
check("nor does its scores hash", !redis.ttl.has(scoresKey(live.id)));
eq("the archive reads back", (await getArchive()).map((e) => e.id), [live.id]);
eq("the entry reads back on its own", (await getArchiveEntry(live.id))?.date, "2026-09-05");
eq("the title came from the event", filed?.title, "Trial mixer");

// The regression this whole XX business exists for.
await setScore(live.id, 1, 2, 7);
check(
  "correcting a score after archiving does NOT put the expiry back",
  !redis.ttl.has(eventKey(live.id)),
  `ttl is ${redis.ttl.get(eventKey(live.id))}`
);
check(
  "and does not put one back on the scores either",
  !redis.ttl.has(scoresKey(live.id)),
  `ttl is ${redis.ttl.get(scoresKey(live.id))}`
);

// Re-filing recomputes from the scores as they now stand.
const before = (await getArchiveEntry(live.id))!;
await setScore(live.id, 2, 1, 8);
const after = (await archiveEvent(live.id, "2026-09-05"))!;
check("re-archiving recounts the matches scored", after.entered > before.entered);
eq("re-archiving does not add a second row", redis.hashes.get(ARCHIVE_KEY)?.size, 1);

// Removing one puts it back on the clock rather than deleting it.
await unarchiveEvent(live.id);
eq("removing it empties the archive", await getArchive(), []);
check("the event itself survives", (await redis.get(eventKey(live.id))) !== null);
check("and starts expiring again", redis.ttl.has(eventKey(live.id)));
check("as do its scores", redis.ttl.has(scoresKey(live.id)));
await setScore(live.id, 3, 1, 4);
check("a live event keeps refreshing its expiry", redis.ttl.has(eventKey(live.id)));

eq("archiving an event that does not exist files nothing", await archiveEvent("ZZZZZZ", "2026-09-05"), null);

// A second tournament, to prove the archive holds more than one.
const other = await createEvent("Sunday mixer", [], schedule);
await archiveEvent(other.id, "2026-09-06");
await archiveEvent(live.id, "2026-09-05");
eq(
  "two tournaments archive independently, newest first",
  (await getArchive()).map((e) => e.id),
  [other.id, live.id]
);

// A row written by some future version must not take the page down.
redis.hashes.get(ARCHIVE_KEY)!.set("BADROW", JSON.stringify({ id: "BADROW" }));
eq(
  "an unreadable row is skipped rather than thrown",
  (await getArchive()).map((e) => e.id),
  [other.id, live.id]
);

__setStoreClientForTests(null);

console.log(failures === 0 ? "\nAll archive checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
