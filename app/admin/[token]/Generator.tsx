"use client";

import { useRouter } from "next/navigation";
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
  playerStats,
  round2,
  teamGap,
  teamLevel,
  travelSummary,
  venueOf,
} from "@/lib/scheduler";
import { parseBulkRoster, type Row } from "@/lib/roster";
import { GAMES_PER_MATCH } from "@/lib/scoring";

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

/**
 * The organiser's screen: build a schedule, then publish it to the club link.
 *
 * This was the whole app until v6. It now sits behind the gate in `lib/admin`
 * because publishing moves the link the club opens, and generating a schedule
 * is not something a member should be able to do by accident. Everything up to
 * the publish button still runs entirely in this browser.
 */
export default function Generator({
  /** Where the club link points right now, read on the server. */
  liveId,
}: {
  liveId: string | null;
}) {
  const router = useRouter();
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

  // Roster entry: upload a spreadsheet, or type the registrants in directly.
  // Publishing for score entry. Local until the organiser asks for it: the
  // schedule only leaves the browser when they press the button.
  const [eventId, setEventId] = useState<string>("");
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState("");
  const [live, setLive] = useState<string | null>(liveId);
  const [takingDown, setTakingDown] = useState(false);
  const [copied, setCopied] = useState(false);

  const [source, setSource] = useState<"upload" | "manual" | null>(null);
  const [entry, setEntry] = useState<Row>({ name: "", level: "", gender: "" });
  const [entryMsg, setEntryMsg] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);

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

  const bulkCount = useMemo(() => parseBulkRoster(bulkText).length, [bulkText]);

  // Courts sharing a name stem are treated as one venue, so players can be kept
  // there. "Shorebird 1" and "Shorebird 2" are one venue; "Dolphin 1" is not.
  const venueGroups = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (let i = 0; i < numCourts; i++) {
      const name = courtName(i + 1, courtNames);
      const key = venueOf(name);
      groups.set(key, [...(groups.get(key) ?? []), name]);
    }
    return [...groups.values()];
  }, [courtNames, numCourts]);

  const travel = useMemo(
    () => (schedule ? travelSummary(schedule) : null),
    [schedule]
  );

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

  /** Add the one player currently typed into the quick-add form. */
  function addEntry() {
    const name = entry.name.trim();
    if (!name) {
      setEntryMsg({ kind: "error", text: "Enter a name first." });
      nameInput.current?.focus();
      return;
    }
    if (rows.some((r) => r.name.trim().toLowerCase() === name.toLowerCase())) {
      setEntryMsg({ kind: "error", text: `"${name}" is already on the roster.` });
      return;
    }
    if (entry.level.trim() !== "" && !Number.isFinite(Number(entry.level))) {
      setEntryMsg({ kind: "error", text: "Rating must be a number, e.g. 3.5." });
      return;
    }
    setError("");
    setSchedule(null);
    setRows((prev) => [...prev, { name, level: entry.level.trim(), gender: entry.gender }]);
    setEntry({ name: "", level: "", gender: "" });
    setEntryMsg({ kind: "info", text: `Added ${name}.` });
    nameInput.current?.focus();
  }

  /** Add everyone in the paste box, skipping names already on the roster. */
  function applyBulk() {
    const parsed = parseBulkRoster(bulkText);
    if (!parsed.length) {
      setEntryMsg({ kind: "error", text: "Nothing to add - put one player per line." });
      return;
    }
    const seen = new Set(rows.map((r) => r.name.trim().toLowerCase()));
    const fresh: Row[] = [];
    let skipped = 0;
    for (const p of parsed) {
      const key = p.name.toLowerCase();
      if (seen.has(key)) {
        skipped += 1;
        continue;
      }
      seen.add(key);
      fresh.push(p);
    }
    setError("");
    setSchedule(null);
    setRows((prev) => [...prev, ...fresh]);
    setBulkText("");
    setEntryMsg({
      kind: skipped ? "error" : "info",
      text:
        `Added ${fresh.length} player(s)` +
        (skipped ? `; skipped ${skipped} already on the roster.` : "."),
    });
  }

  function clearRoster() {
    setRows([]);
    setSchedule(null);
    setError("");
    setEntryMsg(null);
    setFileName("");
  }

  function chooseSource(next: "upload" | "manual") {
    setSource(next);
    setError("");
    setEntryMsg(null);
  }

  async function generate() {
    setError("");
    setSchedule(null);
    // A new schedule is a different event; the old code no longer describes it.
    setEventId("");
    setPublishError("");
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
        courtNames, // decides which courts share a venue
      });
      setSchedule(s);
      setUsedCourtNames([...courtNames]); // freeze names used for this result
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Send the schedule to the server so phones can score it. This is the only
   * point at which anything leaves the browser, and it is always a deliberate
   * press: generating and downloading a schedule stays entirely local.
   */
  async function publish() {
    if (!schedule || publishing) return;
    setPublishing(true);
    setPublishError("");
    try {
      const res = await fetch("/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schedule,
          courtNames: usedCourtNames,
          title: fileName ? fileName.replace(/\.xlsx?$/i, "") : "Tennis mixer",
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Could not publish the event.");
      setEventId(body.id);
      // Publishing moved the club link server-side; mirror that here so the
      // banner and the take-down button agree with what members will see.
      if (body.current !== false) setLive(body.id);
    } catch (e) {
      setPublishError(e instanceof Error ? e.message : String(e));
    } finally {
      setPublishing(false);
    }
  }

  // The link handed to the club is the bare root URL, which publishing points
  // at this event. It never changes week to week, so it can live in the group
  // chat permanently. The per-event link below it is the permanent record of
  // this one day, useful for looking a mixer up again later.
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const clubUrl = origin || "https://rstc-tennis-sch.vercel.app";
  const eventUrl = eventId ? `${clubUrl}/e/${eventId}` : "";

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(clubUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked; the link is on screen to copy by hand.
    }
  }

  /** Take the club link down, so the root page stops showing this mixer. */
  async function takeDown() {
    if (takingDown) return;
    setTakingDown(true);
    setPublishError("");
    try {
      const res = await fetch("/api/admin/current", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: null }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Could not take the link down.");
      setLive(null);
    } catch (e) {
      setPublishError(e instanceof Error ? e.message : String(e));
    } finally {
      setTakingDown(false);
    }
  }

  async function signOut() {
    await fetch("/api/admin/lock", { method: "POST" }).catch(() => {});
    router.push("/");
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
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
              Organiser
            </p>
            <h1 className="text-2xl font-bold sm:text-3xl">
              🎾 Tennis Doubles Mixer Scheduler
            </h1>
          </div>
          <button
            onClick={signOut}
            className="rounded-lg border border-black/15 px-3 py-1.5 text-xs hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
          >
            Sign out of this device
          </button>
        </div>
        <p className="mt-2 text-sm opacity-70">
          Enter your registrants (or upload a roster), set your variables, and generate a
          balanced doubles schedule:
          similar-level players face off each round, and no two people are ever teammates
          twice. Download the result as Excel.
        </p>

        {/* What members see right now, so nobody publishes over a live mixer
            without noticing, and so an old one can be taken down. */}
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-black/[0.04] px-3 py-2 text-xs dark:bg-white/[0.06]">
          {live ? (
            <>
              <span className="inline-flex items-center gap-1.5 font-medium">
                <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
                Live on the club link
              </span>
              <span className="font-mono font-semibold tracking-widest">{live}</span>
              <a href="/" target="_blank" rel="noreferrer" className="underline opacity-70 hover:opacity-100">
                open it ↗
              </a>
              <button
                onClick={takeDown}
                disabled={takingDown}
                className="underline opacity-50 hover:opacity-100 disabled:opacity-30"
              >
                {takingDown ? "taking it down…" : "take it down"}
              </button>
            </>
          ) : (
            <span className="inline-flex items-center gap-1.5 opacity-70">
              <span className="inline-block h-2 w-2 rounded-full bg-black/25 dark:bg-white/30" />
              Nothing is on the club link. Members see an empty page until you publish.
            </span>
          )}
        </div>
      </header>

      {/* Roster source: upload a file, or type players in */}
      <section className="mb-6 rounded-xl border border-black/10 p-5 dark:border-white/15">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="font-semibold">1. Build your roster</h2>
            <p className="mt-1 text-xs opacity-60">
              Upload a spreadsheet, or type the registrants straight into the browser.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <ModeButton active={source === "upload"} onClick={() => chooseSource("upload")}>
              Upload Excel
            </ModeButton>
            <ModeButton active={source === "manual"} onClick={() => chooseSource("manual")}>
              Enter manually
            </ModeButton>
          </div>
        </div>

        {source === null && (
          <p className="text-sm opacity-60">
            Pick one to get started. You can mix the two: upload a file and still add
            walk-ups by hand, or the other way round.
          </p>
        )}

        {source === "upload" && (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs opacity-60">
              Needs a name column (or First/Last name) and a level column (Level, NTRP,
              USDA, or Tournament Rating). A Gender column is used if present.
            </p>
            <div className="flex shrink-0 items-center gap-3">
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
        )}

        {source === "upload" && fileName && (
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

        {source === "manual" && (
          <div>
            <div className="grid gap-3 sm:grid-cols-[1fr_7rem_6rem_auto]">
              <label className="flex flex-col gap-1 text-sm">
                <span className="opacity-70">Name</span>
                <input
                  ref={nameInput}
                  value={entry.name}
                  onChange={(e) => setEntry({ ...entry, name: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && addEntry()}
                  placeholder="Jane Doe"
                  className="rounded-lg border border-black/15 bg-transparent px-3 py-2 outline-none focus:border-emerald-500 dark:border-white/20"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="opacity-70">Rating</span>
                <input
                  value={entry.level}
                  inputMode="decimal"
                  onChange={(e) => setEntry({ ...entry, level: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && addEntry()}
                  placeholder="3.5"
                  className="rounded-lg border border-black/15 bg-transparent px-3 py-2 outline-none focus:border-emerald-500 dark:border-white/20"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="opacity-70">Gender</span>
                <select
                  value={entry.gender}
                  onChange={(e) => setEntry({ ...entry, gender: e.target.value as Gender })}
                  className="rounded-lg border border-black/15 bg-transparent px-3 py-2 outline-none focus:border-emerald-500 dark:border-white/20"
                >
                  <option value="">-</option>
                  <option value="F">F</option>
                  <option value="M">M</option>
                </select>
              </label>
              <div className="flex items-end">
                <button
                  onClick={addEntry}
                  className="w-full rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 sm:w-auto"
                >
                  Add player
                </button>
              </div>
            </div>
            <p className="mt-2 text-xs opacity-50">
              Press Enter to add and keep typing. The rating can be left blank now and
              filled in from the table below.
            </p>

            <div className="mt-4 border-t border-black/10 pt-4 dark:border-white/10">
              <button
                type="button"
                onClick={() => setBulkOpen(!bulkOpen)}
                className="text-sm text-emerald-700 hover:underline dark:text-emerald-400"
              >
                {bulkOpen ? "- Hide the paste box" : "+ Paste a whole list at once"}
              </button>
              {bulkOpen && (
                <div className="mt-3">
                  <textarea
                    value={bulkText}
                    onChange={(e) => setBulkText(e.target.value)}
                    rows={6}
                    placeholder={"Jane Doe, 3.5, F\nJohn Smith, 4.0, M\nPat Lee 3.0 F"}
                    className="w-full rounded-lg border border-black/15 bg-transparent px-3 py-2 font-mono text-xs outline-none focus:border-emerald-500 dark:border-white/20"
                  />
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <button
                      onClick={applyBulk}
                      disabled={bulkCount === 0}
                      className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-40"
                    >
                      Add {bulkCount} player{bulkCount === 1 ? "" : "s"}
                    </button>
                    <p className="text-xs opacity-50">
                      One player per line: name, rating, gender. Commas optional; rating
                      and gender may be left off.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {source !== null && entryMsg && (
          <p
            className={`mt-3 text-xs ${
              entryMsg.kind === "error"
                ? "text-amber-600 dark:text-amber-400"
                : "text-emerald-700 dark:text-emerald-400"
            }`}
          >
            {entryMsg.text}
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
            <div className="flex items-center gap-4">
              <button onClick={addRow} className="text-sm text-emerald-700 hover:underline dark:text-emerald-400">
                + Add blank row
              </button>
              <button onClick={clearRoster} className="text-sm opacity-50 hover:text-red-600 hover:opacity-100">
                Clear roster
              </button>
            </div>
          </div>
          <div className="max-h-96 overflow-auto rounded-lg border border-black/10 dark:border-white/10">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-neutral-100 dark:bg-neutral-800">
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
            <p className="mt-2 text-xs opacity-60">
              {venueGroups.length > 1 ? (
                <>
                  Read as {venueGroups.length} venues:{" "}
                  {venueGroups.map((g) => g.join(" + ")).join(", ")}. Courts that share
                  a name are treated as walkable; the schedule keeps players at one
                  venue as much as it can without changing who they play.
                </>
              ) : (
                <>
                  All {numCourts} courts read as one venue, so only court changes are
                  minimised. Give courts names like &quot;Shorebird 1&quot; and
                  &quot;Dolphin 1&quot; if they are far apart.
                </>
              )}
            </p>
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

          {/* Publishing is opt-in, and the only thing that ever sends the
              schedule off this device. It also points the club link here, so
              members open one URL and find whatever was published last. */}
          <div className="mb-6 rounded-xl border border-emerald-700/30 bg-emerald-50/50 p-4 dark:bg-emerald-950/20">
            {!eventId ? (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 className="text-sm font-semibold">Publish it to the club</h3>
                  <p className="mt-1 text-xs opacity-70">
                    Publishing puts this schedule on the club link, where members can see
                    their courts, enter their scores and watch the leaderboard. Each match
                    is {GAMES_PER_MATCH} games.
                    {live && (
                      <>
                        {" "}
                        It will replace <span className="font-mono">{live}</span>, which is
                        on the link now.
                      </>
                    )}
                  </p>
                </div>
                <button
                  onClick={publish}
                  disabled={publishing}
                  className="shrink-0 rounded-lg border border-emerald-700 px-4 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-700 hover:text-white disabled:opacity-50 dark:text-emerald-300"
                >
                  {publishing ? "Publishing…" : "Publish to the club link"}
                </button>
              </div>
            ) : (
              <div>
                <h3 className="text-sm font-semibold">It&apos;s live</h3>
                <p className="mt-1 text-xs opacity-70">
                  Share this one link with the club. It is the same every week, so it can
                  stay in the group chat: whoever opens it gets whatever you published last.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <a
                    href="/"
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-800"
                  >
                    Open the club page ↗
                  </a>
                  <button
                    onClick={copyLink}
                    className="rounded-lg border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
                  >
                    {copied ? "Copied ✓" : "Copy the club link"}
                  </button>
                  <code className="rounded bg-black/5 px-2 py-1.5 text-xs dark:bg-white/10">
                    {clubUrl}
                  </code>
                </div>
                <p className="mt-3 text-xs opacity-60">
                  This mixer is also kept at its own permanent address, worth saving if you
                  want to look it up again after next week&apos;s replaces it:{" "}
                  <a href={eventUrl} target="_blank" rel="noreferrer" className="underline">
                    {eventUrl}
                  </a>{" "}
                  (code <span className="font-mono font-semibold tracking-widest">{eventId}</span>)
                </p>
                <p className="mt-2 text-xs opacity-60">
                  Download the Excel from the club page once scores are in, and it will carry
                  the results and the leaderboard alongside the schedule.
                </p>
              </div>
            )}
            {publishError && (
              <p className="mt-3 rounded-lg bg-red-50 p-3 text-xs text-red-800 dark:bg-red-950/40 dark:text-red-200">
                {publishError}
              </p>
            )}
          </div>

          <div className="mb-3 grid grid-cols-3 gap-3">
            <Stat label="Avg court spread" value={metrics.spread} big />
            <Stat label="Avg team gap" value={metrics.gap} big />
            <Stat label="Widest court" value={metrics.maxSpread} big />
          </div>

          {travel && (
            <div className="mb-6">
              <div className="grid grid-cols-3 gap-3">
                <Stat
                  label="Stay on the same court"
                  value={`${Math.round((100 * travel.stays) / Math.max(1, travel.transitions))}%`}
                  big
                />
                <Stat label="Venue changes, all players" value={String(travel.drives)} big />
                <Stat
                  label="Never change venue"
                  value={`${travel.neverDrive}/${schedule.players.length}`}
                  big
                />
              </div>
              <p className="mt-2 text-xs opacity-60">
                Of {travel.transitions} moves between matches, {travel.stays} keep the
                player on the same court, {travel.walks} are a walk to the other court
                at the same venue and {travel.drives} cross venues. Court assignment
                does not affect who plays whom, so this costs nothing in match quality.
              </p>
            </div>
          )}

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
          <details className="mt-8 rounded-lg border border-black/10 p-4 dark:border-white/10">
            <summary className="cursor-pointer text-sm font-medium">
              Where each player goes
            </summary>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-black/5 dark:bg-white/10">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Player</th>
                    {schedule.rounds.map((r) => (
                      <th key={r.number} className="px-3 py-2 text-left font-medium">
                        R{r.number}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {playerStats(schedule)
                    .slice()
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((st) => {
                      const trail = st.courtsByRound;
                      return (
                        <tr key={st.name} className="border-t border-black/5 dark:border-white/5">
                          <td className="px-3 py-1.5 font-medium">{st.name}</td>
                          {trail.map((c, i) => {
                            const prev = trail.slice(0, i).filter((x) => x !== null).pop();
                            const same = c !== null && c === prev;
                            return (
                              <td
                                key={i}
                                className={`px-3 py-1.5 ${
                                  c === null
                                    ? "opacity-40"
                                    : same
                                      ? "opacity-60"
                                      : "font-medium"
                                }`}
                              >
                                {c === null ? "bye" : courtName(c, usedCourtNames)}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs opacity-50">
              Bold marks a court change from the player&apos;s previous match. The same
              table is in the Excel download, on the By Player sheet.
            </p>
          </details>
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

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-lg border px-4 py-2 text-sm font-medium transition ${
        active
          ? "border-emerald-600 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300"
          : "border-black/15 hover:border-black/30 dark:border-white/20 dark:hover:border-white/40"
      }`}
    >
      {children}
    </button>
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
