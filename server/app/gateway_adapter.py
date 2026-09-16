"""Strict sanitized-protocol gateway for offline or explicitly hosted models.

The operator chooses one endpoint; there is no provider discovery or automatic
fallback. A gateway must expose the reviewed manifest at /v1/model-manifest.
"""

from __future__ import annotations

from dataclasses import asdict
from urllib.parse import urlsplit

import httpx

from app.gateways.ollama import MODEL_PROMPT_VERSION, ReasonerInvalidResponse, ReasonerUnavailable
from app.model_adapter import ModelManifest, validate_adapter_response
from app.schemas import ReasoningResponse, SanitizedObservation
from app.settings import Settings
from app.validation import validate_observation


class GatewayReasoner:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.model = settings.ollama_model
        self.manifest = ModelManifest(
            "sanitized-gateway",
            self.model,
            settings.ollama_model_digest,
            MODEL_PROMPT_VERSION,
            urlsplit(settings.gateway_url or "").hostname in {"localhost", "127.0.0.1", "::1"},
        )
        self._client = httpx.AsyncClient(
            base_url=settings.gateway_url or "",
            timeout=settings.ollama_timeout_seconds,
            headers={"Authorization": "Bearer " + settings.gateway_api_key.get_secret_value()}
            if settings.gateway_api_key
            else {},
            follow_redirects=False,
            trust_env=False,
            limits=httpx.Limits(max_connections=4, max_keepalive_connections=2),
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def _bounded(self, method: str, path: str, **kwargs: object) -> bytes:
        async with self._client.stream(method, path, **kwargs) as response:
            response.raise_for_status()
            content = bytearray()
            async for chunk in response.aiter_bytes():
                content.extend(chunk)
                if len(content) > 20_000:
                    raise ReasonerInvalidResponse("model_response_too_large")
            return bytes(content)

    async def ready(self) -> bool:
        import json

        try:
            manifest = json.loads(await self._bounded("GET", "/v1/model-manifest"))
            return manifest == asdict(self.manifest)
        except (httpx.HTTPError, ValueError, ReasonerInvalidResponse):
            return False

    async def reason(self, observation: SanitizedObservation) -> ReasoningResponse:
        # Revalidate even direct adapter calls; a Pydantic instance alone does
        # not prove that its image masks and invariant text floor were checked.
        validate_observation(observation, self.settings)
        if not await self.ready():
            raise ReasonerUnavailable("reasoning_model_digest_unverified")
        try:
            content = await self._bounded("POST", "/v1/reason", json=observation.model_dump())
            return validate_adapter_response(ReasoningResponse.model_validate_json(content), observation)
        except httpx.HTTPError:
            raise ReasonerUnavailable("reasoning_backend_unavailable") from None
        except ValueError:
            raise ReasonerInvalidResponse("invalid_reasoning_response") from None
