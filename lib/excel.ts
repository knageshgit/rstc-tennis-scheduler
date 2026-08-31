/**
 * Excel input parsing and styled schedule export, using ExcelJS (browser-side).
 */
import ExcelJS from "exceljs";

import {
  Schedule,
  courtAvg,
  courtSpread,
  playerStats,
  round2,
  teamGap,
  teamLevel,
} from "./scheduler";

const NAME_ALIASES = new Set(["name", "player", "player name", "full name"]);
const FIRST_ALIASES = new Set(["first name", "first", "firstname"]);
const LAST_ALIASES = new Set(["last name", "last", "lastname", "surname"]);
const LEVEL_ALIASES = new Set([
  "level",
  "usda",
  "usda level",
  "ntrp",
  "ntrp level",
  "rating",
  "usta",
  "usta level",
  "tournament rating",
]);

export interface RosterRow {
  name: string;
  level: number | null; // null when the source cell is blank / unparsable
}

export interface ParseResult {
  rows: RosterRow[];
  detectedColumns: { name: string[]; level: string };
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    // ExcelJS rich text / hyperlink / formula result objects
    const anyv = v as unknown as Record<string, unknown>;
    if ("text" in anyv && typeof anyv.text === "string") return anyv.text;
    if ("result" in anyv) return String(anyv.result ?? "");
    if ("richText" in anyv && Array.isArray(anyv.richText)) {
      return (anyv.richText as { text: string }[]).map((r) => r.text).join("");
    }
  }
  return String(v);
}

function cleanName(raw: string): string {
  // Drop parenthetical artifacts like "Kittur (first)" and collapse whitespace.
  return raw.replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+/g, " ").trim();
}

export async function parseRoster(data: ArrayBuffer): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("The spreadsheet has no sheets.");

  const headerRow = ws.getRow(1);
  const headers: { col: number; key: string; label: string }[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, col) => {
    const label = cellText(cell.value).trim();
    headers.push({ col, key: label.toLowerCase(), label });
  });

  const find = (aliases: Set<string>) =>
    headers.find((h) => aliases.has(h.key));

  const nameH = find(NAME_ALIASES);
  const firstH = find(FIRST_ALIASES);
  const lastH = find(LAST_ALIASES);
  const levelH = find(LEVEL_ALIASES);

  const hasName = !!nameH || !!firstH || !!lastH;
  if (!hasName || !levelH) {
    const found = headers.map((h) => h.label).join(", ");
    throw new Error(
      `Could not find the required columns. Expected a name column (Name) or ` +
        `First/Last name columns, and a level column (Level, NTRP, USDA, Tournament Rating). ` +
        `Found: ${found || "(no headers)"}.`
    );
  }

  const rows: RosterRow[] = [];
  const lastRow = ws.rowCount;
  for (let r = 2; r <= lastRow; r++) {
    const row = ws.getRow(r);
    let name = "";
    if (nameH) {
      name = cellText(row.getCell(nameH.col).value).trim();
    } else {
      const parts: string[] = [];
      if (firstH) parts.push(cellText(row.getCell(firstH.col).value).trim());
      if (lastH) parts.push(cellText(row.getCell(lastH.col).value).trim());
      name = parts.join(" ");
    }
    name = cleanName(name);
    if (!name) continue; // skip blank rows

    const rawLevel = cellText(row.getCell(levelH.col).value).trim();
    let level: number | null = null;
    if (rawLevel !== "") {
      const n = Number(rawLevel);
      level = Number.isFinite(n) ? n : null;
    }
    rows.push({ name, level });
  }

  const nameLabels = [nameH?.label, firstH?.label, lastH?.label].filter(
    Boolean
  ) as string[];
  return { rows, detectedColumns: { name: nameLabels, level: levelH.label } };
}

// ---- styled output ---------------------------------------------------------
const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF1F4E5F" },
};
const ROUND_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF2E7D32" },
};
const BORDER: Partial<ExcelJS.Borders> = {
  top: { style: "thin", color: { argb: "FFD0D0D0" } },
  left: { style: "thin", color: { argb: "FFD0D0D0" } },
  bottom: { style: "thin", color: { argb: "FFD0D0D0" } },
  right: { style: "thin", color: { argb: "FFD0D0D0" } },
};

function autosize(ws: ExcelJS.Worksheet, maxWidth = 40) {
  ws.columns.forEach((col) => {
    let max = 8;
    col.eachCell?.({ includeEmpty: true }, (cell) => {
      const len = cell.value ? String(cell.value).length : 0;
      if (len > max) max = len;
    });
    col.width = Math.min(max + 3, maxWidth);
  });
}

export async function buildScheduleWorkbook(s: Schedule): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Tennis Doubles Mixer Scheduler";
  wb.created = new Date();

  // --- Schedule sheet ---
  const ws = wb.addWorksheet("Schedule");
  const headers = [
    "Court",
    "Team A",
    "Level",
    "vs",
    "Team B",
    "Level",
    "Court Avg",
    "Level Spread",
    "Team Gap",
  ];

  for (const rnd of s.rounds) {
    const banner = ws.addRow([`ROUND ${rnd.number}`]);
    ws.mergeCells(banner.number, 1, banner.number, headers.length);
    const bcell = banner.getCell(1);
    bcell.fill = ROUND_FILL;
    bcell.font = { color: { argb: "FFFFFFFF" }, bold: true, size: 12 };
    bcell.alignment = { vertical: "middle" };

    const head = ws.addRow(headers);
    head.eachCell((cell) => {
      cell.fill = HEADER_FILL;
      cell.font = { color: { argb: "FFFFFFFF" }, bold: true };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = BORDER;
    });

    const sorted = [...rnd.matches].sort((a, b) => a.court - b.court);
    for (const m of sorted) {
      const [a1, a2] = [s.players[m.teamA[0]].name, s.players[m.teamA[1]].name];
      const [b1, b2] = [s.players[m.teamB[0]].name, s.players[m.teamB[1]].name];
      const row = ws.addRow([
        m.court,
        `${a1} & ${a2}`,
        round2(teamLevel(s, m.teamA) / 2),
        "vs",
        `${b1} & ${b2}`,
        round2(teamLevel(s, m.teamB) / 2),
        round2(courtAvg(s, m)),
        round2(courtSpread(s, m)),
        round2(teamGap(s, m)),
      ]);
      row.eachCell((cell, col) => {
        cell.border = BORDER;
        cell.alignment = {
          horizontal: col === 2 || col === 5 ? "left" : "center",
          vertical: "middle",
        };
      });
    }

    if (rnd.byes.length) {
      const names = rnd.byes.map((i) => s.players[i].name).join(", ");
      const byeRow = ws.addRow([`Byes: ${names}`]);
      ws.mergeCells(byeRow.number, 1, byeRow.number, headers.length);
      byeRow.getCell(1).font = { italic: true, color: { argb: "FF8A6D3B" } };
    }
    ws.addRow([]); // spacer
  }
  autosize(ws);
  ws.views = [{ state: "frozen", ySplit: 0 }];

  // --- By Player sheet ---
  const ps = wb.addWorksheet("By Player");
  const pHeaders = ["Player", "Level", "Matches", "Byes", "Partners", "Opponents"];
  const ph = ps.addRow(pHeaders);
  ph.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = { color: { argb: "FFFFFFFF" }, bold: true };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = BORDER;
  });
  const stats = [...playerStats(s)].sort(
    (a, b) => b.level - a.level || a.name.localeCompare(b.name)
  );
  for (const st of stats) {
    const row = ps.addRow([
      st.name,
      st.level,
      st.matches,
      st.byes,
      st.partners.join(", "),
      st.opponents.join(", "),
    ]);
    row.eachCell((cell, col) => {
      cell.border = BORDER;
      cell.alignment = {
        horizontal: col >= 2 && col <= 4 ? "center" : "left",
        vertical: "middle",
      };
    });
  }
  autosize(ps);
  ps.views = [{ state: "frozen", ySplit: 1 }];

  return wb.xlsx.writeBuffer();
}
