// Round-trip the Excel export for every tournament format and re-read the
// result to confirm the sheets are shaped correctly.
// Run: npx tsx scripts/verify_excel.mts
import ExcelJS from "exceljs";
import { buildScheduleWorkbook } from "../lib/excel.ts";
import { generateSchedule, type Format, type Player } from "../lib/scheduler.ts";

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

if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nExcel export verified for all formats.");
