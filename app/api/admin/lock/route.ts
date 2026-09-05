/**
 * POST /api/admin/lock - forget the unlock on this device.
 *
 * Worth having on a shared or borrowed laptop: the cookie otherwise lasts a
 * month. It needs no authentication, since all it can do is take access away
 * from whoever calls it.
 */
import { lockCookieHeader } from "@/lib/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  return Response.json(
    { ok: true },
    { headers: { "set-cookie": lockCookieHeader(), "cache-control": "no-store" } }
  );
}
