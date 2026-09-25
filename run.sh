#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESET='\033[0m'
CYAN='\033[36m'
GREEN='\033[32m'
YELLOW='\033[33m'
DIM='\033[2m'

if [[ ! -t 1 ]]; then
  RESET=''
  CYAN=''
  GREEN=''
  YELLOW=''
  DIM=''
fi

say() { printf "%b%s%b\n" "$1" "$2" "$RESET"; }

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun is required to run this project. Install Bun and try again."
  exit 1
fi

if [[ ! -f "$ROOT/backend/.env" ]]; then
  echo "Missing backend/.env. Copy backend/.env.example to backend/.env and set IMPOSSIBL_API_KEY."
  exit 1
fi

printf "\n%b  JEV VOICE BROWSER AGENT%b\n" "$CYAN" "$RESET"
printf "%b  Starting the local browser agent%b\n\n" "$DIM" "$RESET"

if [[ ! -x "$ROOT/backend/node_modules/.bin/tsx" ]]; then
  say "$YELLOW" "Installing backend dependencies..."
  (cd "$ROOT/backend" && bun install) || exit $?
else
  say "$GREEN" "Backend dependencies are ready."
fi

if [[ ! -x "$ROOT/frontend/node_modules/.bin/next" ]]; then
  say "$YELLOW" "Installing frontend dependencies..."
  (cd "$ROOT/frontend" && bun install) || exit $?
else
  say "$GREEN" "Frontend dependencies are ready."
fi

pids=()
cleanup() {
  trap - INT TERM EXIT
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

printf "\n%b  Frontend  %bhttp://localhost:3000%b\n" "$CYAN" "$GREEN" "$RESET"
printf "%b  Backend   %bhttp://127.0.0.1:8787%b\n\n" "$CYAN" "$GREEN" "$RESET"
printf "%b  Press Ctrl+C to stop both servers.%b\n\n" "$DIM" "$RESET"

(cd "$ROOT/backend" && bun run dev) &
pids+=("$!")
(cd "$ROOT/frontend" && bun run dev) &
pids+=("$!")

wait -n "${pids[@]}"
