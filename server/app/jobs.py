from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Literal

from app.job_ledger import RedisJobLedger, SQLiteJobLedger
from app.schemas import ReasoningResponse

LOGGER = logging.getLogger("privacy_server")
JobState = Literal["pending", "succeeded", "failed"]
JobRunner = Callable[[], Awaitable[ReasoningResponse]]


class ReasoningJobError(Exception):
    def __init__(self, status_code: int, code: str) -> None:
        super().__init__(code)
        self.status_code = status_code
        self.code = code


class ReasoningQueueFull(Exception):
    pass


class ReasoningJobNotFound(Exception):
    pass


@dataclass(frozen=True, slots=True)
class ReasoningJobView:
    job_id: str
    snapshot_id: str
    state: JobState
    response: ReasoningResponse | None = None
    failure_status: int | None = None
    failure_code: str | None = None


@dataclass(slots=True)
class _ReasoningJob:
    job_id: str
    snapshot_id: str
    created_at: float
    updated_at: float
    state: JobState = "pending"
    response: ReasoningResponse | None = None
    failure_status: int | None = None
    failure_code: str | None = None
    task: asyncio.Task[None] | None = None
    changed: asyncio.Event = field(default_factory=asyncio.Event)


class ReasoningJobStore:
    """Bounded in-memory jobs containing sanitized observations only through runner closures."""

    def __init__(
        self,
        *,
        max_jobs: int,
        ttl_seconds: float,
        max_concurrent: int,
        ledger: SQLiteJobLedger | RedisJobLedger | None = None,
    ) -> None:
        self._max_jobs = max_jobs
        self._ttl_seconds = ttl_seconds
        self._jobs: dict[str, _ReasoningJob] = {}
        self._lock = asyncio.Lock()
        self._semaphore = asyncio.Semaphore(max_concurrent)
        self._closed = False
        self._ledger = ledger

    def _expire_locked(self, now: float) -> None:
        expired = [job_id for job_id, job in self._jobs.items() if now - job.updated_at >= self._ttl_seconds]
        for job_id in expired:
            job = self._jobs.pop(job_id)
            job.changed.set()
            if job.task is not None and not job.task.done():
                job.task.cancel()

    def _make_room_locked(self) -> None:
        if len(self._jobs) < self._max_jobs:
            return
        completed = sorted(
            (job for job in self._jobs.values() if job.state != "pending"),
            key=lambda job: job.updated_at,
        )
        while len(self._jobs) >= self._max_jobs and completed:
            evicted = self._jobs.pop(completed.pop(0).job_id, None)
            if evicted is not None:
                evicted.changed.set()
        if len(self._jobs) >= self._max_jobs:
            raise ReasoningQueueFull

    async def submit(self, snapshot_id: str, runner: JobRunner) -> ReasoningJobView:
        now = time.monotonic()
        async with self._lock:
            if self._closed:
                raise ReasoningQueueFull
            self._expire_locked(now)
            self._make_room_locked()
            job_id = str(uuid.uuid4())
            job = _ReasoningJob(
                job_id=job_id,
                snapshot_id=snapshot_id,
                created_at=now,
                updated_at=now,
            )
            self._jobs[job_id] = job
            if self._ledger is not None:
                await self._ledger.pending(job_id, snapshot_id)
            job.task = asyncio.create_task(self._execute(job_id, runner), name="sanitized-reasoning-job")
            return self._view(job)

    async def _execute(self, job_id: str, runner: JobRunner) -> None:
        try:
            async with self._semaphore:
                response = await runner()
        except asyncio.CancelledError:
            raise
        except ReasoningJobError as exc:
            await self._finish_failure(job_id, exc.status_code, exc.code)
        except Exception as exc:
            LOGGER.error("reasoning_job_failed type=%s", type(exc).__name__)
            await self._finish_failure(job_id, 500, "service_error")
        else:
            await self._finish_success(job_id, response)

    async def _finish_success(self, job_id: str, response: ReasoningResponse) -> None:
        async with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            job.state = "succeeded"
            job.response = response
            job.updated_at = time.monotonic()
            job.task = None
            job.changed.set()
            if self._ledger is not None:
                await self._ledger.success(job_id, response)

    async def _finish_failure(self, job_id: str, status_code: int, code: str) -> None:
        async with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            job.state = "failed"
            job.failure_status = status_code
            job.failure_code = code
            job.updated_at = time.monotonic()
            job.task = None
            job.changed.set()
            if self._ledger is not None:
                await self._ledger.failure(job_id, status_code, code)

    async def get(self, job_id: str, *, wait_seconds: float = 0) -> ReasoningJobView:
        try:
            parsed = uuid.UUID(job_id)
        except ValueError:
            raise ReasoningJobNotFound from None
        if parsed.version != 4 or str(parsed) != job_id:
            raise ReasoningJobNotFound
        async with self._lock:
            self._expire_locked(time.monotonic())
            job = self._jobs.get(job_id)
            if job is None:
                if self._ledger is None:
                    raise ReasoningJobNotFound
                durable = await self._ledger.get(job_id)
                if durable is None:
                    raise ReasoningJobNotFound
                snapshot_id, state, response, failure_status, failure_code = durable
                return ReasoningJobView(job_id, snapshot_id, state, response, failure_status, failure_code)
            if job.state != "pending" or wait_seconds <= 0:
                return self._view(job)
            changed = job.changed
        try:
            await asyncio.wait_for(changed.wait(), timeout=wait_seconds)
        except TimeoutError:
            pass
        async with self._lock:
            self._expire_locked(time.monotonic())
            job = self._jobs.get(job_id)
            if job is None:
                raise ReasoningJobNotFound
            return self._view(job)

    @staticmethod
    def _view(job: _ReasoningJob) -> ReasoningJobView:
        return ReasoningJobView(
            job_id=job.job_id,
            snapshot_id=job.snapshot_id,
            state=job.state,
            response=job.response,
            failure_status=job.failure_status,
            failure_code=job.failure_code,
        )

    async def close(self) -> None:
        async with self._lock:
            self._closed = True
            for job in self._jobs.values():
                job.changed.set()
            tasks = [job.task for job in self._jobs.values() if job.task is not None]
            self._jobs.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
