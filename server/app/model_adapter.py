"""Provider-neutral sanitized model adapter contract.

Adapters receive a validated SanitizedObservation and must return a validated
ReasoningResponse. The contract prevents a hosted or offline provider from
introducing a second payload shape or bypassing the action guard.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from app.schemas import ReasoningResponse, SanitizedObservation


@dataclass(frozen=True)
class ModelManifest:
    provider: str
    model_id: str
    model_digest: str | None
    prompt_version: str
    offline: bool


class SanitizedModelAdapter(Protocol):
    manifest: ModelManifest

    async def ready(self) -> bool: ...

    async def reason(self, observation: SanitizedObservation) -> ReasoningResponse: ...

    async def close(self) -> None: ...


def validate_adapter_response(
    response: ReasoningResponse, observation: SanitizedObservation
) -> ReasoningResponse:
    """Enforce protocol identity before the shared action guard runs."""
    if response.schemaVersion != observation.schemaVersion or response.snapshotId != observation.snapshotId:
        raise ValueError("model adapter returned a mismatched snapshot")
    return response
