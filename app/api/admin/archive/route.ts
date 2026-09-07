/**
 * POST   /api/admin/archive - file a finished tournament in the results archive
 * DELETE /api/admin/archive - take one back out
 *
 * Archiving is a deliberate act by the organiser, not something that happens
 * when a mixer is published or when the last score lands. The club asked for it
 * that way: a schedule is published the night before and scored all morning, so
 * the only person who knows a tournament is actually over is the one running
 * it. It also means the members' results page never shows a half-finished day.
 *
 * Organisers only, for the same reason publishing is: this writes what the club
 * shows on its own website.
 */
import { isAdminRequest } from "@/lib/admin";
import { isValidDate } from "@/lib/archive";
import {
  archiveEvent,
  getArchive,
  isStoreConfigured,
  isValidEventId,
  normalizeEventId,
  StoreUnavailableError,
  unarchiveEvent,
} from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { headers: { "cache-control": "no-store" } };

/** Both verbs need the same three checks before they touch anything. */
async function guard(request: Request): Promise<Response | string> {
  if (!isAdminRequest(request)) {
    return Response.json({ error: "Organisers only." }, { status: 401 });
  }
  if (!isStoreConfigured()) {
    return Response.json(
      { error: "Sharing is not configured on this deployment." },
      { status: 503 }
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const { id } = (body ?? {}) as { id?: unknown };
  if (typeof id !== "string") {
    return Response.json({ error: "Which tournament?" }, { status: 400 });
  }
  const code = normalizeEventId(id);
  if (!isValidEventId(code)) {
    return Response.json({ error: "That is not a valid event code." }, { status: 400 });
  }
  return code;
}

export async function POST(request: Request) {
  // The body is read once, so the date has to come out before `guard` consumes
  // it. Cloning is cheaper than restructuring both handlers around one parse.
  const clone = request.clone();
  const code = await guard(request);
  if (code instanceof Response) return code;

  let date = "";
  try {
    const { date: d } = (await clone.json()) as { date?: unknown };
    if (typeof d === "string") date = d;
  } catch {
    /* Already parsed once in `guard`; an unusable date falls back below. */
  }
  // The browser sends the date because only it knows the club's timezone. An
  // absent or malformed one falls back to the day the schedule was published,
  // which `summarize` works out from the stored event.
  if (date && !isValidDate(date)) {
    return Response.json({ error: "That date is not a real date." }, { status: 400 });
  }

  try {
    const entry = await archiveEvent(code, date);
    if (!entry) {
      return Response.json({ error: "No event with that code." }, { status: 404 });
    }
    return Response.json({ entry, archive: await getArchive() }, noStore);
  } catch (err) {
    if (err instanceof StoreUnavailableError) {
      return Response.json({ error: err.message }, { status: 503 });
    }
    console.error("archiveEvent failed", err);
    return Response.json({ error: "Could not archive that tournament." }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const code = await guard(request);
  if (code instanceof Response) return code;
  try {
    await unarchiveEvent(code);
    return Response.json({ archive: await getArchive() }, noStore);
  } catch (err) {
    if (err instanceof StoreUnavailableError) {
      return Response.json({ error: err.message }, { status: 503 });
    }
    console.error("unarchiveEvent failed", err);
    return Response.json({ error: "Could not remove that tournament." }, { status: 500 });
  }
}
