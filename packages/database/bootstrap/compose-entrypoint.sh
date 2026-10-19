#!/bin/sh
# Waits for Postgres over TCP (up to 30 seconds), then runs psql with the arguments given to this script.
set -eu

# Unix time (in seconds) when we stop trying
deadline=$(( $(date +%s) + 30 ))

while [ "$(date +%s)" -lt "$deadline" ]; do
  # -t 1: give up on a single try after 1 second
  if pg_isready -h postgres -U postgres -d ledger -t 1; then
    # exec replaces this script with psql, so psql's exit code becomes ours
    exec psql "$@"
  fi
  sleep 1
done

echo "Postgres is not ready after 30 seconds" >&2
exit 1