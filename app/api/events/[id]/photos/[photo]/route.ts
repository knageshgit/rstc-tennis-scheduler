/**
 * GET /api/events/<id>/photos/<photo> - one image, as an image.
 *
 * This is the URL that goes in `src`, so it returns bytes rather than JSON, and
 * it is the one route in the app that is aggressively cached. That is not an
 * optimisation, it is the design: a gallery of forty tiles on six phones is
 * hundreds of requests, and every one that the CDN answers is a database read
 * that never happens. Photo ids are never reused and an image never changes
 * once stored, so `immutable` is honestly true here in a way it rarely is.
 *
 * `?size=thumb` returns the grid copy, roughly a tenth the weight. The grid
 * asks for thumbnails and only the opened photo costs a full-size fetch.
 */
import { isValidPhotoId } from "@/lib/photos";
import {
  getPhotoBytes,
  isStoreConfigured,
  isValidEventId,
  normalizeEventId,
  StoreUnavailableError,
} from "@/lib/store";

export const runtime = "nodejs";

/** A year, which is as close to "forever" as a cache header is allowed to be. */
const IMMUTABLE = "public, max-age=31536000, s-maxage=31536000, immutable";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string; photo: string }> }
) {
  const { id, photo } = await ctx.params;
  const code = normalizeEventId(id);
  if (!isValidEventId(code) || !isValidPhotoId(photo)) {
    return new Response("Not found", { status: 404 });
  }
  if (!isStoreConfigured()) return new Response("Not found", { status: 404 });

  const size = new URL(request.url).searchParams.get("size") === "thumb" ? "thumb" : "full";

  let base64: string | null;
  try {
    base64 = await getPhotoBytes(code, photo, size);
  } catch (err) {
    if (err instanceof StoreUnavailableError) {
      return new Response("Unavailable", { status: 503 });
    }
    throw err;
  }
  if (!base64) return new Response("Not found", { status: 404 });

  const bytes = Buffer.from(base64, "base64");
  return new Response(new Uint8Array(bytes), {
    headers: {
      // Everything is re-encoded to JPEG on the phone before upload, so the
      // stored type is known rather than echoed back from what a client claimed.
      "content-type": "image/jpeg",
      "content-length": String(bytes.byteLength),
      "cache-control": IMMUTABLE,
      // Nothing here is user-controlled markup, but these images are served
      // from the app's own origin, so a stored file must never be sniffed into
      // something executable.
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
    },
  });
}
