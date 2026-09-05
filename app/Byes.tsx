"use client";

/**
 * Who is sitting out a round.
 *
 * This used to be a grey one-line footnote under each round, and on the day it
 * was the line people missed: a player who is not on any court has nothing else
 * on the page telling them so, and the organiser reading names out needs it as
 * much as the court assignments. So it gets its own block, with the same weight
 * as a match card but a dashed edge, because nobody is playing in it.
 *
 * Shared by the organiser's page and the members' page. The two want slightly
 * different things from it - the organiser needs the M/F marks that explain why
 * a gendered format benched who it did, a member needs their own name to jump
 * out - so both are options rather than two near-identical copies that drift.
 */
import { type Schedule } from "@/lib/scheduler";

export default function Byes({
  schedule: s,
  byes,
  /** Highlight this player, when a member has picked their name. */
  meIndex = -1,
  /** Mark M/F, which is what makes a gendered format's byes make sense. */
  showGender = false,
}: {
  schedule: Schedule;
  byes: number[];
  meIndex?: number;
  showGender?: boolean;
}) {
  if (!byes.length) return null;

  // In the gendered formats byes rotate within each gender's own pool, so the
  // split is the number that explains the round, not the total.
  const men = byes.filter((i) => s.players[i].gender === "M").length;
  const women = byes.filter((i) => s.players[i].gender === "F").length;
  const split =
    showGender && s.format !== "open" && men + women === byes.length
      ? ` · ${men} men, ${women} women`
      : "";

  return (
    <div className="mt-3 rounded-xl border border-dashed border-black/20 bg-black/[0.03] px-3 py-2.5 dark:border-white/25 dark:bg-white/[0.04]">
      <p className="text-xs font-semibold uppercase tracking-wide opacity-55">
        Sitting out this round · {byes.length}
        {split}
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {byes.map((i) => {
          const p = s.players[i];
          const mine = i === meIndex;
          return (
            <span
              key={i}
              className={`rounded-md px-2 py-1 text-xs ${
                mine
                  ? "bg-emerald-600/20 font-semibold"
                  : "bg-black/[0.06] dark:bg-white/10"
              }`}
            >
              {p.name}
              {showGender && p.gender && s.format !== "open" && (
                <span className="ml-1 opacity-50">{p.gender}</span>
              )}
              {mine && <span className="ml-1 opacity-60">← you</span>}
            </span>
          );
        })}
      </div>
    </div>
  );
}
