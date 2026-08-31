"""
Quick correctness checks for the scheduling engine. Run: python test_scheduler.py

Verifies the hard constraints and reports balance quality across several roster
sizes, including edge cases (non-multiples of 4, minimum roster, over-cap).
"""

import random

from scheduler import (MAX_ON_COURT, MAX_PLAYERS, PLAYERS_PER_COURT, Player,
                       ScheduleError, generate_schedule)


def _roster(n, seed=1):
    rng = random.Random(seed)
    levels = [2.5, 3.0, 3.5, 4.0, 4.5, 5.0]
    return [Player(name=f"P{i:02d}", level=rng.choice(levels)) for i in range(n)]


def check(n, num_rounds=5):
    players = _roster(n)
    sched = generate_schedule(players, num_rounds=num_rounds, seed=42)

    # 1) No repeated partnerships (the hard rule).
    assert not sched.partner_repeats(), f"n={n}: repeated partners found"

    active = PLAYERS_PER_COURT * (min(n, MAX_ON_COURT) // PLAYERS_PER_COURT)
    for rnd in sched.rounds:
        # 2) Correct number of courts and no double-booking within a round.
        assert len(rnd.matches) == active // PLAYERS_PER_COURT, f"n={n} r{rnd.number}: wrong court count"
        seen = set()
        for m in rnd.matches:
            for i in m.all_indices():
                assert i not in seen, f"n={n} r{rnd.number}: player {i} double-booked"
                seen.add(i)
        # 3) Byes account for everyone else.
        assert len(seen) + len(rnd.byes) == n, f"n={n} r{rnd.number}: player count mismatch"

    # 4) Byes are fairly rotated (spread of at most 1).
    stats = sched.player_stats()
    bye_counts = [s["byes"] for s in stats]
    assert max(bye_counts) - min(bye_counts) <= 1, f"n={n}: unfair byes {bye_counts}"

    # 5) Everyone gets distinct partners each time they play.
    for s in stats:
        assert len(s["partners"]) == len(set(s["partners"])), f"n={n}: {s['name']} has a repeat partner"

    spreads = [sched.court_spread(m) for r in sched.rounds for m in r.matches]
    gaps = [sched.team_gap(m) for r in sched.rounds for m in r.matches]
    avg_spread = sum(spreads) / len(spreads)
    avg_gap = sum(gaps) / len(gaps)
    print(f"  n={n:2d}: OK  | avg court spread {avg_spread:.2f} | "
          f"avg team gap {avg_gap:.2f} | max court spread {max(spreads):.1f}")


def main():
    print("Testing schedule generation across roster sizes...")
    for n in [25, 24, 23, 22, 21, 20, 16, 12, 8, 6]:
        check(n)

    print("Edge cases...")
    # Over the registered cap must raise.
    try:
        generate_schedule(_roster(MAX_PLAYERS + 1))
        raise AssertionError(f"expected ScheduleError for {MAX_PLAYERS + 1} players")
    except ScheduleError:
        print(f"  {MAX_PLAYERS + 1} players -> correctly rejected (over registered cap)")

    # Too few players for the requested rounds must raise.
    try:
        generate_schedule(_roster(5), num_rounds=5)
        raise AssertionError("expected ScheduleError for 5 players / 5 rounds")
    except ScheduleError:
        print("  5 players, 5 rounds -> correctly rejected (not enough unique partners)")

    print("\nAll checks passed.")


if __name__ == "__main__":
    main()
