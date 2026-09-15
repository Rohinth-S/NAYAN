from __future__ import annotations

import pytest
from conftest import CONSENT_ID, SUBMIT_ID, observation_payload

from app.schemas import BrowserAction, ReasoningResponse


def _form_payload(
    *, checked: bool = False, required: bool = True, label: str = "I confirm this selection"
) -> dict:
    payload = observation_payload(
        task="Confirm and submit the enrollment form",
        elements=[
            {
                "id": CONSENT_ID,
                "role": "checkbox",
                "label": label,
                "bounds": {"x": 4, "y": 4, "width": 20, "height": 20},
                "state": {
                    "disabled": False,
                    "checked": checked,
                    "editable": False,
                    "required": required,
                },
            },
            {
                "id": SUBMIT_ID,
                "role": "button",
                "label": "Submit enrollment",
                "bounds": {"x": 4, "y": 28, "width": 50, "height": 16},
                "state": {"disabled": False, "checked": False, "editable": False, "required": False},
            },
        ],
    )
    return payload


@pytest.mark.asyncio
async def test_submit_click_is_reordered_before_unchecked_required_consent(client, fake_reasoner) -> None:
    fake_reasoner.response = ReasoningResponse(
        schemaVersion="1.0",
        snapshotId="11111111-1111-4111-8111-111111111111",
        action=BrowserAction(type="click", elementId=SUBMIT_ID),
    )
    response = await client.post("/v1/reason", json=_form_payload())
    assert response.status_code == 200
    assert response.json()["action"] == {"type": "click", "elementId": CONSENT_ID}


@pytest.mark.asyncio
async def test_checked_required_consent_keeps_model_submit_action(client, fake_reasoner) -> None:
    fake_reasoner.response = ReasoningResponse(
        schemaVersion="1.0",
        snapshotId="11111111-1111-4111-8111-111111111111",
        action=BrowserAction(type="click", elementId=SUBMIT_ID),
    )
    response = await client.post("/v1/reason", json=_form_payload(checked=True))
    assert response.status_code == 200
    assert response.json()["action"] == {"type": "click", "elementId": SUBMIT_ID}


@pytest.mark.asyncio
async def test_repeated_checked_consent_click_advances_to_unique_submit(client, fake_reasoner) -> None:
    fake_reasoner.response = ReasoningResponse(
        schemaVersion="1.0",
        snapshotId="11111111-1111-4111-8111-111111111111",
        action=BrowserAction(type="click", elementId=CONSENT_ID),
    )
    response = await client.post("/v1/reason", json=_form_payload(checked=True))
    assert response.status_code == 200
    assert response.json()["action"] == {"type": "click", "elementId": SUBMIT_ID}


@pytest.mark.asyncio
async def test_unrelated_model_click_after_consent_checked_recovers_to_submit(client, fake_reasoner) -> None:
    fake_reasoner.response = ReasoningResponse(
        schemaVersion="1.0",
        snapshotId="11111111-1111-4111-8111-111111111111",
        action=BrowserAction(type="click", elementId="e_help_123456789012"),
    )
    payload = _form_payload(checked=True)
    payload["elements"].append(
        {
            "id": "e_help_123456789012",
            "role": "button",
            "label": "Help",
            "bounds": {"x": 4, "y": 4, "width": 20, "height": 16},
            "state": {"disabled": False, "checked": False, "editable": False, "required": False},
        }
    )
    response = await client.post("/v1/reason", json=payload)
    assert response.status_code == 200
    assert response.json()["action"] == {"type": "click", "elementId": SUBMIT_ID}


@pytest.mark.asyncio
async def test_incomplete_done_response_recovers_to_submit(client, fake_reasoner) -> None:
    fake_reasoner.response = ReasoningResponse(
        schemaVersion="1.0",
        snapshotId="11111111-1111-4111-8111-111111111111",
        action=BrowserAction(type="done", message="I need another step"),
    )
    response = await client.post("/v1/reason", json=_form_payload(checked=True))
    assert response.status_code == 200
    assert response.json()["action"] == {"type": "click", "elementId": SUBMIT_ID}


@pytest.mark.asyncio
async def test_completed_done_message_is_preserved(client, fake_reasoner) -> None:
    fake_reasoner.response = ReasoningResponse(
        schemaVersion="1.0",
        snapshotId="11111111-1111-4111-8111-111111111111",
        action=BrowserAction(type="done", message="Task complete"),
    )
    payload = _form_payload(checked=True)
    payload["elements"].append(
        {
            "id": "e_save_123456789012",
            "role": "button",
            "label": "Save draft",
            "bounds": {"x": 4, "y": 4, "width": 20, "height": 16},
            "state": {"disabled": False, "checked": False, "editable": False, "required": False},
        }
    )
    response = await client.post("/v1/reason", json=payload)
    assert response.status_code == 200
    assert response.json()["action"] == {"type": "done", "message": "Task complete"}


@pytest.mark.asyncio
async def test_ambiguous_terminal_controls_preserve_unrelated_model_click(client, fake_reasoner) -> None:
    fake_reasoner.response = ReasoningResponse(
        schemaVersion="1.0",
        snapshotId="11111111-1111-4111-8111-111111111111",
        action=BrowserAction(type="click", elementId="e_help_123456789012"),
    )
    payload = _form_payload(checked=True)
    payload["elements"].extend(
        [
            {
                "id": "e_help_123456789012",
                "role": "button",
                "label": "Help",
                "bounds": {"x": 4, "y": 4, "width": 20, "height": 16},
                "state": {"disabled": False, "checked": False, "editable": False, "required": False},
            },
            {
                "id": "e_save_123456789012",
                "role": "button",
                "label": "Save draft",
                "bounds": {"x": 28, "y": 4, "width": 20, "height": 16},
                "state": {"disabled": False, "checked": False, "editable": False, "required": False},
            },
        ]
    )
    response = await client.post("/v1/reason", json=payload)
    assert response.status_code == 200
    assert response.json()["action"] == {"type": "click", "elementId": "e_help_123456789012"}


@pytest.mark.asyncio
async def test_fill_task_does_not_redirect_model_input_or_click(client, fake_reasoner) -> None:
    payload = _form_payload(checked=True)
    payload["task"] = "Fill the enrollment form and submit it"
    payload["elements"].insert(
        0,
        {
            "id": "e_name_123456789012",
            "role": "textbox",
            "label": "Public display name",
            "bounds": {"x": 4, "y": 4, "width": 40, "height": 16},
            "state": {"disabled": False, "checked": False, "editable": True, "required": False},
        },
    )
    fake_reasoner.response = ReasoningResponse(
        schemaVersion="1.0",
        snapshotId="11111111-1111-4111-8111-111111111111",
        action=BrowserAction(type="input", elementId="e_name_123456789012", text="Public value"),
    )
    response = await client.post("/v1/reason", json=payload)
    assert response.status_code == 200
    assert response.json()["action"] == {
        "type": "input",
        "elementId": "e_name_123456789012",
        "text": "Public value",
    }


@pytest.mark.asyncio
async def test_optional_unrelated_checkbox_is_not_invented_as_a_prerequisite(client, fake_reasoner) -> None:
    fake_reasoner.response = ReasoningResponse(
        schemaVersion="1.0",
        snapshotId="11111111-1111-4111-8111-111111111111",
        action=BrowserAction(type="click", elementId=SUBMIT_ID),
    )
    response = await client.post(
        "/v1/reason",
        json=_form_payload(required=False, label="Subscribe to optional updates"),
    )
    assert response.status_code == 200
    assert response.json()["action"] == {"type": "click", "elementId": SUBMIT_ID}


@pytest.mark.asyncio
async def test_non_commit_task_preserves_model_action(client, fake_reasoner) -> None:
    fake_reasoner.response = ReasoningResponse(
        schemaVersion="1.0",
        snapshotId="11111111-1111-4111-8111-111111111111",
        action=BrowserAction(type="click", elementId=SUBMIT_ID),
    )
    payload = _form_payload()
    payload["task"] = "Describe the visible form"
    response = await client.post("/v1/reason", json=payload)
    assert response.status_code == 200
    assert response.json()["action"] == {"type": "click", "elementId": SUBMIT_ID}


@pytest.mark.asyncio
async def test_disabled_prerequisite_is_never_selected(client, fake_reasoner) -> None:
    fake_reasoner.response = ReasoningResponse(
        schemaVersion="1.0",
        snapshotId="11111111-1111-4111-8111-111111111111",
        action=BrowserAction(type="click", elementId=SUBMIT_ID),
    )
    payload = _form_payload()
    payload["elements"][0]["state"]["disabled"] = True
    response = await client.post("/v1/reason", json=payload)
    assert response.status_code == 200
    assert response.json()["action"] == {"type": "click", "elementId": SUBMIT_ID}


@pytest.mark.asyncio
async def test_disabled_unique_terminal_stops_safely_after_submission(client, fake_reasoner) -> None:
    fake_reasoner.response = ReasoningResponse(
        schemaVersion="1.0",
        snapshotId="11111111-1111-4111-8111-111111111111",
        action=BrowserAction(type="click", elementId=SUBMIT_ID),
    )
    payload = _form_payload(checked=True)
    payload["elements"][1]["state"]["disabled"] = True
    response = await client.post("/v1/reason", json=payload)
    assert response.status_code == 200
    assert response.json()["action"] == {
        "type": "done",
        "message": "Terminal action is no longer available; inspect the page result.",
    }


@pytest.mark.asyncio
async def test_disabled_terminal_with_pending_consent_clicks_prerequisite(client, fake_reasoner) -> None:
    fake_reasoner.response = ReasoningResponse(
        schemaVersion="1.0",
        snapshotId="11111111-1111-4111-8111-111111111111",
        action=BrowserAction(type="click", elementId=SUBMIT_ID),
    )
    payload = _form_payload(checked=False)
    payload["elements"][1]["state"]["disabled"] = True
    response = await client.post("/v1/reason", json=payload)
    assert response.status_code == 200
    assert response.json()["action"] == {"type": "click", "elementId": CONSENT_ID}
