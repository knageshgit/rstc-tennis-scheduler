/**
 * Server-side storage for a published event, on Upstash Redis.
 *
 * Up to v5 the app was entirely local: a schedule lived in one browser tab and
 * nothing was ever sent anywhere. Score entry from several phones at once needs
 * shared state, so publishing an event writes it here and every phone reads and
 * writes the same record.
 *
 * The interesting constraint is concurrency. A round ends and six courts report
 * within the same few seconds, so a naive "read the scores, add mine, write
 * them back" would drop entries: two phones both read, both write, and the
 * second erases the first. Here that is not a problem to solve, it is a
 * property of the data structure. Each event's scores are one Redis hash,
 * keyed by match:
 *
 *     ev:K7M2QP:scores      r1c1 -> 5
 *                           r1c2 -> 3
 *                           r3c2 -> 6
 *
 * `HSET` writes a single field, so two captains entering different courts at
 * the same instant cannot touch each other's entry, and a read is one `HGETALL`
 * of the whole thing. Correcting a score overwrites its field; clearing one
 * deletes the field, which is different from scoring zero.
 *
 * This replaced a Vercel Blob store, which had no atomic update and refused to
 * overwrite, so scores had to be encoded into blob *pathnames* and folded back
 * together on read. That worked, but the read was a `list()` call on every
 * poll from every phone, and `list()` bills as a Blob Advanced Operation: one
 * phone with the page open burned 360 of the 2,000 monthly free-tier
 * operations per hour, and a single afternoon's mixer suspended the store.
 * Redis costs one cheap command per read and gives atomicity for free, which
 * is why roughly 120 lines of pathname encoding and fold logic are gone.
 */
import { Redis } from "@upstash/redis";

import { MAX_COURTS, type Schedule } from "./scheduler";
import { isValidGames, parseMatchKey, matchKey, type Scores } from "./scoring";

/** An unambiguous alphabet: no O/0, I/1, or similar look-alikes to mistype. */
const ID_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const ID_LENGTH = 6;

/**
 * How long a published event sticks around. Long enough that no live mixer
 * could ever expire mid-play, short enough that the store does not accumulate
 * every schedule forever. Refreshed whenever a score is entered, so an event
 * in use keeps itself alive.
 */
const EVENT_TTL_SECONDS = 180 * 24 * 60 * 60;

export interface StoredEvent {
  id: string;
  createdAt: number;
  title: string;
  courtNames: string[];
  schedule: Schedule;
}

// ---- keys ------------------------------------------------------------------
/** The event record itself. Exported so the tests can assert the namespacing. */
export const eventKey = (id: string) => `ev:${id}`;
/** The hash of scores for one event, field per match. */
export const scoresKey = (id: string) => `ev:${id}:scores`;
/** Which event the club link points at. A single key, overwritten in place. */
export const CURRENT_KEY = "cur";

// ---- the client ------------------------------------------------------------
/**
 * The slice of Redis this module actually uses. Naming it does two things:
 * it documents the whole dependency in seven lines, and it lets the tests
 * drive the store against an in-memory fake with no network and no account.
 */
export interface StoreClient {
  get<T>(key: string): Promise<T | null>;
  set(
    key: string,
    value: unknown,
    opts?: { nx?: true; ex?: number }
  ): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  hgetall<T extends Record<string, unknown>>(key: string): Promise<T | null>;
  hset(key: string, kv: Record<string, unknown>): Promise<number>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

/**
 * The Marketplace integration writes `KV_REST_API_*`; a database connected by
 * hand writes `UPSTASH_REDIS_REST_*`. Accept either, so the deployment works
 * whichever way the store was provisioned.
 */
function credentials(): { url: string; token: string } | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

let client: StoreClient | null = null;
let injected: StoreClient | null = null;

/** Point the store at a fake client. Tests only; pass null to undo. */
export function __setStoreClientForTests(c: StoreClient | null): void {
  injected = c;
  client = null;
}

/** Is shared storage configured in this environment? */
export function isStoreConfigured(): boolean {
  return Boolean(injected) || credentials() !== null;
}

export class StoreUnavailableError extends Error {}

function db(): StoreClient {
  if (injected) return injected;
  if (client) return client;
  const creds = credentials();
  if (!creds) {
    throw new StoreUnavailableError(
      "Score sharing is not configured on this deployment."
    );
  }
  client = new Redis(creds) as unknown as StoreClient;
  return client;
}

// ---- event codes -----------------------------------------------------------
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

/** Does this look like a code we could have issued? */
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

// ---- events ----------------------------------------------------------------
export async function createEvent(
  title: string,
  courtNames: string[],
  schedule: Schedule
): Promise<StoredEvent> {
  const redis = db();
  // `nx` means "only if this key is free", so a code that happens to collide
  // with a live event fails rather than quietly replacing somebody else's day.
  for (let attempt = 0; attempt < 5; attempt++) {
    const ev: StoredEvent = {
      id: newEventId(),
      createdAt: Date.now(),
      title,
      courtNames,
      schedule,
    };
    const ok = await redis.set(eventKey(ev.id), ev, { nx: true, ex: EVENT_TTL_SECONDS });
    if (ok) return ev;
  }
  throw new Error("Could not allocate an event code; please try again.");
}

export async function getEvent(id: string): Promise<StoredEvent | null> {
  try {
    const ev = await db().get<StoredEvent>(eventKey(id));
    // A record written by an older version, or by hand, should read as absent
    // rather than crash the page that renders it.
    return ev && typeof ev === "object" && isValidScheduleShape(ev.schedule) ? ev : null;
  } catch (err) {
    if (err instanceof StoreUnavailableError) throw err;
    return null; // No such event, or an unreadable one.
  }
}

// ---- scores ----------------------------------------------------------------
/**
 * Every score currently standing, as one `HGETALL`.
 *
 * Anything in the hash that is not a match key with a legal 0-8 value is
 * dropped rather than trusted: the scoring page indexes straight into the
 * schedule with these, so one bad field should not take the page down.
 */
export async function getScores(id: string): Promise<Scores> {
  const raw = await db().hgetall<Record<string, unknown>>(scoresKey(id));
  if (!raw) return {};
  const out: Scores = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!parseMatchKey(key)) continue;
    const games = typeof value === "string" ? Number(value) : value;
    if (isValidGames(games)) out[key] = games;
  }
  return out;
}

/**
 * Record team A's games for one match, or clear it when `games` is null.
 *
 * One field of one hash, so simultaneous entries from different courts cannot
 * interfere. Clearing deletes the field, which is what makes "not yet played"
 * distinguishable from "held to zero games".
 */
export async function setScore(
  id: string,
  round: number,
  court: number,
  games: number | null
): Promise<void> {
  const redis = db();
  const key = scoresKey(id);
  const field = matchKey(round, court);
  if (games === null) {
    await redis.hdel(key, field);
    return;
  }
  await redis.hset(key, { [field]: games });
  // The hash is created by the first HSET and so has no expiry of its own.
  // Setting it on every write also means an event being actively scored keeps
  // both halves of itself alive.
  await redis.expire(key, EVENT_TTL_SECONDS);
  await redis.expire(eventKey(id), EVENT_TTL_SECONDS);
}

// ---- the club link ---------------------------------------------------------
/**
 * Which event the root URL shows.
 *
 * The club wanted one link they could put in the group chat once and reuse
 * every week, so the root page does not ask for a code: it follows this
 * pointer, which the organiser moves when they publish. Old per-event links
 * keep working and keep showing their own day.
 *
 * One key, set and overwritten in place. On Blob this needed the same
 * append-only trick as the scores, because `put` would not overwrite and a
 * cached read of a mutable blob could hand a member last week's mixer. A Redis
 * `SET` has neither problem.
 */
export async function setCurrentEvent(id: string | null): Promise<void> {
  const redis = db();
  if (id === null) {
    await redis.del(CURRENT_KEY);
    return;
  }
  await redis.set(CURRENT_KEY, id);
}

/** The event the root URL should show, or null if nothing is published. */
export async function getCurrentEventId(): Promise<string | null> {
  if (!isStoreConfigured()) return null;
  try {
    const id = await db().get<string>(CURRENT_KEY);
    // Guards the shape only. A pointer at an event that has since expired
    // still passes here and lands the member on "no event with that code",
    // which takes 180 days of publishing nothing to reach and is fixed by
    // publishing again.
    return typeof id === "string" && isValidEventId(id) ? id : null;
  } catch {
    return null; // Storage is unreachable; the root page says so politely.
  }
}
