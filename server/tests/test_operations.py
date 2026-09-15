from __future__ import annotations

import httpx
import pytest
from conftest import FakeReasoner, observation_payload

from app.main import create_app
from app.settings import Settings


@pytest.mark.asyncio
async def test_reasoning_rate_limit_rejects_before_model_invocation() -> None:
    reasoner = FakeReasoner()
    settings = Settings(rate_limit_requests=1, rate_limit_window_seconds=60)
    app = create_app(settings, reasoner)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        first = await client.post("/v1/reason", json=observation_payload())
        second = await client.post(
            "/v1/reason",
            json=observation_payload(snapshotId="33333333-3333-4333-8333-333333333333"),
        )
    assert first.status_code == 200
    assert second.status_code == 429
    assert second.json() == {"detail": "rate_limit_exceeded"}


@pytest.mark.asyncio
async def test_metrics_are_aggregate_only_and_do_not_expose_snapshot_or_body() -> None:
    app = create_app(Settings(), FakeReasoner())
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post("/v1/reason", json=observation_payload())
        metrics = await client.get("/health/metrics")
    assert response.status_code == 200
    assert metrics.status_code == 200
    body = metrics.text
    assert "reasoning.received" in body
    assert "11111111-1111-4111-8111-111111111111" not in body
    assert "Benefits portal" not in body
    assert "dataBase64" not in body
