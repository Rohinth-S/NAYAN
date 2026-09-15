from __future__ import annotations

from typing import Any

import httpx
import pytest
from conftest import CONSENT_ID, SNAPSHOT_ID, FakeReasoner, observation_payload

from app.schemas import BrowserAction, ReasoningResponse, SanitizedObservation


def _with_grade(grade: int, *, field: str = "task", value: str) -> dict[str, Any]:
    payload = observation_payload()
    payload["privacy"]["grade"] = grade
    if field == "task":
        payload["task"] = value
    elif field == "title":
        payload["page"]["title"] = value
    else:
        payload["elements"][0]["label"] = value
    return payload


def test_legacy_request_defaults_to_fail_safe_grade_three() -> None:
    observation = SanitizedObservation.model_validate(observation_payload())
    assert observation.privacy.grade == 3


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid_grade", [0, 4, -1, "1", 1.0, True, None])
async def test_privacy_grade_is_a_strict_integer_enum(
    client: httpx.AsyncClient, invalid_grade: object
) -> None:
    payload = observation_payload()
    payload["privacy"]["grade"] = invalid_grade
    response = await client.post("/v1/reason", json=payload)
    assert response.status_code == 422
    assert response.json() == {"detail": "invalid_sanitized_observation"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "allowed_text",
    [
        "Contact ananya.demo@example.test",
        "Call +91 98765 43210",
        "DOB: 12/03/1998",
        "IP 192.168.20.14",
        "Address: 42 Lake Road Bengaluru",
        "Full name: Ananya Demo",
    ],
)
async def test_grade_one_may_intentionally_share_contact_and_name_context(
    client: httpx.AsyncClient, allowed_text: str
) -> None:
    response = await client.post("/v1/reason", json=_with_grade(1, value=allowed_text))
    assert response.status_code == 200


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "always_private_text",
    [
        "PAN ABCDE1234F",
        "Aadhaar 2345 6789 1234",
        "Passport K1234567",
        "Card 4111 1111 1111 1111",
        "OTP: 482901",
        "password=SIH-secret-92!",
        "Authorization: Bearer abcdefghijklmnop",
        "api_key=sk-1234567890abcdefghijklmnop",
        "Bank account number: 123456789012",
    ],
)
@pytest.mark.parametrize("grade", [1, 2, 3])
async def test_all_grades_reject_recognizable_high_impact_secrets(
    client: httpx.AsyncClient, grade: int, always_private_text: str
) -> None:
    response = await client.post("/v1/reason", json=_with_grade(grade, value=always_private_text))
    assert response.status_code == 422
    assert response.json() == {"detail": "unredacted_pii_detected"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "grade_two_private_text",
    [
        "Contact ananya.demo@example.test",
        "Call +91 98765 43210",
        "DOB: 12/03/1998",
        "IP 192.168.20.14",
        "Address: 42 Lake Road Bengaluru",
        "Customer ID: CUST_88291",
    ],
)
@pytest.mark.parametrize("grade", [2, 3])
async def test_grade_two_and_three_reject_direct_contact_and_location_identifiers(
    client: httpx.AsyncClient, grade: int, grade_two_private_text: str
) -> None:
    response = await client.post(
        "/v1/reason", json=_with_grade(grade, field="title", value=grade_two_private_text)
    )
    assert response.status_code == 422
    assert response.json() == {"detail": "unredacted_pii_detected"}


@pytest.mark.asyncio
async def test_grade_two_may_intentionally_share_a_name(client: httpx.AsyncClient) -> None:
    response = await client.post(
        "/v1/reason", json=_with_grade(2, field="element", value="Full name: Ananya Demo")
    )
    assert response.status_code == 200


@pytest.mark.asyncio
@pytest.mark.parametrize("private_text", ["Full name: Ananya Demo", "Employee ID: EMP_48291"])
async def test_grade_three_rejects_labeled_identity_context(
    client: httpx.AsyncClient, private_text: str
) -> None:
    response = await client.post("/v1/reason", json=_with_grade(3, value=private_text))
    assert response.status_code == 422
    assert response.json() == {"detail": "unredacted_pii_detected"}


@pytest.mark.asyncio
async def test_action_text_uses_the_selected_grade(
    client: httpx.AsyncClient, fake_reasoner: FakeReasoner
) -> None:
    public_contact = "ananya.demo@example.test"
    fake_reasoner.response = ReasoningResponse(
        schemaVersion="1.0",
        snapshotId=SNAPSHOT_ID,
        action=BrowserAction(type="input", elementId=CONSENT_ID, text=public_contact),
    )
    grade_one = _with_grade(1, value="Enter the provided contact")
    grade_one["elements"][0]["role"] = "textbox"
    grade_one["elements"][0]["state"]["editable"] = True
    accepted = await client.post("/v1/reason", json=grade_one)
    assert accepted.status_code == 200

    grade_two = _with_grade(2, value="Enter the provided contact")
    grade_two["elements"][0]["role"] = "textbox"
    grade_two["elements"][0]["state"]["editable"] = True
    rejected = await client.post("/v1/reason", json=grade_two)
    assert rejected.status_code == 502
    assert rejected.json() == {"detail": "invalid_reasoning_response"}
