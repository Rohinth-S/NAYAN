from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from conftest import SNAPSHOT_ID, SUBMIT_ID, observation_payload

from app.ollama import OllamaReasoner, ReasonerInvalidResponse
from app.schemas import SanitizedObservation


@pytest.mark.asyncio
async def test_ollama_receives_sanitized_image_and_structured_contract_only() -> None:
    captured: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        content = json.dumps(
            {
                "schemaVersion": "1.0",
                "snapshotId": SNAPSHOT_ID,
                "action": {"type": "click", "elementId": SUBMIT_ID},
            }
        )
        return httpx.Response(200, json={"message": {"role": "assistant", "content": content}})

    reasoner = OllamaReasoner("http://127.0.0.1:11434", "qwen3-vl:2b-instruct", 10)
    await reasoner.close()
    reasoner._client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://ollama")
    observation = SanitizedObservation.model_validate(observation_payload())
    try:
        response = await reasoner.reason(observation)
    finally:
        await reasoner.close()

    assert response.action.type == "click"
    assert captured["model"] == "qwen3-vl:2b-instruct"
    assert captured["stream"] is False
    assert captured["think"] is False
    assert captured["options"] == {"temperature": 0, "num_ctx": 4096}
    messages = captured["messages"]
    assert isinstance(messages, list)
    assert messages[1]["images"] == [observation.image.dataBase64]
    assert observation.image.dataBase64 not in messages[1]["content"]
    model_context = json.loads(messages[1]["content"].split("\n", 1)[1])
    assert model_context["privacy"]["grade"] == 3
    assert "Never infer, reconstruct, guess" in messages[0]["content"]
    assert captured["format"]["additionalProperties"] is False
    assert "$defs" not in captured["format"]


@pytest.mark.asyncio
async def test_ollama_markdown_or_non_schema_output_fails_closed() -> None:
    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "message": {
                    "role": "assistant",
                    "content": '```json\n{"action":{"type":"done"}}\n```',
                }
            },
        )

    reasoner = OllamaReasoner("http://127.0.0.1:11434", "qwen3-vl:2b-instruct", 10)
    await reasoner.close()
    reasoner._client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://ollama")
    try:
        with pytest.raises(ReasonerInvalidResponse):
            await reasoner.reason(SanitizedObservation.model_validate(observation_payload()))
    finally:
        await reasoner.close()


@pytest.mark.asyncio
async def test_readiness_requires_exact_configured_model() -> None:
    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"models": [{"name": "another-model:latest"}]})

    reasoner = OllamaReasoner("http://127.0.0.1:11434", "qwen3-vl:2b-instruct", 10)
    await reasoner.close()
    reasoner._client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://ollama")
    try:
        assert await reasoner.ready() is False
    finally:
        await reasoner.close()
