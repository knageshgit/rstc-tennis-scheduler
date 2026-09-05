/**
 * GET  /api/events/[id]/scores - every score entered so far (the polling call).
 * PUT  /api/events/[id]/scores - record or clear one match's result.
 *
 * A PUT carries the games won by team A only; team B's are implied, since the
 * two always add to GAMES_PER_MATCH. The write touches a single hash field, so
 * two captains entering different courts at the same instant cannot lose each
 * other's entry.
 */
import { GAMES_PER_MATCH, isValidGames, matchKey } from "@/lib/scoring";
import {
  getEvent,
  getScores,
  isStoreConfigured,
  isValidEventId,
  normalizeEventId,
  setScore,
} from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

function badStore() {
  return Response.json(
    { error: "Score sharing is not configured on this deployment." },
    { status: 503 }
  );
}

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isStoreConfigured()) return badStore();
  const id = normalizeEventId((await ctx.params).id ?? "");
  if (!isValidEventId(id)) {
    return Response.json({ error: "That is not a valid event code." }, { status: 400 });
  }
  try {
    const scores = await getScores(id);
    return Response.json({ scores }, { headers: NO_STORE });
  } catch (err) {
    console.error("getScores failed", err);
    return Response.json({ error: "Could not load the scores." }, { status: 500 });
  }
}

export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isStoreConfigured()) return badStore();
  const id = normalizeEventId((await ctx.params).id ?? "");
  if (!isValidEventId(id)) {
    return Response.json({ error: "That is not a valid event code." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const { round, court, games } = (body ?? {}) as {
    round?: unknown;
    court?: unknown;
    games?: unknown;
  };

  if (typeof round !== "number" || typeof court !== "number") {
    return Response.json({ error: "Which round and court?" }, { status: 400 });
  }
  // `null` clears a score that was entered by mistake.
  const clearing = games === null;
  if (!clearing && !isValidGames(games)) {
    return Response.json(
      { error: `A team's score must be a whole number of 0 to ${GAMES_PER_MATCH} games.` },
      { status: 400 }
    );
  }

  try {
    const ev = await getEvent(id);
    if (!ev) return Response.json({ error: "No event with that code." }, { status: 404 });

    // Only accept a score for a match that is actually on this schedule, so a
    // typo cannot park an orphan entry that never shows up anywhere.
    const rnd = ev.schedule.rounds.find((r) => r.number === round);
    if (!rnd || !rnd.matches.some((m) => m.court === court)) {
      return Response.json(
        { error: `Round ${round} has no court ${court} on this schedule.` },
        { status: 400 }
      );
    }

    await setScore(id, matchKey(round, court), clearing ? null : (games as number));
    const scores = await getScores(id);
    return Response.json({ ok: true, scores }, { headers: NO_STORE });
  } catch (err) {
    console.error("setScore failed", err);
    return Response.json({ error: "Could not save that score." }, { status: 500 });
  }
}
