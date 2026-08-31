"""Generate a sample 24-player roster spreadsheet for testing/demo."""

import random

import pandas as pd

FIRST = ["Alex", "Sam", "Jordan", "Taylor", "Casey", "Morgan", "Riley", "Jamie",
         "Avery", "Quinn", "Cameron", "Drew", "Reese", "Skyler", "Parker", "Rowan",
         "Emerson", "Finley", "Harper", "Kai", "Logan", "Micah", "Noel", "Sage"]
LEVELS = [2.5, 3.0, 3.5, 4.0, 4.5, 5.0]


def make(n: int = 24, seed: int = 7) -> pd.DataFrame:
    rng = random.Random(seed)
    names = FIRST[:n]
    # Weighted toward the middle of the NTRP range, like a real club.
    weights = [1, 3, 5, 5, 3, 1]
    levels = [rng.choices(LEVELS, weights=weights)[0] for _ in names]
    return pd.DataFrame({"Name": names, "Level": levels})


if __name__ == "__main__":
    df = make()
    df.to_excel("sample_players.xlsx", index=False)
    print(f"Wrote sample_players.xlsx with {len(df)} players")
    print(df.to_string(index=False))
