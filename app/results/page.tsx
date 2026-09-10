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
 *
 * One table at every width rather than a table on a laptop and cards on a
 * phone. Six columns will not fit a phone, so the ones that are context rather
 * than answer - format, roster size - fold underneath the mixer name below
 * `sm`, and the table keeps its shape instead of turning into a different
 * component that has to be kept in step with this one.
 */
import Link from "next/link";

import {
  bySeason,
  formatLabel,
  type ArchiveEntry,
  type Standing,
} from "@/lib/archive";
import type { Format } from "@/lib/scheduler";
import { getArchive, isStoreConfigured } from "@/lib/store";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Tournament results · RSTC Tennis Mixer",
  description: "Final leaderboards from every RSTC mixer.",
};

/**
 * A colour per format, so the column can be read at a glance rather than word
 * by word. Three fixed values and never a computed Tailwind class name, which
 * would be stripped at build time.
 */
const FORMAT_STYLES: Record<Format, string> = {
  open: "bg-sky-100 text-sky-800 ring-sky-600/20 dark:bg-sky-500/15 dark:text-sky-300 dark:ring-sky-400/30",
  mixed:
    "bg-violet-100 text-violet-800 ring-violet-600/20 dark:bg-violet-500/15 dark:text-violet-300 dark:ring-violet-400/30",
  same: "bg-amber-100 text-amber-900 ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-400/30",
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
    <main className={`mx-auto w-full max-w-5xl p-4 sm:p-6 ${bare ? "" : "pb-16"}`}>
      {!bare && (
        <header className="mb-6">
          <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">
            Tournament{" "}
            <span className="bg-gradient-to-r from-emerald-600 to-teal-500 bg-clip-text text-transparent dark:from-emerald-400 dark:to-teal-300">
              results
            </span>
          </h1>
          <p className="mt-2 text-sm opacity-70">
            Final leaderboards from every mixer we have played. Open one to see the full
            standings, overall and by gender.
          </p>

          {/* Above the table on purpose: a member who lands here on a Saturday
              morning wants today's draw, not last month's winner. */}
          <Link
            href="/"
            className="mt-4 inline-flex items-center gap-2 rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-500"
          >
            🎾 Today&rsquo;s mixer
          </Link>
        </header>
      )}

      <h2 className="mb-3 text-lg font-bold tracking-tight">Past tournaments</h2>

      {archive.length === 0 ? (
        <p className="rounded-xl border border-dashed border-black/15 p-8 text-center text-sm opacity-60 dark:border-white/20">
          {isStoreConfigured()
            ? "No tournaments have been archived yet. They appear here once the organiser closes one out."
            : "Sharing is not configured on this deployment, so there is nothing to show."}
        </p>
      ) : (
        seasons.map(({ year, entries }) => (
          <section key={year} className="mb-8">
            {/* The year only earns a heading once there is more than one. */}
            {seasons.length > 1 && (
              <h2 className="mb-2 flex items-center gap-3 text-sm font-bold tracking-widest text-emerald-700 dark:text-emerald-400">
                {year}
                <span className="h-px flex-1 bg-gradient-to-r from-emerald-600/40 to-transparent" />
              </h2>
            )}
            <ResultsTable entries={entries} />
          </section>
        ))
      )}

      {!bare && (
        <footer className="mt-8 border-t border-black/10 pt-4 text-xs opacity-60 dark:border-white/15">
          Every match is scored out of 8 games, and players are ranked on total games won.
        </footer>
      )}
    </main>
  );
}

function ResultsTable({ entries }: { entries: ArchiveEntry[] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-black/10 shadow-sm dark:border-white/15">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-gradient-to-r from-emerald-700 to-teal-600 text-left text-xs font-semibold uppercase tracking-wider text-white">
              <th className="w-px px-3 py-3 whitespace-nowrap">Date</th>
              <th className="px-3 py-3">Mixer</th>
              <th className="hidden w-px px-3 py-3 whitespace-nowrap sm:table-cell">Format</th>
              <th className="px-3 py-3">Top 3 men</th>
              <th className="px-3 py-3">Top 3 women</th>
              <th className="w-px px-3 py-3" />
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr
                key={e.id}
                // Zebra striping does the work of row borders, and survives the
                // wrapping that the winner column does on a narrow screen.
                className={`transition-colors hover:bg-emerald-50 dark:hover:bg-emerald-500/10 ${
                  i % 2 ? "bg-black/[0.03] dark:bg-white/[0.04]" : ""
                }`}
              >
                <td className="px-3 py-3 align-top font-semibold whitespace-nowrap tabular-nums">
                  {longDate(e.date)}
                </td>
                <td className="px-3 py-3 align-top">
                  <span className="font-medium">
                    {e.title || <span className="opacity-40">Club mixer</span>}
                  </span>
                  {/* The format badge folds in here only on a phone, where it
                      has no column of its own; the roster size folds in at
                      every width, having given its column to the podiums. */}
                  <span className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span className="sm:hidden">
                      <FormatBadge format={e.format} />
                    </span>
                    <span className="text-xs opacity-60">
                      {e.players} players · {e.rounds} rounds
                    </span>
                  </span>
                  {!e.complete && (
                    <span
                      className="mt-1 block text-xs opacity-50"
                      title={`${e.entered} of ${e.total} matches scored`}
                    >
                      {e.entered} of {e.total} matches scored
                    </span>
                  )}
                </td>
                <td className="hidden px-3 py-3 align-top sm:table-cell">
                  <FormatBadge format={e.format} />
                </td>
                {e.podium ? (
                  <>
                    <td className="px-3 py-3 align-top">
                      <Podium places={e.podium.men} />
                    </td>
                    <td className="px-3 py-3 align-top">
                      <Podium places={e.podium.women} />
                    </td>
                  </>
                ) : (
                  <td className="px-3 py-3 align-top" colSpan={2}>
                    <LegacyResult entry={e} />
                  </td>
                )}
                <td className="px-3 py-3 text-right align-top whitespace-nowrap">
                  <Link
                    href={`/e/${e.id}?tab=board`}
                    className="inline-block rounded-lg border border-emerald-600/40 px-2.5 py-1 text-xs font-semibold text-emerald-800 transition hover:bg-emerald-700 hover:text-white dark:text-emerald-300 dark:hover:bg-emerald-600 dark:hover:text-white"
                  >
                    Leaderboard →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FormatBadge({ format }: { format: Format }) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap ${FORMAT_STYLES[format] ?? FORMAT_STYLES.open}`}
    >
      {formatLabel(format)}
    </span>
  );
}

/** Gold, silver, bronze. Anything past third shares bronze's treatment. */
const PLACE_STYLES = [
  "bg-amber-200 text-amber-900 dark:bg-amber-400/25 dark:text-amber-200",
  "bg-slate-200 text-slate-700 dark:bg-slate-400/25 dark:text-slate-200",
  "bg-orange-200/70 text-orange-900 dark:bg-orange-400/20 dark:text-orange-200",
];

/**
 * The top three of one draw, which is how the club has always read a result.
 *
 * A tournament can be archived with matches unscored - somebody forgets to
 * enter a court and the organiser closes it out anyway - so a placing is only
 * shown once there is something to place on, and the row says how much is
 * missing under the mixer name.
 *
 */
function Podium({ places }: { places: Standing[] }) {
  if (places.length === 0) {
    return <span className="text-xs opacity-40">&mdash;</span>;
  }
  return (
    <ol className="space-y-1">
      {places.map((p, i) => (
        <li key={`${p.rank}-${p.name}`} className="flex items-baseline gap-2 whitespace-nowrap">
          <span
            className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold tabular-nums ${
              PLACE_STYLES[Math.min(p.rank, 3) - 1] ?? PLACE_STYLES[2]
            }`}
          >
            {p.rank}
          </span>
          <span className={i === 0 ? "font-semibold" : ""}>{p.name}</span>
          <span className="ml-auto pl-2 text-xs opacity-60 tabular-nums">{p.games}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * A row filed before v8.1, which recorded only the overall winner.
 *
 * One fact, so one cell across both podium columns rather than the same
 * sentence printed twice. Re-archiving the tournament fills the podiums in.
 */
function LegacyResult({ entry }: { entry: ArchiveEntry }) {
  if (entry.champions.length === 0) {
    return <span className="text-xs opacity-40">Not scored</span>;
  }
  return (
    <span className="text-xs opacity-60">
      Top three not recorded &middot; overall winner{" "}
      <span className="font-semibold opacity-100">{entry.champions.join(", ")}</span>
    </span>
  );
}

/**
 * "Sat, Sep 5, 2026" from "2026-09-05".
 *
 * Parsed as UTC and rendered as UTC. The string is a calendar date with no
 * timezone of its own, and letting the server's zone shift it would print the
 * day before to anyone west of London.
 */
function longDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
