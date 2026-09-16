from __future__ import annotations

import asyncio
import time
from collections import defaultdict, deque
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import redis.asyncio as redis


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


LUA_SLIDING_WINDOW = """
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local current = redis.call('ZCARD', key)

if current >= limit then
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    if oldest and oldest[2] then
        return {0, math.max(1, math.ceil(tonumber(oldest[2]) + window - now))}
    else
        return {0, math.max(1, math.ceil(window))}
    end
else
    redis.call('ZADD', key, now, now)
    redis.call('EXPIRE', key, math.ceil(window) + 1)
    return {1, 0}
end
"""


class RedisRateLimiter:
    """Bounded redis-backed limiter for production multi-instance profile."""

    def __init__(self, redis_client: redis.Redis, limit: int, window_seconds: float) -> None:
        self.redis = redis_client
        self.limit = limit
        self.window_seconds = window_seconds
        # Register the script once
        self._script = self.redis.register_script(LUA_SLIDING_WINDOW)

    async def allow(self, key: str) -> tuple[bool, int]:
        now = time.time()
        redis_key = f"ratelimit:{key}"
        result = await self._script(
            keys=[redis_key],
            args=[self.limit, self.window_seconds, now]
        )
        allowed, retry_after = result
        return bool(allowed), int(retry_after)
