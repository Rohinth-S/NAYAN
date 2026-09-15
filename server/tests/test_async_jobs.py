from __future__ import annotations

import asyncio
import logging
import uuid

import httpx
import pytest
from conftest import SNAPSHOT_ID, SUBMIT_ID, FakeReasoner, observation_payload
from pydantic import SecretStr

from app.jobs import ReasoningJobNotFound, ReasoningJobStore
from app.main import create_app, preferred_wait_seconds
from app.schemas import BrowserAction, ReasoningResponse, SanitizedObservation
from app.settings import Settings


async def poll_until_terminal(
    client: httpx.AsyncClient,
    job_id: str,
    *,
    headers: dict[str, str] | None = None,
) -> httpx.Response:
    for _ in range(20):
        response = await client.get(f"/v1/reason/{job_id}", headers=headers)
        if response.status_code != 202:
            return response
        await asyncio.sleep(0)
    raise AssertionError("reasoning job did not finish")


def test_long_poll_preference_is_strict_and_bounded() -> None:
    assert preferred_wait_seconds("wait=10") == 10
    assert preferred_wait_seconds("respond-async, WAIT=999") == 10
    assert preferred_wait_seconds("wait=-1") == 0
    assert preferred_wait_seconds("wait=1.5") == 0
    assert preferred_wait_seconds("wait=secret") == 0


@pytest.mark.asyncio
async def test_async_submit_returns_bounded_ticket_then_matching_result(
    client: httpx.AsyncClient,
    fake_reasoner: FakeReasoner,
) -> None:
    accepted = await client.post(
        "/v1/reason",
        json=observation_payload(),
        headers={"Prefer": "respond-async"},
    )
    assert accepted.status_code == 202
    ticket = accepted.json()
    assert ticket == {
        "schemaVersion": "1.0",
        "snapshotId": SNAPSHOT_ID,
        "jobId": ticket["jobId"],
        "status": "pending",
    }
    assert uuid.UUID(ticket["jobId"]).version == 4

    result = await poll_until_terminal(client, ticket["jobId"])
    assert result.status_code == 200
    assert result.json() == {
        "schemaVersion": "1.0",
        "snapshotId": SNAPSHOT_ID,
        "action": {"type": "click", "elementId": SUBMIT_ID},
    }
    assert fake_reasoner.seen is not None


@pytest.mark.asyncio
async def test_pending_poll_contains_no_observation_data(settings: Settings) -> None:
    release = asyncio.Event()

    class BlockingReasoner(FakeReasoner):
        async def reason(self, observation: SanitizedObservation) -> ReasoningResponse:
            self.seen = observation
            await release.wait()
            return await super().reason(observation)

    reasoner = BlockingReasoner()
    app = create_app(settings, reasoner)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        accepted = await client.post(
            "/v1/reason",
            json=observation_payload(task="PRIVATE_ASYNC_CANARY"),
            headers={"Prefer": "wait=1, RESPOND-ASYNC; handling=strict"},
        )
        ticket = accepted.json()
        pending = await client.get(f"/v1/reason/{ticket['jobId']}")
        assert pending.status_code == 202
        assert set(pending.json()) == {"schemaVersion", "snapshotId", "jobId", "status"}
        assert "PRIVATE_ASYNC_CANARY" not in pending.text
        release.set()
        assert (await poll_until_terminal(client, ticket["jobId"])).status_code == 200


@pytest.mark.asyncio
async def test_long_poll_returns_as_soon_as_reasoning_finishes(settings: Settings) -> None:
    release = asyncio.Event()

    class BlockingReasoner(FakeReasoner):
        async def reason(self, observation: SanitizedObservation) -> ReasoningResponse:
            await release.wait()
            return await super().reason(observation)

    app = create_app(settings, BlockingReasoner())
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        accepted = await client.post(
            "/v1/reason",
            json=observation_payload(),
            headers={"Prefer": "respond-async"},
        )
        poll = asyncio.create_task(
            client.get(
                f"/v1/reason/{accepted.json()['jobId']}",
                headers={"Prefer": "wait=10"},
            )
        )
        await asyncio.sleep(0)
        assert not poll.done()
        release.set()
        result = await asyncio.wait_for(poll, timeout=1)
    assert result.status_code == 200


@pytest.mark.asyncio
async def test_async_invalid_model_action_fails_closed(
    client: httpx.AsyncClient,
    fake_reasoner: FakeReasoner,
) -> None:
    fake_reasoner.response = ReasoningResponse(
        schemaVersion="1.0",
        snapshotId=SNAPSHOT_ID,
        action=BrowserAction(type="click", elementId="e_unknown_target_1234"),
    )
    accepted = await client.post(
        "/v1/reason",
        json=observation_payload(),
        headers={"Prefer": "respond-async"},
    )
    result = await poll_until_terminal(client, accepted.json()["jobId"])
    assert result.status_code == 502
    assert result.json() == {"detail": "invalid_reasoning_response"}


@pytest.mark.asyncio
async def test_async_queue_is_bounded(settings: Settings) -> None:
    release = asyncio.Event()

    class BlockingReasoner(FakeReasoner):
        async def reason(self, observation: SanitizedObservation) -> ReasoningResponse:
            await release.wait()
            return await super().reason(observation)

    bounded = settings.model_copy(
        update={"max_reasoning_jobs": 1, "max_concurrent_reasoning_jobs": 1}
    )
    app = create_app(bounded, BlockingReasoner())
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        first = await client.post(
            "/v1/reason", json=observation_payload(), headers={"Prefer": "respond-async"}
        )
        second = await client.post(
            "/v1/reason", json=observation_payload(), headers={"Prefer": "respond-async"}
        )
        assert first.status_code == 202
        assert second.status_code == 503
        assert second.json() == {"detail": "reasoning_queue_full"}
        release.set()
        assert (await poll_until_terminal(client, first.json()["jobId"])).status_code == 200


@pytest.mark.asyncio
async def test_sync_reasoning_shares_model_gate_and_times_out(settings: Settings) -> None:
    started = asyncio.Event()
    release = asyncio.Event()

    class BlockingReasoner(FakeReasoner):
        async def reason(self, observation: SanitizedObservation) -> ReasoningResponse:
            started.set()
            await release.wait()
            return await super().reason(observation)

    bounded = settings.model_copy(
        update={
            "max_concurrent_reasoning_jobs": 1,
            "reasoning_admission_timeout_seconds": 0.1,
        }
    )
    app = create_app(bounded, BlockingReasoner())
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        first = asyncio.create_task(client.post("/v1/reason", json=observation_payload()))
        await started.wait()
        second = await client.post("/v1/reason", json=observation_payload())
        assert second.status_code == 503
        assert second.json() == {"detail": "reasoning_capacity_timeout"}
        release.set()
        assert (await first).status_code == 200


@pytest.mark.asyncio
async def test_job_poll_requires_same_auth_and_origin_boundary(settings: Settings) -> None:
    key = "0123456789abcdef"
    extension_origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
    secured = settings.model_copy(update={"api_key": SecretStr(key)})
    app = create_app(secured, FakeReasoner())
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    auth_headers = {"Origin": extension_origin, "X-Privacy-Agent-Key": key}
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        preflight = await client.options(
            "/v1/reason",
            headers={
                "Origin": extension_origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type,prefer,x-privacy-agent-key",
            },
        )
        accepted = await client.post(
            "/v1/reason",
            json=observation_payload(),
            headers={**auth_headers, "Prefer": "respond-async"},
        )
        job_id = accepted.json()["jobId"]
        missing_auth = await client.get(
            f"/v1/reason/{job_id}", headers={"Origin": extension_origin}
        )
        wrong_origin = await client.get(
            f"/v1/reason/{job_id}",
            headers={"Origin": "https://attacker.example", "X-Privacy-Agent-Key": key},
        )
        result = await poll_until_terminal(client, job_id, headers=auth_headers)
    assert preflight.status_code == 200
    assert preflight.headers["access-control-allow-origin"] == extension_origin
    assert "prefer" in preflight.headers["access-control-allow-headers"].lower()
    assert missing_auth.status_code == 401
    assert wrong_origin.status_code == 403
    assert result.status_code == 200


@pytest.mark.asyncio
async def test_unknown_job_is_generic_and_job_id_is_not_logged(
    client: httpx.AsyncClient,
    caplog: pytest.LogCaptureFixture,
) -> None:
    unknown = "d536ab44-bf48-4a15-8392-a8eb64ba072e"
    with caplog.at_level(logging.INFO, logger="privacy_server.access"):
        response = await client.get(f"/v1/reason/{unknown}")
    assert response.status_code == 404
    assert response.json() == {"detail": "reasoning_job_not_found"}
    assert unknown not in caplog.text
    assert "endpoint=/v1/reason/{jobId}" in caplog.text


@pytest.mark.asyncio
async def test_expired_job_is_removed_and_its_task_cancelled() -> None:
    started = asyncio.Event()

    async def blocked_runner() -> ReasoningResponse:
        started.set()
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    jobs = ReasoningJobStore(max_jobs=1, ttl_seconds=0, max_concurrent=1)
    submitted = await jobs.submit(SNAPSHOT_ID, blocked_runner)
    await started.wait()
    with pytest.raises(ReasoningJobNotFound):
        await jobs.get(submitted.job_id)
    await jobs.close()
