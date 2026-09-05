# 🎾 RSTC Tennis Doubles Mixer Scheduler

A web app that turns a roster spreadsheet into a balanced doubles mixer schedule.
Upload an Excel file of players and their ratings, fill in any missing ratings in
the browser, and generate a multi-round schedule where:

- Each court holds four **similar-level** players, so matches are competitive and exciting.
- The two teams on a court have **near-equal combined rating**.
- **No two players are ever teammates more than once** (hard rule).
- Byes are **rotated fairly** when the roster is not a multiple of 4.

Doubles throughout (2 per team, 4 per court), up to **6 courts** and **24 players on
court** at once (extra registrants rotate through byes), default **5 rounds**.

## Tournament formats

Pick one in **Event settings**; the schedule is built to satisfy it.

| Format | Rule | Court composition |
|--------|------|-------------------|
| **Open doubles** | Any two players may partner. | 4 similar-rated players. |
| **Mixed doubles** | Every team is one man + one woman. | 2 men + 2 women. |
| **Same-gender doubles** | Men's teams face men's teams, women's face women's. | 4 players of one gender. |

The two gendered formats need every player marked **M** or **F** in the roster grid
(the app tells you who is missing one and will not generate until they are set).

Byes rotate within each gender's own pool in those formats, since a man cannot fill
a woman's slot. In same-gender play the courts are split between a men's and a
women's draw in whatever proportion keeps the two sides' bye rates closest, capped by
the number of courts you have. For example 12 men + 12 women on 6 courts gives 3
men's courts and 3 women's courts; 11 men + 14 women gives 2 men's and 3 women's
courts, with 3 men and 2 women sitting out each round.

Because mixed and same-gender play constrain who may partner whom, courts are a
little wider on rating spread than open doubles on the same roster. That is inherent
to the format, not a scheduling failure.

**Live app:** https://rstc-tennis-sch.vercel.app

## Web app (Next.js): this is what deploys

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
3. Pick the **tournament format**, the number of courts and rounds (and an optional
   seed for reproducibility), then click **Generate**.
4. Review the rounds on screen and **download the schedule** as Excel.

The downloaded workbook has a **Schedule** sheet (round by round, with team averages,
court level spread, and team gap, plus a **Draw** column marking the men's and women's
courts in same-gender play) and a **By Player** sheet (partners, opponents, matches,
byes).

### Project layout
| Path | Purpose |
|------|---------|
| `app/page.tsx` | The whole UI: upload → edit → generate → download. |
| `lib/scheduler.ts` | Scheduling/optimization engine (randomized restarts). |
| `lib/excel.ts` | Excel parsing and styled schedule export (ExcelJS). |
| `scripts/verify.mts` | Engine checks across all three formats and a dozen roster shapes, plus expected-failure cases. |
| `scripts/verify_excel.mts` | Round-trips the exported workbook for each format and re-reads it. |
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

For each round the engine picks who sits out (fewest byes so far, ties broken at
random), groups the active players by level onto courts, then splits each court's four
players into the two most balanced teams that reuse no prior partnership. It runs
thousands of randomized constructions (fast at this scale) and keeps the lowest-cost
schedule with zero repeated partnerships. Small random jitter on levels lets partners
rotate across rounds while keeping each court tight on level.

The format changes how courts are formed and which team splits are legal:

- **Open** and **same-gender**: the level-sorted pool is cut into consecutive groups
  of four (one pool per gender in same-gender play), and all three ways of splitting
  a group into two teams are candidates.
- **Mixed**: each court is anchored by the next unassigned player from the bottom of
  the level order and filled from the nearest players whose gender slot is still open,
  giving 2 men + 2 women per court. Only the two man/woman splits are candidates.

Run the checks with `npx tsx scripts/verify.mts` and `npx tsx scripts/verify_excel.mts`.

## Notes on roster size
- **24 players** fills all 6 courts every round with no byes.
- Sizes that aren't a multiple of 4 produce rotating byes (e.g. 25 players → 6 courts
  and 1 bye per round).
- With very small rosters, courts span a wider level range to keep partners unique;
  balance tightens as the roster grows.
