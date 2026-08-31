#!/usr/bin/env bash
# Launch the Tennis Doubles Mixer Scheduler.
# First run sets up a virtual environment and installs dependencies.
set -e
cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
  echo "Setting up virtual environment (first run only)..."
  python3 -m venv .venv
  ./.venv/bin/pip install --quiet --upgrade pip
  ./.venv/bin/pip install --quiet -r requirements.txt
fi

exec ./.venv/bin/streamlit run app.py
