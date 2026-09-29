#!/usr/bin/env bash
set -e

echo "========================================================"
echo "  Sonetel Power Dialer & Pipeline — macOS Local Server  "
echo "========================================================"

if [ ! -d ".venv" ]; then
  echo "→ Creating Python virtual environment (.venv)..."
  python3 -m venv .venv
fi

echo "→ Activating virtual environment & verifying dependencies..."
source .venv/bin/activate
pip install --upgrade pip -q
pip install -r requirements.txt -q

echo "→ Launching FastAPI server at http://127.0.0.1:8000 ..."
if command -v open >/dev/null 2>&1; then
  (sleep 1.5 && open "http://127.0.0.1:8000") &
fi

exec uvicorn main:app --host 0.0.0.0 --port 8000 --reload
