/**
 * GET /api/events/[id] - the published schedule plus every score entered so far.
 * This is the one call a phone makes on load; afterwards it polls the lighter
 * /scores endpoint, since the schedule half never changes.
 */
import { getEvent, getScores, isStoreConfigured, isValidEventId, normalizeEventId } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isStoreConfigured()) {
    return Response.json(
      { error: "Score sharing is not configured on this deployment." },
      { status: 503 }
    );
  }
  const id = normalizeEventId((await ctx.params).id ?? "");
  if (!isValidEventId(id)) {
    return Response.json({ error: "That is not a valid event code." }, { status: 400 });
  }

  try {
    const ev = await getEvent(id);
    if (!ev) {
      return Response.json({ error: "No event with that code." }, { status: 404 });
    }
    const scores = await getScores(id);
    return Response.json(
      {
        id: ev.id,
        title: ev.title,
        createdAt: ev.createdAt,
        courtNames: ev.courtNames,
        schedule: ev.schedule,
        scores,
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (err) {
    console.error("getEvent failed", err);
    return Response.json({ error: "Could not load the event." }, { status: 500 });
  }
}
