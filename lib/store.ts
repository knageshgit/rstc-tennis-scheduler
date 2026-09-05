/**
 * Server-side storage for a published event.
 *
 * Up to this version the app was entirely local: a schedule lived in one
 * browser tab and nothing was ever sent anywhere. Score entry from several
 * phones at once needs shared state, so publishing an event writes it here and
 * every phone reads and writes the same record.
 *
 * The shape is deliberately small. An event is one immutable record (the
 * schedule, which never changes once published) plus a Redis hash of scores,
 * one field per match. Writing a score is a single HSET of one field, so two
 * captains submitting different courts at the same moment cannot overwrite
 * each other: there is no read-modify-write anywhere in this file.
 */
import { Redis } from "@upstash/redis";

import { MAX_COURTS, type Schedule } from "./scheduler";
import { isValidGames, type Scores } from "./scoring";

/** Events expire after this long, so old club days clean themselves up. */
export const EVENT_TTL_SECONDS = 60 * 60 * 24 * 180; // 180 days

/** An unambiguous alphabet: no O/0, I/1, or similar look-alikes to mistype. */
const ID_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const ID_LENGTH = 6;

export interface StoredEvent {
  id: string;
  createdAt: number;
  title: string;
  courtNames: string[];
  schedule: Schedule;
}

let client: Redis | null = null;

/** Is the Redis connection configured in this environment? */
export function isStoreConfigured(): boolean {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  );
}

/**
 * The Redis client, created on first use. Deliberately lazy: building this at
 * module scope would throw during `next build`, before the Marketplace
 * integration has injected its environment variables.
 */
function redis(): Redis {
  if (!isStoreConfigured()) {
    throw new StoreUnavailableError(
      "Score sharing is not configured on this deployment."
    );
  }
  if (!client) client = Redis.fromEnv();
  return client;
}

export class StoreUnavailableError extends Error {}

const eventKey = (id: string) => `ev:${id}`;
const scoresKey = (id: string) => `ev:${id}:scores`;

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
  const r = redis();
  // Retry on the vanishingly unlikely collision rather than clobber an event.
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = newEventId();
    const ev: StoredEvent = {
      id,
      createdAt: Date.now(),
      title,
      courtNames,
      schedule,
    };
    const ok = await r.set(eventKey(id), JSON.stringify(ev), {
      nx: true,
      ex: EVENT_TTL_SECONDS,
    });
    if (ok) return ev;
  }
  throw new Error("Could not allocate an event code; please try again.");
}

export async function getEvent(id: string): Promise<StoredEvent | null> {
  const raw = await redis().get(eventKey(id));
  if (raw === null || raw === undefined) return null;
  // Upstash parses JSON responses automatically, but a plain string can come
  // back when the value was written by an older client. Handle both.
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as StoredEvent;
    } catch {
      return null;
    }
  }
  return raw as StoredEvent;
}

export async function getScores(id: string): Promise<Scores> {
  const raw = await redis().hgetall<Record<string, unknown>>(scoresKey(id));
  const out: Scores = {};
  if (!raw) return out;
  for (const [k, v] of Object.entries(raw)) {
    const n = typeof v === "number" ? v : Number(v);
    // Anything unparsable is dropped rather than surfaced as a 0, which would
    // silently read as "this match finished 0-8".
    if (isValidGames(n)) out[k] = n;
  }
  return out;
}

/**
 * Record team A's games for one match, or clear it when `games` is null.
 * One field, one write: concurrent entries for different courts never collide.
 */
export async function setScore(
  id: string,
  key: string,
  games: number | null
): Promise<void> {
  const r = redis();
  if (games === null) await r.hdel(scoresKey(id), key);
  else await r.hset(scoresKey(id), { [key]: games });
  // Keep the scores alive as long as the event itself.
  await r.expire(scoresKey(id), EVENT_TTL_SECONDS);
  await r.expire(eventKey(id), EVENT_TTL_SECONDS);
}
