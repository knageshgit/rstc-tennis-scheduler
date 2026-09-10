/**
 * Checks the chat rules and the storage behind the Chat tab.
 *
 * The tidying is the part worth holding down. Anyone with the club link can
 * post, so whatever arrives has to be made safe to store and render before it
 * is kept: control characters out, a wall of blank lines collapsed, a length
 * cap that actually caps. And the lifetime, like the photos, has to follow the
 * tournament, which is invisible for six months if it is wrong.
 *
 * Run with: npx tsx scripts/verify_chat.mts
 */
import {
  ANONYMOUS,
  MAX_MESSAGES_PER_EVENT,
  MAX_MESSAGE_LENGTH,
  MAX_NAME_LENGTH,
  checkMessage,
  cleanName,
  cleanText,
  isChatMessage,
  isValidMessageId,
  newMessageId,
  sortMessages,
  startsRun,
  type ChatMessage,
} from "../lib/chat";
import { generateSchedule, type Player } from "../lib/scheduler";
import {
  addMessage,
  archiveEvent,
  chatKey,
  clearChat,
  createEvent,
  deleteMessage,
  listMessages,
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

// ---- ids -------------------------------------------------------------------
const ids = Array.from({ length: 3000 }, () => newMessageId());
check("every id validates", ids.every(isValidMessageId));
check("ids are distinct", new Set(ids).size === ids.length);
check("a later message sorts later", newMessageId(1_000) < newMessageId(2_000));
check("a made-up id is rejected", !isValidMessageId("../../secrets"));
check("an empty id is rejected", !isValidMessageId(""));

// ---- tidying text ----------------------------------------------------------
eq("ordinary text survives", cleanText("Court 3 is short a player"), "Court 3 is short a player");
eq("surrounding space goes", cleanText("   hello   "), "hello");
eq("a single newline survives", cleanText("line one\nline two"), "line one\nline two");
eq("windows line endings are normalised", cleanText("a\r\nb"), "a\nb");
eq("a lone carriage return becomes a newline", cleanText("a\rb"), "a\nb");
eq("a wall of blank lines collapses", cleanText("a\n\n\n\n\n\nb"), "a\n\nb");
eq("tabs become spaces", cleanText("a\tb"), "a b");

// Control characters are the interesting case: they must not reach the store.
const nasty = `hi${String.fromCharCode(0)}${String.fromCharCode(7)}${String.fromCharCode(27)}there`;
eq("nulls, bells and escapes are stripped", cleanText(nasty), "hithere");
eq("delete is stripped", cleanText(`a${String.fromCharCode(127)}b`), "ab");
check(
  "nothing below space survives except newline",
  ![...cleanText(nasty)].some((c) => (c.codePointAt(0) ?? 0) < 32)
);

eq("a non-string is empty", cleanText(null), "");
eq("a number is empty", cleanText(42), "");
eq("whitespace only is empty", cleanText("  \n\n  "), "");
check(
  "an over-long message is cut to the limit",
  cleanText("x".repeat(MAX_MESSAGE_LENGTH + 500)).length === MAX_MESSAGE_LENGTH
);

// Emoji and accents are ordinary text and must come through untouched.
eq("emoji survive", cleanText("great match 🎾🏆"), "great match 🎾🏆");
eq("accents survive", cleanText("Karmele Urtizberea"), "Karmele Urtizberea");

// HTML is stored as typed. React escapes it when rendering; escaping here would
// mean storing the escapes and showing them to the next reader.
eq(
  "markup is stored as written, not escaped",
  cleanText("<b>bold</b> & <script>"),
  "<b>bold</b> & <script>"
);

// ---- tidying names ---------------------------------------------------------
eq("a name survives", cleanName("Sarah Ehler"), "Sarah Ehler");
eq("a name is put on one line", cleanName("Sarah\nEhler"), "Sarah Ehler");
eq("runs of space in a name collapse", cleanName("Sarah    Ehler"), "Sarah Ehler");
check(
  "an over-long name is cut",
  cleanName("y".repeat(MAX_NAME_LENGTH + 40)).length === MAX_NAME_LENGTH
);
eq("a missing name is empty", cleanName(undefined), "");

// ---- what the server will accept -------------------------------------------
const accepted = checkMessage({ text: "  see you on court 2  ", existingCount: 0 });
check("a normal message is accepted", accepted.ok);
check("and comes back tidied", accepted.ok && accepted.text === "see you on court 2");
check("an empty message is refused", !checkMessage({ text: "   ", existingCount: 0 }).ok);
check("a non-string is refused", !checkMessage({ text: null, existingCount: 0 }).ok);
check(
  "the last slot is still allowed",
  checkMessage({ text: "hi", existingCount: MAX_MESSAGES_PER_EVENT - 1 }).ok
);
const full = checkMessage({ text: "hi", existingCount: MAX_MESSAGES_PER_EVENT });
check("one past the cap is refused", !full.ok);
check(
  "and says what to do about it",
  !full.ok && /organiser/i.test(full.error),
  !full.ok ? full.error : ""
);

// ---- records ---------------------------------------------------------------
const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: newMessageId(),
  at: Date.now(),
  by: "Sarah Ehler",
  text: "hello",
  ...over,
});
check("a real record validates", isChatMessage(msg()));
check("a record with no text is dropped", !isChatMessage(msg({ text: "" })));
check("a record with a bad id is dropped", !isChatMessage({ ...msg(), id: "nope" }));
check("a string is not a record", !isChatMessage("hello"));
check("null is not a record", !isChatMessage(null));

eq(
  "a conversation reads oldest first",
  sortMessages([msg({ at: 300, text: "c" }), msg({ at: 100, text: "a" }), msg({ at: 200, text: "b" })]).map(
    (m) => m.text
  ),
  ["a", "b", "c"]
);

// ---- grouping into runs ----------------------------------------------------
const t = 1_000_000;
check("the first message always shows its sender", startsRun(msg({ at: t })));
check(
  "a second message from the same person moments later does not",
  !startsRun(msg({ at: t + 5_000, by: "A" }), msg({ at: t, by: "A" }))
);
check(
  "a different sender always does",
  startsRun(msg({ at: t + 5_000, by: "B" }), msg({ at: t, by: "A" }))
);
check(
  "the same sender after a long gap does",
  startsRun(msg({ at: t + 10 * 60_000, by: "A" }), msg({ at: t, by: "A" }))
);

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

function roster(n: number): Player[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `P${i + 1}`,
    level: 3 + (i % 10) / 10,
    gender: (i % 2 === 0 ? "M" : "F") as const,
  }));
}
const schedule = generateSchedule(roster(12), { numRounds: 3, seed: 5, format: "open" });
const ev = await createEvent("Chat trial", ["Court 1"], schedule);

eq("a new event has no chat", await listMessages(ev.id), []);

const a = msg({ at: 1, text: "first" });
const b = msg({ at: 2, text: "second", by: ANONYMOUS });
await addMessage(ev.id, a);
await addMessage(ev.id, b);
eq("both messages read back in order", (await listMessages(ev.id)).map((m) => m.text), [
  "first",
  "second",
]);
eq("an unsigned message keeps its label", (await listMessages(ev.id))[1].by, ANONYMOUS);
check("chat on a live event expires", redis.ttl.has(chatKey(ev.id)));

// Two phones posting in the same instant must both survive: distinct ids mean
// distinct hash fields, so neither overwrites the other.
const sameMs = Date.now();
const one = msg({ at: sameMs, text: "same instant A" });
const two = msg({ at: sameMs, text: "same instant B" });
await addMessage(ev.id, one);
await addMessage(ev.id, two);
eq("simultaneous messages both survive", (await listMessages(ev.id)).length, 4);

// Lifetime follows the tournament, exactly as the photos do.
await archiveEvent(ev.id, "2026-09-05");
check("archiving keeps the chat for good", !redis.ttl.has(chatKey(ev.id)));
const afterArchive = msg({ at: sameMs + 1, text: "posted after archiving" });
await addMessage(ev.id, afterArchive);
check(
  "a message posted to an archived mixer stays permanent",
  !redis.ttl.has(chatKey(ev.id)),
  `ttl ${redis.ttl.get(chatKey(ev.id))}`
);
await unarchiveEvent(ev.id);
check("un-archiving puts the chat back on the clock", redis.ttl.has(chatKey(ev.id)));

await deleteMessage(ev.id, a.id);
check(
  "a deleted message is gone",
  !(await listMessages(ev.id)).some((m) => m.id === a.id)
);
eq("the rest remain", (await listMessages(ev.id)).length, 4);

// A record from a future version costs one line, not the tab.
redis.hashes.get(chatKey(ev.id))!.set("junk", JSON.stringify({ id: "junk" }));
eq("an unreadable record is skipped", (await listMessages(ev.id)).length, 4);

await clearChat(ev.id);
eq("clearing empties the conversation", await listMessages(ev.id), []);

// Chat belongs to one event and must not leak into another.
const other = await createEvent("Another", [], schedule);
await addMessage(other.id, msg({ text: "elsewhere" }));
eq("each event has its own chat", (await listMessages(ev.id)).length, 0);
eq("and the other one is unaffected", (await listMessages(other.id)).length, 1);

__setStoreClientForTests(null);

console.log(failures === 0 ? "\nAll chat checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
