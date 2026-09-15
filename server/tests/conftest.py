from __future__ import annotations

import base64
import io
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from PIL import Image, ImageDraw

from app.main import create_app
from app.schemas import BrowserAction, ReasoningResponse, SanitizedObservation
from app.settings import Settings

SNAPSHOT_ID = "11111111-1111-4111-8111-111111111111"
DOCUMENT_ID = "22222222-2222-4222-8222-222222222222"
CONSENT_ID = "e_consent_1234567890"
SUBMIT_ID = "e_submit_12345678901"


def png_base64(width: int = 64, height: int = 48) -> str:
    buffer = io.BytesIO()
    image = Image.new("RGB", (width, height), (240, 242, 245))
    if width >= 56 and height >= 16:
        ImageDraw.Draw(image).rectangle((26, 4, 55, 15), fill=(0, 0, 0))
    image.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode()


def observation_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "schemaVersion": "1.0",
        "snapshotId": SNAPSHOT_ID,
        "documentId": DOCUMENT_ID,
        "page": {"origin": "https://site-0123456789abcdef0123.invalid", "title": "Benefits portal"},
        "task": "Review the benefits selection",
        "elements": [
            {
                "id": CONSENT_ID,
                "role": "checkbox",
                "label": "Selection checkbox",
                "bounds": {"x": 4, "y": 4, "width": 20, "height": 20},
                "state": {"disabled": False, "checked": False, "editable": False},
            },
            {
                "id": SUBMIT_ID,
                "role": "button",
                "label": "Submit enrollment",
                "bounds": {"x": 4, "y": 28, "width": 50, "height": 16},
                "state": {"disabled": False, "checked": False, "editable": False},
            },
        ],
        "image": {"mime": "image/png", "dataBase64": png_base64(), "width": 64, "height": 48},
        "redactions": [
            {
                "kind": "pii-text",
                "source": "regex",
                "bounds": {"x": 26, "y": 4, "width": 30, "height": 12},
            }
        ],
        "privacy": {
            "detectorBackend": "wasm",
            "visualFallback": "none",
            "rawImageRetained": False,
        },
    }
    payload.update(overrides)
    return payload


class FakeReasoner:
    model = "fake-local-model"

    def __init__(self) -> None:
        self.is_ready = True
        self.response: ReasoningResponse | None = None
        self.seen: SanitizedObservation | None = None

    async def ready(self) -> bool:
        return self.is_ready

    async def reason(self, observation: SanitizedObservation) -> ReasoningResponse:
        self.seen = observation
        return self.response or ReasoningResponse(
            schemaVersion="1.0",
            snapshotId=observation.snapshotId,
            action=BrowserAction(type="click", elementId=SUBMIT_ID),
        )

    async def close(self) -> None:
        return None


@pytest.fixture
def settings() -> Settings:
    return Settings(
        ollama_model="fake-local-model",
        max_request_bytes=200_000,
        max_image_bytes=100_000,
        max_image_pixels=100_000,
    )


@pytest.fixture
def fake_reasoner() -> FakeReasoner:
    return FakeReasoner()


@pytest.fixture
async def client(settings: Settings, fake_reasoner: FakeReasoner) -> AsyncIterator[httpx.AsyncClient]:
    app = create_app(settings=settings, reasoner=fake_reasoner)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as test_client:
        yield test_client
