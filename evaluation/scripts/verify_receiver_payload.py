#!/usr/bin/env python3
"""Fail-closed checks over the exact JSON body received by the reasoning server."""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import re
import struct
import sys
import urllib.parse
import zlib
from pathlib import Path
from typing import Any, Iterable, Sequence


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
ORIGIN_ALIAS_PATTERN = r"^https://site-[0-9a-f]{20}\.invalid$"
ORIGIN_ALIAS_RE = re.compile(ORIGIN_ALIAS_PATTERN)
PLACEHOLDER_BACKGROUND = (243, 244, 246)


class PayloadVerificationError(ValueError):
	"""Raised when verification cannot be completed safely."""


def _read_json(path: Path) -> dict[str, Any]:
	try:
		value = json.loads(path.read_text(encoding="utf-8"))
	except (OSError, UnicodeError, json.JSONDecodeError) as exc:
		raise PayloadVerificationError(f"Cannot read valid JSON from {path}: {exc}") from exc
	if not isinstance(value, dict):
		raise PayloadVerificationError(f"Top-level value in {path} must be an object")
	return value


def _canary_variants(value: str) -> dict[str, bytes]:
	raw = value.encode("utf-8")
	variants = {
		"plain": raw,
		"url": urllib.parse.quote(value, safe="").encode("ascii"),
		"urlPlus": urllib.parse.quote_plus(value, safe="").encode("ascii"),
		"base64": base64.b64encode(raw),
		"base64Url": base64.urlsafe_b64encode(raw).rstrip(b"="),
	}
	return {name: encoded for name, encoded in variants.items() if encoded}


def _alphanumeric(value: str) -> str:
	return "".join(character for character in value.upper() if character.isalnum())


def _minimum_privacy_grade(value: dict[str, Any], field: str) -> int:
	grade = value.get("minimumPrivacyGrade", 1)
	if isinstance(grade, bool) or not isinstance(grade, int) or grade not in {1, 2, 3}:
		raise PayloadVerificationError(f"{field}.minimumPrivacyGrade must be the integer 1, 2, or 3")
	return grade


def _collect_canaries(corpus: dict[str, Any], case_id: str, privacy_grade: int) -> list[dict[str, Any]]:
	cases = corpus.get("cases")
	if not isinstance(cases, list):
		raise PayloadVerificationError("corpus.cases must be an array")
	for case in cases:
		if isinstance(case, dict) and case.get("caseId") == case_id:
			if case.get("synthetic") is not True:
				raise PayloadVerificationError(f"case {case_id} is not marked synthetic")
			canaries = case.get("canaries")
			if not isinstance(canaries, list):
				raise PayloadVerificationError(f"case {case_id}.canaries must be an array")
			return [
				canary
				for index, canary in enumerate(canaries)
				if isinstance(canary, dict)
				and _minimum_privacy_grade(canary, f"case {case_id}.canaries[{index}]") <= privacy_grade
			]
	raise PayloadVerificationError(f"Unknown caseId: {case_id}")


def _find_case(corpus: dict[str, Any], case_id: str) -> dict[str, Any]:
	for case in corpus.get("cases", []):
		if isinstance(case, dict) and case.get("caseId") == case_id:
			return case
	raise PayloadVerificationError(f"Unknown caseId: {case_id}")


def _exact_keys(value: Any, expected: set[str], field: str) -> dict[str, Any]:
	if not isinstance(value, dict):
		raise PayloadVerificationError(f"{field} must be an object")
	actual = set(value)
	if actual != expected:
		missing = sorted(expected - actual)
		unknown = sorted(actual - expected)
		raise PayloadVerificationError(f"{field} keys differ: missing={missing}, unknown={unknown}")
	return value


def _wire_bounds(value: Any, field: str) -> None:
	box = _exact_keys(value, {"x", "y", "width", "height"}, field)
	for name in ("x", "y", "width", "height"):
		coordinate = box[name]
		if isinstance(coordinate, bool) or not isinstance(coordinate, int):
			raise PayloadVerificationError(f"{field}.{name} must be an integer")
	if box["x"] < 0 or box["y"] < 0 or box["width"] <= 0 or box["height"] <= 0:
		raise PayloadVerificationError(f"{field} has invalid dimensions")


def _validate_wire_shape(payload: dict[str, Any], case: dict[str, Any]) -> None:
	_exact_keys(
		payload,
		{"schemaVersion", "snapshotId", "documentId", "page", "task", "elements", "image", "redactions", "privacy"},
		"request",
	)
	for field in ("snapshotId", "documentId", "task"):
		if not isinstance(payload[field], str) or not payload[field]:
			raise PayloadVerificationError(f"request.{field} must be a non-empty string")
	page = _exact_keys(payload["page"], {"origin", "title"}, "request.page")
	if not isinstance(page["origin"], str) or not isinstance(page["title"], str):
		raise PayloadVerificationError("request.page fields must be strings")
	parsed_origin = urllib.parse.urlsplit(page["origin"])
	if (
		parsed_origin.scheme not in {"http", "https"}
		or not parsed_origin.hostname
		or parsed_origin.username is not None
		or parsed_origin.password is not None
		or parsed_origin.path not in {"", "/"}
		or parsed_origin.query
		or parsed_origin.fragment
	):
		raise PayloadVerificationError("request.page.origin must contain only scheme and authority")
	if ORIGIN_ALIAS_RE.fullmatch(page["origin"]) is None:
		raise PayloadVerificationError("request.page.origin is not a keyed extension alias")
	expected_pattern = case.get("wireExpectations", {}).get("originAliasPattern")
	if expected_pattern is not None and expected_pattern != ORIGIN_ALIAS_PATTERN:
		raise PayloadVerificationError("Synthetic case originAliasPattern does not match protocol v1")

	elements = payload["elements"]
	if not isinstance(elements, list):
		raise PayloadVerificationError("request.elements must be an array")
	raw_source_refs = {
		str(element["sourceRef"])
		for element in case.get("rawFixture", {}).get("elements", [])
		if isinstance(element, dict) and isinstance(element.get("sourceRef"), str)
	}
	for index, item in enumerate(elements):
		element = _exact_keys(item, {"id", "role", "label", "bounds", "state"}, f"request.elements[{index}]")
		for field in ("id", "role", "label"):
			if not isinstance(element[field], str):
				raise PayloadVerificationError(f"request.elements[{index}].{field} must be a string")
		if not element["id"] or element["id"] in raw_source_refs:
			raise PayloadVerificationError(f"request.elements[{index}].id is not opaque")
		_wire_bounds(element["bounds"], f"request.elements[{index}].bounds")
		state = _exact_keys(
			element["state"], {"disabled", "checked", "editable", "required"}, f"request.elements[{index}].state"
		)
		if any(not isinstance(value, bool) for value in state.values()):
			raise PayloadVerificationError(f"request.elements[{index}].state values must be boolean")

	image = _exact_keys(payload["image"], {"mime", "dataBase64", "width", "height"}, "request.image")
	if image["mime"] != "image/png" or not isinstance(image["dataBase64"], str):
		raise PayloadVerificationError("request.image must contain base64-encoded image/png")
	for field in ("width", "height"):
		if isinstance(image[field], bool) or not isinstance(image[field], int) or image[field] <= 0:
			raise PayloadVerificationError(f"request.image.{field} must be a positive integer")

	redactions = payload["redactions"]
	if not isinstance(redactions, list):
		raise PayloadVerificationError("request.redactions must be an array")
	for index, item in enumerate(redactions):
		redaction = _exact_keys(item, {"kind", "source", "bounds"}, f"request.redactions[{index}]")
		if not isinstance(redaction["kind"], str) or not isinstance(redaction["source"], str):
			raise PayloadVerificationError(f"request.redactions[{index}] labels must be strings")
		_wire_bounds(redaction["bounds"], f"request.redactions[{index}].bounds")

	if not isinstance(payload["privacy"], dict):
		raise PayloadVerificationError("request.privacy must be an object")
	privacy = payload["privacy"]
	required_privacy = {"detectorBackend", "visualFallback", "rawImageRetained"}
	optional_privacy = {"grade", "redactionMode"}
	missing_privacy = required_privacy - set(privacy)
	unknown_privacy = set(privacy) - required_privacy - optional_privacy
	if missing_privacy or unknown_privacy:
		raise PayloadVerificationError(
			f"request.privacy keys differ: missing={sorted(missing_privacy)}, unknown={sorted(unknown_privacy)}"
		)
	if not isinstance(privacy["detectorBackend"], str) or not privacy["detectorBackend"]:
		raise PayloadVerificationError("request.privacy.detectorBackend must be a non-empty string")
	if (
		not isinstance(privacy["visualFallback"], str)
		or privacy["visualFallback"] not in {"none", "full-mask"}
		or privacy["rawImageRetained"] is not False
	):
		raise PayloadVerificationError("request.privacy flags are invalid")
	grade = privacy.get("grade", 3)
	if isinstance(grade, bool) or not isinstance(grade, int) or grade not in {1, 2, 3}:
		raise PayloadVerificationError("request.privacy.grade must be the integer 1, 2, or 3")
	redaction_mode = privacy.get("redactionMode", "opaque")
	if not isinstance(redaction_mode, str) or redaction_mode not in {"semantic", "opaque"}:
		raise PayloadVerificationError("request.privacy.redactionMode is invalid")
	if privacy.get("visualFallback") == "full-mask" and redaction_mode != "opaque":
		raise PayloadVerificationError("full-mask fallback must use opaque redaction mode")


def _find_png_base64(payload: Any) -> str:
	matches: list[str] = []

	def visit(value: Any) -> None:
		if isinstance(value, dict):
			for key, child in value.items():
				if key == "dataBase64" and isinstance(child, str):
					matches.append(child)
				else:
					visit(child)
		elif isinstance(value, list):
			for child in value:
				visit(child)

	visit(payload)
	if len(matches) != 1:
		raise PayloadVerificationError(f"Expected exactly one image.dataBase64 field, found {len(matches)}")
	value = matches[0]
	if value.startswith("data:"):
		prefix = "data:image/png;base64,"
		if not value.startswith(prefix):
			raise PayloadVerificationError("Only a PNG data URL is supported")
		value = value[len(prefix) :]
	return value


def _paeth(left: int, above: int, upper_left: int) -> int:
	estimate = left + above - upper_left
	left_distance = abs(estimate - left)
	above_distance = abs(estimate - above)
	upper_left_distance = abs(estimate - upper_left)
	if left_distance <= above_distance and left_distance <= upper_left_distance:
		return left
	if above_distance <= upper_left_distance:
		return above
	return upper_left


def _decode_png_rgb(data: bytes) -> tuple[int, int, list[tuple[int, int, int, int]]]:
	"""Decode non-interlaced 8-bit RGB/RGBA PNGs using only the standard library."""
	if not data.startswith(PNG_SIGNATURE):
		raise PayloadVerificationError("Decoded image is not a PNG")
	position = len(PNG_SIGNATURE)
	width = height = color_type = bit_depth = interlace = None
	idat = bytearray()
	seen_iend = False
	seen_ihdr = False
	seen_idat = False
	while position < len(data):
		if position + 12 > len(data):
			raise PayloadVerificationError("Truncated PNG chunk")
		length = struct.unpack(">I", data[position : position + 4])[0]
		chunk_type = data[position + 4 : position + 8]
		chunk_start = position + 8
		chunk_end = chunk_start + length
		crc_end = chunk_end + 4
		if crc_end > len(data):
			raise PayloadVerificationError("Truncated PNG chunk payload")
		chunk = data[chunk_start:chunk_end]
		expected_crc = struct.unpack(">I", data[chunk_end:crc_end])[0]
		actual_crc = binascii.crc32(chunk_type + chunk) & 0xFFFFFFFF
		if expected_crc != actual_crc:
			raise PayloadVerificationError("PNG CRC mismatch")
		position = crc_end
		if chunk_type == b"IHDR":
			if seen_ihdr or seen_idat:
				raise PayloadVerificationError("PNG IHDR ordering is invalid")
			if len(chunk) != 13:
				raise PayloadVerificationError("Invalid PNG IHDR")
			seen_ihdr = True
			width, height, bit_depth, color_type, compression, filtering, interlace = struct.unpack(
				">IIBBBBB", chunk
			)
			if width <= 0 or height <= 0 or width * height > 20_000_000:
				raise PayloadVerificationError("Unsafe PNG dimensions")
			if compression != 0 or filtering != 0:
				raise PayloadVerificationError("Unsupported PNG compression or filter method")
		elif chunk_type == b"IDAT":
			if not seen_ihdr:
				raise PayloadVerificationError("PNG IDAT appears before IHDR")
			seen_idat = True
			idat.extend(chunk)
		elif chunk_type == b"IEND":
			if not seen_ihdr or not seen_idat or chunk:
				raise PayloadVerificationError("PNG IEND ordering is invalid")
			seen_iend = True
			break
		else:
			# Ancillary chunks can carry profiles or arbitrary text. A fresh outbound
			# raster has no reason to retain them, so verification rejects all of them.
			raise PayloadVerificationError("Receiver PNG contains a non-pixel metadata chunk")
	if position != len(data):
		raise PayloadVerificationError("Receiver PNG contains trailing data")
	if (
		not seen_iend
		or width is None
		or height is None
		or bit_depth is None
		or color_type is None
		or interlace is None
	):
		raise PayloadVerificationError("Incomplete PNG")
	if bit_depth != 8 or color_type not in (2, 6) or interlace != 0:
		raise PayloadVerificationError("Verifier supports non-interlaced 8-bit RGB/RGBA PNGs only")
	channels = 3 if color_type == 2 else 4
	stride = int(width) * channels
	try:
		filtered = zlib.decompress(bytes(idat))
	except zlib.error as exc:
		raise PayloadVerificationError("Invalid compressed PNG pixels") from exc
	expected_size = int(height) * (stride + 1)
	if len(filtered) != expected_size:
		raise PayloadVerificationError("Unexpected PNG pixel payload length")
	rows: list[bytearray] = []
	offset = 0
	previous = bytearray(stride)
	for _row_index in range(int(height)):
		filter_type = filtered[offset]
		offset += 1
		raw = filtered[offset : offset + stride]
		offset += stride
		reconstructed = bytearray(stride)
		for index, byte in enumerate(raw):
			left = reconstructed[index - channels] if index >= channels else 0
			above = previous[index]
			upper_left = previous[index - channels] if index >= channels else 0
			if filter_type == 0:
				value = byte
			elif filter_type == 1:
				value = byte + left
			elif filter_type == 2:
				value = byte + above
			elif filter_type == 3:
				value = byte + ((left + above) // 2)
			elif filter_type == 4:
				value = byte + _paeth(left, above, upper_left)
			else:
				raise PayloadVerificationError(f"Unsupported PNG row filter {filter_type}")
			reconstructed[index] = value & 0xFF
		rows.append(reconstructed)
		previous = reconstructed
	pixels = []
	for row in rows:
		for offset in range(0, len(row), channels):
			alpha = row[offset + 3] if channels == 4 else 255
			pixels.append((row[offset], row[offset + 1], row[offset + 2], alpha))
	return int(width), int(height), pixels


def _annotation_pixels(
	pixels: Sequence[tuple[int, int, int, int]], width: int, height: int, bounds: dict[str, Any]
) -> Iterable[tuple[int, int, int, int]]:
	try:
		x = int(bounds["x"])
		y = int(bounds["y"])
		box_width = int(bounds["width"])
		box_height = int(bounds["height"])
	except (KeyError, TypeError, ValueError) as exc:
		raise PayloadVerificationError("Invalid annotation bounds") from exc
	if x < 0 or y < 0 or box_width <= 0 or box_height <= 0 or x + box_width > width or y + box_height > height:
		raise PayloadVerificationError("Annotation bounds are outside receiver PNG")
	for row in range(y, y + box_height):
		start = row * width + x
		yield from pixels[start : start + box_width]


def _annotation_corners(
	pixels: Sequence[tuple[int, int, int, int]], width: int, height: int, bounds: dict[str, Any]
) -> list[tuple[int, int, int, int]]:
	try:
		x = int(bounds["x"])
		y = int(bounds["y"])
		box_width = int(bounds["width"])
		box_height = int(bounds["height"])
	except (KeyError, TypeError, ValueError) as exc:
		raise PayloadVerificationError("Invalid annotation bounds") from exc
	if x < 0 or y < 0 or box_width <= 0 or box_height <= 0 or x + box_width > width or y + box_height > height:
		raise PayloadVerificationError("Annotation bounds are outside receiver PNG")
	points = ((x, y), (x + box_width - 1, y), (x, y + box_height - 1), (x + box_width - 1, y + box_height - 1))
	return [pixels[row * width + column] for column, row in points]


def verify_payload(
	corpus: dict[str, Any],
	case_id: str,
	payload_bytes: bytes,
	*,
	min_mask_coverage: float = 1.0,
	mask_rgb: tuple[int, int, int] = (0, 0, 0),
) -> dict[str, Any]:
	if not 0 <= min_mask_coverage <= 1:
		raise PayloadVerificationError("min_mask_coverage must be between 0 and 1")
	case = _find_case(corpus, case_id)
	try:
		payload = json.loads(payload_bytes.decode("utf-8"))
	except (UnicodeError, json.JSONDecodeError) as exc:
		raise PayloadVerificationError("Receiver body must be UTF-8 JSON") from exc
	if not isinstance(payload, dict):
		raise PayloadVerificationError("Receiver body must be a JSON object")
	_validate_wire_shape(payload, case)
	privacy = payload.get("privacy")
	if not isinstance(privacy, dict) or privacy.get("rawImageRetained") is not False:
		raise PayloadVerificationError("privacy.rawImageRetained must be false")
	privacy_grade = privacy.get("grade", 3)
	assert isinstance(privacy_grade, int) and not isinstance(privacy_grade, bool)
	canaries = _collect_canaries(corpus, case_id, privacy_grade)
	leaks = []
	lower_payload = payload_bytes.lower()
	normalized_payload = _alphanumeric(payload_bytes.decode("utf-8", errors="ignore"))
	for canary in canaries:
		canary_id = canary.get("canaryId")
		value = canary.get("value")
		if not isinstance(canary_id, str) or not isinstance(value, str) or not value:
			raise PayloadVerificationError("Every canary needs non-empty canaryId and value")
		for representation, encoded in _canary_variants(value).items():
			if encoded.lower() in lower_payload:
				leaks.append({"canaryId": canary_id, "representation": representation})
		normalized_canary = _alphanumeric(value)
		if len(normalized_canary) >= 8 and normalized_canary in normalized_payload:
			leaks.append({"canaryId": canary_id, "representation": "separatorInsensitive"})
	if payload.get("schemaVersion") != "1.0":
		raise PayloadVerificationError("Receiver payload schemaVersion must be 1.0")

	png_base64 = _find_png_base64(payload)
	try:
		png_bytes = base64.b64decode(png_base64, validate=True)
	except (ValueError, binascii.Error) as exc:
		raise PayloadVerificationError("image.dataBase64 is not strict base64") from exc
	width, height, pixels = _decode_png_rgb(png_bytes)
	image = payload.get("image")
	if not isinstance(image, dict) or image.get("width") != width or image.get("height") != height:
		raise PayloadVerificationError("Receiver PNG dimensions do not match image metadata")

	mask_assertions = []
	redaction_mode = privacy.get("redactionMode", "opaque")
	for annotation in case.get("annotations", []):
		if (
			not isinstance(annotation, dict)
			or annotation.get("requiresMask") is not True
			or _minimum_privacy_grade(annotation, "annotation") > privacy_grade
		):
			continue
		bounds = annotation.get("bounds")
		if not isinstance(bounds, dict):
			continue
		region_pixels = list(_annotation_pixels(pixels, width, height, bounds))
		mask_count = sum(
			1 for red, green, blue, alpha in region_pixels if (red, green, blue) == mask_rgb and alpha == 255
		)
		placeholder_count = sum(
			1
			for red, green, blue, _alpha in region_pixels
			if (red, green, blue) == PLACEHOLDER_BACKGROUND
		)
		coverage = mask_count / len(region_pixels)
		original_color = annotation.get("sourceColorRgb")
		original_color_count: int | None = None
		if isinstance(original_color, list) and len(original_color) == 3:
			target = tuple(int(component) for component in original_color)
			original_color_count = sum(
				1 for red, green, blue, _alpha in region_pixels if (red, green, blue) == target
			)
		if redaction_mode == "opaque":
			passed = coverage >= min_mask_coverage and (original_color_count in (None, 0))
		else:
			corners = _annotation_corners(pixels, width, height, bounds)
			neutral_corner_count = sum(1 for red, green, blue, _alpha in corners if (red, green, blue) == PLACEHOLDER_BACKGROUND)
			passed = neutral_corner_count == 4 and placeholder_count > 0 and (original_color_count in (None, 0))
		mask_assertions.append(
			{
				"annotationId": annotation.get("annotationId"),
				"redactionMode": redaction_mode,
				"maskCoverage": round(coverage, 6),
				"placeholderCoverage": round(placeholder_count / len(region_pixels), 6),
				"originalColorPixelCount": original_color_count,
				"passed": passed,
			}
		)

	# Deduplicate without printing any sensitive value.
	unique_leaks = sorted(
		{(item["canaryId"], item["representation"]) for item in leaks},
		key=lambda item: (item[0], item[1]),
	)
	leak_report = [{"canaryId": item[0], "representation": item[1]} for item in unique_leaks]
	passed = not leak_report and all(assertion["passed"] for assertion in mask_assertions)
	return {
		"caseId": case_id,
		"privacyGrade": privacy_grade,
		"passed": passed,
		"textCanaryLeaks": leak_report,
		"maskAssertions": mask_assertions,
		"decodedImage": {"width": width, "height": height, "format": "PNG"},
	}


def _parser() -> argparse.ArgumentParser:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("--corpus", required=True, type=Path)
	parser.add_argument("--case-id", required=True)
	parser.add_argument("--payload", required=True, type=Path, help="Exact receiver-side HTTP body")
	parser.add_argument("--min-mask-coverage", type=float, default=1.0)
	return parser


def main(argv: Sequence[str] | None = None) -> int:
	args = _parser().parse_args(argv)
	try:
		corpus = _read_json(args.corpus)
		payload_bytes = args.payload.read_bytes()
		report = verify_payload(
			corpus, args.case_id, payload_bytes, min_mask_coverage=args.min_mask_coverage
		)
	except (OSError, PayloadVerificationError) as exc:
		print(f"payload verification error: {exc}", file=sys.stderr)
		return 2
	print(json.dumps(report, indent=2, sort_keys=True))
	return 0 if report["passed"] else 1


if __name__ == "__main__":
	raise SystemExit(main())
