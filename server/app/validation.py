from __future__ import annotations

import base64
import binascii
import io
import math
import re
import struct
from collections.abc import Iterable

from PIL import Image, UnidentifiedImageError

from app.detector_registry import PATTERNS, normalize_for_detection
from app.schemas import BrowserAction, SanitizedObservation, is_redaction_placeholder
from app.settings import Settings

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
FORBIDDEN_PNG_CHUNKS = {b"tEXt", b"zTXt", b"iTXt", b"eXIf", b"iCCP", b"acTL", b"fcTL", b"fdAT"}
PLACEHOLDER_BACKGROUND = (243, 244, 246)

# These are defense-in-depth recognizers over the already-sanitized text capsule.
# The client owns complete classification and pixel redaction; the server only
# catches high-confidence violations without trying to reconstruct private text.
ALWAYS_PROTECTED_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("pan", re.compile(r"(?<![A-Z0-9])[A-Z]{5}\d{4}[A-Z](?![A-Z0-9])", re.IGNORECASE)),
    ("aadhaar", re.compile(r"(?<!\d)\d{4}[ -]?\d{4}[ -]?\d{4}(?!\d)")),
    ("indian_passport", re.compile(r"(?<![A-Z0-9])[A-Z][1-9]\d{6}(?![A-Z0-9])", re.IGNORECASE)),
    ("card", re.compile(r"(?<!\d)(?:\d[ -]?){13,19}(?!\d)")),
    (
        "otp",
        re.compile(r"\b(?:otp|one[- ]time (?:password|pin|code))\s*[:=\-]?\s*\d{4,8}\b", re.IGNORECASE),
    ),
    (
        "auth_secret",
        re.compile(
            r"\b(?:password|passphrase|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|"
            r"client[-_ ]?secret|session[-_ ]?(?:id|token)|private[-_ ]?key)\s*[:=]\s*"
            r"[^\s\[\]]{4,}",
            re.IGNORECASE,
        ),
    ),
    ("bearer_token", re.compile(r"\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}\b", re.IGNORECASE)),
    (
        "known_token_prefix",
        re.compile(r"(?<![A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})(?![A-Za-z0-9])"),
    ),
    (
        "bank_account",
        re.compile(r"\b(?:bank\s+)?account(?:\s+(?:number|no\.?))?\s*[:=\-]\s*\d{9,18}\b", re.IGNORECASE),
    ),
    # Keep the receiver's defense-in-depth floor aligned with the client
    # detector. These identifiers are always protected locally, so a client
    # regression must still be rejected before model invocation.
    ("ssn", re.compile(r"(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)")),
    ("ifsc", re.compile(r"(?<![A-Z0-9])[A-Z]{4}0[A-Z0-9]{6}(?![A-Z0-9])", re.IGNORECASE)),
)

GRADE_2_PROTECTED_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("email", re.compile(r"(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+", re.IGNORECASE)),
    ("indian_phone", re.compile(r"(?<!\d)(?:\+?91[-\s]?)?[6-9](?:[-\s]?\d){9}(?!\d)")),
    (
        "ip_address",
        re.compile(
            r"(?<!\d)(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}"
            r"(?:25[0-5]|2[0-4]\d|1?\d?\d)(?!\d)"
        ),
    ),
    (
        "date_of_birth",
        re.compile(
            r"\b(?:date\s+of\s+birth|birth\s*date|dob)\s*[:=\-]\s*"
            r"(?:\d{1,2}[./-]){2}\d{2,4}\b",
            re.IGNORECASE,
        ),
    ),
    (
        "address",
        re.compile(
            r"\b(?:home|residential|postal|mailing|street)?\s*address\s*[:=\-]\s*"
            r"\d{1,6}\s+[A-Za-z0-9][A-Za-z0-9 .,'/-]{3,}",
            re.IGNORECASE,
        ),
    ),
    (
        "direct_account_id",
        re.compile(
            r"\b(?:customer|account)\s*(?:id|number|no\.?)\s*[:=\-]\s*[A-Z0-9][A-Z0-9_-]{5,}\b",
            re.IGNORECASE,
        ),
    ),
)

GRADE_3_PROTECTED_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "person_name",
        re.compile(
            r"\b(?:full\s+name|first\s+name|last\s+name|given\s+name|surname|profile\s+for)"
            r"\s*[:=\-]?\s+[A-Z][A-Za-z'.-]{1,49}(?:\s+[A-Z][A-Za-z'.-]{1,49}){0,4}\b",
            re.IGNORECASE,
        ),
    ),
    (
        "username_or_employee_id",
        re.compile(
            r"\b(?:user(?:name|\s+id)|employee\s+id|staff\s+id)\s*[:=\-]\s*"
            r"[A-Za-z0-9][A-Za-z0-9._-]{2,}\b",
            re.IGNORECASE,
        ),
    ),
)

# Compatibility export for integrations that imported the pre-grade detector
# list. New code should call protected_text_patterns(grade) instead.
PII_PATTERNS = ALWAYS_PROTECTED_PATTERNS + GRADE_2_PROTECTED_PATTERNS + GRADE_3_PROTECTED_PATTERNS


def protected_text_patterns(grade: int) -> tuple[tuple[str, re.Pattern[str]], ...]:
    patterns = ALWAYS_PROTECTED_PATTERNS + tuple(
        (kind, pattern) for kind, minimum, pattern in PATTERNS if minimum <= grade
    )
    if grade >= 2:
        patterns += GRADE_2_PROTECTED_PATTERNS
    if grade >= 3:
        patterns += GRADE_3_PROTECTED_PATTERNS
    return patterns


class ObservationRejected(ValueError):
    """The payload is syntactically valid but violates a privacy invariant."""


def _iter_png_chunks(data: bytes) -> Iterable[bytes]:
    position = len(PNG_SIGNATURE)
    while position + 12 <= len(data):
        length = struct.unpack(">I", data[position : position + 4])[0]
        chunk_type = data[position + 4 : position + 8]
        end = position + 12 + length
        if end > len(data):
            raise ObservationRejected("invalid_png")
        yield chunk_type
        position = end
        if chunk_type == b"IEND":
            if position != len(data):
                raise ObservationRejected("invalid_png")
            return
    raise ObservationRejected("invalid_png")


def decode_and_validate_png(observation: SanitizedObservation, settings: Settings) -> bytes:
    encoded = observation.image.dataBase64
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ObservationRejected("invalid_image_encoding") from exc
    if len(data) > settings.max_image_bytes:
        raise ObservationRejected("image_too_large")
    if not data.startswith(PNG_SIGNATURE):
        raise ObservationRejected("invalid_png")
    chunk_types = tuple(_iter_png_chunks(data))
    if not chunk_types or chunk_types[0] != b"IHDR" or chunk_types[-1] != b"IEND":
        raise ObservationRejected("invalid_png")
    if FORBIDDEN_PNG_CHUNKS.intersection(chunk_types):
        raise ObservationRejected("png_metadata_or_animation_not_allowed")
    try:
        with Image.open(io.BytesIO(data)) as image:
            image.verify()
        with Image.open(io.BytesIO(data)) as image:
            width, height = image.size
            frames = getattr(image, "n_frames", 1)
            image.load()
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as exc:
        raise ObservationRejected("invalid_png") from exc
    if frames != 1:
        raise ObservationRejected("animated_image_not_allowed")
    if (width, height) != (observation.image.width, observation.image.height):
        raise ObservationRejected("image_dimensions_mismatch")
    if width * height > settings.max_image_pixels:
        raise ObservationRejected("image_pixel_limit_exceeded")
    return data


def _ensure_bounds_within_image(observation: SanitizedObservation) -> None:
    width = observation.image.width
    height = observation.image.height
    all_bounds = [element.bounds for element in observation.elements]
    all_bounds.extend(redaction.bounds for redaction in observation.redactions)
    for bounds in all_bounds:
        if bounds.x + bounds.width > width or bounds.y + bounds.height > height:
            raise ObservationRejected("bounds_outside_image")


def _iter_visible_text(observation: SanitizedObservation) -> Iterable[str]:
    yield observation.task
    yield observation.page.title
    for element in observation.elements:
        yield element.label


def _reject_obvious_unredacted_pii(observation: SanitizedObservation) -> None:
    for value in _iter_visible_text(observation):
        if not value or is_redaction_placeholder(value):
            continue
        for _, pattern in protected_text_patterns(observation.privacy.grade):
            if pattern.search(value):
                raise ObservationRejected("unredacted_pii_detected")
        if any(pattern.search(normalize_for_detection(value)) for _, minimum, pattern in PATTERNS
               if minimum <= observation.privacy.grade):
            raise ObservationRejected("unredacted_pii_detected")


def _verify_declared_masks(observation: SanitizedObservation, data: bytes) -> None:
    total_area = sum(redaction.bounds.width * redaction.bounds.height for redaction in observation.redactions)
    image_area = observation.image.width * observation.image.height
    if total_area > image_area * 4:
        raise ObservationRejected("redaction_area_limit_exceeded")
    try:
        with Image.open(io.BytesIO(data)) as image:
            rgba = image.convert("RGBA")
            for redaction in observation.redactions:
                bounds = redaction.bounds
                box = (
                    math.floor(bounds.x),
                    math.floor(bounds.y),
                    math.ceil(bounds.x + bounds.width),
                    math.ceil(bounds.y + bounds.height),
                )
                crop = rgba.crop(box)
                if observation.privacy.redactionMode == "opaque":
                    red, green, blue, alpha = crop.split()
                    if (
                        red.getextrema() != (0, 0)
                        or green.getextrema() != (0, 0)
                        or blue.getextrema() != (0, 0)
                        or alpha.getextrema() != (255, 255)
                    ):
                        raise ObservationRejected("redaction_not_opaque_black")
                else:
                    # Semantic mode still replaces the entire region locally.
                    # The compositor paints a neutral background before drawing
                    # an italic [REDACTED:*] marker; checking the four corners
                    # prevents a client from declaring semantic mode while
                    # leaving the original pixels untouched.
                    pixels = crop.load()
                    crop_width, crop_height = crop.size
                    corners = {
                        pixels[0, 0][:3],
                        pixels[max(0, crop_width - 1), 0][:3],
                        pixels[0, max(0, crop_height - 1)][:3],
                        pixels[max(0, crop_width - 1), max(0, crop_height - 1)][:3],
                    }
                    if PLACEHOLDER_BACKGROUND not in corners:
                        raise ObservationRejected("semantic_placeholder_background_missing")
            if observation.privacy.visualFallback == "full-mask":
                has_full_frame_redaction = any(
                    redaction.bounds.x == 0
                    and redaction.bounds.y == 0
                    and redaction.bounds.width == observation.image.width
                    and redaction.bounds.height == observation.image.height
                    for redaction in observation.redactions
                )
                if not has_full_frame_redaction:
                    raise ObservationRejected("full_mask_redaction_required")
                red, green, blue, alpha = rgba.split()
                if (
                    red.getextrema() != (0, 0)
                    or green.getextrema() != (0, 0)
                    or blue.getextrema() != (0, 0)
                    or alpha.getextrema() != (255, 255)
                ):
                    raise ObservationRejected("full_mask_image_required")
    except ObservationRejected:
        raise
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise ObservationRejected("invalid_png") from exc


def validate_observation(observation: SanitizedObservation, settings: Settings) -> bytes:
    if len(observation.elements) > settings.max_elements:
        raise ObservationRejected("too_many_elements")
    if len(observation.redactions) > settings.max_redactions:
        raise ObservationRejected("too_many_redactions")
    _ensure_bounds_within_image(observation)
    _reject_obvious_unredacted_pii(observation)
    data = decode_and_validate_png(observation, settings)
    _verify_declared_masks(observation, data)
    return data


def validate_action_for_observation(
    response_snapshot_id: str,
    action: BrowserAction,
    observation: SanitizedObservation,
) -> None:
    if response_snapshot_id != observation.snapshotId:
        raise ObservationRejected("model_returned_stale_snapshot")
    if action.elementId is None:
        return
    elements = {element.id: element for element in observation.elements}
    target = elements.get(action.elementId)
    if target is None:
        raise ObservationRejected("model_returned_unknown_element")
    if target.state.disabled:
        raise ObservationRejected("model_targeted_disabled_element")
    if action.type == "input" and not target.state.editable:
        raise ObservationRejected("model_targeted_non_editable_element")
    if action.type == "scroll" and target.role != "scroll-region":
        raise ObservationRejected("model_targeted_non_scroll_region")
    if action.type == "input" and action.text:
        for _, pattern in protected_text_patterns(observation.privacy.grade):
            if pattern.search(action.text):
                raise ObservationRejected("model_returned_pii")
        if any(pattern.search(normalize_for_detection(action.text)) for _, minimum, pattern in PATTERNS
               if minimum <= observation.privacy.grade):
            raise ObservationRejected("model_returned_pii")
