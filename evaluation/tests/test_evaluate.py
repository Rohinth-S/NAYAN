from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.evaluate import EvaluationInputError, Rect, _union_area, evaluate_documents


EVALUATION_ROOT = Path(__file__).resolve().parents[1]


def _corpus() -> dict:
	return {
		"schemaVersion": "1.0",
		"corpusId": "unit-test-corpus",
		"cases": [
			{
				"caseId": "case-a",
				"synthetic": True,
				"viewport": {"width": 100, "height": 100},
				"annotations": [
					{
						"annotationId": "email-box",
						"kind": "EMAIL",
						"sourceRef": "email-input",
						"field": "value",
						"bounds": {"x": 0, "y": 0, "width": 10, "height": 10},
						"countsForDetection": True,
						"requiresMask": True,
					},
					{
						"annotationId": "pan-attribute",
						"kind": "PAN",
						"sourceRef": "pan-input",
						"field": "attributes.data-pan",
						"countsForDetection": True,
						"requiresMask": False,
					},
				],
			}
		],
	}


def _results() -> dict:
	return {
		"schemaVersion": "1.0",
		"runId": "unit-test-run",
		"observations": [
			{
				"caseId": "case-a",
				"snapshotId": "snapshot-1",
				"privacy": {
					"detectorBackend": "test",
					"visualFallback": "none",
					"rawImageRetained": False,
				},
				"piiDetections": [
					{
						"detectionId": "email",
						"kind": "EMAIL",
						"source": "regex",
						"bounds": {"x": 0, "y": 0, "width": 10, "height": 10},
					},
					{
						"detectionId": "pan",
						"kind": "PAN",
						"source": "regex",
						"sourceRef": "pan-input",
						"field": "attributes.data-pan",
					},
					{
						"detectionId": "false-positive",
						"kind": "INDIAN_PHONE",
						"source": "regex",
						"bounds": {"x": 50, "y": 50, "width": 5, "height": 5},
					},
				],
				"redactions": [
					{
						"kind": "EMAIL",
						"source": "regex",
						"bounds": {"x": 0, "y": 0, "width": 12, "height": 12},
					}
				],
				"taskResult": {"success": True, "steps": 2, "terminalAction": "done"},
				"latencyMs": {"endToEnd": 100, "localDetection": 20},
				"resources": {"peakRssMb": 50, "maxMainThreadBlockMs": 4},
			}
		],
	}


def test_scores_detection_redaction_task_and_runtime() -> None:
	report = evaluate_documents(_corpus(), _results())

	assert report["piiDetection"]["micro"] == {
		"truePositives": 2,
		"falsePositives": 1,
		"falseNegatives": 0,
		"precision": 0.666667,
		"recall": 1.0,
		"f1": 0.8,
	}
	assert report["redaction"] == {
		"sensitivePixels": 100,
		"redactedPixels": 144,
		"coveredSensitivePixels": 100,
		"missedSensitivePixels": 0,
		"excessRedactedPixels": 44,
		"coverage": 1.0,
		"pixelPrecision": 0.694444,
		"excessRate": 0.305556,
	}
	assert report["task"]["successRate"] == 1.0
	assert report["task"]["meanSteps"] == 2.0
	assert report["latencyMs"]["endToEnd"]["p95"] == 100.0
	assert report["resources"]["peakRssMb"]["sampleCount"] == 1
	assert report["privacyGrades"] == {"1": 0, "2": 0, "3": 1}


def test_union_area_does_not_double_count_overlaps() -> None:
	assert _union_area([Rect(0, 0, 10, 10), Rect(5, 0, 10, 10)]) == 150


def test_rejects_raw_image_retention() -> None:
	results = _results()
	results["observations"][0]["privacy"]["rawImageRetained"] = True
	with pytest.raises(EvaluationInputError, match="rawImageRetained"):
		evaluate_documents(_corpus(), results)


def test_grade_one_excludes_grade_two_annotations_from_privacy_recall() -> None:
	corpus = _corpus()
	results = _results()
	results["observations"][0]["privacy"]["grade"] = 1
	for annotation in corpus["cases"][0]["annotations"]:
		if annotation["kind"] == "EMAIL":
			annotation["minimumPrivacyGrade"] = 2
		elif annotation["kind"] == "PAN":
			annotation["minimumPrivacyGrade"] = 1

	report = evaluate_documents(corpus, results)

	assert report["privacyGrades"] == {"1": 1, "2": 0, "3": 0}
	assert report["piiDetection"]["micro"]["truePositives"] == 1
	assert report["piiDetection"]["micro"]["falseNegatives"] == 0
	assert report["cases"][0]["redaction"]["sensitivePixels"] == 0


def test_rejects_invalid_privacy_grade() -> None:
	results = _results()
	results["observations"][0]["privacy"]["grade"] = True
	with pytest.raises(EvaluationInputError, match="grade"):
		evaluate_documents(_corpus(), results)


def test_derives_binary_detection_from_extension_redactions() -> None:
	results = _results()
	del results["observations"][0]["piiDetections"]
	results["observations"][0]["redactions"][0]["kind"] = "pii-text"

	report = evaluate_documents(_corpus(), results)

	assert report["piiDetection"]["micro"]["truePositives"] == 1
	assert report["piiDetection"]["micro"]["falsePositives"] == 0
	assert report["piiDetection"]["micro"]["falseNegatives"] == 1


def test_packaged_corpus_and_empty_template_are_accepted_without_fake_metrics() -> None:
	corpus = json.loads((EVALUATION_ROOT / "corpus" / "synthetic_cases.json").read_text(encoding="utf-8"))
	results = json.loads((EVALUATION_ROOT / "examples" / "run-results.template.json").read_text(encoding="utf-8"))

	report = evaluate_documents(corpus, results)

	assert report["coverage"]["corpusCaseCount"] == 4
	assert report["coverage"]["observedCaseCount"] == 0
	assert report["task"]["successRate"] is None
	assert report["piiDetection"]["micro"]["precision"] is None
	assert report["redaction"]["coverage"] is None
