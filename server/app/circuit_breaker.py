import asyncio
import time
from enum import Enum
from typing import Callable, Awaitable, Any, TypeVar

T = TypeVar('T')

class CircuitState(Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"

class CircuitBreakerError(Exception):
    pass

class CircuitBreaker:
    """Half-open circuit breaker state machine for model gateways."""
    def __init__(self, failure_threshold: int = 3, recovery_timeout: float = 10.0):
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        
        self.state = CircuitState.CLOSED
        self.failure_count = 0
        self.last_failure_time = 0.0

    async def call(self, func: Callable[[], Awaitable[T]], *args: Any, **kwargs: Any) -> T:
        now = time.monotonic()
        
        if self.state == CircuitState.OPEN:
            if now - self.last_failure_time >= self.recovery_timeout:
                self.state = CircuitState.HALF_OPEN
            else:
                raise CircuitBreakerError("Circuit is OPEN. Fast failing.")
                
        try:
            result = await func(*args, **kwargs)
        except Exception as e:
            self._record_failure(now)
            raise e
            
        self._record_success()
        return result

    def _record_failure(self, now: float) -> None:
        self.last_failure_time = now
        if self.state == CircuitState.HALF_OPEN:
            self.state = CircuitState.OPEN
        else:
            self.failure_count += 1
            if self.failure_count >= self.failure_threshold:
                self.state = CircuitState.OPEN

    def _record_success(self) -> None:
        self.failure_count = 0
        self.state = CircuitState.CLOSED
