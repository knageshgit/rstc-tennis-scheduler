# 🎾 Tennis Doubles Mixer Scheduler

Builds a balanced doubles schedule from a roster spreadsheet. Given a list of
players and their NTRP levels, it produces a multi-round schedule where:

- Each court holds four **similar-level** players, so matches are competitive and exciting.
- The two teams on a court have **near-equal combined rating**.
- **No two players are ever teammates more than once** (hard rule).
- Byes are **rotated fairly** when the roster is not a multiple of 4.

Format: doubles (2 per team, 4 per court), up to **6 courts** and **24 players**,
default **5 rounds**.

## Quick start

```bash
./run.sh
```

The first run creates a virtual environment and installs dependencies, then opens
the app in your browser. On later runs it just launches.

To run manually:

```bash
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
./.venv/bin/streamlit run app.py
```

## Using the app

1. Prepare a roster spreadsheet (`.xlsx`) with two columns:
   - a **name** column: `Name` (or `Player`)
   - a **level** column: `Level`, `NTRP`, or `USDA`

   | Name   | Level |
   |--------|-------|
   | Alex   | 4.0   |
   | Sam    | 3.5   |
   | Jordan | 4.5   |

2. Upload it, adjust the number of rounds if needed, and click **Generate schedule**.
3. Review the rounds on screen and **download the schedule** as an Excel file.

The downloaded workbook has two sheets:
- **Schedule** — each round, court by court, with team averages, court level spread, and team gap.
- **By Player** — every player's partners, opponents, matches played, and byes.

## Files

| File | Purpose |
|------|---------|
| `app.py` | Streamlit web app (upload → generate → download). |
| `scheduler.py` | Core scheduling/optimization engine. |
| `io_utils.py` | Reading rosters and writing the Excel schedule. |
| `make_sample.py` | Generates `sample_players.xlsx` for testing. |
| `test_scheduler.py` | Correctness checks across roster sizes and edge cases. |

## How it works

For each round the engine groups active players by NTRP level onto courts, then
splits each court's four players into the two most balanced teams that reuse no
prior partnership. It runs thousands of randomized constructions (fast at this
scale) and keeps the lowest-cost schedule with zero repeated partnerships. Small
random "jitter" on levels lets partners rotate across rounds while keeping each
court tight on level.

## Notes on roster size

- **24 players** fills all 6 courts every round with no byes — the ideal case.
- Sizes that are not a multiple of 4 produce rotating byes (e.g. 22 players → 5
  courts and 2 byes per round).
- With very small rosters, courts must span a wider level range to keep partners
  unique; balance naturally tightens as the roster grows.
