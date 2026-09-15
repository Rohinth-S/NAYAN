#!/usr/bin/env python3
"""Deterministic scorer for the SIH26171 synthetic evaluation corpus.

The scorer intentionally consumes detector instrumentation rather than reconstructing
predictions from a sanitized network payload. Instrumentation uses fixture references
and bounding boxes, never raw sensitive values.
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


SCHEMA_VERSION = "1.0"
DETECTION_REDACTION_KINDS = {"pii-text", "password", "sensitive-field", "face"}


class EvaluationInputError(ValueError):
	"""Raised when a corpus or result document violates the evaluator contract."""


@dataclass(frozen=True, order=True)
class Rect:
	x: int
	y: int
	width: int
	height: int

	@property
	def right(self) -> int:
		return self.x + self.width

	@property
	def bottom(self) -> int:
		return self.y + self.height

	@property
	def area(self) -> int:
		return self.width * self.height

	def intersection(self, other: "Rect") -> "Rect | None":
		x1 = max(self.x, other.x)
		y1 = max(self.y, other.y)
		x2 = min(self.right, other.right)
		y2 = min(self.bottom, other.bottom)
		if x2 <= x1 or y2 <= y1:
			return None
		return Rect(x1, y1, x2 - x1, y2 - y1)

	def clip(self, width: int, height: int) -> "Rect | None":
		return self.intersection(Rect(0, 0, width, height))


def _load_json(path: Path) -> dict[str, Any]:
	try:
		data = json.loads(path.read_text(encoding="utf-8"))
	except (OSError, UnicodeError, json.JSONDecodeError) as exc:
		raise EvaluationInputError(f"Cannot read valid JSON from {path}: {exc}") from exc
	if not isinstance(data, dict):
		raise EvaluationInputError(f"Top-level value in {path} must be an object")
	return data


def _object(value: Any, field: str) -> dict[str, Any]:
	if not isinstance(value, dict):
		raise EvaluationInputError(f"{field} must be an object")
	return value


def _array(value: Any, field: str) -> list[Any]:
	if not isinstance(value, list):
		raise EvaluationInputError(f"{field} must be an array")
	return value


def _string(value: Any, field: str) -> str:
	if not isinstance(value, str) or not value:
		raise EvaluationInputError(f"{field} must be a non-empty string")
	return value


def _finite_number(value: Any, field: str) -> float:
	if isinstance(value, bool) or not isinstance(value, (int, float)):
		raise EvaluationInputError(f"{field} must be a number")
	number = float(value)
	if not math.isfinite(number) or number < 0:
		raise EvaluationInputError(f"{field} must be finite and non-negative")
	return number


def _privacy_grade(privacy: Mapping[str, Any], field: str) -> int:
	"""Read an explicit grade or apply the protocol's fail-safe legacy default."""
	grade = privacy.get("grade", 3)
	if isinstance(grade, bool) or not isinstance(grade, int) or grade not in {1, 2, 3}:
		raise EvaluationInputError(f"{field}.grade must be the integer 1, 2, or 3")
	return grade


def _annotation_applies(annotation: Mapping[str, Any], grade: int) -> bool:
	minimum_grade = annotation.get("minimumPrivacyGrade", 1)
	if isinstance(minimum_grade, bool) or not isinstance(minimum_grade, int) or minimum_grade not in {1, 2, 3}:
		raise EvaluationInputError("annotation.minimumPrivacyGrade must be the integer 1, 2, or 3")
	return minimum_grade <= grade


def _rect(value: Any, field: str) -> Rect:
	obj = _object(value, field)
	try:
		values = [obj[name] for name in ("x", "y", "width", "height")]
	except KeyError as exc:
		raise EvaluationInputError(f"{field} is missing {exc.args[0]}") from exc
	if any(isinstance(item, bool) or not isinstance(item, int) for item in values):
		raise EvaluationInputError(f"{field} coordinates must be integers")
	x, y, width, height = values
	if x < 0 or y < 0 or width <= 0 or height <= 0:
		raise EvaluationInputError(f"{field} must have non-negative position and positive size")
	return Rect(x, y, width, height)


def _ratio(numerator: int | float, denominator: int | float) -> float | None:
	if denominator == 0:
		return None
	return round(float(numerator) / float(denominator), 6)


def _f1(precision: float | None, recall: float | None) -> float | None:
	if precision is None or recall is None:
		return None
	if precision + recall == 0:
		return 0.0
	return round(2 * precision * recall / (precision + recall), 6)


def _union_area(rectangles: Iterable[Rect]) -> int:
	"""Return exact union area using a deterministic x-axis sweep."""
	rects = list(rectangles)
	if not rects:
		return 0
	x_points = sorted({edge for rect in rects for edge in (rect.x, rect.right)})
	total = 0
	for left, right in zip(x_points, x_points[1:]):
		if right <= left:
			continue
		intervals = sorted(
			(rect.y, rect.bottom) for rect in rects if rect.x < right and rect.right > left
		)
		if not intervals:
			continue
		merged_height = 0
		start, end = intervals[0]
		for next_start, next_end in intervals[1:]:
			if next_start > end:
				merged_height += end - start
				start, end = next_start, next_end
			else:
				end = max(end, next_end)
		merged_height += end - start
		total += (right - left) * merged_height
	return total


def _intersection_union_area(first: Sequence[Rect], second: Sequence[Rect]) -> int:
	intersections = []
	for left in first:
		for right in second:
			intersection = left.intersection(right)
			if intersection is not None:
				intersections.append(intersection)
	return _union_area(intersections)


def _iou(first: Rect, second: Rect) -> float:
	intersection = first.intersection(second)
	if intersection is None:
		return 0.0
	return intersection.area / (first.area + second.area - intersection.area)


def _locator_match(truth: Mapping[str, Any], prediction: Mapping[str, Any]) -> bool:
	truth_ref = truth.get("sourceRef")
	prediction_ref = prediction.get("sourceRef")
	if not isinstance(truth_ref, str) or truth_ref != prediction_ref:
		return False
	truth_field = truth.get("field")
	prediction_field = prediction.get("field")
	return isinstance(truth_field, str) and truth_field == prediction_field


def _match_quality(
	truth: Mapping[str, Any], prediction: Mapping[str, Any], iou_threshold: float
) -> float | None:
	if prediction.get("matchAnySensitiveKind") is not True and truth.get("kind") != prediction.get("kind"):
		return None
	truth_bounds = truth.get("bounds")
	prediction_bounds = prediction.get("bounds")
	if truth_bounds is not None and prediction_bounds is not None:
		quality = _iou(_rect(truth_bounds, "groundTruth.bounds"), _rect(prediction_bounds, "detection.bounds"))
		return quality if quality >= iou_threshold else None
	return 1.0 if _locator_match(truth, prediction) else None


def _maximum_matching(
	truths: Sequence[Mapping[str, Any]],
	predictions: Sequence[Mapping[str, Any]],
	iou_threshold: float,
) -> list[tuple[int, int, float]]:
	"""Find a deterministic maximum-cardinality bipartite match."""
	adjacency: dict[int, list[tuple[int, float]]] = {}
	for prediction_index, prediction in enumerate(predictions):
		edges = []
		for truth_index, truth in enumerate(truths):
			quality = _match_quality(truth, prediction, iou_threshold)
			if quality is not None:
				edges.append((truth_index, quality))
		adjacency[prediction_index] = sorted(
			edges,
			key=lambda edge: (
				-edge[1],
				str(truths[edge[0]].get("annotationId", edge[0])),
			),
		)

	truth_to_prediction: dict[int, int] = {}

	def assign(prediction_index: int, visited: set[int]) -> bool:
		for truth_index, _quality in adjacency[prediction_index]:
			if truth_index in visited:
				continue
			visited.add(truth_index)
			current = truth_to_prediction.get(truth_index)
			if current is None or assign(current, visited):
				truth_to_prediction[truth_index] = prediction_index
				return True
		return False

	prediction_order = sorted(
		range(len(predictions)),
		key=lambda index: str(predictions[index].get("detectionId", index)),
	)
	for prediction_index in prediction_order:
		assign(prediction_index, set())

	pairs = []
	for truth_index, prediction_index in sorted(truth_to_prediction.items()):
		quality = _match_quality(truths[truth_index], predictions[prediction_index], iou_threshold)
		assert quality is not None
		pairs.append((truth_index, prediction_index, quality))
	return pairs


def _metric_counts(tp: int, fp: int, fn: int) -> dict[str, int | float | None]:
	precision = _ratio(tp, tp + fp)
	recall = _ratio(tp, tp + fn)
	return {
		"truePositives": tp,
		"falsePositives": fp,
		"falseNegatives": fn,
		"precision": precision,
		"recall": recall,
		"f1": _f1(precision, recall),
	}


def _validate_document_versions(corpus: Mapping[str, Any], results: Mapping[str, Any]) -> None:
	if corpus.get("schemaVersion") != SCHEMA_VERSION:
		raise EvaluationInputError(f"Corpus schemaVersion must be {SCHEMA_VERSION}")
	if results.get("schemaVersion") != SCHEMA_VERSION:
		raise EvaluationInputError(f"Results schemaVersion must be {SCHEMA_VERSION}")
	_string(corpus.get("corpusId"), "corpus.corpusId")
	_string(results.get("runId"), "results.runId")


def _validate_and_index_cases(corpus: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
	cases: dict[str, dict[str, Any]] = {}
	for index, item in enumerate(_array(corpus.get("cases"), "corpus.cases")):
		case = _object(item, f"corpus.cases[{index}]")
		case_id = _string(case.get("caseId"), f"corpus.cases[{index}].caseId")
		if case_id in cases:
			raise EvaluationInputError(f"Duplicate corpus caseId: {case_id}")
		if case.get("synthetic") is not True:
			raise EvaluationInputError(f"Corpus case {case_id} must be explicitly marked synthetic=true")
		viewport = _object(case.get("viewport"), f"case {case_id}.viewport")
		width = viewport.get("width")
		height = viewport.get("height")
		if isinstance(width, bool) or not isinstance(width, int) or width <= 0:
			raise EvaluationInputError(f"case {case_id}.viewport.width must be a positive integer")
		if isinstance(height, bool) or not isinstance(height, int) or height <= 0:
			raise EvaluationInputError(f"case {case_id}.viewport.height must be a positive integer")
		for annotation_index, annotation_item in enumerate(
			_array(case.get("annotations"), f"case {case_id}.annotations")
		):
			annotation = _object(annotation_item, f"case {case_id}.annotations[{annotation_index}]")
			_string(annotation.get("annotationId"), "annotation.annotationId")
			_string(annotation.get("kind"), "annotation.kind")
			_annotation_applies(annotation, 3)
			if annotation.get("bounds") is not None:
				bounds = _rect(annotation["bounds"], "annotation.bounds")
				if bounds.right > width or bounds.bottom > height:
					raise EvaluationInputError(
						f"case {case_id} annotation {annotation['annotationId']} is outside viewport"
					)
		cases[case_id] = case
	return cases


def _validate_and_index_observations(
	results: Mapping[str, Any], cases: Mapping[str, Mapping[str, Any]]
) -> dict[str, dict[str, Any]]:
	observations: dict[str, dict[str, Any]] = {}
	for index, item in enumerate(_array(results.get("observations"), "results.observations")):
		observation = _object(item, f"results.observations[{index}]")
		case_id = _string(observation.get("caseId"), f"results.observations[{index}].caseId")
		if case_id not in cases:
			raise EvaluationInputError(f"Result references unknown caseId: {case_id}")
		if case_id in observations:
			raise EvaluationInputError(f"Duplicate result caseId: {case_id}")
		_string(observation.get("snapshotId"), f"result {case_id}.snapshotId")
		privacy = _object(observation.get("privacy"), f"result {case_id}.privacy")
		unknown_privacy = set(privacy) - {
			"detectorBackend",
			"visualFallback",
			"rawImageRetained",
			"redactionMode",
			"grade",
		}
		if unknown_privacy:
			raise EvaluationInputError(
				f"result {case_id}.privacy contains unknown fields: {sorted(unknown_privacy)}"
			)
		_string(privacy.get("detectorBackend"), f"result {case_id}.privacy.detectorBackend")
		if privacy.get("visualFallback") not in {"none", "full-mask"}:
			raise EvaluationInputError(
				f"result {case_id}.privacy.visualFallback must be 'none' or 'full-mask'"
			)
		if privacy.get("rawImageRetained") is not False:
			raise EvaluationInputError(f"result {case_id}.privacy.rawImageRetained must be false")
		redaction_mode = privacy.get("redactionMode", "opaque")
		if not isinstance(redaction_mode, str) or redaction_mode not in {"semantic", "opaque"}:
			raise EvaluationInputError(f"result {case_id}.privacy.redactionMode is invalid")
		_privacy_grade(privacy, f"result {case_id}.privacy")
		if observation.get("piiDetections") is not None:
			_array(observation.get("piiDetections"), f"result {case_id}.piiDetections")
		_array(observation.get("redactions"), f"result {case_id}.redactions")
		observations[case_id] = observation
	return observations


def _score_detection_case(
	case: Mapping[str, Any], observation: Mapping[str, Any], iou_threshold: float
) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]], list[tuple[int, int, float]]]:
	grade = _privacy_grade(_object(observation.get("privacy"), "observation.privacy"), "observation.privacy")
	truths: list[dict[str, Any]] = [
		_object(item, "annotation")
		for item in _array(case.get("annotations"), "case.annotations")
		if _object(item, "annotation").get("countsForDetection", True) is True
		and _annotation_applies(_object(item, "annotation"), grade)
	]
	if observation.get("piiDetections") is None:
		# The extension's strict wire schema exposes only redaction boxes. Treat the
		# detector-origin redaction kinds as binary sensitive-region detections and
		# exclude conservative full-media/fallback masks from PII precision/recall.
		predictions: list[dict[str, Any]] = [
			{
				"detectionId": f"redaction-{index}",
				"kind": str(redaction.get("kind")),
				"source": redaction.get("source"),
				"bounds": redaction.get("bounds"),
				"matchAnySensitiveKind": True,
			}
			for index, item in enumerate(_array(observation.get("redactions"), "observation.redactions"))
			if (redaction := _object(item, "redaction")).get("kind") in DETECTION_REDACTION_KINDS
		]
	else:
		predictions = [
			_object(item, "piiDetection")
			for item in _array(observation.get("piiDetections"), "observation.piiDetections")
		]
	for prediction in predictions:
		_string(prediction.get("detectionId"), "piiDetection.detectionId")
		_string(prediction.get("kind"), "piiDetection.kind")
		if prediction.get("bounds") is not None:
			_rect(prediction["bounds"], "piiDetection.bounds")
	pairs = _maximum_matching(truths, predictions, iou_threshold)
	matched_truth = {truth_index for truth_index, _prediction_index, _quality in pairs}
	matched_prediction = {prediction_index for _truth_index, prediction_index, _quality in pairs}
	counts = _metric_counts(
		len(pairs), len(predictions) - len(matched_prediction), len(truths) - len(matched_truth)
	)
	counts["meanMatchedIoU"] = (
		round(sum(quality for _truth, _prediction, quality in pairs) / len(pairs), 6)
		if pairs
		else None
	)
	return counts, truths, predictions, pairs


def _score_redaction_case(case: Mapping[str, Any], observation: Mapping[str, Any]) -> dict[str, Any]:
	viewport = _object(case.get("viewport"), "case.viewport")
	width = int(viewport["width"])
	height = int(viewport["height"])
	grade = _privacy_grade(_object(observation.get("privacy"), "observation.privacy"), "observation.privacy")
	sensitive = []
	for item in _array(case.get("annotations"), "case.annotations"):
		annotation = _object(item, "annotation")
		if (
			annotation.get("requiresMask") is True
			and annotation.get("bounds") is not None
			and _annotation_applies(annotation, grade)
		):
			sensitive.append(_rect(annotation["bounds"], "annotation.bounds"))
	redacted = []
	for index, item in enumerate(_array(observation.get("redactions"), "observation.redactions")):
		redaction = _object(item, f"redactions[{index}]")
		_string(redaction.get("kind"), f"redactions[{index}].kind")
		bounds = _rect(redaction.get("bounds"), f"redactions[{index}].bounds")
		clipped = bounds.clip(width, height)
		if clipped is not None:
			redacted.append(clipped)
	sensitive_pixels = _union_area(sensitive)
	redacted_pixels = _union_area(redacted)
	covered_pixels = _intersection_union_area(sensitive, redacted)
	missed_pixels = sensitive_pixels - covered_pixels
	excess_pixels = redacted_pixels - covered_pixels
	return {
		"sensitivePixels": sensitive_pixels,
		"redactedPixels": redacted_pixels,
		"coveredSensitivePixels": covered_pixels,
		"missedSensitivePixels": missed_pixels,
		"excessRedactedPixels": excess_pixels,
		"coverage": _ratio(covered_pixels, sensitive_pixels),
		"pixelPrecision": _ratio(covered_pixels, redacted_pixels),
		"excessRate": _ratio(excess_pixels, redacted_pixels),
	}


def _flatten_numeric(prefix: str, value: Any, target: dict[str, list[float]]) -> None:
	if isinstance(value, dict):
		for key in sorted(value):
			child_prefix = f"{prefix}.{key}" if prefix else key
			_flatten_numeric(child_prefix, value[key], target)
	elif value is not None:
		target[prefix].append(_finite_number(value, prefix))


def _summary(values: Sequence[float]) -> dict[str, int | float | None]:
	if not values:
		return {"sampleCount": 0, "min": None, "median": None, "mean": None, "p95": None, "max": None}
	ordered = sorted(values)
	p95_index = max(0, math.ceil(0.95 * len(ordered)) - 1)
	return {
		"sampleCount": len(ordered),
		"min": round(ordered[0], 6),
		"median": round(float(statistics.median(ordered)), 6),
		"mean": round(float(statistics.fmean(ordered)), 6),
		"p95": round(ordered[p95_index], 6),
		"max": round(ordered[-1], 6),
	}


def evaluate_documents(
	corpus: Mapping[str, Any], results: Mapping[str, Any], *, iou_threshold: float = 0.5
) -> dict[str, Any]:
	"""Validate and score an in-memory corpus and run-results document."""
	if not 0 < iou_threshold <= 1:
		raise EvaluationInputError("iou_threshold must be in (0, 1]")
	_validate_document_versions(corpus, results)
	cases = _validate_and_index_cases(corpus)
	observations = _validate_and_index_observations(results, cases)

	case_reports = []
	grade_counts = {1: 0, 2: 0, 3: 0}
	total_tp = total_fp = total_fn = 0
	per_kind_raw: dict[str, list[int]] = defaultdict(lambda: [0, 0, 0])
	total_sensitive = total_redacted = total_covered = 0
	task_total = task_succeeded = task_steps = 0
	latency_values: dict[str, list[float]] = defaultdict(list)
	resource_values: dict[str, list[float]] = defaultdict(list)

	for case_id in sorted(observations):
		case = cases[case_id]
		observation = observations[case_id]
		grade = _privacy_grade(_object(observation["privacy"], "observation.privacy"), "observation.privacy")
		grade_counts[grade] += 1
		detection, truths, predictions, pairs = _score_detection_case(case, observation, iou_threshold)
		redaction = _score_redaction_case(case, observation)
		total_tp += int(detection["truePositives"])
		total_fp += int(detection["falsePositives"])
		total_fn += int(detection["falseNegatives"])
		matched_truth = {truth_index for truth_index, _prediction, _quality in pairs}
		matched_prediction = {prediction_index for _truth, prediction_index, _quality in pairs}
		for truth_index, truth in enumerate(truths):
			kind = str(truth["kind"])
			per_kind_raw[kind][0 if truth_index in matched_truth else 2] += 1
		for prediction_index, prediction in enumerate(predictions):
			if prediction_index not in matched_prediction:
				per_kind_raw[str(prediction["kind"])][1] += 1
		total_sensitive += int(redaction["sensitivePixels"])
		total_redacted += int(redaction["redactedPixels"])
		total_covered += int(redaction["coveredSensitivePixels"])

		task_report: dict[str, Any] | None = None
		if observation.get("taskResult") is not None:
			task_result = _object(observation["taskResult"], f"result {case_id}.taskResult")
			if not isinstance(task_result.get("success"), bool):
				raise EvaluationInputError(f"result {case_id}.taskResult.success must be boolean")
			steps = task_result.get("steps")
			if isinstance(steps, bool) or not isinstance(steps, int) or steps < 0:
				raise EvaluationInputError(f"result {case_id}.taskResult.steps must be a non-negative integer")
			task_total += 1
			task_succeeded += int(task_result["success"])
			task_steps += steps
			task_report = {
				"success": task_result["success"],
				"steps": steps,
				"terminalAction": task_result.get("terminalAction"),
				"reasonCode": task_result.get("reasonCode"),
			}

		if observation.get("latencyMs") is not None:
			_flatten_numeric("", _object(observation["latencyMs"], "latencyMs"), latency_values)
		if observation.get("resources") is not None:
			_flatten_numeric("", _object(observation["resources"], "resources"), resource_values)

		case_reports.append(
			{
				"caseId": case_id,
				"snapshotId": observation["snapshotId"],
				"privacy": {**observation["privacy"], "grade": grade},
				"detection": detection,
				"redaction": redaction,
				"task": task_report,
			}
		)

	micro = _metric_counts(total_tp, total_fp, total_fn)
	per_kind = {
		kind: _metric_counts(counts[0], counts[1], counts[2])
		for kind, counts in sorted(per_kind_raw.items())
	}
	precision_values = [float(metrics["precision"]) for metrics in per_kind.values() if metrics["precision"] is not None]
	recall_values = [float(metrics["recall"]) for metrics in per_kind.values() if metrics["recall"] is not None]
	f1_values = [float(metrics["f1"]) for metrics in per_kind.values() if metrics["f1"] is not None]
	macro = {
		"precision": round(statistics.fmean(precision_values), 6) if precision_values else None,
		"recall": round(statistics.fmean(recall_values), 6) if recall_values else None,
		"f1": round(statistics.fmean(f1_values), 6) if f1_values else None,
	}

	redaction_excess = total_redacted - total_covered
	redaction_summary = {
		"sensitivePixels": total_sensitive,
		"redactedPixels": total_redacted,
		"coveredSensitivePixels": total_covered,
		"missedSensitivePixels": total_sensitive - total_covered,
		"excessRedactedPixels": redaction_excess,
		"coverage": _ratio(total_covered, total_sensitive),
		"pixelPrecision": _ratio(total_covered, total_redacted),
		"excessRate": _ratio(redaction_excess, total_redacted),
	}

	return {
		"reportSchemaVersion": SCHEMA_VERSION,
		"corpusId": corpus["corpusId"],
		"runId": results["runId"],
		"thresholds": {"detectionIoU": iou_threshold},
		"privacyGrades": {str(grade): grade_counts[grade] for grade in (1, 2, 3)},
		"coverage": {
			"corpusCaseCount": len(cases),
			"observedCaseCount": len(observations),
			"missingCaseIds": sorted(set(cases) - set(observations)),
		},
		"piiDetection": {"micro": micro, "macro": macro, "perKind": per_kind},
		"redaction": redaction_summary,
		"task": {
			"observedCount": task_total,
			"succeededCount": task_succeeded,
			"successRate": _ratio(task_succeeded, task_total),
			"meanSteps": _ratio(task_steps, task_total),
		},
		"latencyMs": {key: _summary(values) for key, values in sorted(latency_values.items())},
		"resources": {key: _summary(values) for key, values in sorted(resource_values.items())},
		"cases": case_reports,
	}


def _parser() -> argparse.ArgumentParser:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("--corpus", type=Path, required=True, help="Labeled corpus JSON")
	parser.add_argument("--results", type=Path, required=True, help="Observed run-results JSON")
	parser.add_argument("--output", type=Path, help="Write report JSON; stdout when omitted")
	parser.add_argument("--iou-threshold", type=float, default=0.5)
	return parser


def main(argv: Sequence[str] | None = None) -> int:
	args = _parser().parse_args(argv)
	try:
		report = evaluate_documents(
			_load_json(args.corpus), _load_json(args.results), iou_threshold=args.iou_threshold
		)
	except EvaluationInputError as exc:
		print(f"evaluation input error: {exc}", file=sys.stderr)
		return 2
	serialized = json.dumps(report, indent=2, sort_keys=True) + "\n"
	if args.output is None:
		sys.stdout.write(serialized)
	else:
		args.output.parent.mkdir(parents=True, exist_ok=True)
		args.output.write_text(serialized, encoding="utf-8")
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
