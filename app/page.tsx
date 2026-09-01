"use client";

import { useMemo, useRef, useState } from "react";

import type { RosterRow } from "@/lib/excel";
import {
  DEFAULT_COURT_NAMES,
  FORMATS,
  Format,
  Gender,
  Layout,
  MAX_COURTS,
  MAX_PLAYERS,
  PLAYERS_PER_COURT,
  Player,
  Schedule,
  ScheduleError,
  computeLayout,
  courtName,
  courtSpread,
  drawLabel,
  formatNeedsGender,
  generateSchedule,
  round2,
  teamGap,
  teamLevel,
} from "@/lib/scheduler";

type Row = { name: string; level: string; gender: Gender }; // level as string for editing

function toRows(roster: RosterRow[]): Row[] {
  return roster.map((r) => ({
    name: r.name,
    level: r.level === null ? "" : String(r.level),
    gender: r.gender,
  }));
}

function rowsToPlayers(
  rows: Row[],
  format: Format
): { players?: Player[]; error?: string } {
  const players: Player[] = [];
  const names = new Set<string>();
  const noGender: string[] = [];
  for (const [i, r] of rows.entries()) {
    const name = r.name.trim();
    if (!name) continue; // ignore blank rows
    if (names.has(name.toLowerCase()))
      return { error: `Duplicate player name: "${name}".` };
    names.add(name.toLowerCase());
    const lvl = Number(r.level);
    if (r.level.trim() === "" || !Number.isFinite(lvl))
      return { error: `Row ${i + 1} (${name}) needs a numeric rating.` };
    if (!r.gender) noGender.push(name);
    players.push({ name, level: lvl, gender: r.gender });
  }
  if (players.length < PLAYERS_PER_COURT)
    return { error: `Need at least ${PLAYERS_PER_COURT} rated players.` };
  if (formatNeedsGender(format) && noGender.length) {
    const shown = noGender.slice(0, 6).join(", ");
    const more = noGender.length > 6 ? ` and ${noGender.length - 6} more` : "";
    return {
      error:
        `This format needs every player marked M or F. ` +
        `Missing gender for: ${shown}${more}.`,
    };
  }
  return { players };
}

export default function Home() {
  const [rows, setRows] = useState<Row[]>([]);
  const [fileName, setFileName] = useState<string>("");
  const [numRounds, setNumRounds] = useState(5);
  const [numCourts, setNumCourts] = useState(MAX_COURTS);
  const [format, setFormat] = useState<Format>("open");
  const [courtNames, setCourtNames] = useState<string[]>([...DEFAULT_COURT_NAMES]);
  const [seed, setSeed] = useState("");
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [usedCourtNames, setUsedCourtNames] = useState<string[]>([...DEFAULT_COURT_NAMES]);
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // ---- derived variables ----
  const named = rows.filter((r) => r.name.trim());
  const validCount = named.length;
  const women = named.filter((r) => r.gender === "F").length;
  const men = named.filter((r) => r.gender === "M").length;
  const unspecified = validCount - women - men;
  const missingCount = named.filter(
    (r) => r.level.trim() === "" || !Number.isFinite(Number(r.level))
  ).length;
  const needsGender = formatNeedsGender(format);

  // Preview how the roster maps onto courts under the selected format. This is
  // the same calculation the engine uses, so what's shown here is what you get.
  const preview = useMemo<{ layout?: Layout; problem?: string }>(() => {
    const roster: Player[] = named.map((r) => ({
      name: r.name.trim(),
      level: Number(r.level) || 0,
      gender: r.gender,
    }));
    if (roster.length < PLAYERS_PER_COURT) return {};
    try {
      return { layout: computeLayout(roster, numCourts, format) };
    } catch (e) {
      return { problem: e instanceof Error ? e.message : String(e) };
    }
    // `named` is rebuilt each render; key off the underlying rows instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, numCourts, format]);

  const overCap = validCount > MAX_PLAYERS;
  const layout = preview.layout;
  const courtsInPlay = layout?.courtsUsed ?? 0;
  const byesEach = layout?.byesPerRound ?? 0;

  async function onFile(file: File) {
    setError("");
    setSchedule(null);
    setFileName(file.name);
    try {
      const buf = await file.arrayBuffer();
      const { parseRoster } = await import("@/lib/excel");
      const result = await parseRoster(buf);
      setRows(toRows(result.rows));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
    }
  }

  function updateRow(i: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((prev) => [...prev, { name: "", level: "", gender: "" }]);
  }
  function removeRow(i: number) {
    setRows((prev) => prev.filter((_, j) => j !== i));
  }
  function updateCourtName(i: number, value: string) {
    setCourtNames((prev) => prev.map((n, j) => (j === i ? value : n)));
  }

  async function generate() {
    setError("");
    setSchedule(null);
    const { players, error: verr } = rowsToPlayers(rows, format);
    if (verr || !players) {
      setError(verr ?? "Invalid roster.");
      return;
    }
    setBusy(true);
    await new Promise((r) => setTimeout(r, 30)); // let the spinner paint
    try {
      const seedNum = seed.trim() === "" ? undefined : Number(seed.trim());
      if (seed.trim() !== "" && !Number.isInteger(seedNum)) {
        throw new ScheduleError("Seed must be a whole number.");
      }
      const s = generateSchedule(players, {
        numRounds,
        seed: seedNum,
        numCourts,
        format,
      });
      setSchedule(s);
      setUsedCourtNames([...courtNames]); // freeze names used for this result
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    if (!schedule) return;
    const { buildScheduleWorkbook } = await import("@/lib/excel");
    const buf = await buildScheduleWorkbook(schedule, usedCourtNames);
    const blob = new Blob([buf], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "tennis_schedule.xlsx";
    a.click();
    URL.revokeObjectURL(url);
  }

  const metrics = useMemo(() => {
    if (!schedule) return null;
    const spreads: number[] = [];
    const gaps: number[] = [];
    for (const rnd of schedule.rounds)
      for (const m of rnd.matches) {
        spreads.push(courtSpread(schedule, m));
        gaps.push(teamGap(schedule, m));
      }
    const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    return {
      spread: avg(spreads).toFixed(2),
      gap: avg(gaps).toFixed(2),
      maxSpread: Math.max(...spreads).toFixed(1),
    };
  }, [schedule]);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:py-12">
      <header className="mb-8">
        <h1 className="text-2xl font-bold sm:text-3xl">🎾 Tennis Doubles Mixer Scheduler</h1>
        <p className="mt-2 text-sm opacity-70">
          Upload a roster, set your variables, and generate a balanced doubles schedule:
          similar-level players face off each round, and no two people are ever teammates
          twice. Download the result as Excel.
        </p>
      </header>

      {/* Upload */}
      <section className="mb-6 rounded-xl border border-black/10 p-5 dark:border-white/15">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-semibold">1. Upload roster (.xlsx)</h2>
            <p className="mt-1 text-xs opacity-60">
              Needs a name column (or First/Last name) and a level column (Level, NTRP,
              USDA, or Tournament Rating). A Gender column is used if present.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <input
              ref={fileInput}
              type="file"
              accept=".xlsx"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
            />
            <button
              onClick={() => fileInput.current?.click()}
              className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
            >
              Choose file
            </button>
          </div>
        </div>
        {fileName && (
          <p className="mt-3 text-xs opacity-70">
            Loaded <span className="font-medium">{fileName}</span> - {validCount} players
            {missingCount > 0 && (
              <span className="text-amber-600 dark:text-amber-400">
                {" "}
                ({missingCount} missing a rating - fill them below)
              </span>
            )}
          </p>
        )}
      </section>

      {error && (
        <div className="mb-6 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {error}
        </div>
      )}

      {/* Variables */}
      {rows.length > 0 && (
        <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Stat label="Players" value={String(validCount)} />
          <Stat label="Women" value={String(women)} />
          <Stat label="Men" value={String(men)} />
          <Stat
            label="No gender set"
            value={String(unspecified)}
            muted={!needsGender || unspecified === 0}
            warn={needsGender && unspecified > 0}
          />
          <Stat
            label={
              format === "same" && layout
                ? `Courts (${layout.menCourts}M / ${layout.womenCourts}W)`
                : "Courts in play"
            }
            value={String(courtsInPlay)}
          />
        </section>
      )}

      {/* Roster editor */}
      {rows.length > 0 && (
        <section className="mb-6 rounded-xl border border-black/10 p-5 dark:border-white/15">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">2. Review &amp; edit roster</h2>
            <button onClick={addRow} className="text-sm text-emerald-700 hover:underline dark:text-emerald-400">
              + Add player
            </button>
          </div>
          <div className="max-h-96 overflow-auto rounded-lg border border-black/10 dark:border-white/10">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-black/5 dark:bg-white/10">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">#</th>
                  <th className="px-3 py-2 text-left font-medium">Name</th>
                  <th className="px-3 py-2 text-left font-medium">Rating</th>
                  <th className="px-3 py-2 text-left font-medium">Gender</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const bad = r.name.trim() && (r.level.trim() === "" || !Number.isFinite(Number(r.level)));
                  return (
                    <tr key={i} className={bad ? "bg-amber-50 dark:bg-amber-950/40" : ""}>
                      <td className="px-3 py-1.5 opacity-50">{i + 1}</td>
                      <td className="px-3 py-1.5">
                        <input
                          value={r.name}
                          onChange={(e) => updateRow(i, { name: e.target.value })}
                          className="w-full rounded border border-transparent bg-transparent px-2 py-1 outline-none focus:border-emerald-500"
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <input
                          value={r.level}
                          inputMode="decimal"
                          placeholder={bad ? "needed" : ""}
                          onChange={(e) => updateRow(i, { level: e.target.value })}
                          className={`w-24 rounded border px-2 py-1 outline-none focus:border-emerald-500 ${
                            bad ? "border-amber-400" : "border-black/15 dark:border-white/20"
                          } bg-transparent`}
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <select
                          value={r.gender}
                          onChange={(e) => updateRow(i, { gender: e.target.value as Gender })}
                          className="rounded border border-black/15 bg-transparent px-2 py-1 outline-none focus:border-emerald-500 dark:border-white/20"
                        >
                          <option value="">-</option>
                          <option value="F">F</option>
                          <option value="M">M</option>
                        </select>
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <button
                          onClick={() => removeRow(i)}
                          className="text-xs opacity-50 hover:text-red-600 hover:opacity-100"
                        >
                          remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {overCap && (
            <p className="mt-3 text-xs text-red-600 dark:text-red-400">
              {validCount} players exceeds the {MAX_PLAYERS}-player cap. Remove{" "}
              {validCount - MAX_PLAYERS} to generate a schedule.
            </p>
          )}
          {preview.problem && (
            <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
              {preview.problem}
            </p>
          )}
          {layout && byesEach > 0 && (
            <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
              {validCount} players on {courtsInPlay} court(s) means {byesEach} player(s)
              sit out each round on a fair rotation
              {format !== "open" &&
                ` (${layout.menByes} men, ${layout.womenByes} women)`}
              .
            </p>
          )}
        </section>
      )}

      {/* Settings: courts, court names, rounds, seed */}
      {rows.length > 0 && (
        <section className="mb-6 rounded-xl border border-black/10 p-5 dark:border-white/15">
          <h2 className="mb-4 font-semibold">3. Event settings</h2>

          <div className="mb-5">
            <p className="mb-2 text-sm opacity-70">Tournament format</p>
            <div className="grid gap-2 sm:grid-cols-3">
              {FORMATS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setFormat(f.value)}
                  aria-pressed={format === f.value}
                  className={`rounded-lg border p-3 text-left transition ${
                    format === f.value
                      ? "border-emerald-600 bg-emerald-50 dark:bg-emerald-950/40"
                      : "border-black/15 hover:border-black/30 dark:border-white/20 dark:hover:border-white/40"
                  }`}
                >
                  <span className="block text-sm font-medium">{f.label}</span>
                  <span className="mt-1 block text-xs opacity-60">{f.blurb}</span>
                </button>
              ))}
            </div>
            {needsGender && unspecified > 0 && (
              <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                {unspecified} player(s) still need a gender set in the roster above
                for this format.
              </p>
            )}
          </div>

          <div className="flex flex-wrap gap-6">
            <label className="flex flex-col gap-1 text-sm">
              <span className="opacity-70">Courts</span>
              <select
                value={numCourts}
                onChange={(e) => setNumCourts(Number(e.target.value))}
                className="w-24 rounded-lg border border-black/15 bg-transparent px-3 py-2 dark:border-white/20"
              >
                {Array.from({ length: MAX_COURTS }, (_, i) => i + 1).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="opacity-70">Rounds</span>
              <input
                type="number"
                min={1}
                max={10}
                value={numRounds}
                onChange={(e) => setNumRounds(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
                className="w-24 rounded-lg border border-black/15 bg-transparent px-3 py-2 dark:border-white/20"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="opacity-70">Seed (optional)</span>
              <input
                value={seed}
                onChange={(e) => setSeed(e.target.value)}
                placeholder="random"
                className="w-32 rounded-lg border border-black/15 bg-transparent px-3 py-2 dark:border-white/20"
              />
            </label>
          </div>

          <div className="mt-5">
            <p className="mb-2 text-sm opacity-70">Court names</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {courtNames.slice(0, numCourts).map((name, i) => (
                <label key={i} className="flex items-center gap-2 text-sm">
                  <span className="w-6 shrink-0 text-right opacity-50">{i + 1}</span>
                  <input
                    value={name}
                    onChange={(e) => updateCourtName(i, e.target.value)}
                    className="w-full rounded-lg border border-black/15 bg-transparent px-3 py-2 dark:border-white/20"
                  />
                </label>
              ))}
            </div>
          </div>

          <button
            onClick={generate}
            disabled={busy}
            className="mt-6 rounded-lg bg-emerald-700 px-6 py-3 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
          >
            {busy ? "Optimizing..." : "Generate schedule"}
          </button>
        </section>
      )}

      {/* Results */}
      {schedule && metrics && (
        <section className="rounded-xl border border-black/10 p-5 dark:border-white/15">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-semibold text-emerald-700 dark:text-emerald-400">
                Schedule ready - no repeated partnerships ✓
              </h2>
              <p className="mt-1 text-xs opacity-60">
                {FORMATS.find((f) => f.value === schedule.format)?.label}
                {schedule.format === "same" &&
                  ` - ${schedule.layout.menCourts} men's court(s), ${schedule.layout.womenCourts} women's court(s)`}
              </p>
            </div>
            <button
              onClick={download}
              className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
            >
              ⬇ Download Excel (.xlsx)
            </button>
          </div>

          <div className="mb-6 grid grid-cols-3 gap-3">
            <Stat label="Avg court spread" value={metrics.spread} big />
            <Stat label="Avg team gap" value={metrics.gap} big />
            <Stat label="Widest court" value={metrics.maxSpread} big />
          </div>

          <div className="space-y-6">
            {schedule.rounds.map((rnd) => (
              <div key={rnd.number}>
                <h3 className="mb-2 font-semibold">Round {rnd.number}</h3>
                <div className="overflow-x-auto rounded-lg border border-black/10 dark:border-white/10">
                  <table className="w-full text-sm">
                    <thead className="bg-black/5 dark:bg-white/10">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">Court</th>
                        {schedule.format === "same" && (
                          <th className="px-3 py-2 text-left font-medium">Draw</th>
                        )}
                        <th className="px-3 py-2 text-left font-medium">Team A</th>
                        <th className="px-3 py-2 text-center font-medium">Lvl</th>
                        <th className="px-3 py-2 text-center font-medium"></th>
                        <th className="px-3 py-2 text-left font-medium">Team B</th>
                        <th className="px-3 py-2 text-center font-medium">Lvl</th>
                        <th className="px-3 py-2 text-center font-medium">Spread</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...rnd.matches]
                        .sort((a, b) => a.court - b.court)
                        .map((m) => (
                          <tr key={m.court} className="border-t border-black/5 dark:border-white/5">
                            <td className="px-3 py-2 font-medium">
                              {courtName(m.court, usedCourtNames)}
                            </td>
                            {schedule.format === "same" && (
                              <td className="px-3 py-2">
                                <span
                                  className={`rounded px-2 py-0.5 text-xs font-medium ${
                                    m.group === "M"
                                      ? "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200"
                                      : "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200"
                                  }`}
                                >
                                  {drawLabel(m)}
                                </span>
                              </td>
                            )}
                            <td className="px-3 py-2">
                              {schedule.players[m.teamA[0]].name} &amp; {schedule.players[m.teamA[1]].name}
                            </td>
                            <td className="px-3 py-2 text-center opacity-70">
                              {round2(teamLevel(schedule, m.teamA) / 2)}
                            </td>
                            <td className="px-3 py-2 text-center opacity-40">vs</td>
                            <td className="px-3 py-2">
                              {schedule.players[m.teamB[0]].name} &amp; {schedule.players[m.teamB[1]].name}
                            </td>
                            <td className="px-3 py-2 text-center opacity-70">
                              {round2(teamLevel(schedule, m.teamB) / 2)}
                            </td>
                            <td className="px-3 py-2 text-center opacity-70">
                              {round2(courtSpread(schedule, m))}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
                {rnd.byes.length > 0 && (
                  <p className="mt-1 text-xs opacity-60">
                    Byes:{" "}
                    {rnd.byes
                      .map((i) => {
                        const p = schedule.players[i];
                        return schedule.format === "open" || !p.gender
                          ? p.name
                          : `${p.name} (${p.gender})`;
                      })
                      .join(", ")}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <footer className="mt-10 text-center text-xs opacity-40">
        Doubles mixer - open, mixed, or same-gender - up to {MAX_COURTS} courts,{" "}
        {MAX_COURTS * PLAYERS_PER_COURT} players on court - courts grouped by level,
        unique partners every round.
      </footer>
    </main>
  );
}

function Stat({
  label,
  value,
  big,
  muted,
  warn,
}: {
  label: string;
  value: string;
  big?: boolean;
  muted?: boolean;
  warn?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-3 text-center ${
        warn
          ? "border-amber-400 text-amber-700 dark:text-amber-300"
          : "border-black/10 dark:border-white/10"
      } ${muted ? "opacity-60" : ""}`}
    >
      <div className={big ? "text-2xl font-bold" : "text-xl font-bold"}>{value}</div>
      <div className="mt-1 text-xs opacity-60">{label}</div>
    </div>
  );
}
