from __future__ import annotations

import json

import httpx
import pytest
from conftest import FakeReasoner, observation_payload
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.main import create_app
from app.settings import Settings


class LeakCaptureReceiver:
    """Test-only receiver that records the exact body arriving at the server boundary."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        self.body = b""

    async def __call__(
        self,
        scope: Scope,
        receive: Receive,
        send: Send,
    ) -> None:
        if scope.get("path") != "/v1/reason":
            await self.app(scope, receive, send)
            return
        parts: list[bytes] = []
        more = True
        while more:
            message = await receive()
            parts.append(message.get("body", b""))
            more = bool(message.get("more_body", False))
        self.body = b"".join(parts)
        delivered = False

        async def replay() -> Message:
            nonlocal delivered
            if delivered:
                return {"type": "http.request", "body": b"", "more_body": False}
            delivered = True
            return {"type": "http.request", "body": self.body, "more_body": False}

        await self.app(scope, replay, send)


@pytest.mark.asyncio
async def test_exact_receiver_body_contains_only_sanitized_contract(settings: Settings) -> None:
    app = create_app(settings, FakeReasoner())
    receiver = LeakCaptureReceiver(app)
    transport = httpx.ASGITransport(app=receiver, raise_app_exceptions=False)
    payload = observation_payload(
        task="Submit the form while leaving [REDACTED:PASSWORD] unchanged",
        page={"origin": "https://site-0123456789abcdef0123.invalid", "title": "[REDACTED:PERSON] benefits"},
    )
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post("/v1/reason", json=payload)
    assert response.status_code == 200
    body_text = receiver.body.decode()
    for raw_canary in (
        "Aarav Sharma",
        "aarav.sharma@example.test",
        "SIH-Canary-Password-93!",
        "ABCDE1234F",
        "98765 43210",
        "SIH-ATTR-CANARY-8841",
        "SIH-URL-CANARY-7719",
    ):
        assert raw_canary not in body_text
    decoded = json.loads(body_text)
    assert set(decoded) == {
        "schemaVersion",
        "snapshotId",
        "documentId",
        "page",
        "task",
        "elements",
        "image",
        "redactions",
        "privacy",
    }
    assert "[REDACTED:PASSWORD]" in decoded["task"]


@pytest.mark.asyncio
async def test_demo_reset_state_and_submit_are_deterministic(settings: Settings) -> None:
    app = create_app(settings, FakeReasoner())
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        page = await client.get("/demo")
        initial = await client.post("/demo/api/reset")
        state = await client.get("/demo/api/state")
        submitted = await client.post("/demo/api/submit", json={"consent": True})
    assert page.status_code == 200
    assert "aarav.sharma@example.test" in page.text
    assert initial.json() == state.json()
    assert state.json()["submitted"] is False
    assert submitted.json()["submitted"] is True
    assert submitted.json()["reasonRequestCount"] == 0


@pytest.mark.asyncio
async def test_reasoning_updates_metadata_only_demo_state(settings: Settings) -> None:
    app = create_app(settings, FakeReasoner())
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post("/v1/reason", json=observation_payload())
        state = await client.get("/demo/api/state")
    assert response.status_code == 200
    payload = state.json()
    assert payload["reasonRequestCount"] == 1
    assert payload["lastRedactionCount"] == 1
    assert payload["lastActionType"] == "click"
    assert len(payload["lastSnapshotDigest"]) == 16
    assert "11111111-1111-4111-8111-111111111111" not in state.text
