# 🎾 RSTC Tennis Doubles Mixer Scheduler

A web app that turns a roster spreadsheet into a balanced doubles mixer schedule.
Upload an Excel file of players and their ratings, fill in any missing ratings in
the browser, and generate a multi-round schedule where:

- Each court holds four **similar-level** players, so matches are competitive and exciting.
- The two teams on a court have **near-equal combined rating**.
- **No two players are ever teammates more than once** (hard rule).
- Byes are **rotated fairly** when the roster is not a multiple of 4.

Format: doubles (2 per team, 4 per court), up to **6 courts** and **24 players on court**
at once (extra registrants rotate through byes), default **5 rounds**.

**Live app:** https://rstc-tennis-sch.vercel.app

## Web app (Next.js) — this is what deploys

Everything runs client-side in the browser (no server, no data leaves the page),
which is why it hosts cleanly on Vercel as a static app.

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build
```

### How to use
1. Prepare an `.xlsx` roster with a **name** column (or **First name** + **Last name**)
   and a level column (**Level**, **NTRP**, **USDA**, or **Tournament Rating**).
2. Upload it, fill in any blank ratings in the editable grid.
3. Set the number of rounds (and an optional seed for reproducibility) and click **Generate**.
4. Review the rounds on screen and **download the schedule** as Excel.

The downloaded workbook has a **Schedule** sheet (round by round, with team averages,
court level spread, and team gap) and a **By Player** sheet (partners, opponents,
matches, byes).

### Project layout
| Path | Purpose |
|------|---------|
| `app/page.tsx` | The whole UI: upload → edit → generate → download. |
| `lib/scheduler.ts` | Scheduling/optimization engine (randomized restarts). |
| `lib/excel.ts` | Excel parsing and styled schedule export (ExcelJS). |
| `scripts/` | Standalone verification scripts (`npx tsx scripts/verify.mts`). Excluded from the build. |
| `python/` | The original Python/Streamlit version (see below). Excluded from the Vercel build. |

## Python version (`python/`)

The original implementation as a Streamlit app with the same algorithm.

```bash
cd python
./run.sh          # sets up a venv and launches the Streamlit app
# or:
python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
./.venv/bin/streamlit run app.py
```

`python/test_scheduler.py` runs correctness checks across roster sizes.

## How the scheduling works

For each round the engine groups active players by level onto courts, then splits
each court's four players into the two most balanced teams that reuse no prior
partnership. It runs thousands of randomized constructions (fast at this scale) and
keeps the lowest-cost schedule with zero repeated partnerships. Small random jitter
on levels lets partners rotate across rounds while keeping each court tight on level.

## Notes on roster size
- **24 players** fills all 6 courts every round with no byes.
- Sizes that aren't a multiple of 4 produce rotating byes (e.g. 25 players → 6 courts
  and 1 bye per round).
- With very small rosters, courts span a wider level range to keep partners unique;
  balance tightens as the roster grows.
