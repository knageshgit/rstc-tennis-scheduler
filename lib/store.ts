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

import {
  isChatMessage,
  sortMessages,
  type ChatMessage,
} from "./chat";
import {
  isPhotoMeta,
  sortPhotos,
  type PhotoMeta,
} from "./photos";
import {
  isArchiveEntry,
  sortArchive,
  summarize,
  type ArchiveEntry,
} from "./archive";

import { MAX_COURTS, type Schedule } from "./scheduler";
import { isValidEventId, newEventId } from "./eventid";
import { isValidGames, parseMatchKey, matchKey, type Scores } from "./scoring";


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

// The code helpers live in `lib/eventid` so the organiser's browser can use
// them without importing this file. Re-exported because the routes and tests
// already reach for them here.
export { isValidEventId, newEventId, normalizeEventId } from "./eventid";

// ---- keys ------------------------------------------------------------------
/** The event record itself. Exported so the tests can assert the namespacing. */
export const eventKey = (id: string) => `ev:${id}`;
/** The hash of scores for one event, field per match. */
export const scoresKey = (id: string) => `ev:${id}:scores`;
/** Which event the club link points at. A single key, overwritten in place. */
export const CURRENT_KEY = "cur";
/** Metadata for one event's photos: field per photo, value a `PhotoMeta`. */
export const photosKey = (id: string) => `ev:${id}:photos`;
/** The full-size image bytes for one photo, base64. Its own key, fetched alone. */
export const photoKey = (id: string, photo: string) => `ev:${id}:ph:${photo}`;
/** The grid thumbnail, so a gallery of forty does not pull forty full images. */
export const thumbKey = (id: string, photo: string) => `ev:${id}:pht:${photo}`;
/** One event's chat: field per message, value a `ChatMessage`. */
export const chatKey = (id: string) => `ev:${id}:chat`;
/**
 * The results archive: one hash, field per event code, value a summary row.
 *
 * A hash rather than a sorted set because the page needs the whole row, not
 * just the ordering, and `HGETALL` fetches every finished tournament in one
 * command. Ordering is a text comparison on the date and belongs in JS.
 */
export const ARCHIVE_KEY = "arch";

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
  hget<T>(key: string, field: string): Promise<T | null>;
  hgetall<T extends Record<string, unknown>>(key: string): Promise<T | null>;
  hset(key: string, kv: Record<string, unknown>): Promise<number>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  /**
   * `mode` is Redis's own conditional expiry. "XX" means "only if this key
   * already has an expiry", which is what keeps an archived tournament
   * permanent even when somebody corrects a score months later.
   */
  expire(key: string, seconds: number, mode?: "XX" | "NX"): Promise<number>;
  /** Remove a key's expiry, so it lives until it is deleted by hand. */
  persist(key: string): Promise<number>;
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

  // Keep the event alive while it is being scored, but never resurrect the
  // expiry on one that has been archived: archiving strips the TTL to keep a
  // finished tournament for good, and a plain EXPIRE here would quietly put a
  // 180-day clock back on it the first time somebody corrected a score.
  //
  // "XX" means "only if this key already has an expiry", so the event key
  // answers the question for us: 1 says it is a live event and both halves
  // should be pushed out, 0 says it is archived and the scores must be made
  // permanent too. The scores hash cannot answer it itself, because the first
  // HSET creates it with no expiry at all and XX would leave it that way.
  const live = await redis.expire(eventKey(id), EVENT_TTL_SECONDS, "XX");
  if (live) await redis.expire(key, EVENT_TTL_SECONDS);
  else await redis.persist(key);
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

// ---- the results archive ---------------------------------------------------
/**
 * File a finished tournament in the archive, and stop it expiring.
 *
 * Two writes that have to happen together in spirit: the summary row goes into
 * the archive hash, and the event loses its TTL so the row it points at is
 * still there to open. They are separate commands, so the order matters -
 * persist first, then index. Persisting an event nothing links to is invisible;
 * a row pointing at an event that expires is a dead link on a members page.
 *
 * Re-archiving an event that is already in is deliberately allowed: HSET
 * overwrites the field, which is how a corrected score gets a corrected
 * champion.
 */
export async function archiveEvent(id: string, date: string): Promise<ArchiveEntry | null> {
  const redis = db();
  const ev = await getEvent(id);
  if (!ev) return null;
  const entry = summarize(ev, await getScores(id), date);
  await redis.persist(eventKey(id));
  await redis.persist(scoresKey(id));
  // The photos are part of the tournament, so they keep for as long as it does.
  // Without this an archived mixer would quietly lose its pictures after 180
  // days while its leaderboard stayed, which is the worse half to lose.
  await redis.persist(photosKey(id));
  await redis.persist(chatKey(id));
  for (const photo of await listPhotos(id)) {
    await redis.persist(photoKey(id, photo.id));
    await redis.persist(thumbKey(id, photo.id));
  }
  await redis.hset(ARCHIVE_KEY, { [id]: entry });
  return entry;
}

/**
 * Take a tournament back out of the archive.
 *
 * Needed while the club is trialling the app, when the archive fills up with
 * practice runs. This puts the TTL back rather than deleting anything, so an
 * event removed by mistake is still there to re-archive, and one removed on
 * purpose eventually clears itself out.
 */
export async function unarchiveEvent(id: string): Promise<void> {
  const redis = db();
  await redis.hdel(ARCHIVE_KEY, id);
  await redis.expire(eventKey(id), EVENT_TTL_SECONDS);
  await redis.expire(scoresKey(id), EVENT_TTL_SECONDS);
  await redis.expire(photosKey(id), EVENT_TTL_SECONDS);
  await redis.expire(chatKey(id), EVENT_TTL_SECONDS);
  for (const photo of await listPhotos(id)) {
    await redis.expire(photoKey(id, photo.id), EVENT_TTL_SECONDS);
    await redis.expire(thumbKey(id, photo.id), EVENT_TTL_SECONDS);
  }
}

/**
 * Every finished tournament, newest first, in one command.
 *
 * A row that does not parse is dropped rather than thrown: an archive written
 * by an older version should cost the club one missing line on the results
 * page, not the whole page.
 */
export async function getArchive(): Promise<ArchiveEntry[]> {
  if (!isStoreConfigured()) return [];
  try {
    const raw = await db().hgetall<Record<string, unknown>>(ARCHIVE_KEY);
    if (!raw) return [];
    return sortArchive(Object.values(raw).filter(isArchiveEntry));
  } catch (err) {
    if (err instanceof StoreUnavailableError) throw err;
    return [];
  }
}

/** Is this event already in the archive? One field, not the whole hash. */
export async function getArchiveEntry(id: string): Promise<ArchiveEntry | null> {
  try {
    const row = await db().hget<unknown>(ARCHIVE_KEY, id);
    return isArchiveEntry(row) ? row : null;
  } catch (err) {
    if (err instanceof StoreUnavailableError) throw err;
    return null;
  }
}

// ---- photos -----------------------------------------------------------------
/**
 * Photos taken during a mixer.
 *
 * Three keys per event rather than one: the metadata for every photo in a
 * single hash, and each image's bytes under a key of their own. That split is
 * the whole design. The gallery needs to know what exists, which is one
 * `HGETALL` of a few hundred bytes, and only then fetches the images it is
 * actually going to show, one request each, straight through the CDN. Keeping
 * the bytes in the metadata hash would mean every gallery view pulled every
 * photo whether it displayed them or not.
 *
 * Photos live and die with their tournament. `addPhoto` copies whatever expiry
 * the event currently has, so a photo added to an archived mixer is permanent
 * and one added to a live mixer expires with it, and archiving persists them
 * alongside the scores.
 */
export async function addPhoto(
  id: string,
  meta: PhotoMeta,
  full: string,
  thumb: string
): Promise<void> {
  const redis = db();
  await redis.set(photoKey(id, meta.id), full);
  await redis.set(thumbKey(id, meta.id), thumb);
  await redis.hset(photosKey(id), { [meta.id]: meta });

  // Match the event's own lifetime. `expire ... XX` returns 1 while the event
  // is still on the clock and 0 once it has been archived, which is exactly the
  // question being asked, and costs no extra round trip.
  const live = await redis.expire(eventKey(id), EVENT_TTL_SECONDS, "XX");
  for (const key of [photoKey(id, meta.id), thumbKey(id, meta.id), photosKey(id)]) {
    if (live) await redis.expire(key, EVENT_TTL_SECONDS);
    else await redis.persist(key);
  }
}

/** Every photo on this event, oldest first. Metadata only, no image bytes. */
export async function listPhotos(id: string): Promise<PhotoMeta[]> {
  try {
    const raw = await db().hgetall<Record<string, unknown>>(photosKey(id));
    if (!raw) return [];
    return sortPhotos(Object.values(raw).filter(isPhotoMeta));
  } catch (err) {
    if (err instanceof StoreUnavailableError) throw err;
    return [];
  }
}

/** One image's bytes, base64. `size` picks the full copy or the thumbnail. */
export async function getPhotoBytes(
  id: string,
  photo: string,
  size: "full" | "thumb"
): Promise<string | null> {
  const key = size === "full" ? photoKey(id, photo) : thumbKey(id, photo);
  const raw = await db().get<string>(key);
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * Remove one photo, bytes and all.
 *
 * Deleting the metadata first would leave the bytes stranded under a key
 * nothing lists, so nothing would ever clean them up; deleting the bytes first
 * leaves at worst a tile that fails to load, which the gallery already handles
 * and which the next delete tidies away.
 */
export async function deletePhoto(id: string, photo: string): Promise<void> {
  const redis = db();
  await redis.del(photoKey(id, photo), thumbKey(id, photo));
  await redis.hdel(photosKey(id), photo);
}

/** What this event's photos weigh, for the organiser's usage line. */
export async function photoUsage(id: string): Promise<{ count: number; bytes: number }> {
  const photos = await listPhotos(id);
  return {
    count: photos.length,
    bytes: photos.reduce((sum, p) => sum + (p.bytes || 0), 0),
  };
}

// ---- chat -------------------------------------------------------------------
/**
 * The mixer chat: one hash, a field per message.
 *
 * The same shape as the scores and for the same reason. Six people typing at
 * once each write their own field, so no message can overwrite another, and
 * reading the conversation is a single `HGETALL`. A list would have been the
 * obvious choice and would also have worked, but a hash keyed by message id is
 * what makes deleting one message a single command instead of a read, filter
 * and rewrite of the whole conversation.
 */
export async function addMessage(id: string, message: ChatMessage): Promise<void> {
  const redis = db();
  await redis.hset(chatKey(id), { [message.id]: message });
  // Match whatever lifetime the event has, exactly as photos do.
  const live = await redis.expire(eventKey(id), EVENT_TTL_SECONDS, "XX");
  if (live) await redis.expire(chatKey(id), EVENT_TTL_SECONDS);
  else await redis.persist(chatKey(id));
}

/** The whole conversation, oldest first. */
export async function listMessages(id: string): Promise<ChatMessage[]> {
  try {
    const raw = await db().hgetall<Record<string, unknown>>(chatKey(id));
    if (!raw) return [];
    return sortMessages(Object.values(raw).filter(isChatMessage));
  } catch (err) {
    if (err instanceof StoreUnavailableError) throw err;
    return [];
  }
}

/** Remove one message. Organisers only, enforced at the route. */
export async function deleteMessage(id: string, message: string): Promise<void> {
  await db().hdel(chatKey(id), message);
}

/** Remove the whole conversation, which is the only way to reset a full chat. */
export async function clearChat(id: string): Promise<void> {
  await db().del(chatKey(id));
}
