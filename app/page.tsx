/**
 * The club link: https://rstc-tennis-sch.vercel.app
 *
 * This is the one URL that goes in the group chat, so it must never need a
 * code, a login, or updating week to week. It follows the pointer the organiser
 * moves when they publish, which means whoever opens it gets today's mixer.
 *
 * It only ever reads and scores. Building a schedule lives behind /admin.
 */
import { getCurrentEventId, isStoreConfigured } from "@/lib/store";

import EventView from "./EventView";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "RSTC Tennis Mixer",
  description: "Today's schedule, results and leaderboard.",
};

export default async function ClubPage() {
  const id = await getCurrentEventId();
  if (id) return <EventView id={id} />;

  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-md flex-col justify-center px-6 text-center">
      <div className="text-4xl">🎾</div>
      <h1 className="mt-3 text-xl font-bold">No mixer is up yet</h1>
      <p className="mt-2 text-sm opacity-70">
        {isStoreConfigured()
          ? "When the organiser publishes this week's schedule it will appear right here, on this same link. Nothing to install, and no code to type."
          : "Sharing is not configured on this deployment, so there is nothing to show."}
      </p>
      <p className="mt-6 text-xs opacity-50">
        Have a link to a particular mixer? It looks like{" "}
        <span className="font-mono">/e/ABC234</span> and still works.
      </p>
    </main>
  );
}
