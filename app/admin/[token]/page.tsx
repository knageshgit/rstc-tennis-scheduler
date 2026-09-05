/**
 * /admin/<secret> - the organiser's door.
 *
 * Two checks, in this order. The path segment has to match ADMIN_PATH or the
 * route 404s exactly as an unused URL would, so a wrong guess learns nothing
 * about whether an admin page exists at all. Past that, an unlock cookie has to
 * be present, or the PIN form stands in for the generator.
 */
import { cookies } from "next/headers";
import { notFound } from "next/navigation";

import { ADMIN_COOKIE, adminConfig, checkCookie, checkToken } from "@/lib/admin";
import { getCurrentEventId } from "@/lib/store";

import Generator from "./Generator";
import PinGate from "./PinGate";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Organiser · Tennis Mixer",
  // Nothing here should ever turn up in a search result.
  robots: { index: false, follow: false },
};

export default async function AdminPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!checkToken(token)) notFound();

  const jar = await cookies();
  if (!checkCookie(jar.get(ADMIN_COOKIE)?.value)) {
    return <PinGate token={token} />;
  }

  const { open } = adminConfig();
  const liveId = await getCurrentEventId();

  return (
    <>
      {open && (
        <div className="bg-amber-100 px-4 py-2 text-center text-xs text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
          <strong>This page is unprotected.</strong> Set <code>ADMIN_PATH</code> and{" "}
          <code>ADMIN_PIN</code> in the environment, or anyone who reaches{" "}
          <code>/admin/&lt;anything&gt;</code> can publish to the club link.
        </div>
      )}
      <Generator liveId={liveId} />
    </>
  );
}
