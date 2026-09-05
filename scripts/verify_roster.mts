/**
 * Checks the paste-a-list parser used by the manual roster entry form.
 * Run with: npx tsx scripts/verify_roster.mts
 */
import { parseBulkRoster, type Row } from "../lib/roster";

let failures = 0;
function check(label: string, text: string, expected: Row[]) {
  const got = parseBulkRoster(text);
  const a = JSON.stringify(got);
  const b = JSON.stringify(expected);
  if (a !== b) {
    failures += 1;
    console.log(`FAIL ${label}\n  got      ${a}\n  expected ${b}`);
  } else {
    console.log(`ok   ${label}`);
  }
}
const r = (name: string, level = "", gender = "") => ({ name, level, gender }) as Row;

check("comma separated", "Jane Doe, 3.5, F", [r("Jane Doe", "3.5", "F")]);
check("space separated", "Jane Doe 3.5 F", [r("Jane Doe", "3.5", "F")]);
check("gender before rating", "Jane Doe F 3.5", [r("Jane Doe", "3.5", "F")]);
check("tab separated", "Jane Doe\t3.5\tF", [r("Jane Doe", "3.5", "F")]);
check("semicolons", "Jane Doe;3.5;F", [r("Jane Doe", "3.5", "F")]);
check("name only", "Jane Doe", [r("Jane Doe")]);
check("name and rating", "Jane Doe, 4", [r("Jane Doe", "4")]);
check("name and gender", "Jane Doe, F", [r("Jane Doe", "", "F")]);
check("long gender words", "Jane Doe, 3.5, female\nJohn Smith, 4.0, Male", [
  r("Jane Doe", "3.5", "F"),
  r("John Smith", "4", "M"),
]);
check("W means woman", "Jane Doe 3.0 W", [r("Jane Doe", "3", "F")]);
check("blank lines and padding", "\n  Jane Doe , 3.5 , F  \n\n John Smith,4,M\n", [
  r("Jane Doe", "3.5", "F"),
  r("John Smith", "4", "M"),
]);
check("three-part name", "Mary Anne Van Dyke, 3.5, F", [r("Mary Anne Van Dyke", "3.5", "F")]);
check("single-word name keeps its name", "Pele", [r("Pele")]);
check("name that looks numeric is kept", "42", [r("42")]);
check("empty input", "   \n  ", []);
check("rating normalised", "Jane Doe, 3.50, F", [r("Jane Doe", "3.5", "F")]);
check("unknown field joins the name", "Jane Doe, 3.5, X", [r("Jane Doe X", "3.5", "")]);
check("last-name-first survives", "Doe, Jane, 3.5, F", [r("Doe Jane", "3.5", "F")]);
check("middle initial M is not a gender", "Jane M Doe 3.5 F", [r("Jane M Doe", "3.5", "F")]);
check("middle initial W is not a gender", "John W Smith", [r("John W Smith")]);

console.log(failures ? `\n${failures} failure(s)` : "\nAll roster-parser checks passed.");
process.exit(failures ? 1 : 0);
