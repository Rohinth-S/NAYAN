#!/bin/bash
# A lightweight cron script for cleaning up expired SIH Privacy Agent jobs.
# Intended to be run periodically via cron (e.g. `0 * * * * /path/to/retention-cron.sh`)

set -e

echo "[INFO] Running SIH Privacy Agent job retention cleanup at $(date)"

# Wait until the server provides an explicit retention API, 
# or clean up SQLite directly if in development mode.
DB_PATH=${PRIVACY_AGENT_JOB_LEDGER_PATH:-"jobs.sqlite3"}

if [ -f "$DB_PATH" ]; then
    echo "[INFO] Cleaning up expired jobs in SQLite: $DB_PATH"
    # Example: Delete jobs older than 24 hours
    sqlite3 "$DB_PATH" "DELETE FROM jobs WHERE datetime(created_at) < datetime('now', '-1 day');"
    echo "[INFO] SQLite cleanup complete."
fi

echo "[INFO] Retention cleanup job finished successfully."
