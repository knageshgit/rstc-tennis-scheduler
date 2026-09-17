/**
 * GET /api/events/[id]/survey - every star rating so far (the polling call).
 * PUT /api/events/[id]/survey - record or clear one player's rating.
 *
 * A PUT carries the player and what they are rating: a round and court for a
 * match, or neither for the tournament as a whole. `stars: null` clears it,
 * which is how somebody undoes a mis-tap rather than being stuck with it.
 *
 * Unlike a score, a rating is checked against the draw before it is stored.
 * Anyone with the link may enter any court's score, deliberately - whoever
 * finishes first types it in. A rating is a different thing: it is that
 * player's opinion of a match they were on, and one from somebody who was not
 * on that court is not a stricter version of the same claim, it is a different
 * claim. So the round, the court and the player have to agree with the
 * schedule. That costs one extra read per write, which over an afternoon of
 * ninety ratings is nothing.
 */
import {
  isValidStars,
  matchesFor,
  overallKey,
  ratingKey,
  MAX_STARS,
  MIN_STARS,
} from "@/lib/survey";
import {
  getEvent,
  getRatings,
  isStoreConfigured,
  isValidEventId,
  normalizeEventId,
  setRating,
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
    const ratings = await getRatings(id);
    return Response.json({ ratings }, { headers: NO_STORE });
  } catch (err) {
    console.error("getRatings failed", err);
    return Response.json({ error: "Could not load the ratings." }, { status: 500 });
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
  const { round, court, player, stars } = (body ?? {}) as {
    round?: unknown;
    court?: unknown;
    player?: unknown;
    stars?: unknown;
  };

  if (typeof player !== "number" || !Number.isInteger(player) || player < 0) {
    return Response.json({ error: "Which player?" }, { status: 400 });
  }
  // null clears; anything else has to be a star count we would hand back.
  if (stars !== null && !isValidStars(stars)) {
    return Response.json(
      { error: `A rating is ${MIN_STARS} to ${MAX_STARS} stars.` },
      { status: 400 }
    );
  }

  const ev = await getEvent(id);
  if (!ev) {
    return Response.json({ error: "No event with that code." }, { status: 404 });
  }
  if (player >= ev.schedule.players.length) {
    return Response.json({ error: "Nobody is playing at that position." }, { status: 400 });
  }

  // No round and no court means the end-of-day question about the tournament
  // itself, which every player on the roster may answer.
  const overall = round === undefined && court === undefined;
  let field: string;
  if (overall) {
    field = overallKey(player);
  } else {
    if (typeof round !== "number" || typeof court !== "number") {
      return Response.json({ error: "Which match?" }, { status: 400 });
    }
    const played = matchesFor(ev.schedule, player).some(
      (m) => m.round === round && m.court === court
    );
    if (!played) {
      return Response.json(
        { error: "That player is not on that court in that round." },
        { status: 400 }
      );
    }
    field = ratingKey(round, court, player);
  }

  try {
    await setRating(id, field, stars as number | null);
    return Response.json({ ok: true, field, stars }, { headers: NO_STORE });
  } catch (err) {
    console.error("setRating failed", err);
    return Response.json({ error: "Could not save that rating." }, { status: 500 });
  }
}
