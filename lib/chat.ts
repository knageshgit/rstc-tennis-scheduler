/**
 * The mixer chat: what a message is, and what the app will accept as one.
 *
 * Pure, so the same rules run in the browser as somebody types and on the
 * server as it stores, and can be tested without either.
 *
 * A club chat is not a general-purpose one. It exists for the things people say
 * during a morning of tennis: "we're short on court 3", "anyone got a spare
 * grip", "coffee after". So a message is short, the identity is the name a
 * member already picked to find their own court, and there is nothing to log
 * into. The organiser can delete anything, which is the same bargain the photos
 * make.
 */

/** Long enough for a paragraph, short enough that nobody writes an essay. */
export const MAX_MESSAGE_LENGTH = 500;

/** A name is a label on a message, never an identity to be checked. */
export const MAX_NAME_LENGTH = 60;

/**
 * Messages kept per tournament.
 *
 * The cap is what stops one runaway phone filling the store, and is generous:
 * a busy club morning produces a few dozen.
 */
export const MAX_MESSAGES_PER_EVENT = 500;

export interface ChatMessage {
  id: string;
  /** When it was sent, epoch ms. Also the sort key. */
  at: number;
  /** Who sent it. "Anonymous" when nobody has picked a name. */
  by: string;
  text: string;
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * A message id: timestamp then randomness, so ids sort in send order and two
 * phones posting in the same millisecond cannot overwrite each other. The id is
 * the hash field, so a collision would silently lose somebody's message.
 */
export function newMessageId(now: number = Date.now()): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let tail = "";
  for (const b of bytes) tail += ID_ALPHABET[b % ID_ALPHABET.length];
  return `${now.toString(36).padStart(9, "0")}${tail}`;
}

export function isValidMessageId(id: unknown): id is string {
  return typeof id === "string" && /^[a-z0-9]{15}$/.test(id);
}

/** CRLF and lone CR both mean "new line"; everything downstream sees only LF. */
function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

const TAB = 9;
const NEWLINE = 10;
const SPACE = 32;
const DELETE_CHAR = 127;

/**
 * Drop the characters that have no business in a stored message.
 *
 * Written as a filter on character codes rather than a regular expression over
 * a control-character range, because the range has to be spelled with literal
 * control characters or escapes, and both are the kind of thing that gets
 * mangled silently by whatever the source passes through on its way here. This
 * says the same thing and can be read aloud.
 *
 * `keepNewlines` is the only difference between tidying a message and tidying a
 * name: people do write two-line messages, and nobody has a two-line name.
 *
 * Line endings are normalised to plain newlines before this runs, so a carriage
 * return never reaches it. Dropping a lone one here would silently weld the end
 * of one line onto the start of the next.
 */
function stripControl(s: string, keepNewlines: boolean): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === TAB) {
      out += " ";
    } else if (code === NEWLINE) {
      out += keepNewlines ? "\n" : " ";
    } else if (code >= SPACE && code !== DELETE_CHAR) {
      out += ch;
    }
  }
  return out;
}

/**
 * Tidy up what somebody typed.
 *
 * Runs of blank lines collapse, so holding return cannot push everyone else's
 * messages off the screen.
 *
 * Nothing here is HTML escaping. React escapes when it renders, and escaping on
 * the way in would mean storing `&amp;` and showing that to the next reader.
 */
export function cleanText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return stripControl(normalizeNewlines(raw), true)
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH);
}

/** A display name, tidied the same way but always on one line. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return stripControl(normalizeNewlines(raw), false).replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH);
}

/** What an unsigned message is attributed to. */
export const ANONYMOUS = "Anonymous";

/** Is this something the server is willing to post? */
export function checkMessage(input: {
  text: unknown;
  existingCount: number;
}): { ok: true; text: string } | { ok: false; error: string } {
  const text = cleanText(input.text);
  if (!text) return { ok: false, error: "Type something first." };
  if (input.existingCount >= MAX_MESSAGES_PER_EVENT) {
    return { ok: false, error: "This mixer's chat is full. The organiser can clear it." };
  }
  return { ok: true, text };
}

/** Is this something we wrote, and can still render? */
export function isChatMessage(v: unknown): v is ChatMessage {
  if (!v || typeof v !== "object") return false;
  const m = v as Partial<ChatMessage>;
  return (
    isValidMessageId(m.id) &&
    typeof m.at === "number" &&
    Number.isFinite(m.at) &&
    typeof m.by === "string" &&
    typeof m.text === "string" &&
    m.text.length > 0
  );
}

/** Oldest first, which is how a conversation reads. */
export function sortMessages(messages: ChatMessage[]): ChatMessage[] {
  return [...messages].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/**
 * Should this message be shown with its sender's name above it?
 *
 * Only when it starts a new run: several messages from the same person within a
 * couple of minutes read as one turn in the conversation, and repeating the
 * name over each is noise.
 */
export function startsRun(message: ChatMessage, previous?: ChatMessage): boolean {
  if (!previous) return true;
  if (previous.by !== message.by) return true;
  return message.at - previous.at > 2 * 60 * 1000;
}

/** "9:42 AM" for today's messages, with a date as well for older ones. */
export function fmtWhen(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (sameDay) return time;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}
