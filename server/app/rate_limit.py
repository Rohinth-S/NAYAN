from __future__ import annotations

import asyncio
import time
from collections import defaultdict, deque


class SlidingWindowRateLimiter:
    """Bounded in-memory limiter for the single-instance development profile."""

    def __init__(self, limit: int, window_seconds: float, max_clients: int = 10_000) -> None:
        self.limit = limit
        self.window_seconds = window_seconds
        self.max_clients = max_clients
        self._events: dict[str, deque[float]] = defaultdict(deque)
        self._lock = asyncio.Lock()

    async def allow(self, key: str) -> tuple[bool, int]:
        now = time.monotonic()
        async with self._lock:
            if key not in self._events and len(self._events) >= self.max_clients:
                oldest = min(
                    self._events,
                    key=lambda item: self._events[item][-1] if self._events[item] else now,
                )
                self._events.pop(oldest, None)
            events = self._events[key]
            cutoff = now - self.window_seconds
            while events and events[0] <= cutoff:
                events.popleft()
            if len(events) >= self.limit:
                retry_after = max(1, int(events[0] + self.window_seconds - now + 0.999))
                return False, retry_after
            events.append(now)
            return True, 0
