"""
Tennis Doubles Mixer Scheduler — Streamlit app.

Upload a roster spreadsheet (player names + NTRP levels), generate a balanced
5-round doubles schedule with no repeated partnerships, review it on screen,
and download it as an Excel file.

Run with:  streamlit run app.py
"""

from __future__ import annotations

import pandas as pd
import streamlit as st

from io_utils import build_workbook, read_roster, workbook_to_bytes
from scheduler import MAX_COURTS, MAX_PLAYERS, ScheduleError, generate_schedule

st.set_page_config(page_title="Tennis Doubles Mixer Scheduler", page_icon="🎾", layout="wide")

st.title("🎾 Tennis Doubles Mixer Scheduler")
st.caption(
    "Upload a roster, and this builds a balanced doubles schedule: similar-level "
    "players face off each round, and no two people are ever teammates twice."
)

with st.sidebar:
    st.header("Settings")
    num_rounds = st.number_input("Number of rounds", min_value=1, max_value=10, value=5)
    seed_text = st.text_input("Random seed (optional)", value="",
                              help="Set a number to make results reproducible. Leave blank for a fresh draw each time.")
    st.markdown("---")
    st.markdown(
        f"**Format**\n\n"
        f"- Doubles: 4 players per court\n"
        f"- Up to {MAX_COURTS} courts, {MAX_PLAYERS} players\n"
        f"- No repeated partnerships\n"
        f"- Courts grouped by NTRP level"
    )
    st.markdown("---")
    st.markdown(
        "**Spreadsheet format**\n\n"
        "Two columns: a **Name** column and a level column "
        "(**Level**, **NTRP**, or **USDA**). Example:\n"
    )
    st.table(pd.DataFrame({"Name": ["Alex", "Sam", "Jordan"], "Level": [4.0, 3.5, 4.5]}))

uploaded = st.file_uploader("Upload roster spreadsheet (.xlsx)", type=["xlsx"])

if uploaded is None:
    st.info("Upload a roster to get started. Use the sidebar to see the expected format.")
    st.stop()

# ---- Read + preview the roster --------------------------------------------
try:
    players = read_roster(uploaded)
except ScheduleError as e:
    st.error(str(e))
    st.stop()

roster_df = pd.DataFrame({"Name": [p.name for p in players],
                          "Level": [p.level for p in players]})

col1, col2 = st.columns([1, 2])
with col1:
    st.subheader(f"Roster ({len(players)} players)")
    st.dataframe(roster_df.sort_values("Level", ascending=False),
                 use_container_width=True, hide_index=True)
with col2:
    st.subheader("Level distribution")
    st.bar_chart(roster_df["Level"].value_counts().sort_index())

playing = 4 * (min(len(players), MAX_PLAYERS) // 4)
byes_each = len(players) - playing
if byes_each:
    st.warning(
        f"{len(players)} players is not a multiple of 4, so **{byes_each}** player(s) "
        f"will sit out each round on a rotating basis, with {playing // 4} courts in play."
    )

# ---- Generate --------------------------------------------------------------
if st.button("Generate schedule", type="primary"):
    seed = None
    if seed_text.strip():
        try:
            seed = int(seed_text.strip())
        except ValueError:
            st.error("Seed must be a whole number.")
            st.stop()

    with st.spinner("Optimizing pairings..."):
        try:
            schedule = generate_schedule(players, num_rounds=int(num_rounds), seed=seed)
        except ScheduleError as e:
            st.error(str(e))
            st.stop()

    st.session_state["schedule"] = schedule

# ---- Display + download ----------------------------------------------------
schedule = st.session_state.get("schedule")
if schedule is not None:
    st.success("Schedule ready. No repeated partnerships. Review below or download the Excel file.")

    # Quality summary
    all_spreads = [schedule.court_spread(m) for r in schedule.rounds for m in r.matches]
    all_gaps = [schedule.team_gap(m) for r in schedule.rounds for m in r.matches]
    m1, m2, m3 = st.columns(3)
    m1.metric("Avg level spread per court", f"{sum(all_spreads) / len(all_spreads):.2f}")
    m2.metric("Avg team rating gap", f"{sum(all_gaps) / len(all_gaps):.2f}")
    m3.metric("Repeated partnerships", len(schedule.partner_repeats()))

    wb = build_workbook(schedule)
    st.download_button(
        "⬇️ Download schedule (.xlsx)",
        data=workbook_to_bytes(wb),
        file_name="tennis_schedule.xlsx",
        mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        type="primary",
    )

    for rnd in schedule.rounds:
        st.subheader(f"Round {rnd.number}")
        rows = []
        for m in sorted(rnd.matches, key=lambda x: x.court):
            a1, a2 = (schedule.players[i].name for i in m.team_a)
            b1, b2 = (schedule.players[i].name for i in m.team_b)
            rows.append({
                "Court": m.court,
                "Team A": f"{a1} & {a2}",
                "Team A avg": round(schedule.team_level(m.team_a) / 2, 2),
                "Team B": f"{b1} & {b2}",
                "Team B avg": round(schedule.team_level(m.team_b) / 2, 2),
                "Court spread": round(schedule.court_spread(m), 2),
            })
        st.dataframe(pd.DataFrame(rows), use_container_width=True, hide_index=True)
        if rnd.byes:
            st.caption("Byes: " + ", ".join(schedule.players[i].name for i in rnd.byes))
