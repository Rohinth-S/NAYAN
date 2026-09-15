from __future__ import annotations

import asyncio
import hashlib

from app.schemas import ActionType, DemoState, SanitizedObservation


class VerificationStore:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._submitted = False
        self._reason_request_count = 0
        self._last_snapshot_digest: str | None = None
        self._last_redaction_count = 0
        self._last_action_type: ActionType | None = None

    async def reset(self) -> DemoState:
        async with self._lock:
            self._submitted = False
            self._reason_request_count = 0
            self._last_snapshot_digest = None
            self._last_redaction_count = 0
            self._last_action_type = None
            return self._snapshot()

    async def record_reason(self, observation: SanitizedObservation, action_type: ActionType) -> None:
        async with self._lock:
            self._reason_request_count += 1
            self._last_snapshot_digest = hashlib.sha256(observation.snapshotId.encode()).hexdigest()[:16]
            self._last_redaction_count = len(observation.redactions)
            self._last_action_type = action_type

    async def mark_submitted(self) -> DemoState:
        async with self._lock:
            self._submitted = True
            return self._snapshot()

    async def get(self) -> DemoState:
        async with self._lock:
            return self._snapshot()

    def _snapshot(self) -> DemoState:
        return DemoState(
            submitted=self._submitted,
            reasonRequestCount=self._reason_request_count,
            lastSnapshotDigest=self._last_snapshot_digest,
            lastRedactionCount=self._last_redaction_count,
            lastActionType=self._last_action_type,
        )
