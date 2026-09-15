from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

from app.schemas import ReasoningResponse


class SQLiteJobLedger:
    """Metadata-only restart ledger; sanitized observations are never persisted."""

    def __init__(self, path: str) -> None:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(target, check_same_thread=False)
        self._connection.execute(
            """CREATE TABLE IF NOT EXISTS reasoning_jobs (
                job_id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, state TEXT NOT NULL,
                response_json TEXT, failure_status INTEGER, failure_code TEXT, updated_at REAL NOT NULL
            )"""
        )
        self._connection.execute(
            "UPDATE reasoning_jobs SET state='failed', failure_status=503, "
            "failure_code='server_restarted', updated_at=? WHERE state='pending'",
            (time.time(),),
        )
        self._connection.commit()

    def pending(self, job_id: str, snapshot_id: str) -> None:
        self._connection.execute(
            "INSERT INTO reasoning_jobs(job_id,snapshot_id,state,updated_at) VALUES(?,?,?,?)",
            (job_id, snapshot_id, "pending", time.time()),
        )
        self._connection.commit()

    def success(self, job_id: str, response: ReasoningResponse) -> None:
        self._connection.execute(
            "UPDATE reasoning_jobs SET state='succeeded', response_json=?, updated_at=? WHERE job_id=?",
            (response.model_dump_json(), time.time(), job_id),
        )
        self._connection.commit()

    def failure(self, job_id: str, status: int, code: str) -> None:
        self._connection.execute(
            "UPDATE reasoning_jobs SET state='failed', failure_status=?, failure_code=?, "
            "updated_at=? WHERE job_id=?",
            (status, code, time.time(), job_id),
        )
        self._connection.commit()

    def get(self, job_id: str) -> tuple[str, str, ReasoningResponse | None, int | None, str | None] | None:
        row = self._connection.execute(
            "SELECT snapshot_id,state,response_json,failure_status,failure_code "
            "FROM reasoning_jobs WHERE job_id=?",
            (job_id,),
        ).fetchone()
        if row is None:
            return None
        response = ReasoningResponse.model_validate(json.loads(row[2])) if row[2] else None
        return row[0], row[1], response, row[3], row[4]

    def close(self) -> None:
        self._connection.close()
