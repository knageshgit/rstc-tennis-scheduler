/**
 * GET    /api/events/<id>/photos - what photos this mixer has
 * POST   /api/events/<id>/photos - add one taken on a phone
 * DELETE /api/events/<id>/photos - remove one (organiser)
 *
 * Adding a photo is open to anyone with the link, exactly like entering a
 * score, and for the same reason: at a club mixer the person with the camera is
 * whoever happened to be standing there, and a login would cost more than it
 * protects. The organiser can delete anything, which is the counterweight.
 *
 * The image arrives already downscaled and base64'd by the browser. The server
 * does not re-encode it - it has no pixels library and no reason to spend
 * function time on one - but it does re-check every limit, because "the client
 * already checked" is not a check.
 */
import { isAdminRequest } from "@/lib/admin";
import {
  MAX_PHOTOS_PER_EVENT,
  checkUpload,
  isValidPhotoId,
  newPhotoId,
  type PhotoMeta,
  type PhotoType,
} from "@/lib/photos";
import {
  addPhoto,
  deletePhoto,
  getEvent,
  isStoreConfigured,
  isValidEventId,
  listPhotos,
  normalizeEventId,
  StoreUnavailableError,
} from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { headers: { "cache-control": "no-store" } };

/** Base64 decodes to roughly three bytes for every four characters. */
function decodedBytes(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

async function eventFrom(params: Promise<{ id: string }>) {
  const { id } = await params;
  const code = normalizeEventId(id);
  return isValidEventId(code) ? code : null;
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const code = await eventFrom(ctx.params);
  if (!code) return Response.json({ error: "That is not a valid event code." }, { status: 400 });
  if (!isStoreConfigured()) return Response.json({ photos: [] }, noStore);
  try {
    return Response.json({ photos: await listPhotos(code) }, noStore);
  } catch (err) {
    if (err instanceof StoreUnavailableError) {
      return Response.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const code = await eventFrom(ctx.params);
  if (!code) return Response.json({ error: "That is not a valid event code." }, { status: 400 });
  if (!isStoreConfigured()) {
    return Response.json(
      { error: "Photo sharing is not configured on this deployment." },
      { status: 503 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const { full, thumb, type, width, height, by } = (body ?? {}) as Record<string, unknown>;

  if (typeof full !== "string" || typeof thumb !== "string") {
    return Response.json({ error: "That upload was missing its image." }, { status: 400 });
  }
  // Reject anything that is not base64 before measuring it: a huge string of
  // junk should not reach the store, and `atob` is not available to check with.
  if (!BASE64.test(full) || !BASE64.test(thumb)) {
    return Response.json({ error: "That image was not encoded correctly." }, { status: 400 });
  }

  // Photos already stored decides whether there is room, so it is read before
  // anything is written rather than trusted from the client.
  let existing: PhotoMeta[];
  try {
    existing = await listPhotos(code);
  } catch (err) {
    if (err instanceof StoreUnavailableError) {
      return Response.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }

  const verdict = checkUpload({
    type,
    fullBytes: decodedBytes(full),
    thumbBytes: decodedBytes(thumb),
    width,
    height,
    existingCount: existing.length,
  });
  if (!verdict.ok) return Response.json({ error: verdict.error }, { status: 400 });

  // The event has to exist, or the photo would be stored against a code nothing
  // renders. Checked after the cheap validation so a junk upload costs no read.
  if (!(await getEvent(code))) {
    return Response.json({ error: "No event with that code." }, { status: 404 });
  }

  const meta: PhotoMeta = {
    id: newPhotoId(),
    at: Date.now(),
    type: type as PhotoType,
    width: width as number,
    height: height as number,
    bytes: decodedBytes(full),
    // A name is only ever a label on a tile, so it is trimmed and truncated
    // rather than matched against the roster.
    ...(typeof by === "string" && by.trim() ? { by: by.trim().slice(0, 60) } : {}),
  };

  try {
    await addPhoto(code, meta, full, thumb);
  } catch (err) {
    if (err instanceof StoreUnavailableError) {
      return Response.json({ error: err.message }, { status: 503 });
    }
    console.error("addPhoto failed", err);
    return Response.json({ error: "That photo could not be saved." }, { status: 500 });
  }

  return Response.json(
    { photo: meta, remaining: MAX_PHOTOS_PER_EVENT - existing.length - 1 },
    { status: 201, ...noStore }
  );
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const code = await eventFrom(ctx.params);
  if (!code) return Response.json({ error: "That is not a valid event code." }, { status: 400 });
  // Anyone may add a photo; only the organiser may remove one. Deleting is the
  // irreversible half, and the only moderation the club has.
  if (!isAdminRequest(request)) {
    return Response.json({ error: "Organisers only." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const { photo } = (body ?? {}) as { photo?: unknown };
  if (!isValidPhotoId(photo)) {
    return Response.json({ error: "Which photo?" }, { status: 400 });
  }

  try {
    await deletePhoto(code, photo);
    return Response.json({ photos: await listPhotos(code) }, noStore);
  } catch (err) {
    if (err instanceof StoreUnavailableError) {
      return Response.json({ error: err.message }, { status: 503 });
    }
    console.error("deletePhoto failed", err);
    return Response.json({ error: "That photo could not be removed." }, { status: 500 });
  }
}
