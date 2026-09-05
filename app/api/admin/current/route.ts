/**
 * POST /api/admin/current - move the club link, or take it down.
 *
 * Publishing already points the link at the new event, so this is for the
 * corrections: putting last week's mixer back up after a mistaken publish, or
 * clearing the root page once an event is over. Organisers only.
 */
import { isAdminRequest } from "@/lib/admin";
import {
  getEvent,
  isStoreConfigured,
  isValidEventId,
  normalizeEventId,
  setCurrentEvent,
} from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return Response.json({ error: "Organisers only." }, { status: 401 });
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
  const { id } = (body ?? {}) as { id?: unknown };

  // `null` takes the club link down; anything else must be a real event, or
  // the root page would sit on a code that loads nothing.
  if (id === null) {
    await setCurrentEvent(null);
    return Response.json({ ok: true, id: null }, { headers: { "cache-control": "no-store" } });
  }
  if (typeof id !== "string") {
    return Response.json({ error: "Which event?" }, { status: 400 });
  }
  const code = normalizeEventId(id);
  if (!isValidEventId(code)) {
    return Response.json({ error: "That is not a valid event code." }, { status: 400 });
  }
  if (!(await getEvent(code))) {
    return Response.json({ error: "No event with that code." }, { status: 404 });
  }
  await setCurrentEvent(code);
  return Response.json({ ok: true, id: code }, { headers: { "cache-control": "no-store" } });
}
