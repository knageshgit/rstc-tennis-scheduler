// Round-trip the Excel export for every tournament format and re-read the
// result to confirm the sheets are shaped correctly.
// Run: npx tsx scripts/verify_excel.mts
import ExcelJS from "exceljs";
import { buildScheduleWorkbook } from "../lib/excel.ts";
import { generateSchedule, type Format, type Player } from "../lib/scheduler.ts";
import {
  GAMES_PER_MATCH,
  leaderboards,
  matchKey,
  type Scores,
} from "../lib/scoring.ts";

const LEVELS = [2.5, 3.0, 3.5, 4.0, 4.5];
function makeRoster(men: number, women: number, seed = 3): Player[] {
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const out: Player[] = [];
  for (let i = 0; i < men; i++)
    out.push({ name: `Man ${i + 1}`, level: LEVELS[Math.floor(rand() * LEVELS.length)], gender: "M" });
  for (let i = 0; i < women; i++)
    out.push({ name: `Woman ${i + 1}`, level: LEVELS[Math.floor(rand() * LEVELS.length)], gender: "F" });
  return out;
}

const COURT_NAMES = ["Shorebird 1", "Shorebird 2", "Dolphin 1", "Dolphin 2", "Preserve 1", "Preserve 2"];
let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) {
    failures += 1;
    console.error(`   FAIL: ${msg}`);
  }
};

for (const format of ["open", "mixed", "same"] as Format[]) {
  const players = makeRoster(13, 12);
  const s = generateSchedule(players, { numRounds: 5, seed: 99, numCourts: 6, format });
  const buf = await buildScheduleWorkbook(s, COURT_NAMES);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet("Schedule");
  const ps = wb.getWorksheet("By Player");
  check(!!ws, `${format}: no Schedule sheet`);
  check(!!ps, `${format}: no By Player sheet`);
  if (!ws || !ps) continue;

  const text = (r: number, c: number) => String(ws.getRow(r).getCell(c).value ?? "");
  const allText: string[] = [];
  ws.eachRow((row) => row.eachCell((cell) => allText.push(String(cell.value ?? ""))));

  // banner + per-round headers
  check(text(1, 1).includes("rounds"), `${format}: missing title row`);
  // Banner cells are merged, and ExcelJS reports the value in every cell of the
  // merge range, so count distinct banners rather than cells.
  const roundBanners = new Set(allText.filter((t) => t.startsWith("ROUND "))).size;
  check(roundBanners === 5, `${format}: found ${roundBanners} round banners, expected 5`);

  // every court name that played should appear
  const courtsUsed = s.layout.courtsUsed;
  for (let c = 1; c <= courtsUsed; c++) {
    check(allText.includes(COURT_NAMES[c - 1]), `${format}: court "${COURT_NAMES[c - 1]}" missing`);
  }

  // Draw column only in same-gender play
  const hasDraw = allText.includes("Draw");
  check(hasDraw === (format === "same"), `${format}: Draw column presence wrong`);
  if (format === "same") {
    check(allText.includes("Men") && allText.includes("Women"), `${format}: draw labels missing`);
  }

  // every match row carries both team strings
  const teamCells = allText.filter((t) => t.includes(" & ") && !t.startsWith("Byes")).length;
  const expectedTeams = s.rounds.reduce((n, r) => n + r.matches.length * 2, 0);
  check(teamCells === expectedTeams, `${format}: ${teamCells} team cells, expected ${expectedTeams}`);

  // By Player sheet has one row per player plus a header
  check(ps.rowCount === players.length + 1, `${format}: By Player has ${ps.rowCount} rows`);

  const bytes = (buf as ArrayBuffer).byteLength;
  console.log(
    `ok  ${format.padEnd(5)} -> ${(bytes / 1024).toFixed(1)} KB, ` +
      `${ws.rowCount} schedule rows, ${courtsUsed} courts, Draw column: ${hasDraw}`
  );
}

// ---- the scored workbook ---------------------------------------------------
// The same builder produces the results file once scores are in: the schedule
// sheet gains games columns and a Leaderboard sheet appears.
for (const [format, fill] of [
  ["open", "all"],
  ["mixed", "partial"],
  ["same", "all"],
] as [Format, "all" | "partial"][]) {
  const players = makeRoster(13, 12);
  const s = generateSchedule(players, { numRounds: 5, seed: 99, numCourts: 6, format });

  const scores: Scores = {};
  let i = 0;
  for (const rnd of s.rounds) {
    for (const m of rnd.matches) {
      if (fill === "partial" && i % 3 === 0) { i++; continue; } // leave gaps
      scores[matchKey(rnd.number, m.court)] = i++ % (GAMES_PER_MATCH + 1);
    }
  }
  const lb = leaderboards(s, scores);
  const buf = await buildScheduleWorkbook(s, COURT_NAMES, scores);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet("Schedule & Scores");
  const lw = wb.getWorksheet("Leaderboard");
  check(!!ws, `${format} scored: schedule sheet not renamed`);
  check(!!lw, `${format} scored: no Leaderboard sheet`);
  check(!wb.getWorksheet("Schedule"), `${format} scored: unscored sheet name left behind`);
  if (!ws || !lw) continue;

  const wsText: string[] = [];
  ws.eachRow((row) => row.eachCell((cell) => wsText.push(String(cell.value ?? ""))));
  check(wsText.includes("Games"), `${format} scored: no Games column on the schedule`);
  check(
    (fill === "partial") === wsText.includes("not scored"),
    `${format} scored: unscored matches not called out correctly`
  );

  // The three tables are present and each holds one row per eligible player.
  const lbText: string[] = [];
  lw.eachRow((row) => row.eachCell((cell) => lbText.push(String(cell.value ?? ""))));
  for (const t of ["OPEN - all players", "MEN", "WOMEN"]) {
    check(lbText.includes(t), `${format} scored: "${t}" table missing`);
  }
  check(
    lbText.some((t) => t.includes(`${lb.entered} of ${lb.total} matches scored`)) ||
      (lb.complete && lbText.some((t) => t.includes(`All ${lb.total} matches scored`))),
    `${format} scored: progress line wrong`
  );

  // Every name appears three times when the roster is fully gendered: once in
  // the Open table and once in its own gender table... plus the By Player sheet
  // is a different worksheet, so within the leaderboard it is exactly twice.
  for (const p of [players[0], players[players.length - 1]]) {
    const seen = lbText.filter((t) => t === p.name).length;
    check(seen === 2, `${format} scored: ${p.name} appears ${seen} times, expected 2`);
  }

  // The games totals in the sheet must match the tally exactly.
  const totalInSheet = lb.all.reduce((n, r) => n + r.games, 0);
  check(
    totalInSheet === lb.entered * 2 * GAMES_PER_MATCH,
    `${format} scored: games total ${totalInSheet}, expected ${lb.entered * 2 * GAMES_PER_MATCH}`
  );

  // Ranks in the sheet must be non-decreasing down the Open table.
  const rankCol: number[] = [];
  let inOpen = false;
  lw.eachRow((row) => {
    const first = String(row.getCell(1).value ?? "");
    if (first.startsWith("OPEN")) inOpen = true;
    else if (first === "MEN") inOpen = false;
    else if (inOpen && typeof row.getCell(1).value === "number") {
      rankCol.push(row.getCell(1).value as number);
    }
  });
  check(rankCol.length === players.length, `${format} scored: Open table has ${rankCol.length} rows`);
  check(
    rankCol.every((r, j) => j === 0 || rankCol[j - 1] <= r),
    `${format} scored: ranks are out of order`
  );

  console.log(
    `ok  ${format.padEnd(5)} scored (${fill.padEnd(7)}) -> ` +
      `${((buf as ArrayBuffer).byteLength / 1024).toFixed(1)} KB, ` +
      `${lb.entered}/${lb.total} matches, leader ${lb.all[0].name} on ${lb.all[0].games} games`
  );
}

// An empty score set must still produce the plain schedule workbook.
{
  const s = generateSchedule(makeRoster(12, 12), { numRounds: 4, seed: 5, format: "open" });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await buildScheduleWorkbook(s, COURT_NAMES, {}));
  check(!!wb.getWorksheet("Schedule"), "empty scores: Schedule sheet missing");
  check(!wb.getWorksheet("Leaderboard"), "empty scores: Leaderboard should not appear");
  console.log("ok  empty score set falls back to the plain schedule workbook");
}

if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nExcel export verified for all formats, scored and unscored.");
