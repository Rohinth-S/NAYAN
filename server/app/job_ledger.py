from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import redis.asyncio as redis

from app.schemas import ReasoningResponse

LedgerRecord = tuple[str, str, ReasoningResponse | None, int | None, str | None]


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

    async def pending(self, job_id: str, snapshot_id: str) -> None:
        self._connection.execute(
            "INSERT INTO reasoning_jobs(job_id,snapshot_id,state,updated_at) VALUES(?,?,?,?)",
            (job_id, snapshot_id, "pending", time.time()),
        )
        self._connection.commit()

    async def success(self, job_id: str, response: ReasoningResponse) -> None:
        self._connection.execute(
            "UPDATE reasoning_jobs SET state='succeeded', response_json=?, updated_at=? WHERE job_id=?",
            (response.model_dump_json(), time.time(), job_id),
        )
        self._connection.commit()

    async def failure(self, job_id: str, status: int, code: str) -> None:
        self._connection.execute(
            "UPDATE reasoning_jobs SET state='failed', failure_status=?, failure_code=?, "
            "updated_at=? WHERE job_id=?",
            (status, code, time.time(), job_id),
        )
        self._connection.commit()

    async def get(
        self, job_id: str
    ) -> LedgerRecord | None:
        row = self._connection.execute(
            "SELECT snapshot_id,state,response_json,failure_status,failure_code "
            "FROM reasoning_jobs WHERE job_id=?",
            (job_id,),
        ).fetchone()
        if row is None:
            return None
        response = ReasoningResponse.model_validate(json.loads(row[2])) if row[2] else None
        return row[0], row[1], response, row[3], row[4]

    async def close(self) -> None:
        self._connection.close()


class RedisJobLedger:
    """Redis-backed durable ledger for multi-instance failover."""

    def __init__(self, redis_client: redis.Redis) -> None:
        self._redis = redis_client

    async def pending(self, job_id: str, snapshot_id: str) -> None:
        await self._redis.hset(
            f"job:{job_id}",
            mapping={
                "snapshot_id": snapshot_id,
                "state": "pending",
                "updated_at": time.time(),
            },
        )
        await self._redis.expire(f"job:{job_id}", 3600)  # 1 hour TTL

    async def success(self, job_id: str, response: ReasoningResponse) -> None:
        await self._redis.hset(
            f"job:{job_id}",
            mapping={
                "state": "succeeded",
                "response_json": response.model_dump_json(),
                "updated_at": time.time(),
            },
        )

    async def failure(self, job_id: str, status: int, code: str) -> None:
        await self._redis.hset(
            f"job:{job_id}",
            mapping={
                "state": "failed",
                "failure_status": str(status),
                "failure_code": code,
                "updated_at": time.time(),
            },
        )

    async def get(
        self, job_id: str
    ) -> LedgerRecord | None:
        data = await self._redis.hgetall(f"job:{job_id}")
        if not data:
            return None

        # Redis returns bytes or decoded strings depending on decode_responses
        def decode(v: bytes | str | None) -> str | None:
            if v is None:
                return None
            if isinstance(v, bytes):
                return v.decode("utf-8")
            return str(v)

        snapshot_id = decode(data.get(b"snapshot_id", data.get("snapshot_id")))
        state = decode(data.get(b"state", data.get("state")))
        response_json = decode(data.get(b"response_json", data.get("response_json")))
        failure_status_str = decode(data.get(b"failure_status", data.get("failure_status")))
        failure_code = decode(data.get(b"failure_code", data.get("failure_code")))

        if not snapshot_id or not state:
            return None

        response = ReasoningResponse.model_validate(json.loads(response_json)) if response_json else None
        failure_status = int(failure_status_str) if failure_status_str else None

        return snapshot_id, state, response, failure_status, failure_code

    async def close(self) -> None:
        pass
