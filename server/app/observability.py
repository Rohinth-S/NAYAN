from __future__ import annotations

import asyncio
from collections import Counter


class PrivacyMetrics:
    """Process-local counters containing no request, URL, label, or job data."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._counters: Counter[str] = Counter()

    async def increment(self, name: str, amount: int = 1) -> None:
        async with self._lock:
            self._counters[name] += amount

    async def snapshot(self) -> dict[str, int]:
        async with self._lock:
            return dict(sorted(self._counters.items()))
