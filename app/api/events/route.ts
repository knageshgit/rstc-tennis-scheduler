/**
 * POST /api/events - publish a generated schedule so phones can score it.
 *
 * The body carries the whole schedule. Nothing about it is recomputed here:
 * the browser has already run the engine, and re-running it on the server could
 * produce a different schedule from the one the organiser is looking at.
 */
import { MAX_COURTS } from "@/lib/scheduler";
import {
  createEvent,
  isStoreConfigured,
  isValidScheduleShape,
  StoreUnavailableError,
} from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
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

  const { schedule, courtNames, title } = (body ?? {}) as {
    schedule?: unknown;
    courtNames?: unknown;
    title?: unknown;
  };

  if (!isValidScheduleShape(schedule)) {
    return Response.json({ error: "That schedule is not valid." }, { status: 400 });
  }
  const names =
    Array.isArray(courtNames) && courtNames.every((c) => typeof c === "string")
      ? (courtNames as string[]).slice(0, MAX_COURTS)
      : schedule.courtNames ?? [];

  try {
    const ev = await createEvent(
      typeof title === "string" ? title.slice(0, 120).trim() : "",
      names,
      schedule
    );
    return Response.json({ id: ev.id, createdAt: ev.createdAt }, { status: 201 });
  } catch (err) {
    if (err instanceof StoreUnavailableError) {
      return Response.json({ error: err.message }, { status: 503 });
    }
    console.error("createEvent failed", err);
    return Response.json({ error: "Could not publish the event." }, { status: 500 });
  }
}
