/**
 * Excel input parsing and styled schedule export, using ExcelJS (browser-side).
 */
import ExcelJS from "exceljs";

import {
  DEFAULT_COURT_NAMES,
  FORMATS,
  Gender,
  Schedule,
  courtAvg,
  courtName,
  courtSpread,
  travelSummary,
  drawLabel,
  playerStats,
  round2,
  teamGap,
  teamLevel,
} from "./scheduler";
import {
  GAMES_PER_MATCH,
  leaderboards,
  readScore,
  tally,
  type PlayerScore,
  type Scores,
} from "./scoring";

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
const GENDER_ALIASES = new Set(["gender", "sex", "m/f"]);

function normalizeGender(raw: string): Gender {
  const c = raw.trim().toLowerCase()[0];
  if (c === "m") return "M";
  if (c === "f" || c === "w") return "F"; // female / woman
  return "";
}

export interface RosterRow {
  name: string;
  level: number | null; // null when the source cell is blank / unparsable
  gender: Gender;
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
  // A roster may have more than one gender-ish column (e.g. "Gender" = M/F and
  // "Gender.1" = Male/Female); gather them all and use the first non-empty value.
  const genderCols = headers.filter(
    (h) => GENDER_ALIASES.has(h.key) || h.key.startsWith("gender")
  );

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

    let gender: Gender = "";
    for (const gc of genderCols) {
      const g = normalizeGender(cellText(row.getCell(gc.col).value));
      if (g) {
        gender = g;
        break;
      }
    }

    rows.push({ name, level, gender });
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

/** One-line description of how the roster maps onto courts for this format. */
function formatSummary(s: Schedule): string {
  const l = s.layout;
  const bits: string[] = [`${s.players.length} players`];
  if (s.format === "same") {
    bits.push(
      `${l.menCourts} men's court(s) (${l.men} men), ` +
        `${l.womenCourts} women's court(s) (${l.women} women)`
    );
  } else if (s.format === "mixed") {
    bits.push(`${l.courtsUsed} court(s), ${l.men} men / ${l.women} women`);
  } else {
    bits.push(`${l.courtsUsed} court(s)`);
  }
  bits.push(
    l.byesPerRound > 0 ? `${l.byesPerRound} bye(s) per round` : "no byes"
  );
  return bits.join(" - ");
}

/** Bye line for a round, split by draw when the format is gendered. */
function byesText(s: Schedule, byes: number[]): string {
  const names = (idxs: number[]) => idxs.map((i) => s.players[i].name).join(", ");
  if (s.format === "open") return `Byes: ${names(byes)}`;
  const men = byes.filter((i) => s.players[i].gender === "M");
  const women = byes.filter((i) => s.players[i].gender === "F");
  const parts: string[] = [];
  if (men.length) parts.push(`Men: ${names(men)}`);
  if (women.length) parts.push(`Women: ${names(women)}`);
  return `Byes - ${parts.join("  |  ")}`;
}

export async function buildScheduleWorkbook(
  s: Schedule,
  courtNames: string[] = DEFAULT_COURT_NAMES,
  scores?: Scores
): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Tennis Doubles Mixer Scheduler";
  wb.created = new Date();

  // Scores are optional: the workbook downloaded before play starts is the
  // schedule alone, and the same builder produces the results afterwards.
  const sc: Scores = scores ?? {};
  const scored = Object.keys(sc).length > 0;

  // --- Schedule sheet ---
  const ws = wb.addWorksheet(scored ? "Schedule & Scores" : "Schedule");
  // Same-gender play splits the courts into a men's and a women's draw, so the
  // sheet gains a column saying which draw each court belongs to.
  const showDraw = s.format === "same";
  const headers = [
    "Court",
    ...(showDraw ? ["Draw"] : []),
    "Team A",
    "Level",
    ...(scored ? ["Games"] : []),
    "vs",
    "Team B",
    "Level",
    ...(scored ? ["Games"] : []),
    "Court Avg",
    "Level Spread",
    "Team Gap",
  ];
  // Columns holding player names, which are the only left-aligned ones.
  const teamCols = [
    headers.indexOf("Team A") + 1,
    headers.lastIndexOf("Team B") + 1,
  ];

  const formatLabel =
    FORMATS.find((f) => f.value === s.format)?.label ?? s.format;
  const title = ws.addRow([`${formatLabel} - ${s.rounds.length} rounds`]);
  ws.mergeCells(title.number, 1, title.number, headers.length);
  title.getCell(1).font = { bold: true, size: 14 };
  const sub = ws.addRow([formatSummary(s)]);
  ws.mergeCells(sub.number, 1, sub.number, headers.length);
  sub.getCell(1).font = { italic: true, color: { argb: "FF666666" } };
  const t = travelSummary(s);
  const venues = [...new Set(t.venues)];
  const travelLine = ws.addRow([
    `Courts are grouped to keep players put: ` +
      `${t.stays} of ${t.transitions} times a player stays on the same court, ` +
      `${t.walks} are a walk within a venue and ${t.drives} cross venues. ` +
      `${t.neverDrive} of ${s.players.length} players never change venue` +
      (venues.length > 1 ? ` (${venues.length} venues in play).` : `.`),
  ]);
  ws.mergeCells(travelLine.number, 1, travelLine.number, headers.length);
  travelLine.getCell(1).font = { italic: true, color: { argb: "FF666666" } };
  ws.addRow([]);

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
      const ga = readScore(sc, rnd.number, m.court);
      const gb = ga === null ? null : GAMES_PER_MATCH - ga;
      const row = ws.addRow([
        courtName(m.court, courtNames),
        ...(showDraw ? [drawLabel(m)] : []),
        `${a1} & ${a2}`,
        round2(teamLevel(s, m.teamA) / 2),
        ...(scored ? [ga ?? ""] : []),
        "vs",
        `${b1} & ${b2}`,
        round2(teamLevel(s, m.teamB) / 2),
        ...(scored ? [gb ?? ""] : []),
        round2(courtAvg(s, m)),
        round2(courtSpread(s, m)),
        round2(teamGap(s, m)),
      ]);
      row.eachCell((cell, col) => {
        cell.border = BORDER;
        cell.alignment = {
          horizontal: teamCols.includes(col) ? "left" : "center",
          vertical: "middle",
        };
      });
      // Embolden the winning side so a round reads at a glance.
      if (ga !== null && gb !== null && ga !== gb) {
        const winner = ga > gb ? teamCols[0] : teamCols[1];
        row.getCell(winner).font = { bold: true };
        row.getCell(winner + 2).font = { bold: true }; // its games column
      }
      if (scored && ga === null) {
        // Not yet played, or nobody entered it. Say so rather than leave blanks.
        row.getCell(headers.indexOf("vs") + 1).value = "not scored";
        row.getCell(headers.indexOf("vs") + 1).font = {
          italic: true,
          color: { argb: "FF8A6D3B" },
        };
      }
    }

    if (rnd.byes.length) {
      const byeRow = ws.addRow([byesText(s, rnd.byes)]);
      ws.mergeCells(byeRow.number, 1, byeRow.number, headers.length);
      byeRow.getCell(1).font = { italic: true, color: { argb: "FF8A6D3B" } };
    }
    ws.addRow([]); // spacer
  }
  autosize(ws);
  ws.views = [{ state: "frozen", ySplit: 0 }];

  // --- By Player sheet ---
  const ps = wb.addWorksheet("By Player");
  const pHeaders = [
    "Player",
    "Level",
    "Gender",
    "Matches",
    "Byes",
    ...(scored ? ["Games Won"] : []),
    "Where to be (by round)",
    "Partners",
    "Opponents",
  ];
  const gamesByName = new Map(tally(s, sc).map((r) => [r.name, r.games]));
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
      st.gender,
      st.matches,
      st.byes,
      ...(scored ? [gamesByName.get(st.name) ?? 0] : []),
      st.courtsByRound
        .map((c, i) => `R${i + 1} ${c === null ? "bye" : courtName(c, courtNames)}`)
        .join("  |  "),
      st.partners.join(", "),
      st.opponents.join(", "),
    ]);
    row.eachCell((cell, col) => {
      cell.border = BORDER;
      cell.alignment = {
        horizontal: col >= 2 && col <= (scored ? 6 : 5) ? "center" : "left",
        vertical: "middle",
      };
    });
  }
  autosize(ps);
  ps.views = [{ state: "frozen", ySplit: 1 }];

  if (scored) addLeaderboardSheet(wb, s, sc);

  return wb.xlsx.writeBuffer();
}

// ---- leaderboard -----------------------------------------------------------
const MEDALS: Record<number, string> = {
  1: "FFFFD966", // gold
  2: "FFD9D9D9", // silver
  3: "FFE8C39E", // bronze
};

const LEADER_HEADERS = [
  "#",
  "Player",
  "Level",
  "Games Won",
  "Matches",
  "Games / Match",
  "Won",
  "Lost",
  "Tied",
  "Byes",
];

/**
 * One ranked table. Rank is on games won; matches played and games per match
 * ride alongside so a player carrying a bye can be read in context rather than
 * looking simply worse than they played.
 */
function addLeaderTable(
  ws: ExcelJS.Worksheet,
  title: string,
  subtitle: string,
  rows: PlayerScore[]
): void {
  const head = ws.addRow([title]);
  ws.mergeCells(head.number, 1, head.number, LEADER_HEADERS.length);
  const hc = head.getCell(1);
  hc.fill = ROUND_FILL;
  hc.font = { color: { argb: "FFFFFFFF" }, bold: true, size: 12 };

  const sub = ws.addRow([subtitle]);
  ws.mergeCells(sub.number, 1, sub.number, LEADER_HEADERS.length);
  sub.getCell(1).font = { italic: true, color: { argb: "FF666666" } };

  const hr = ws.addRow(LEADER_HEADERS);
  hr.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = { color: { argb: "FFFFFFFF" }, bold: true };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = BORDER;
  });

  if (!rows.length) {
    const none = ws.addRow(["Nobody on the roster is marked for this table."]);
    ws.mergeCells(none.number, 1, none.number, LEADER_HEADERS.length);
    none.getCell(1).font = { italic: true, color: { argb: "FF8A6D3B" } };
    ws.addRow([]);
    ws.addRow([]);
    return;
  }

  for (const r of rows) {
    const row = ws.addRow([
      r.rank,
      r.name,
      r.level,
      r.games,
      r.played,
      r.played ? round2(r.avg) : "",
      r.wins,
      r.losses,
      r.ties,
      r.byes,
    ]);
    row.eachCell((cell, col) => {
      cell.border = BORDER;
      cell.alignment = {
        horizontal: col === 2 ? "left" : "center",
        vertical: "middle",
      };
    });
    const medal = MEDALS[r.rank];
    if (medal) {
      row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: medal } };
      row.getCell(1).font = { bold: true };
      row.getCell(2).font = { bold: true };
      row.getCell(4).font = { bold: true };
    }
  }
  ws.addRow([]);
  ws.addRow([]);
}

function addLeaderboardSheet(wb: ExcelJS.Workbook, s: Schedule, sc: Scores): void {
  const ws = wb.addWorksheet("Leaderboard");
  const lb = leaderboards(s, sc);

  const title = ws.addRow(["Leaderboard"]);
  ws.mergeCells(title.number, 1, title.number, LEADER_HEADERS.length);
  title.getCell(1).font = { bold: true, size: 14 };

  const status = lb.complete
    ? `All ${lb.total} matches scored.`
    : `${lb.entered} of ${lb.total} matches scored - ${lb.total - lb.entered} still to come in.`;
  const note = ws.addRow([
    `Every match is ${GAMES_PER_MATCH} games; a player's score is the games their team won. ` +
      `Ranking is on games won. ${status}`,
  ]);
  ws.mergeCells(note.number, 1, note.number, LEADER_HEADERS.length);
  note.getCell(1).font = { italic: true, color: { argb: "FF666666" } };
  ws.addRow([]);

  const byeNote = s.layout.byesPerRound
    ? " Players with a bye have one fewer match to win games in; the Games / Match column shows the rate."
    : "";
  addLeaderTable(ws, "OPEN - all players", `Every player on the roster.${byeNote}`, lb.all);
  addLeaderTable(ws, "MEN", "The same games, ranked among the men.", lb.men);
  addLeaderTable(ws, "WOMEN", "The same games, ranked among the women.", lb.women);

  autosize(ws);
  ws.views = [{ state: "frozen", ySplit: 3 }];
}
