from __future__ import annotations

import base64
import binascii
import json
import struct
import zlib

import pytest

from scripts.verify_receiver_payload import PayloadVerificationError, verify_payload


def _png(width: int, height: int, pixels: list[tuple[int, int, int]]) -> bytes:
	def chunk(kind: bytes, value: bytes) -> bytes:
		return struct.pack(">I", len(value)) + kind + value + struct.pack(">I", binascii.crc32(kind + value) & 0xFFFFFFFF)

	rows = bytearray()
	for y in range(height):
		rows.append(0)
		for x in range(width):
			rows.extend(pixels[y * width + x])
	return (
		b"\x89PNG\r\n\x1a\n"
		+ chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
		+ chunk(b"IDAT", zlib.compress(bytes(rows)))
		+ chunk(b"IEND", b"")
	)


def _corpus() -> dict:
	return {
		"cases": [
			{
				"caseId": "receiver-test",
				"synthetic": True,
				"canaries": [
					{
						"canaryId": "email-canary",
						"kind": "EMAIL",
						"value": "receiver.canary@example.test",
					}
				],
				"annotations": [
					{
						"annotationId": "sensitive-box",
						"requiresMask": True,
						"bounds": {"x": 1, "y": 1, "width": 2, "height": 2},
						"sourceColorRgb": [255, 0, 255],
					}
				],
			}
		],
	}


def _payload(pixels: list[tuple[int, int, int]]) -> bytes:
	encoded = base64.b64encode(_png(4, 4, pixels)).decode("ascii")
	return json.dumps(
		{
			"schemaVersion": "1.0",
			"snapshotId": "opaque-snapshot",
			"documentId": "opaque-document",
			"page": {"origin": "https://site-0123456789abcdefabcd.invalid", "title": "Sanitized"},
			"task": "Continue",
			"elements": [],
			"image": {"mime": "image/png", "dataBase64": encoded, "width": 4, "height": 4},
			"redactions": [],
			"privacy": {
				"detectorBackend": "test",
				"visualFallback": "none",
				"rawImageRetained": False,
			},
		},
		separators=(",", ":"),
	).encode("utf-8")


def test_clean_receiver_body_and_opaque_pixels_pass() -> None:
	pixels = [(255, 255, 255)] * 16
	for index in (5, 6, 9, 10):
		pixels[index] = (0, 0, 0)

	report = verify_payload(_corpus(), "receiver-test", _payload(pixels))

	assert report["passed"] is True
	assert report["textCanaryLeaks"] == []
	assert report["maskAssertions"][0]["maskCoverage"] == 1.0
	assert report["privacyGrade"] == 3


def test_grade_one_allows_a_grade_two_contact_canary() -> None:
	corpus = _corpus()
	corpus["cases"][0]["canaries"][0]["minimumPrivacyGrade"] = 2
	corpus["cases"][0]["annotations"][0]["minimumPrivacyGrade"] = 2
	payload = json.loads(_payload([(255, 255, 255)] * 16))
	payload["privacy"]["grade"] = 1
	payload["task"] = "Contact receiver.canary@example.test"

	report = verify_payload(corpus, "receiver-test", json.dumps(payload).encode())

	assert report["passed"] is True
	assert report["privacyGrade"] == 1
	assert report["textCanaryLeaks"] == []
	assert report["maskAssertions"] == []


def test_reports_text_canary_without_echoing_its_value() -> None:
	pixels = [(0, 0, 0)] * 16
	payload = json.loads(_payload(pixels))
	payload["task"] = "Email receiver.canary@example.test"

	report = verify_payload(_corpus(), "receiver-test", json.dumps(payload).encode())

	assert report["passed"] is False
	assert {item["canaryId"] for item in report["textCanaryLeaks"]} == {"email-canary"}
	assert "receiver.canary" not in json.dumps(report)


def test_unmasked_sensitive_pixels_fail() -> None:
	pixels = [(255, 255, 255)] * 16
	for index in (5, 6, 9, 10):
		pixels[index] = (255, 0, 255)

	report = verify_payload(_corpus(), "receiver-test", _payload(pixels))

	assert report["passed"] is False
	assert report["maskAssertions"][0]["originalColorPixelCount"] == 4


def test_malformed_png_fails_closed() -> None:
	payload = json.loads(_payload([(0, 0, 0)] * 16))
	payload["image"]["dataBase64"] = base64.b64encode(b"not a png").decode()
	with pytest.raises(PayloadVerificationError, match="not a PNG"):
		verify_payload(_corpus(), "receiver-test", json.dumps(payload).encode())


@pytest.mark.parametrize("visual_fallback", ["none", "full-mask"])
def test_accepts_protocol_visual_fallback_enums(visual_fallback: str) -> None:
	payload = json.loads(_payload([(0, 0, 0)] * 16))
	payload["privacy"]["visualFallback"] = visual_fallback

	assert verify_payload(_corpus(), "receiver-test", json.dumps(payload).encode())["passed"] is True


def test_rejects_boolean_visual_fallback() -> None:
	payload = json.loads(_payload([(0, 0, 0)] * 16))
	payload["privacy"]["visualFallback"] = False

	with pytest.raises(PayloadVerificationError, match="privacy flags"):
		verify_payload(_corpus(), "receiver-test", json.dumps(payload).encode())


@pytest.mark.parametrize("invalid_grade", [0, 4, True, "1"])
def test_rejects_invalid_privacy_grade(invalid_grade: object) -> None:
	payload = json.loads(_payload([(0, 0, 0)] * 16))
	payload["privacy"]["grade"] = invalid_grade

	with pytest.raises(PayloadVerificationError, match="grade"):
		verify_payload(_corpus(), "receiver-test", json.dumps(payload).encode())


def test_accepts_semantic_redaction_mode_and_legacy_omission() -> None:
	pixels = [(255, 255, 255)] * 16
	for index in (5, 6, 9, 10):
		pixels[index] = (243, 244, 246)
	payload = json.loads(_payload(pixels))
	payload["privacy"]["redactionMode"] = "semantic"
	assert verify_payload(_corpus(), "receiver-test", json.dumps(payload).encode())["passed"] is True


def test_rejects_unknown_wire_field() -> None:
	payload = json.loads(_payload([(0, 0, 0)] * 16))
	payload["rawHtml"] = "<input>"

	with pytest.raises(PayloadVerificationError, match="unknown=.*rawHtml"):
		verify_payload(_corpus(), "receiver-test", json.dumps(payload).encode())


def test_rejects_png_metadata_chunks() -> None:
	payload = json.loads(_payload([(0, 0, 0)] * 16))
	clean_png = base64.b64decode(payload["image"]["dataBase64"])
	metadata = b"Comment\x00synthetic metadata"
	metadata_chunk = (
		struct.pack(">I", len(metadata))
		+ b"tEXt"
		+ metadata
		+ struct.pack(">I", binascii.crc32(b"tEXt" + metadata) & 0xFFFFFFFF)
	)
	# PNG signature (8 bytes) + fixed IHDR chunk (25 bytes).
	payload["image"]["dataBase64"] = base64.b64encode(
		clean_png[:33] + metadata_chunk + clean_png[33:]
	).decode()

	with pytest.raises(PayloadVerificationError, match="metadata chunk"):
		verify_payload(_corpus(), "receiver-test", json.dumps(payload).encode())


@pytest.mark.parametrize(
	"unsafe_origin",
	[
		"https://portal.example.test",
		"http://site-0123456789abcdefabcd.invalid",
		"https://site-0123456789ABCDEFabcd.invalid",
		"https://site-0123456789abcdefabcd.invalid/path",
		"https://site-0123456789abcdefabcd.invalid?query=secret",
		"https://user@site-0123456789abcdefabcd.invalid",
	],
)
def test_rejects_raw_or_malformed_origin_alias(unsafe_origin: str) -> None:
	payload = json.loads(_payload([(0, 0, 0)] * 16))
	payload["page"]["origin"] = unsafe_origin

	with pytest.raises(PayloadVerificationError, match="origin"):
		verify_payload(_corpus(), "receiver-test", json.dumps(payload).encode())
