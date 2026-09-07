/**
 * /results - every finished tournament, with a link into each leaderboard.
 *
 * This is the page the club points its members' area at. It is deliberately a
 * server component with no polling and no client JavaScript: the archive only
 * changes when an organiser files a tournament, so making members' phones ask
 * about it every ten seconds would repeat the mistake that cost us the Blob
 * store. One `HGETALL` per view, rendered on the server.
 *
 * `?embed=1` drops the heading and the footer for iframing into a page that
 * already has its own. Nothing else changes, so the same URL works either way.
 */
import Link from "next/link";

import { bySeason, formatLabel, type ArchiveEntry } from "@/lib/archive";
import { getArchive, isStoreConfigured } from "@/lib/store";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Tournament results · RSTC Tennis Mixer",
  description: "Final leaderboards from every RSTC mixer.",
};

export default async function ResultsPage({
  searchParams,
}: {
  searchParams: Promise<{ embed?: string }>;
}) {
  const { embed } = await searchParams;
  const bare = embed === "1";
  const archive = await getArchive();
  const seasons = bySeason(archive);

  return (
    <main className={`mx-auto w-full max-w-3xl p-4 sm:p-6 ${bare ? "" : "pb-16"}`}>
      {!bare && (
        <header className="mb-5">
          <h1 className="text-xl font-bold">Tournament results</h1>
          <p className="mt-1 text-sm opacity-70">
            Final leaderboards from every mixer we have played. Open one to see the full
            standings, overall and by gender.
          </p>
        </header>
      )}

      {archive.length === 0 ? (
        <p className="rounded-lg border border-dashed border-black/15 p-6 text-center text-sm opacity-60 dark:border-white/20">
          {isStoreConfigured()
            ? "No tournaments have been archived yet. They appear here once the organiser closes one out."
            : "Sharing is not configured on this deployment, so there is nothing to show."}
        </p>
      ) : (
        seasons.map(({ year, entries }) => (
          <section key={year} className="mb-8">
            {/* The year only earns a heading once there is more than one. */}
            {seasons.length > 1 && (
              <h2 className="mb-2 text-sm font-semibold tracking-wide opacity-60">{year}</h2>
            )}
            <ResultsTable entries={entries} />
          </section>
        ))
      )}

      {!bare && (
        <footer className="mt-8 border-t border-black/10 pt-4 text-xs opacity-60 dark:border-white/15">
          <Link href="/" className="underline underline-offset-2">
            Today&rsquo;s mixer
          </Link>{" "}
          · Every match is scored out of 8 games, and players are ranked on total games won.
        </footer>
      )}
    </main>
  );
}

/**
 * The archive as a table on a laptop and as cards on a phone.
 *
 * Two renderings of the same rows rather than one that scrolls sideways: this
 * page is opened from the club&rsquo;s website on whatever device is to hand, and a
 * six-column table on a phone is unreadable however carefully it is squeezed.
 */
function ResultsTable({ entries }: { entries: ArchiveEntry[] }) {
  return (
    <>
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-black/15 text-left text-xs uppercase tracking-wide opacity-60 dark:border-white/20">
              <th className="py-2 pr-3 font-medium">Date</th>
              <th className="py-2 pr-3 font-medium">Mixer</th>
              <th className="py-2 pr-3 font-medium">Format</th>
              <th className="py-2 pr-3 text-right font-medium">Players</th>
              <th className="py-2 pr-3 font-medium">Winner</th>
              <th className="py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr
                key={e.id}
                className="border-b border-black/5 last:border-0 dark:border-white/10"
              >
                <td className="py-2.5 pr-3 whitespace-nowrap tabular-nums">
                  {longDate(e.date)}
                </td>
                <td className="py-2.5 pr-3">{e.title || <span className="opacity-50">—</span>}</td>
                <td className="py-2.5 pr-3">{formatLabel(e.format)}</td>
                <td className="py-2.5 pr-3 text-right tabular-nums">{e.players}</td>
                <td className="py-2.5 pr-3">
                  <Champion entry={e} />
                </td>
                <td className="py-2.5 text-right whitespace-nowrap">
                  <BoardLink id={e.id} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="space-y-3 sm:hidden">
        {entries.map((e) => (
          <li
            key={e.id}
            className="rounded-xl border border-black/10 p-3 dark:border-white/15"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-semibold tabular-nums">{longDate(e.date)}</span>
              <BoardLink id={e.id} />
            </div>
            <p className="mt-0.5 text-sm">{e.title}</p>
            <p className="mt-1 text-xs opacity-70">
              {formatLabel(e.format)} · {e.players} players · {e.rounds} rounds
            </p>
            <p className="mt-1 text-xs">
              <span className="opacity-60">Winner: </span>
              <Champion entry={e} />
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}

function BoardLink({ id }: { id: string }) {
  return (
    <Link
      href={`/e/${id}?tab=board`}
      className="rounded-lg border border-black/15 px-2.5 py-1 text-xs font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
    >
      Leaderboard →
    </Link>
  );
}

/**
 * Who won, and an honest note when that is not yet settled.
 *
 * A tournament can be archived with matches still unscored - somebody forgets
 * to enter a court and the organiser closes it out anyway - and quietly naming
 * a winner off a partial table would be wrong.
 */
function Champion({ entry }: { entry: ArchiveEntry }) {
  if (entry.champions.length === 0) {
    return <span className="opacity-50">Not scored</span>;
  }
  return (
    <>
      <span className="font-medium">{entry.champions.join(", ")}</span>{" "}
      <span className="opacity-60 tabular-nums">{entry.championGames} games</span>
      {!entry.complete && (
        <span className="ml-1 opacity-50" title={`${entry.entered} of ${entry.total} matches scored`}>
          (partial)
        </span>
      )}
    </>
  );
}

/**
 * "Sat 5 Sep 2026" from "2026-09-05".
 *
 * Parsed as UTC and rendered as UTC. The string is a calendar date with no
 * timezone of its own, and letting the server's zone shift it would print the
 * day before to anyone west of London.
 */
function longDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
