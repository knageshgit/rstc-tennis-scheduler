/**
 * Server-side storage for a published event, on Vercel Blob.
 *
 * Up to this version the app was entirely local: a schedule lived in one
 * browser tab and nothing was ever sent anywhere. Score entry from several
 * phones at once needs shared state, so publishing an event writes it here and
 * every phone reads and writes the same record.
 *
 * The interesting constraint is concurrency. A round ends and six courts report
 * within the same few seconds, so a naive "read the scores, add mine, write
 * them back" would drop entries: two phones both read, both write, and the
 * second erases the first. There is no lock and no transaction available here,
 * so the data model removes the need for one.
 *
 * Each score is its own blob, and the score is carried in the *pathname*:
 *
 *     ev/K7M2QP/s/r3c2__5__1764950400000
 *                  ^     ^  ^
 *                  |     |  when it was entered
 *                  |     games won by team A ("x" if the score was cleared)
 *                  which match
 *
 * Nothing is ever overwritten or deleted, so a write is a single blob upload
 * that cannot collide with any other. Reading is a single `list` of the
 * prefix: the pathnames alone carry every score, so no blob contents are
 * fetched at all. Re-entering a score just adds a newer entry, and the reader
 * keeps the latest per match, which also makes a correction from one phone win
 * over a stale value from another.
 *
 * The cost of that is a few stale entries per corrected score, which is
 * bounded by how often a human retypes a number, and worth it for writes that
 * are correct without coordination.
 */
import { get, list, put, type PutCommandOptions } from "@vercel/blob";

import { MAX_COURTS, type Schedule } from "./scheduler";
import { isValidGames, matchKey, parseMatchKey, type Scores } from "./scoring";

/** An unambiguous alphabet: no O/0, I/1, or similar look-alikes to mistype. */
const ID_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const ID_LENGTH = 6;

/** Marks a score that was entered and then cleared again. */
const CLEARED = "x";

/** Blobs are private: the schedule carries the names of everyone playing. */
const PUT_OPTS: PutCommandOptions = {
  access: "private",
  addRandomSuffix: false,
  contentType: "application/json",
};

export interface StoredEvent {
  id: string;
  createdAt: number;
  title: string;
  courtNames: string[];
  schedule: Schedule;
}

/** Is blob storage configured in this environment? */
export function isStoreConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

export class StoreUnavailableError extends Error {}

function assertConfigured(): void {
  if (!isStoreConfigured()) {
    throw new StoreUnavailableError(
      "Score sharing is not configured on this deployment."
    );
  }
}

const eventPath = (id: string) => `ev/${id}/event.json`;
export const scorePrefix = (id: string) => `ev/${id}/s/`;

/** Build the blob pathname that encodes one score entry. Exported for tests. */
export function scorePath(
  id: string,
  key: string,
  games: number | null,
  at: number
): string {
  return `${scorePrefix(id)}${key}__${games === null ? CLEARED : games}__${at}`;
}

/** A short, human-readable, hard-to-guess event code. */
export function newEventId(): string {
  const bytes = new Uint8Array(ID_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return out;
}

/**
 * Clean up a code typed or pasted by hand. The alphabet already leaves out the
 * characters people confuse (0/O and 1/I/l), so there is nothing to fold: this
 * only upper-cases and drops spaces, dashes and any other stray punctuation.
 */
export function normalizeEventId(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .split("")
    .filter((c) => ID_ALPHABET.includes(c))
    .join("");
}

/** Does this look like an event code we could have issued? */
export function isValidEventId(id: string): boolean {
  return id.length === ID_LENGTH && normalizeEventId(id) === id;
}

/**
 * Is this a schedule we can safely store and later render?
 *
 * The browser has already run the engine, and re-running it here could produce
 * a different schedule from the one the organiser is looking at, so the server
 * takes the client's word for the arrangement. What it will not take on trust
 * is the shape: every player index has to be in range, or the scoring page
 * would later read `players[undefined]` and break for everyone.
 */
export function isValidScheduleShape(s: unknown): s is Schedule {
  if (!s || typeof s !== "object") return false;
  const sch = s as Partial<Schedule>;
  if (!Array.isArray(sch.players) || sch.players.length < 4 || sch.players.length > 200) {
    return false;
  }
  if (!Array.isArray(sch.rounds) || sch.rounds.length < 1 || sch.rounds.length > 20) {
    return false;
  }
  for (const p of sch.players) {
    if (!p || typeof p.name !== "string" || !p.name.trim()) return false;
    if (typeof p.level !== "number" || !Number.isFinite(p.level)) return false;
  }
  const n = sch.players.length;
  const inRange = (i: unknown) =>
    typeof i === "number" && Number.isInteger(i) && i >= 0 && i < n;
  for (const rnd of sch.rounds) {
    if (!rnd || typeof rnd.number !== "number" || !Number.isInteger(rnd.number)) return false;
    if (!Array.isArray(rnd.matches) || !Array.isArray(rnd.byes)) return false;
    if (!rnd.byes.every(inRange)) return false;
    for (const m of rnd.matches) {
      if (!m || typeof m.court !== "number") return false;
      if (!Number.isInteger(m.court) || m.court < 1 || m.court > MAX_COURTS) return false;
      if (!Array.isArray(m.teamA) || m.teamA.length !== 2) return false;
      if (!Array.isArray(m.teamB) || m.teamB.length !== 2) return false;
      if (![...m.teamA, ...m.teamB].every(inRange)) return false;
    }
  }
  return true;
}

export async function createEvent(
  title: string,
  courtNames: string[],
  schedule: Schedule
): Promise<StoredEvent> {
  assertConfigured();
  // `put` refuses to overwrite by default, so a colliding code throws rather
  // than quietly replacing somebody else's event.
  for (let attempt = 0; attempt < 5; attempt++) {
    const ev: StoredEvent = {
      id: newEventId(),
      createdAt: Date.now(),
      title,
      courtNames,
      schedule,
    };
    try {
      await put(eventPath(ev.id), JSON.stringify(ev), PUT_OPTS);
      return ev;
    } catch {
      // Almost certainly a pathname collision; try another code.
    }
  }
  throw new Error("Could not allocate an event code; please try again.");
}

export async function getEvent(id: string): Promise<StoredEvent | null> {
  assertConfigured();
  try {
    // Private blobs are not fetchable by URL; `get` carries the credentials.
    // The record never changes once published, so serving it from cache is
    // exactly what we want.
    const res = await get(eventPath(id), { access: "private", useCache: true });
    if (!res || res.statusCode !== 200 || !res.stream) return null;
    const text = await new Response(res.stream).text();
    return JSON.parse(text) as StoredEvent;
  } catch {
    return null; // No such event, or an unreadable one.
  }
}

/** One parsed score entry, as recovered from a blob pathname. */
export interface Entry {
  key: string;
  games: number | null;
  at: number;
}

/** Recover a score entry from its pathname, or null if it is not one. */
export function parseEntry(pathname: string, id: string): Entry | null {
  const tail = pathname.slice(scorePrefix(id).length);
  const parts = tail.split("__");
  if (parts.length !== 3) return null;
  const [key, rawGames, rawAt] = parts;
  if (!parseMatchKey(key)) return null;
  const at = Number(rawAt);
  if (!Number.isFinite(at)) return null;
  if (rawGames === CLEARED) return { key, games: null, at };
  const games = Number(rawGames);
  if (!isValidGames(games)) return null;
  return { key, games, at };
}

/**
 * Every score currently standing. One `list` call: the pathnames carry the
 * values, so no blob content is fetched.
 */
export async function getScores(id: string): Promise<Scores> {
  assertConfigured();
  const prefix = scorePrefix(id);
  const entries: Entry[] = [];

  let cursor: string | undefined;
  do {
    const page = await list({ prefix, limit: 1000, cursor });
    for (const blob of page.blobs) {
      const entry = parseEntry(blob.pathname, id);
      if (entry) entries.push(entry);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  return foldEntries(entries);
}

/**
 * Reduce every entry ever written for an event to the scores standing now:
 * the newest entry per match wins, and one that cleared a score leaves the
 * match unscored rather than scored zero. Pure, so it can be tested directly.
 */
export function foldEntries(entries: Entry[]): Scores {
  const latest = new Map<string, Entry>();
  for (const entry of entries) {
    const seen = latest.get(entry.key);
    if (!seen || entry.at >= seen.at) latest.set(entry.key, entry);
  }
  const out: Scores = {};
  for (const [key, entry] of latest) {
    if (entry.games !== null) out[key] = entry.games;
  }
  return out;
}

/**
 * Record team A's games for one match, or clear it when `games` is null.
 * A single upload to a pathname nothing else will ever use, so simultaneous
 * entries from different courts cannot interfere with each other.
 */
export async function setScore(
  id: string,
  round: number,
  court: number,
  games: number | null
): Promise<void> {
  assertConfigured();
  const key = matchKey(round, court);
  await put(scorePath(id, key, games, Date.now()), "{}", PUT_OPTS);
}

// ---- the club link ---------------------------------------------------------
/**
 * Which event the root URL shows.
 *
 * The club wanted one link they could put in the group chat once and reuse
 * every week, so the root page does not ask for a code: it follows a pointer
 * that the organiser moves when they publish. Old per-event links keep working
 * and keep showing their own day.
 *
 * The pointer uses the same append-only trick as the scores above, for the
 * same reason and one more: a blob `put` refuses to overwrite by default, and
 * a cached read of a mutable blob could hand a member last week's mixer. So
 * nothing is mutated. Each change writes a new blob whose pathname carries the
 * event code and the time, and the newest one wins:
 *
 *     cur/1764950400000__K7M2QP     the club link points here
 *     cur/1765555200000__-          taken down; the root shows nothing
 *
 * One blob per publish is a handful per season, which is not worth tidying.
 */
const CURRENT_PREFIX = "cur/";

/** Marks the club link as pointing at nothing. Not a legal event code. */
const NO_EVENT = "-";

/** Build the pathname that records where the club link points. For tests. */
export function currentPath(id: string | null, at: number): string {
  return `${CURRENT_PREFIX}${at}__${id ?? NO_EVENT}`;
}

/** Recover a pointer from its pathname, or null if it is not one. */
export function parseCurrent(pathname: string): { id: string | null; at: number } | null {
  if (!pathname.startsWith(CURRENT_PREFIX)) return null;
  const parts = pathname.slice(CURRENT_PREFIX.length).split("__");
  if (parts.length !== 2) return null;
  const at = Number(parts[0]);
  if (!Number.isFinite(at)) return null;
  if (parts[1] === NO_EVENT) return { id: null, at };
  if (!isValidEventId(parts[1])) return null;
  return { id: parts[1], at };
}

/**
 * Where the club link points now: the newest pointer written. Pure, so the
 * tie-breaking is testable without touching the network.
 */
export function foldCurrent(entries: { id: string | null; at: number }[]): string | null {
  let best: { id: string | null; at: number } | null = null;
  for (const e of entries) {
    if (!best || e.at >= best.at) best = e;
  }
  return best?.id ?? null;
}

/** Point the club link at an event, or at nothing when `id` is null. */
export async function setCurrentEvent(id: string | null): Promise<void> {
  assertConfigured();
  await put(currentPath(id, Date.now()), "{}", PUT_OPTS);
}

/** The event the root URL should show, or null if nothing is published. */
export async function getCurrentEventId(): Promise<string | null> {
  if (!isStoreConfigured()) return null;
  const entries: { id: string | null; at: number }[] = [];
  let cursor: string | undefined;
  try {
    do {
      const page = await list({ prefix: CURRENT_PREFIX, limit: 1000, cursor });
      for (const blob of page.blobs) {
        const entry = parseCurrent(blob.pathname);
        if (entry) entries.push(entry);
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  } catch {
    return null; // Storage is unreachable; the root page says so politely.
  }
  return foldCurrent(entries);
}
