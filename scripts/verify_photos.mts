/**
 * Checks the photo rules and the storage behaviour behind the Photos tab.
 *
 * Two things here are worth a test rather than a click. The limits, because
 * they are the only thing standing between one enthusiastic photographer and a
 * full database, and they are re-checked on the server precisely because the
 * browser's copy cannot be trusted. And the lifetime, because a photo has to
 * follow its tournament exactly: expiring with a live one, kept for good once
 * the tournament is archived, and back on the clock if it is un-archived. That
 * last one is invisible for six months if it is wrong.
 *
 * Run with: npx tsx scripts/verify_photos.mts
 */
import {
  MAX_FULL_BYTES,
  MAX_PHOTOS_PER_EVENT,
  MAX_THUMB_BYTES,
  checkUpload,
  fitWithin,
  fmtBytes,
  isAllowedType,
  isPhotoMeta,
  isValidPhotoId,
  newPhotoId,
  sortPhotos,
  type PhotoMeta,
} from "../lib/photos";
import { generateSchedule, type Player } from "../lib/scheduler";
import {
  addPhoto,
  archiveEvent,
  createEvent,
  deletePhoto,
  eventKey,
  getPhotoBytes,
  listPhotos,
  photoKey,
  photoUsage,
  photosKey,
  setScore,
  thumbKey,
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
const ids = Array.from({ length: 3000 }, () => newPhotoId());
check("every id validates", ids.every(isValidPhotoId));
check("ids are distinct", new Set(ids).size === ids.length);
check(
  "ids issued later sort later",
  newPhotoId(1_000) < newPhotoId(2_000),
  `${newPhotoId(1_000)} vs ${newPhotoId(2_000)}`
);
check("a path traversal attempt is not a photo id", !isValidPhotoId("../../etc/passwd"));
check("an empty id is rejected", !isValidPhotoId(""));
check("an upper-case id is rejected", !isValidPhotoId("ABCDEFGHIJKLMNOPQ"));
check("a short id is rejected", !isValidPhotoId("abc123"));

// ---- types -----------------------------------------------------------------
check("jpeg is allowed", isAllowedType("image/jpeg"));
check("webp is allowed", isAllowedType("image/webp"));
check("svg is not allowed", !isAllowedType("image/svg+xml"));
check("html is not allowed", !isAllowedType("text/html"));
check("a missing type is not allowed", !isAllowedType(undefined));

// ---- scaling ---------------------------------------------------------------
eq("a landscape photo scales by its long edge", fitWithin(4000, 3000, 1200), {
  width: 1200,
  height: 900,
});
eq("a portrait photo scales by its long edge", fitWithin(3000, 4000, 1200), {
  width: 900,
  height: 1200,
});
eq("a small photo is never enlarged", fitWithin(300, 200, 1200), { width: 300, height: 200 });
eq("a square photo stays square", fitWithin(2000, 2000, 320), { width: 320, height: 320 });
const pano = fitWithin(12000, 400, 320);
check("an extreme panorama keeps at least one pixel of height", pano.height >= 1, JSON.stringify(pano));
eq("zero dimensions do not divide by zero", fitWithin(0, 0, 1200), { width: 0, height: 0 });

// ---- upload rules ----------------------------------------------------------
const good = {
  type: "image/jpeg",
  fullBytes: 200_000,
  thumbBytes: 20_000,
  width: 1200,
  height: 900,
  existingCount: 0,
};
check("a normal photo is accepted", checkUpload(good).ok);
check("an oversized image is refused", !checkUpload({ ...good, fullBytes: MAX_FULL_BYTES + 1 }).ok);
check("an empty image is refused", !checkUpload({ ...good, fullBytes: 0 }).ok);
check(
  "an oversized thumbnail is refused",
  !checkUpload({ ...good, thumbBytes: MAX_THUMB_BYTES + 1 }).ok
);
check("an SVG is refused", !checkUpload({ ...good, type: "image/svg+xml" }).ok);
check(
  "the event's last slot is still allowed",
  checkUpload({ ...good, existingCount: MAX_PHOTOS_PER_EVENT - 1 }).ok
);
check(
  "one past the limit is refused",
  !checkUpload({ ...good, existingCount: MAX_PHOTOS_PER_EVENT }).ok
);
check("absurd dimensions are refused", !checkUpload({ ...good, width: 99999 }).ok);
check("fractional dimensions are refused", !checkUpload({ ...good, width: 12.5 }).ok);
check("negative dimensions are refused", !checkUpload({ ...good, height: -10 }).ok);
const refusal = checkUpload({ ...good, existingCount: MAX_PHOTOS_PER_EVENT });
check(
  "a refusal explains itself in a sentence worth showing",
  !refusal.ok && /limit/i.test(refusal.error),
  !refusal.ok ? refusal.error : ""
);

// ---- metadata --------------------------------------------------------------
const meta = (over: Partial<PhotoMeta> = {}): PhotoMeta => ({
  id: newPhotoId(),
  at: Date.now(),
  type: "image/jpeg",
  width: 1200,
  height: 900,
  bytes: 200_000,
  ...over,
});
check("a real record validates", isPhotoMeta(meta()));
check("a record with no id is dropped", !isPhotoMeta({ ...meta(), id: "nope" }));
check("a record with a bad type is dropped", !isPhotoMeta({ ...meta(), type: "image/gif" }));
check("a string is not a record", !isPhotoMeta("photo"));
check("null is not a record", !isPhotoMeta(null));

eq(
  "photos read oldest first, as the morning happened",
  sortPhotos([meta({ at: 300 }), meta({ at: 100 }), meta({ at: 200 })]).map((p) => p.at),
  [100, 200, 300]
);

eq("bytes read as bytes", fmtBytes(512), "512 B");
eq("kilobytes read as kilobytes", fmtBytes(200_000), "195 KB");
eq("megabytes get a decimal", fmtBytes(11_000_000), "10.5 MB");

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
const schedule = generateSchedule(roster(16), { numRounds: 4, seed: 3, format: "open" });
const ev = await createEvent("Photo trial", ["Shorebird 1"], schedule);

eq("a new event has no photos", await listPhotos(ev.id), []);

const first = meta({ by: "Sarah Ehler" });
await addPhoto(ev.id, first, "ZnVsbA==", "dGh1bWI=");
const back = await listPhotos(ev.id);
eq("the photo is listed", back.length, 1);
eq("the uploader's name survives", back[0].by, "Sarah Ehler");
eq("the full image reads back", await getPhotoBytes(ev.id, first.id, "full"), "ZnVsbA==");
eq("the thumbnail reads back", await getPhotoBytes(ev.id, first.id, "thumb"), "dGh1bWI=");
eq("an unknown photo reads as nothing", await getPhotoBytes(ev.id, newPhotoId(), "full"), null);

check("a photo on a live event expires", redis.ttl.has(photoKey(ev.id, first.id)));
check("so does its thumbnail", redis.ttl.has(thumbKey(ev.id, first.id)));
check("so does the photo index", redis.ttl.has(photosKey(ev.id)));

const second = meta({ at: Date.now() + 5 });
await addPhoto(ev.id, second, "Zg==", "dA==");
eq("two photos are listed oldest first", (await listPhotos(ev.id)).map((p) => p.id), [
  first.id,
  second.id,
]);
eq("usage counts every photo", await photoUsage(ev.id), { count: 2, bytes: 400_000 });

// Archiving has to carry the photos, or an archived mixer keeps its leaderboard
// and quietly loses its pictures six months later.
await archiveEvent(ev.id, "2026-09-05");
check("archiving keeps the photo for good", !redis.ttl.has(photoKey(ev.id, first.id)));
check("and its thumbnail", !redis.ttl.has(thumbKey(ev.id, first.id)));
check("and the second photo", !redis.ttl.has(photoKey(ev.id, second.id)));
check("and the index", !redis.ttl.has(photosKey(ev.id)));
check("and the event itself", !redis.ttl.has(eventKey(ev.id)));

// A photo added after archiving must be permanent too, not put on a clock.
const third = meta({ at: Date.now() + 10 });
await addPhoto(ev.id, third, "Zg==", "dA==");
check(
  "a photo added to an archived mixer is permanent",
  !redis.ttl.has(photoKey(ev.id, third.id)),
  `ttl ${redis.ttl.get(photoKey(ev.id, third.id))}`
);

// Correcting a score must not drag the photos back onto a clock either.
await setScore(ev.id, 1, 1, 6);
check("correcting a score leaves archived photos permanent", !redis.ttl.has(photoKey(ev.id, first.id)));

await unarchiveEvent(ev.id);
check("un-archiving puts photos back on the clock", redis.ttl.has(photoKey(ev.id, first.id)));
check("including ones added while archived", redis.ttl.has(photoKey(ev.id, third.id)));
check("and the index", redis.ttl.has(photosKey(ev.id)));

await deletePhoto(ev.id, first.id);
eq("deleting removes it from the list", (await listPhotos(ev.id)).map((p) => p.id), [
  second.id,
  third.id,
]);
check("the bytes go too", !redis.strings.has(photoKey(ev.id, first.id)));
check("and the thumbnail", !redis.strings.has(thumbKey(ev.id, first.id)));
eq("deleting an unknown photo is harmless", await deletePhoto(ev.id, newPhotoId()), undefined);

// A record written by a future version should cost one missing tile, not the tab.
redis.hashes.get(photosKey(ev.id))!.set("junk", JSON.stringify({ id: "junk" }));
eq(
  "an unreadable record is skipped rather than thrown",
  (await listPhotos(ev.id)).map((p) => p.id),
  [second.id, third.id]
);

// Photos belong to one event and must not leak into another.
const other = await createEvent("Another", [], schedule);
eq("a different event has its own photos", await listPhotos(other.id), []);
eq(
  "and cannot read the first event's images",
  await getPhotoBytes(other.id, second.id, "full"),
  null
);

__setStoreClientForTests(null);

console.log(failures === 0 ? "\nAll photo checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
