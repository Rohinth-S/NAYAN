"""Circuit breaker around a single sanitized reasoning call.

The breaker never retries a request, never changes privacy.grade, and never
substitutes an unsanitized payload. Timeouts and concurrency are bounded; an
open circuit fails closed until a single half-open probe is allowed.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from enum import StrEnum
from typing import TypeVar

from app.gateways.ollama import ReasonerUnavailable

T = TypeVar("T")


class CircuitState(StrEnum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


class CircuitOpen(RuntimeError):
    pass


class CircuitBreaker:
    def __init__(
        self,
        *,
        failure_threshold: int = 3,
        open_seconds: float = 30.0,
        timeout_seconds: float = 90.0,
        max_concurrency: int = 2,
        half_open_max_calls: int = 1,
    ) -> None:
        if failure_threshold < 1 or half_open_max_calls < 1 or max_concurrency < 1:
            raise ValueError("circuit breaker limits must be positive")
        self.failure_threshold = failure_threshold
        self.open_seconds = open_seconds
        self.timeout_seconds = timeout_seconds
        self.half_open_max_calls = half_open_max_calls
        self._state = CircuitState.CLOSED
        self._failures = 0
        self._opened_until = 0.0
        self._half_open_inflight = 0
        self._lock = asyncio.Lock()
        self._concurrency = asyncio.Semaphore(max_concurrency)

    @property
    def state(self) -> CircuitState:
        return self._state

    def is_blocking(self) -> bool:
        if self._state != CircuitState.OPEN:
            return False
        return time.monotonic() < self._opened_until

    async def call(self, func: Callable[..., Awaitable[T]], *args: object) -> T:
        async with self._lock:
            now = time.monotonic()
            if self._state == CircuitState.OPEN:
                if now < self._opened_until:
                    raise CircuitOpen("reasoning_circuit_open")
                self._state = CircuitState.HALF_OPEN
                self._half_open_inflight = 0
            if self._state == CircuitState.HALF_OPEN:
                if self._half_open_inflight >= self.half_open_max_calls:
                    raise CircuitOpen("reasoning_circuit_half_open_busy")
                self._half_open_inflight += 1
        try:
            async with self._concurrency:
                result = await asyncio.wait_for(func(*args), timeout=self.timeout_seconds)
        except TimeoutError:
            await self._record_failure()
            raise
        except Exception as exc:
            # Invalid JSON or a schema error means the backend answered. Count
            # only unavailability so a malformed reply cannot disable the model.
            if isinstance(exc, ReasonerUnavailable):
                await self._record_failure()
            else:
                await self._record_success()
            raise
        else:
            await self._record_success()
            return result

    async def _record_success(self) -> None:
        async with self._lock:
            self._failures = 0
            self._state = CircuitState.CLOSED
            self._half_open_inflight = 0

    async def _record_failure(self) -> None:
        async with self._lock:
            if self._state == CircuitState.HALF_OPEN:
                self._open_locked()
                return
            self._failures += 1
            if self._failures >= self.failure_threshold:
                self._open_locked()

    def _open_locked(self) -> None:
        self._state = CircuitState.OPEN
        self._opened_until = time.monotonic() + self.open_seconds
        self._half_open_inflight = 0
