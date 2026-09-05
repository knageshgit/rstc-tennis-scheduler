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

## Two pages, two audiences

| Who | URL | What they can do |
|-----|-----|------------------|
| **Club members** | `/` (the live app link above) | See the **Schedule**, enter and read **Results**, watch the **Leaderboard**, download the Excel. Share this link freely; it is the same every week. |
| **Organisers** | `/admin/<secret>` | Everything above, plus building a schedule and publishing it. Keep this link to yourself. |

The club link never changes. Publishing a schedule points it at that mixer, so the
one URL in the group chat always opens whatever is on today. Each mixer also keeps a
permanent address of its own at `/e/<CODE>` for looking one up after the next has
replaced it.

## Web app (Next.js): this is what deploys

Building a schedule runs entirely client-side: upload, edit, generate and download
all happen in the browser and nothing is sent anywhere. The one exception is
**Publish to the club link** (below), which is an explicit button press and the only
thing that ever puts a schedule on a server.

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build
```

### How to use (organisers, at `/admin/<secret>`)
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

## Scoring and the leaderboard

Every match is **8 games**. A player's score for a match is the number of games their
team won, so the two teams on a court always split 8 between them. Totals are ranked
in three tables over that one set of numbers: **Open** (everyone), **Men**, and
**Women**.

Ranking is on **total games won**. Where the roster does not divide evenly into
courts, some players sit out a round and so have one fewer match in which to win
games, so every table also carries **matches played** and **games per match**: the
rank follows the total, and the average is there to show when a bye is the reason
someone sits lower than their play deserved.

### Running it on the day
1. Generate the schedule, then press **Publish to the club link**. The root URL now
   shows this mixer, and it also gets a permanent address of its own, `/e/K7M2QP`.
2. Members open the club link. No code, no login: the same URL works every week.
   Three tabs:
   - **Schedule** - every round and court. **Find me** picks a name and pulls that
     player's whole day into one strip, marking their match in each round. Remembered
     on that phone.
   - **Results** - the 0-8 picker for each match; enter the games for either team and
     the other side fills in automatically. Anyone may enter any court, deliberately.
     Entries save immediately and every phone refreshes every 10 seconds. Each phone
     can filter to a single court, and that choice is remembered too.
   - **Leaderboard** - Open, Men and Women, live as scores come in.
3. **Download results as Excel** from the Leaderboard tab at any point.
4. When the day is over, **take it down** from the organiser page if you would rather
   the root page sat empty until next week.

The scored workbook is the same file, not a second one: the schedule sheet gains
**Games** columns with the winning side in bold and unscored matches called out, the
By Player sheet gains a games total, and a **Leaderboard** sheet holds the three
ranked tables.

### How score storage works

Score entry is the one feature that needs a server. It uses a private **Vercel Blob**
store (`BLOB_READ_WRITE_TOKEN`, injected by `vercel blob create-store`). The store is
private because a published schedule carries the name of everyone playing.

The design point worth knowing is concurrency. A round ends and six courts report
within seconds of each other, so the obvious "read the scores, add mine, write them
back" would silently drop entries. Instead **each score is its own blob, with the
value in the pathname**:

```
ev/K7M2QP/s/r3c2__5__1764950400000
             |     |  when it was entered
             |     games won by team A ("x" if the score was cleared)
             which match
```

Nothing is ever overwritten or deleted, so a write is one upload that cannot collide
with any other, and a read is a single `list` of the prefix (the pathnames carry the
data, so no blob contents are fetched). Re-entering a score appends a newer entry and
the reader keeps the latest per match, which also means a correction beats a stale
value arriving late from another phone. `scripts/verify_store.mts` covers that round
trip and the last-write-wins rule.

The club link is stored the same append-only way, for the same reason and one more:
a `put` refuses to overwrite by default, and a cached read of a mutable blob could
serve a member last week's mixer. So each change writes a new pointer and the newest
wins.

```
cur/1764950400000__K7M2QP     the club link points here
cur/1765555200000__-          taken down; the root page shows nothing
```

Without `BLOB_READ_WRITE_TOKEN` everything else still works and publishing returns a
plain "not configured" message rather than failing.

### The organiser gate

Two locks, both environment variables, because a club wanted a link to keep rather
than an account system:

| Variable | What it does |
|----------|--------------|
| `ADMIN_PATH` | The unguessable path segment. The page lives at `/admin/$ADMIN_PATH`; every other segment, and a bare `/admin`, 404s like any unused URL. |
| `ADMIN_PIN` | Typed once per device. The PIN is checked on the server, which answers with an httpOnly cookie holding a hash of both secrets, good for a month. |

The path hides the page from anyone sweeping the site; the PIN is what still protects
it when the link is forwarded to the wrong group chat. Because the unlock endpoint
wants the path as well as the PIN, guessing the PIN means already having the link,
which is what makes a short PIN defensible here.

Both are checked in constant time, and the cookie stops working the moment either
secret changes: **rotating a leaked link is one `vercel env` edit and a redeploy**.
`POST /api/events` (publish) and `POST /api/admin/current` (move or take down the
club link) require the cookie. Reading an event and entering a score never do.

> **Leaving them unset leaves the admin area open**, which is deliberate so that
> `npm run dev` works on a laptop with no setup: any segment reaches `/admin/<x>` and
> no PIN is asked for. The page says so in a banner. Set both in production.

```bash
vercel env add ADMIN_PATH production   # e.g. 16 hex characters
vercel env add ADMIN_PIN production
```

`scripts/verify_admin.mts` covers the wrong answers as well as the right ones: wrong
path, wrong PIN, forged and absent cookies, cookies issued before a rotation, and
each half-configured combination.

### Project layout
| Path | Purpose |
|------|---------|
| `app/page.tsx` | The club link: resolves the current event and hands it to the member view. |
| `app/EventView.tsx` | What members see: the Schedule / Results / Leaderboard tabs. |
| `app/e/[id]/` | One mixer by its permanent code, rendering the same three tabs. |
| `app/admin/[token]/` | The organiser page: the gate, the PIN form, and the generator. |
| `app/api/events/` | Publish an event, read it, and record one match's score. |
| `app/api/admin/` | Unlock and lock a device; move or take down the club link. |
| `lib/admin.ts` | The organiser gate: secret path, PIN, and the unlock cookie (pure). |
| `lib/scheduler.ts` | Scheduling/optimization engine (randomized restarts). |
| `lib/scoring.ts` | Games tally and the Open/Men/Women rankings (pure, no I/O). |
| `lib/store.ts` | Event storage on Vercel Blob, and the guard on what may be stored. |
| `lib/roster.ts` | Parses a pasted player list for manual roster entry. |
| `lib/excel.ts` | Excel parsing and styled schedule/results export (ExcelJS). |
| `scripts/verify.mts` | Engine checks across all three formats and a dozen roster shapes, plus expected-failure cases. |
| `scripts/verify_excel.mts` | Round-trips the exported workbook for each format, scored and unscored. |
| `scripts/verify_scoring.mts` | Tally and ranking checks, including byes, ties and half-scored events. |
| `scripts/verify_store.mts` | Event codes, the schedule shape guard, and the club-link pointer. |
| `scripts/verify_admin.mts` | The organiser gate, right answers and wrong ones. |
| `scripts/verify_travel.mts` | Asserts travel polish never costs schedule quality. |
| `scripts/verify_roster.mts` | The pasted-list parser. |
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

Run every check before deploying:

```bash
for f in verify verify_excel verify_roster verify_travel verify_scoring verify_store; do
  npx tsx scripts/$f.mts || break
done
npm run lint && npm run build
```

## Notes on roster size
- **24 players** fills all 6 courts every round with no byes.
- Sizes that aren't a multiple of 4 produce rotating byes (e.g. 25 players → 6 courts
  and 1 bye per round).
- With very small rosters, courts span a wider level range to keep partners unique;
  balance tightens as the roster grows.
