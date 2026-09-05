/**
 * POST /api/admin/unlock - trade the organiser PIN for a cookie.
 *
 * Both secrets are checked here: the secret path is sent along with the PIN so
 * that this endpoint is no easier to attack than the page it unlocks. Wrong
 * either way, the answer is the same 401 with the same wording, so a guess
 * cannot tell an attacker which half was wrong.
 */
import { checkPin, checkToken, unlockCookieHeader } from "@/lib/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DENIED = { error: "That PIN is not right." };

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const { token, pin } = (body ?? {}) as { token?: unknown; pin?: unknown };
  if (typeof token !== "string" || typeof pin !== "string") {
    return Response.json(DENIED, { status: 401 });
  }
  if (!checkToken(token) || !checkPin(pin)) {
    return Response.json(DENIED, { status: 401 });
  }
  return Response.json(
    { ok: true },
    { headers: { "set-cookie": unlockCookieHeader(), "cache-control": "no-store" } }
  );
}
