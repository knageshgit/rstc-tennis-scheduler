// Exercises the full client code path (build sample xlsx -> parse -> generate ->
// export -> re-open) using the same lib/excel + lib/scheduler code the browser runs.
// Self-contained synthetic data, no real people. Run: npx tsx scripts/verify_excel.mts
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import ExcelJS from "exceljs";

import { parseRoster, buildScheduleWorkbook } from "../lib/excel.ts";
import { generateSchedule, partnerRepeats, type Player } from "../lib/scheduler.ts";

// Build a sample roster workbook shaped like a real club export: First/Last name
// columns, a "Tournament Rating" column, and a few blank ratings to fill in.
const sample = [
  ["Ada", "Byte", 4.0], ["Grace", "Hopper", 3.9], ["Alan", "Turing", 3.8],
  ["Linus", "Kernel", 3.8], ["Ken", "Unix", 3.7], ["Dennis", "Sea", 3.7],
  ["Barbara", "Logic", 3.6], ["Edsger", "Path", 3.5], ["Donald", "Art", 3.5],
  ["John", "Van", 3.5], ["Tim", "Web", 3.5], ["Guido", "Python", 3.5],
  ["Margaret", "Apollo", 3.4], ["Katherine", "Orbit", 3.4], ["Radia", "Tree", 3.3],
  ["Vint", "Packet", 3.3], ["Bjarne", "Plus", 3.2], ["Brendan", "Script", 3.1],
  ["James", "Bean", 3.1], ["Anders", "Type", 3.1], ["Yukihiro", "Ruby", 3.0],
  ["Rasmus", "Elephant", 3.0], ["Ida", "Blank", null], ["Hedy", "Blank", null],
  ["Joan", "Blank", null],
] as [string, string, number | null][];

const wb0 = new ExcelJS.Workbook();
const ws0 = wb0.addWorksheet("Sheet1");
ws0.addRow(["First name", "Last name", "Tournament Rating"]);
for (const [f, l, r] of sample) ws0.addRow([f, l, r]);
const srcPath = join(tmpdir(), "sample_roster.xlsx");
await writeFile(srcPath, Buffer.from(await wb0.xlsx.writeBuffer()));

// --- parse it back via the app's parser ---
const buf = await readFile(srcPath);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const { rows, detectedColumns } = await parseRoster(ab as ArrayBuffer);
console.log("Detected name column(s):", detectedColumns.name, "| level column:", detectedColumns.level);
console.log("Parsed rows:", rows.length);
const missing = rows.filter((r) => r.level === null).map((r) => r.name);
console.log("Missing ratings (as the UI would flag):", missing.join(", "));

// fill the blanks (as a user would in the grid)
const overrides: Record<string, number> = {
  "Ida Blank": 3.0,
  "Hedy Blank": 3.8,
  "Joan Blank": 3.8,
};
const players: Player[] = rows.map((r) => ({ name: r.name, level: r.level ?? overrides[r.name] }));
const unfilled = players.filter((p) => p.level === undefined || Number.isNaN(p.level));
if (unfilled.length) throw new Error("unfilled: " + unfilled.map((p) => p.name).join(", "));

const s = generateSchedule(players, 5, 2026);
console.log("\nGenerated. Repeated partnerships:", partnerRepeats(s).length);

const outBuf = await buildScheduleWorkbook(s);
const outPath = join(tmpdir(), "sample_schedule.xlsx");
await writeFile(outPath, Buffer.from(outBuf));
console.log("Wrote", outPath, `(${outBuf.byteLength} bytes)`);

// re-open to confirm the exported workbook is valid
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(outBuf as ArrayBuffer);
console.log("Re-opened output. Sheets:", wb.worksheets.map((w) => w.name).join(", "));
console.log("\nFull client path OK ✓");
