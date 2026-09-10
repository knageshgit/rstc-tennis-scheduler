/**
 * Photos taken at a mixer: identity, limits, and what a stored photo records.
 *
 * Pure on purpose. Turning a 4MB camera shot into something worth storing has
 * to happen in the browser (see `lib/photo-capture.ts`), and putting the bytes
 * somewhere has to happen on the server (`lib/store.ts`), but the rules about
 * what is allowed and how much of it are the same in both places and are the
 * part worth testing on their own.
 *
 * The sizes below are not arbitrary. A phone camera produces roughly 3-5MB per
 * shot; stored as-is, one mixer would outgrow the whole database. Every upload
 * is therefore downscaled and re-encoded before it leaves the phone, and the
 * server refuses anything that arrives larger than the browser should ever have
 * sent. Two copies are kept: a full size worth looking at, and a thumbnail the
 * gallery grid loads instead of forty full images.
 */

/** The long edge of the stored image, in pixels. Fills a phone screen. */
export const FULL_EDGE = 1200;
/** The long edge of the grid thumbnail. */
export const THUMB_EDGE = 320;

/**
 * The most a single stored image may weigh. The browser aims well under this
 * and drops quality until it fits; the server rejects anything above it.
 *
 * Kept below Upstash's 1MB request ceiling with room for base64's 33% overhead
 * and the surrounding JSON: 700KB of image is about 950KB on the wire.
 */
export const MAX_FULL_BYTES = 700_000;
export const MAX_THUMB_BYTES = 90_000;

/**
 * Photos per tournament.
 *
 * A cap rather than a warning, because the store is shared: one enthusiastic
 * photographer should not be able to crowd out the next three mixers. Forty is
 * comfortably more than a club morning produces, and works out around 11MB per
 * tournament once base64 overhead is counted.
 */
export const MAX_PHOTOS_PER_EVENT = 40;

/** What a phone is allowed to send. HEIC is converted to JPEG before upload. */
export const ALLOWED_TYPES = ["image/jpeg", "image/webp", "image/png"] as const;
export type PhotoType = (typeof ALLOWED_TYPES)[number];

/** What the gallery knows about one photo without fetching a single byte. */
export interface PhotoMeta {
  id: string;
  /** When it was taken, epoch ms. Also the sort key. */
  at: number;
  type: PhotoType;
  /** Pixel dimensions of the full-size copy, so the grid can reserve space. */
  width: number;
  height: number;
  /** Bytes of the full-size copy. */
  bytes: number;
  /**
   * Who added it, when the app knows.
   *
   * The club page already asks a member to pick their name so it can show them
   * their own court, so the photo can be signed without asking anything extra.
   * Absent when nobody has picked a name, never required.
   */
  by?: string;
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * A photo id: the timestamp, then randomness.
 *
 * Time-ordered so the gallery sorts by id alone, and unique enough that two
 * phones uploading in the same millisecond cannot collide. Ids are never
 * reused, which is what lets the image URL be cached forever.
 */
export function newPhotoId(now: number = Date.now()): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let tail = "";
  for (const b of bytes) tail += ID_ALPHABET[b % ID_ALPHABET.length];
  return `${now.toString(36).padStart(9, "0")}${tail}`;
}

/** Could we have issued this id? Guards the path segment of the image URL. */
export function isValidPhotoId(id: unknown): id is string {
  return typeof id === "string" && /^[a-z0-9]{17}$/.test(id);
}

export function isAllowedType(t: unknown): t is PhotoType {
  return typeof t === "string" && (ALLOWED_TYPES as readonly string[]).includes(t);
}

/**
 * Scale a photo's dimensions down to fit inside a square of `edge`, keeping the
 * aspect ratio and never scaling a small photo up.
 */
export function fitWithin(
  width: number,
  height: number,
  edge: number
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= edge || longest === 0) {
    return { width: Math.round(width), height: Math.round(height) };
  }
  const k = edge / longest;
  // At least 1px each way: a panorama scaled hard could otherwise round to zero
  // and produce a canvas the browser refuses to draw.
  return {
    width: Math.max(1, Math.round(width * k)),
    height: Math.max(1, Math.round(height * k)),
  };
}

/** Is this something the server is willing to keep? */
export function checkUpload(input: {
  type: unknown;
  fullBytes: number;
  thumbBytes: number;
  width: unknown;
  height: unknown;
  existingCount: number;
}): { ok: true } | { ok: false; error: string } {
  if (!isAllowedType(input.type)) {
    return { ok: false, error: "That is not an image we can store." };
  }
  if (input.existingCount >= MAX_PHOTOS_PER_EVENT) {
    return {
      ok: false,
      error: `This mixer already has ${MAX_PHOTOS_PER_EVENT} photos, which is the limit.`,
    };
  }
  if (!(input.fullBytes > 0) || input.fullBytes > MAX_FULL_BYTES) {
    return { ok: false, error: "That photo is too large to store." };
  }
  if (!(input.thumbBytes > 0) || input.thumbBytes > MAX_THUMB_BYTES) {
    return { ok: false, error: "That photo could not be prepared for upload." };
  }
  const w = input.width;
  const h = input.height;
  const sane = (v: unknown) =>
    typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 20000;
  if (!sane(w) || !sane(h)) {
    return { ok: false, error: "That photo has unusable dimensions." };
  }
  return { ok: true };
}

/** Is this something we wrote, and can still render a tile from? */
export function isPhotoMeta(v: unknown): v is PhotoMeta {
  if (!v || typeof v !== "object") return false;
  const p = v as Partial<PhotoMeta>;
  return (
    isValidPhotoId(p.id) &&
    typeof p.at === "number" &&
    Number.isFinite(p.at) &&
    isAllowedType(p.type) &&
    typeof p.width === "number" &&
    typeof p.height === "number"
  );
}

/** Newest last, which is the order a roll of photos from one morning reads in. */
export function sortPhotos(photos: PhotoMeta[]): PhotoMeta[] {
  return [...photos].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/** "2.3 MB" from a byte count, for the organiser's usage line. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
