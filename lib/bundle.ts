/**
 * The complete record of one tournament, as a single zip.
 *
 * "Archive" already means something in this app: filing a mixer into the club's
 * results page. This is the other kind, the one a club secretary means. It
 * takes everything the app holds about a tournament and hands it over as files
 * on a disk, so the record survives independently of this site, of Redis, of
 * Vercel, and of whether anyone is still paying for any of it.
 *
 * That is the whole point, so it decides the format. Not a JSON blob that only
 * this app can read: a workbook that opens in Excel, photos as ordinary JPEGs
 * in a folder, the chat as plain text, and a README that says what everything
 * is. The raw JSON goes in too, because it is the only lossless copy and it is
 * what would let a future version load the tournament back, but it is not what
 * anyone is expected to open.
 *
 * Built in the browser rather than on the server: the images already have to
 * travel to the organiser's machine, and routing them through a serverless
 * function first would double the transfer and risk its response limit.
 */
import JSZip from "jszip";

import type { ChatMessage } from "./chat";
import { buildScheduleWorkbook } from "./excel";
import { leaderboards, type Scores } from "./scoring";
import type { Schedule } from "./scheduler";
import { formatLabel } from "./archive";
import type { PhotoMeta } from "./photos";

export interface BundleEvent {
  id: string;
  title: string;
  createdAt: number;
  courtNames: string[];
  schedule: Schedule;
}

export interface BundleProgress {
  /** What is happening now, in words worth showing on a button. */
  step: string;
  /** 0 to 1, for a progress bar. */
  done: number;
}

/**
 * Gather everything about one tournament and return a zip.
 *
 * Photos are fetched one at a time on purpose. Forty parallel image requests
 * from one browser is how you get a handful of failures on club wifi, and this
 * runs once, in the background, while somebody watches a progress line.
 */
export async function buildTournamentBundle(
  event: BundleEvent,
  onProgress: (p: BundleProgress) => void
): Promise<{ blob: Blob; filename: string }> {
  const zip = new JSZip();
  const base = folderName(event);

  onProgress({ step: "Reading the scores", done: 0.05 });
  const scores = await getJSON<{ scores: Scores }>(`/api/events/${event.id}/scores`);
  const scoreMap = scores?.scores ?? {};

  onProgress({ step: "Reading the chat", done: 0.12 });
  const chat = await getJSON<{ messages: ChatMessage[] }>(`/api/events/${event.id}/chat`);
  const messages = chat?.messages ?? [];

  onProgress({ step: "Listing the photos", done: 0.18 });
  const photoList = await getJSON<{ photos: PhotoMeta[] }>(`/api/events/${event.id}/photos`);
  const photos = photoList?.photos ?? [];

  onProgress({ step: "Building the workbook", done: 0.25 });
  const workbook = await buildScheduleWorkbook(
    event.schedule,
    event.courtNames?.length ? event.courtNames : event.schedule.courtNames,
    scoreMap
  );
  zip.file(`${base}/schedule-and-scores.xlsx`, workbook);

  zip.file(`${base}/README.txt`, readme(event, scoreMap, messages, photos));
  zip.file(`${base}/leaderboard.csv`, leaderboardCsv(event.schedule, scoreMap));
  zip.file(`${base}/chat.txt`, chatText(event, messages));
  zip.file(
    `${base}/tournament.json`,
    JSON.stringify({ event, scores: scoreMap, chat: messages, photos }, null, 2)
  );

  // Photos last, because they are the slow part and everything above is already
  // safely in the zip if a download stalls.
  let n = 0;
  for (const photo of photos) {
    n += 1;
    onProgress({
      step: `Downloading photo ${n} of ${photos.length}`,
      done: 0.3 + 0.65 * (n / Math.max(1, photos.length)),
    });
    try {
      const res = await fetch(`/api/events/${event.id}/photos/${photo.id}`);
      if (!res.ok) continue;
      zip.file(`${base}/photos/${photoName(photo, n)}`, await res.blob());
    } catch {
      // One unreadable photo should not cost the organiser the other thirty-nine.
    }
  }

  onProgress({ step: "Compressing", done: 0.97 });
  // The bulk of this is JPEG and xlsx, both already compressed, so deflating
  // again costs time and saves almost nothing. Text files still get squeezed.
  const blob = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 1 },
  });

  onProgress({ step: "Done", done: 1 });
  return { blob, filename: `${base}.zip` };
}

async function getJSON<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** "2026-09-05-players-v2026-09-05-vm2-LNAQZN", safe on every filesystem. */
function folderName(event: BundleEvent): string {
  const date = new Date(event.createdAt).toISOString().slice(0, 10);
  const slug = (event.title || "tennis-mixer")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return `${date}-${slug || "tennis-mixer"}-${event.id}`;
}

/**
 * "03-sarah-ehler.jpg". Numbered so the folder sorts in the order the photos
 * were taken, which is the order they happened.
 */
function photoName(photo: PhotoMeta, index: number): string {
  const who = (photo.by || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return `${String(index).padStart(3, "0")}${who ? `-${who}` : ""}.jpg`;
}

function chatText(event: BundleEvent, messages: ChatMessage[]): string {
  if (messages.length === 0) return "Nothing was said in the chat at this mixer.\n";
  const lines = messages.map(
    (m) => `[${new Date(m.at).toLocaleString()}] ${m.by}: ${m.text.replace(/\n/g, "\n    ")}`
  );
  return [
    `Chat from ${event.title || "the mixer"} (${event.id})`,
    `${messages.length} message${messages.length === 1 ? "" : "s"}`,
    "",
    ...lines,
    "",
  ].join("\n");
}

/**
 * The standings as CSV as well as in the workbook.
 *
 * The xlsx is the readable copy, but a CSV is what survives being opened by
 * anything at all in ten years, which is the point of the exercise.
 */
function leaderboardCsv(schedule: Schedule, scores: Scores): string {
  const board = leaderboards(schedule, scores);
  const cell = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [["Table", "Rank", "Player", "Level", "Games", "Played", "Games per match"]];
  for (const [table, list] of [
    ["Overall", board.all],
    ["Men", board.men],
    ["Women", board.women],
  ] as const) {
    for (const r of list) {
      rows.push([
        table,
        String(r.rank),
        r.name,
        String(r.level),
        String(r.games),
        String(r.played),
        r.avg.toFixed(1),
      ]);
    }
  }
  return rows.map((r) => r.map(cell).join(",")).join("\n") + "\n";
}

function readme(
  event: BundleEvent,
  scores: Scores,
  messages: ChatMessage[],
  photos: PhotoMeta[]
): string {
  const board = leaderboards(event.schedule, scores);
  const podium = (list: typeof board.all) =>
    list
      .filter((r) => r.rank <= 3 && r.games > 0)
      .map((r) => `  ${r.rank}. ${r.name} (${r.games} games)`)
      .join("\n") || "  not scored";

  return [
    event.title || "Tennis mixer",
    "=".repeat((event.title || "Tennis mixer").length),
    "",
    `Event code:   ${event.id}`,
    `Published:    ${new Date(event.createdAt).toLocaleString()}`,
    `Format:       ${formatLabel(event.schedule.format)}`,
    `Players:      ${event.schedule.players.length}`,
    `Rounds:       ${event.schedule.rounds.length}`,
    `Courts:       ${(event.courtNames?.length ? event.courtNames : event.schedule.courtNames)?.join(", ") || "unnamed"}`,
    `Scored:       ${board.entered} of ${board.total} matches${board.complete ? " (complete)" : ""}`,
    "",
    "Top three men",
    podium(board.men),
    "",
    "Top three women",
    podium(board.women),
    "",
    "What is in this folder",
    "----------------------",
    "schedule-and-scores.xlsx   Every round, who played whom, the games won,",
    "                           a sheet per player, and the leaderboards.",
    "leaderboard.csv            The standings again, as plain CSV.",
    `chat.txt                   The mixer chat, ${messages.length} message${messages.length === 1 ? "" : "s"}.`,
    `photos/                    ${photos.length} photo${photos.length === 1 ? "" : "s"}, numbered in the order taken.`,
    "tournament.json            Everything above in its raw form. Nothing is",
    "                           lost here, but it is not meant for reading.",
    "",
    `Exported ${new Date().toLocaleString()} from the RSTC Tennis Mixer app.`,
    "",
  ].join("\n");
}
