"""
Core scheduling engine for the tennis doubles mixer.

Rules enforced:
  * Doubles: 4 players per court, 2 per team.
  * Up to 6 courts and 24 players (24 fills all 6 courts).
  * A configurable number of rounds (default 5).
  * HARD constraint: no two players are teammates more than once across all rounds.
  * OBJECTIVE (soft): every court holds four players of similar NTRP level
    (exciting, competitive matches) and the two teams on a court have
    near-equal combined rating.
  * Byes are rotated fairly when the roster is not a multiple of 4.

The search is a randomized construction with many restarts. For 24 players and
5 rounds the space is tiny, so thousands of restarts run in a fraction of a
second and reliably find a conflict-free, well-balanced schedule.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

MAX_COURTS = 6
PLAYERS_PER_COURT = 4
MAX_ON_COURT = MAX_COURTS * PLAYERS_PER_COURT   # 24 players play at once (6 courts)
MAX_PLAYERS = 40                                 # registered cap; extras rotate through byes


@dataclass(frozen=True)
class Player:
    name: str
    level: float


@dataclass
class Match:
    court: int                      # 1-indexed court number within the round
    team_a: Tuple[int, int]         # player indices
    team_b: Tuple[int, int]

    def all_indices(self) -> Tuple[int, int, int, int]:
        return (*self.team_a, *self.team_b)


@dataclass
class Round:
    number: int
    matches: List[Match] = field(default_factory=list)
    byes: List[int] = field(default_factory=list)


@dataclass
class Schedule:
    players: List[Player]
    rounds: List[Round]
    cost: float

    # ---- reporting helpers -------------------------------------------------
    def team_level(self, team: Tuple[int, int]) -> float:
        return self.players[team[0]].level + self.players[team[1]].level

    def court_spread(self, match: Match) -> float:
        levels = [self.players[i].level for i in match.all_indices()]
        return max(levels) - min(levels)

    def team_gap(self, match: Match) -> float:
        return abs(self.team_level(match.team_a) - self.team_level(match.team_b))

    def partner_repeats(self) -> List[Tuple[str, str]]:
        """Return list of any teammate pairs that occur more than once (should be empty)."""
        seen = set()
        repeats = []
        for rnd in self.rounds:
            for m in rnd.matches:
                for team in (m.team_a, m.team_b):
                    key = frozenset(team)
                    if key in seen:
                        a, b = tuple(team)
                        repeats.append((self.players[a].name, self.players[b].name))
                    seen.add(key)
        return repeats

    def player_stats(self) -> List[dict]:
        stats = []
        for idx, p in enumerate(self.players):
            partners, opponents, matches_played, byes = [], [], 0, 0
            for rnd in self.rounds:
                if idx in rnd.byes:
                    byes += 1
                for m in rnd.matches:
                    if idx in m.team_a or idx in m.team_b:
                        matches_played += 1
                        team = m.team_a if idx in m.team_a else m.team_b
                        other = m.team_b if idx in m.team_a else m.team_a
                        partners += [self.players[j].name for j in team if j != idx]
                        opponents += [self.players[j].name for j in other]
            stats.append({
                "name": p.name,
                "level": p.level,
                "matches": matches_played,
                "byes": byes,
                "partners": partners,
                "opponents": opponents,
            })
        return stats


class ScheduleError(ValueError):
    pass


def _active_count(n: int) -> int:
    """How many players actually play each round (largest multiple of 4, capped at 24)."""
    return min(PLAYERS_PER_COURT * (n // PLAYERS_PER_COURT), MAX_COURTS * PLAYERS_PER_COURT)


def _validate(players: List[Player], num_rounds: int) -> None:
    n = len(players)
    if n > MAX_PLAYERS:
        raise ScheduleError(f"Too many players: {n}. The cap is {MAX_PLAYERS}.")
    if n < PLAYERS_PER_COURT:
        raise ScheduleError(f"Need at least {PLAYERS_PER_COURT} players to form a doubles match; got {n}.")
    # Each player needs `num_rounds` distinct partners, drawn from n-1 others.
    if n - 1 < num_rounds:
        raise ScheduleError(
            f"With {n} players you cannot give everyone {num_rounds} unique partners "
            f"(only {n - 1} other players exist). Reduce the number of rounds or add players."
        )


def _choose_byes(n: int, active: int, bye_counts: List[int], rng: random.Random) -> List[int]:
    """Pick which players sit out this round, favouring those with the fewest byes so far."""
    num_byes = n - active
    if num_byes == 0:
        return []
    order = list(range(n))
    rng.shuffle(order)                       # break ties randomly
    order.sort(key=lambda i: bye_counts[i])  # fewest byes first
    return sorted(order[:num_byes])          # sit the players who've sat the least


def _build_round(
    players: List[Player],
    active: List[int],
    used_pairs: set,
    rng: random.Random,
) -> Optional[List[Match]]:
    """
    Build one round's matches from the active players.

    Groups similar-level players onto the same court, then splits each group of
    four into the two teams that (a) reuse no prior partnership and (b) are the
    most balanced. Returns None if a court cannot avoid a repeated partnership,
    signalling the caller to retry with fresh randomness.
    """
    levels = [players[i].level for i in range(len(players))]

    # Retry with growing jitter: small jitter keeps courts tight on level;
    # larger jitter shuffles groupings so partners can rotate across rounds.
    for attempt in range(40):
        jitter = 0.15 + 0.08 * attempt
        order = sorted(active, key=lambda i: levels[i] + rng.uniform(-jitter, jitter))
        groups = [order[k:k + PLAYERS_PER_COURT] for k in range(0, len(order), PLAYERS_PER_COURT)]

        matches: List[Match] = []
        round_pairs: List[frozenset] = []
        ok = True
        for court_no, group in enumerate(groups, start=1):
            g = sorted(group, key=lambda i: levels[i])
            a, b, c, d = g
            # All three ways to split four players into two teams:
            splits = [((a, b), (c, d)), ((a, c), (b, d)), ((a, d), (b, c))]
            best = None
            for t1, t2 in splits:
                p1, p2 = frozenset(t1), frozenset(t2)
                if p1 in used_pairs or p2 in used_pairs:
                    continue
                gap = abs((levels[t1[0]] + levels[t1[1]]) - (levels[t2[0]] + levels[t2[1]]))
                if best is None or gap < best[0]:
                    best = (gap, t1, t2, p1, p2)
            if best is None:
                ok = False
                break
            matches.append(Match(court=court_no, team_a=best[1], team_b=best[2]))
            round_pairs += [best[3], best[4]]

        if ok:
            used_pairs.update(round_pairs)
            return matches

    return None


def _schedule_cost(players: List[Player], rounds: List[Round]) -> float:
    """Lower is better. Court level-spread dominates; team imbalance is a tie-breaker."""
    levels = [p.level for p in players]
    cost = 0.0
    for rnd in rounds:
        for m in rnd.matches:
            idxs = m.all_indices()
            grp = [levels[i] for i in idxs]
            spread = max(grp) - min(grp)
            gap = abs((levels[m.team_a[0]] + levels[m.team_a[1]])
                      - (levels[m.team_b[0]] + levels[m.team_b[1]]))
            cost += spread * 10.0 + gap
    return cost


def generate_schedule(
    players: List[Player],
    num_rounds: int = 5,
    seed: Optional[int] = None,
    restarts: int = 6000,
) -> Schedule:
    """
    Produce a balanced, conflict-free schedule.

    Runs many randomized constructions and keeps the lowest-cost one that has
    zero repeated partnerships. Raises ScheduleError if the inputs are invalid
    or (extremely unlikely for valid inputs) no conflict-free schedule is found.
    """
    _validate(players, num_rounds)

    n = len(players)
    active_n = _active_count(n)
    master_rng = random.Random(seed)

    best_schedule: Optional[Schedule] = None

    for _ in range(restarts):
        rng = random.Random(master_rng.random())
        used_pairs: set = set()
        bye_counts = [0] * n
        rounds: List[Round] = []
        failed = False

        for r in range(1, num_rounds + 1):
            byes = _choose_byes(n, active_n, bye_counts, rng)
            for i in byes:
                bye_counts[i] += 1
            active = [i for i in range(n) if i not in set(byes)]

            matches = _build_round(players, active, used_pairs, rng)
            if matches is None:
                failed = True
                break
            rounds.append(Round(number=r, matches=matches, byes=byes))

        if failed:
            continue

        cost = _schedule_cost(players, rounds)
        if best_schedule is None or cost < best_schedule.cost:
            best_schedule = Schedule(players=players, rounds=rounds, cost=cost)
            if cost == 0:
                break  # perfect balance, cannot improve

    if best_schedule is None:
        raise ScheduleError(
            "Could not build a schedule without repeating partners. "
            "Try fewer rounds or a different roster size."
        )

    # Safety net: the hard constraint must hold.
    repeats = best_schedule.partner_repeats()
    if repeats:
        raise ScheduleError(f"Internal error: repeated partnerships slipped through: {repeats}")

    return best_schedule
