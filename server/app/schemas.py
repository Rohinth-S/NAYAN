from __future__ import annotations

import math
import re
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SCHEMA_VERSION = "1.0"
SAFE_ID_PATTERN = r"^[A-Za-z0-9_-]+$"
SAFE_TAG_PATTERN = r"^[a-z0-9][a-z0-9_-]*$"
UUID_PATTERN = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
ELEMENT_ID_PATTERN = r"^e_[A-Za-z0-9_-]{16,64}$"
PLACEHOLDER_PATTERN = re.compile(r"^\[REDACTED:[A-Z0-9_-]{2,40}\]$")


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)


class Bounds(StrictModel):
    x: float = Field(ge=0, le=16_384)
    y: float = Field(ge=0, le=16_384)
    width: float = Field(gt=0, le=16_384)
    height: float = Field(gt=0, le=16_384)

    @model_validator(mode="after")
    def finite_values(self) -> Bounds:
        if not all(math.isfinite(value) for value in (self.x, self.y, self.width, self.height)):
            raise ValueError("bounds must be finite")
        return self


class Page(StrictModel):
    origin: str = Field(min_length=1, max_length=512)
    title: str = Field(default="", max_length=300)

    @field_validator("origin")
    @classmethod
    def origin_only(cls, value: str) -> str:
        if not re.fullmatch(r"https://site-[0-9a-f]{20}\.invalid", value):
            raise ValueError("page.origin must be an opaque session-scoped site alias")
        parts = urlsplit(value)
        if parts.scheme != "https" or not parts.hostname:
            raise ValueError("page.origin must be an HTTPS origin alias")
        if parts.username or parts.password or parts.query or parts.fragment:
            raise ValueError("page.origin cannot contain credentials, query, or fragment")
        if parts.path not in {""}:
            raise ValueError("page.origin cannot contain a path")
        return value


class ElementState(StrictModel):
    disabled: bool = False
    checked: bool = False
    editable: bool = False
    # Structural form metadata only; no field value is exposed.
    required: bool = False


class Element(StrictModel):
    id: str = Field(pattern=ELEMENT_ID_PATTERN)
    role: Literal[
        "button",
        "link",
        "textbox",
        "checkbox",
        "radio",
        "combobox",
        "option",
        "scroll-region",
        "other",
    ]
    label: str = Field(default="", max_length=300)
    bounds: Bounds
    state: ElementState


class SanitizedImage(StrictModel):
    mime: Literal["image/png"]
    dataBase64: str = Field(min_length=12, max_length=8_000_000, pattern=r"^[A-Za-z0-9+/]+={0,2}$")
    width: int = Field(ge=1, le=8_192)
    height: int = Field(ge=1, le=8_192)

    @field_validator("dataBase64")
    @classmethod
    def png_prefix(cls, value: str) -> str:
        if not value.startswith("iVBORw0KGgo"):
            raise ValueError("image must begin with a PNG signature")
        return value


class Redaction(StrictModel):
    kind: Literal[
        "password",
        "pii-text",
        "sensitive-field",
        "face",
        "aadhaar-card",
        "pan-card",
        "voter-id",
        "driving-license",
        "passport",
        "signature",
        "canvas-text",
        "uninspectable-frame",
        "uninspectable-media",
        "visual-fallback",
    ]
    source: Literal["dom", "regex", "onnx", "unified-detector", "dbnet", "ocr", "fallback"]
    bounds: Bounds
    # Approach B: confidence from unified detector, absent for rule-based sources.
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)


class PrivacyMetadata(StrictModel):
    detectorBackend: Literal["webgpu", "wasm", "missing", "error"]
    visualFallback: Literal["none", "full-mask"]
    rawImageRetained: Literal[False]
    # Privacy grades are cumulative. Missing legacy values fail safe to Grade 3.
    grade: Literal[1, 2, 3] = 3
    # Older local fixtures omit this field and are treated as opaque-black.
    # Current extensions send semantic placeholders whenever local detection is available.
    redactionMode: Literal["semantic", "opaque"] = "opaque"
    # Optional v1 digest of the compiled detector registry plus protocol version.
    # Absent values keep the invariant-floor scan; a present value must match exactly.
    registryDigest: str | None = Field(default=None, pattern=r"^sha256:[0-9a-f]{64}$")
    # Approach B: which detector architecture produced visual detections.
    detectorArch: Literal["ultraface", "yolov8n", "yolov10n"] | None = None
    # Approach B: canvas privacy tier applied to canvas-app elements.
    canvasPrivacyTier: Literal["visual-redaction", "dbnet-blind-mask", "manual-escalation"] | None = None

    @field_validator("grade", mode="before")
    @classmethod
    def strict_integer_grade(cls, value: object) -> object:
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError("privacy grade must be the integer 1, 2, or 3")
        return value

    @model_validator(mode="after")
    def unavailable_detector_needs_full_mask(self) -> PrivacyMetadata:
        if self.detectorBackend in {"missing", "error"} and self.visualFallback != "full-mask":
            raise ValueError("unavailable visual detector requires full-image mask")
        if self.redactionMode == "semantic" and self.visualFallback != "none":
            raise ValueError("semantic redaction cannot be used with full-mask fallback")
        return self


class SanitizedObservation(StrictModel):
    schemaVersion: Literal["1.0"]
    snapshotId: str = Field(pattern=UUID_PATTERN)
    documentId: str = Field(pattern=UUID_PATTERN)
    page: Page
    task: str = Field(min_length=1, max_length=2_000)
    elements: list[Element] = Field(max_length=500)
    image: SanitizedImage
    redactions: list[Redaction] = Field(max_length=1_000)
    privacy: PrivacyMetadata

    @model_validator(mode="after")
    def unique_element_ids(self) -> SanitizedObservation:
        ids = [element.id for element in self.elements]
        if len(ids) != len(set(ids)):
            raise ValueError("element IDs must be unique")
        return self


ActionType = Literal[
    "click",
    "input",
    "scroll",
    "wait",
    "done",
    "hover",
    "focus",
    "doubleClick",
    "check",
    "uncheck",
    "select",
]


class BrowserAction(StrictModel):
    type: ActionType
    elementId: str | None = Field(default=None, pattern=ELEMENT_ID_PATTERN)
    text: str | None = Field(default=None, max_length=512)
    # Public option label/value only; the local executor resolves it against a
    # current native <select> without exposing the option list in the protocol.
    option: str | None = Field(default=None, min_length=1, max_length=300)
    direction: Literal["up", "down"] | None = None
    amount: int | None = Field(default=None, ge=1, le=5_000)
    milliseconds: int | None = Field(default=None, ge=100, le=5_000)
    message: str | None = Field(default=None, max_length=512)

    @model_validator(mode="after")
    def validate_shape(self) -> BrowserAction:
        present = {
            "elementId": self.elementId is not None,
            "text": self.text is not None,
            "option": self.option is not None,
            "direction": self.direction is not None,
            "amount": self.amount is not None,
            "milliseconds": self.milliseconds is not None,
            "message": self.message is not None,
        }
        required: dict[str, set[str]] = {
            "click": {"elementId"},
            "input": {"elementId", "text"},
            "scroll": {"direction", "amount"},
            "wait": {"milliseconds"},
            "done": set(),
            "hover": {"elementId"},
            "focus": {"elementId"},
            "doubleClick": {"elementId"},
            "check": {"elementId"},
            "uncheck": {"elementId"},
            "select": {"elementId", "option"},
        }
        allowed: dict[str, set[str]] = {
            "click": {"elementId"},
            "input": {"elementId", "text"},
            "scroll": {"elementId", "direction", "amount"},
            "wait": {"milliseconds"},
            "done": {"message"},
            "hover": {"elementId"},
            "focus": {"elementId"},
            "doubleClick": {"elementId"},
            "check": {"elementId"},
            "uncheck": {"elementId"},
            "select": {"elementId", "option"},
        }
        missing = required[self.type] - {name for name, exists in present.items() if exists}
        extra = {name for name, exists in present.items() if exists} - allowed[self.type]
        if missing:
            raise ValueError(f"{self.type} action is missing required fields")
        if extra:
            raise ValueError(f"{self.type} action contains fields that are not allowed")
        return self


class ReasoningResponse(StrictModel):
    schemaVersion: Literal["1.0"]
    snapshotId: str = Field(pattern=UUID_PATTERN)
    action: BrowserAction


class ReasoningJobStatus(StrictModel):
    schemaVersion: Literal["1.0"] = "1.0"
    snapshotId: str = Field(pattern=UUID_PATTERN)
    jobId: str = Field(pattern=UUID_PATTERN)
    status: Literal["pending"] = "pending"


class LiveHealth(StrictModel):
    status: Literal["live"] = "live"
    service: str
    schemaVersion: Literal["1.0"] = "1.0"


class ReadyHealth(StrictModel):
    status: Literal["ready", "unavailable"]
    model: str
    schemaVersion: Literal["1.0"] = "1.0"


class DemoSubmit(StrictModel):
    consent: Literal[True]


class DemoState(StrictModel):
    submitted: bool
    reasonRequestCount: int
    lastSnapshotDigest: str | None
    lastRedactionCount: int
    lastActionType: ActionType | None


def is_redaction_placeholder(value: str) -> bool:
    return bool(PLACEHOLDER_PATTERN.fullmatch(value))
