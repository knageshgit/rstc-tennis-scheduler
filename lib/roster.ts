import type { Gender } from "@/lib/scheduler";

/** One editable roster line. `level` is kept as a string while being typed. */
export type Row = { name: string; level: string; gender: Gender };

const GENDER_TOKENS: Record<string, Gender> = {
  m: "M", male: "M", man: "M", men: "M", boy: "M",
  f: "F", female: "F", woman: "F", women: "F", w: "F", girl: "F",
};

/**
 * Parse a pasted list into roster rows. One player per line; fields separated
 * by commas, tabs, semicolons, or plain spaces. A trailing M/F token sets the
 * gender and a trailing number sets the rating, in either order, so all of
 * these lines work:
 *   Jane Doe, 3.5, F
 *   Jane Doe 3.5 F
 *   Jane Doe F 3.5
 *   Jane Doe
 */
export function parseBulkRoster(text: string): Row[] {
  const out: Row[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    let gender: Gender = "";
    let level = "";
    const claimGender = (t: string) => {
      const g = GENDER_TOKENS[t.toLowerCase()];
      if (!gender && g) {
        gender = g;
        return true;
      }
      return false;
    };
    const claimLevel = (t: string) => {
      if (!level && t !== "" && Number.isFinite(Number(t))) {
        level = String(Number(t));
        return true;
      }
      return false;
    };

    let name: string;
    if (/[,\t;]/.test(line)) {
      // Delimited: the first field is the name. Later fields become the rating
      // or the gender if they look like one; anything else is treated as more
      // of the name, so "Doe, Jane, 3.5, F" survives intact.
      const parts = line.split(/[,\t;]+/).map((x) => x.trim()).filter(Boolean);
      const nameParts: string[] = [];
      for (const t of parts) {
        if (nameParts.length && (claimGender(t) || claimLevel(t))) continue;
        nameParts.push(t);
      }
      name = nameParts.join(" ");
    } else {
      // Space separated: only the last two tokens can be a rating or a gender,
      // so a middle initial like "Jane M Doe" stays part of the name.
      const parts = line.split(/\s+/);
      for (let pass = 0; pass < 2 && parts.length > 1; pass++) {
        const last = parts[parts.length - 1];
        if (claimGender(last) || claimLevel(last)) parts.pop();
        else break;
      }
      name = parts.join(" ");
    }

    name = name.trim();
    if (name) out.push({ name, level, gender });
  }
  return out;
}
