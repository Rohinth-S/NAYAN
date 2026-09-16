import pytest
from app.action_guard import guard_reasoned_action
from app.schemas import (
    BrowserAction,
    Element,
    ElementState,
    Bounds,
    Page,
    PrivacyMetadata,
    SanitizedImage,
    SanitizedObservation,
    ReasoningResponse,
)

def _mock_bounds() -> Bounds:
    return Bounds(x=10, y=10, width=10, height=10)

def _mock_observation(task: str, elements: list[Element]) -> SanitizedObservation:
    return SanitizedObservation(
        schemaVersion="1.0",
        snapshotId="11111111-1111-4111-8111-111111111111",
        documentId="22222222-2222-4222-8222-222222222222",
        page=Page(origin="https://site-00000000000000000000.invalid", title=""),
        task=task,
        elements=elements,
        image=SanitizedImage(
            mime="image/png",
            dataBase64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==",
            width=100,
            height=100,
        ),
        redactions=[],
        privacy=PrivacyMetadata(
            detectorBackend="wasm",
            visualFallback="none",
            rawImageRetained=False,
            grade=3,
            redactionMode="semantic"
        ),
    )

def test_guard_prevents_unchecking_consent():
    """Verify that action_guard correctly redirects an erroneous consent click to submit."""
    consent = Element(
        id="e_consent00000000000",
        role="checkbox",
        label="I agree to terms",
        bounds=_mock_bounds(),
        state=ElementState(required=True, checked=True),
    )
    submit = Element(
        id="e_submit000000000000",
        role="button",
        label="Submit",
        bounds=_mock_bounds(),
        state=ElementState(),
    )
    
    observation = _mock_observation("submit the form", [consent, submit])
    response = ReasoningResponse(
        schemaVersion="1.0",
        snapshotId="11111111-1111-4111-8111-111111111111",
        action=BrowserAction(type="click", elementId="e_consent00000000000"),
    )
    
    guarded = guard_reasoned_action(observation, response)
    
    # It should automatically fix the action to click the submit button instead.
    assert guarded.action.type == "click"
    assert guarded.action.elementId == "e_submit000000000000"
