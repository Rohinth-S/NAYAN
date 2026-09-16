from __future__ import annotations

import httpx
import pytest
from conftest import CONSENT_ID, SUBMIT_ID, FakeReasoner, observation_payload

from app.circuit_breaker import CircuitBreaker
from app.generated_policy import REGISTRY_DIGEST
from app.main import create_app
from app.gateways.ollama import ReasonerUnavailable
from app.schemas import ReasoningResponse, SanitizedObservation
from app.settings import Settings
from app.structural_planner import plan_structural_action, plan_structural_response

SECOND_SUBMIT_ID = "e_submit_second_1234567"


def _form_payload(*, extra_submit: bool = False, required: bool = True) -> dict:
    elements = [
        {
            "id": CONSENT_ID,
            "role": "checkbox",
            "label": "I confirm this selection",
            "bounds": {"x": 4, "y": 4, "width": 20, "height": 20},
            "state": {
                "disabled": False,
                "checked": False,
                "editable": False,
                "required": required,
            },
        },
        {
            "id": SUBMIT_ID,
            "role": "button",
            "label": "Submit enrollment",
            "bounds": {"x": 4, "y": 28, "width": 24, "height": 16},
            "state": {"disabled": False, "checked": False, "editable": False, "required": False},
        },
    ]
    if extra_submit:
        elements.append(
            {
                "id": SECOND_SUBMIT_ID,
                "role": "button",
                "label": "Submit application",
                "bounds": {"x": 30, "y": 28, "width": 24, "height": 16},
                "state": {"disabled": False, "checked": False, "editable": False, "required": False},
            }
        )
    return observation_payload(
        task="Confirm and submit the enrollment form",
        elements=elements,
    )


@pytest.mark.asyncio
async def test_matching_registry_digest_is_accepted(
    client: httpx.AsyncClient, fake_reasoner: FakeReasoner
) -> None:
    payload = observation_payload()
    payload["privacy"]["registryDigest"] = REGISTRY_DIGEST
    response = await client.post("/v1/reason", json=payload)
    assert response.status_code == 200
    assert fake_reasoner.seen is not None


@pytest.mark.asyncio
async def test_registry_digest_mismatch_is_rejected_before_the_model(
    client: httpx.AsyncClient, fake_reasoner: FakeReasoner
) -> None:
    payload = observation_payload()
    payload["privacy"]["registryDigest"] = "sha256:" + ("a" * 64)
    response = await client.post("/v1/reason", json=payload)
    assert response.status_code == 422
    assert response.json() == {"detail": "privacy_registry_digest_mismatch"}
    assert fake_reasoner.seen is None


def test_structural_planner_never_inputs_private_values() -> None:
    payload = _form_payload()
    payload["elements"].append(
        {
            "id": "e_name_field_12345678",
            "role": "textbox",
            "label": "[REDACTED:NAME]",
            "bounds": {"x": 4, "y": 12, "width": 20, "height": 12},
            "state": {"disabled": False, "checked": False, "editable": True, "required": True},
        }
    )
    observation = SanitizedObservation.model_validate(payload)
    action = plan_structural_action(observation)
    assert action.type == "click"
    assert action.elementId == CONSENT_ID
    assert action.text is None
    response = plan_structural_response(observation)
    assert response.action.type != "input"
    assert "[REDACTED" not in (response.action.message or "")


@pytest.mark.asyncio
async def test_dead_backend_clicks_unique_consent(settings: Settings) -> None:
    reasoner = FakeReasoner()
    reasoner.is_ready = False
    app = create_app(settings, reasoner)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post("/v1/reason", json=_form_payload())
    assert response.status_code == 200
    assert response.json()["action"] == {"type": "click", "elementId": CONSENT_ID}
    assert reasoner.seen is None


@pytest.mark.asyncio
async def test_ambiguous_two_submits_fail_closed(settings: Settings) -> None:
    reasoner = FakeReasoner()
    reasoner.is_ready = False
    app = create_app(settings, reasoner)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post("/v1/reason", json=_form_payload(extra_submit=True))
    assert response.status_code == 200
    assert response.json()["action"]["type"] == "done"
    assert reasoner.seen is None


@pytest.mark.asyncio
async def test_open_breaker_does_not_call_the_model(settings: Settings) -> None:
    class FailingReasoner(FakeReasoner):
        def __init__(self) -> None:
            super().__init__()
            self.calls = 0

        async def reason(self, observation: SanitizedObservation) -> ReasoningResponse:
            self.calls += 1
            self.seen = observation
            raise ReasonerUnavailable("reasoning_backend_unavailable")

    reasoner = FailingReasoner()
    breaker = CircuitBreaker(
        failure_threshold=1,
        open_seconds=60,
        timeout_seconds=1,
        max_concurrency=1,
    )
    app = create_app(settings, reasoner, circuit_breaker=breaker)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    payload = _form_payload()
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        first = await client.post("/v1/reason", json=payload)
        second = await client.post("/v1/reason", json=payload)
    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["action"]["type"] == "click"
    assert reasoner.calls == 1


@pytest.mark.asyncio
async def test_planner_error_fails_closed_instead_of_crashing(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(_observation: SanitizedObservation) -> ReasoningResponse:
        raise ValueError("structural planner returned a disallowed action")

    monkeypatch.setattr("app.main.plan_structural_response", boom)
    reasoner = FakeReasoner()
    reasoner.is_ready = False
    app = create_app(settings, reasoner)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post("/v1/reason", json=_form_payload())
    assert response.status_code == 502
    assert response.json() == {"detail": "invalid_reasoning_response"}
