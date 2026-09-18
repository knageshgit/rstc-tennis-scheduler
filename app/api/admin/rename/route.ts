/**
 * POST /api/admin/rename - give a published tournament its proper name.
 *
 * The title used to be whatever the roster spreadsheet was called, so a mixer
 * could go up in front of the club as "Copy of Players-v2026-09-15". The
 * generator now asks for a name, but that only helps the next tournament: one
 * already published cannot be fixed by republishing, because publishing mints
 * a fresh code and a fresh draw, and the draw is exactly what must not move
 * once people have read it.
 *
 * So this changes the one field, on an event that already exists, and touches
 * nothing else. Organizers only: the name is what every member sees at the top
 * of the page.
 */
import { isAdminRequest } from "@/lib/admin";
import {
  isStoreConfigured,
  isValidEventId,
  normalizeEventId,
  renameEvent,
} from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The same cap the publish route applies, so both doors agree. */
const MAX_TITLE = 120;

export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return Response.json({ error: "Organizers only." }, { status: 401 });
  }
  if (!isStoreConfigured()) {
    return Response.json(
      { error: "Score sharing is not configured on this deployment." },
      { status: 503 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const { id, title } = (body ?? {}) as { id?: unknown; title?: unknown };

  if (typeof id !== "string") {
    return Response.json({ error: "Which event?" }, { status: 400 });
  }
  const code = normalizeEventId(id);
  if (!isValidEventId(code)) {
    return Response.json({ error: "That is not a valid event code." }, { status: 400 });
  }
  if (typeof title !== "string") {
    return Response.json({ error: "What should it be called?" }, { status: 400 });
  }
  // An empty name is allowed and means "no name": the member page already
  // falls back to "Tennis mixer", which reads better than a filename.
  const clean = title.slice(0, MAX_TITLE).trim();

  try {
    const ev = await renameEvent(code, clean);
    if (!ev) {
      return Response.json({ error: "No event with that code." }, { status: 404 });
    }
    return Response.json(
      { ok: true, id: code, title: ev.title },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (err) {
    console.error("renameEvent failed", err);
    return Response.json({ error: "Could not rename that event." }, { status: 500 });
  }
}
