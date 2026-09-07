/**
 * Event codes: the six characters a member reads off a phone screen.
 *
 * Their own module, apart from the store that issues them, because the
 * organiser's browser needs to check a code somebody typed by hand, and
 * importing `lib/store` to do it would pull the Redis client into the page
 * bundle. Everything here is pure and safe to run anywhere.
 */
/** An unambiguous alphabet: no O/0, I/1, or similar look-alikes to mistype. */
export const ID_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const ID_LENGTH = 6;

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
