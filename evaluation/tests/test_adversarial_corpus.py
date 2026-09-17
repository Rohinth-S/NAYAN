from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / "corpus" / "adversarial-privacy-v1.json"


def test_adversarial_corpus_covers_all_declared_privacy_surfaces() -> None:
    payload = json.loads(CORPUS.read_text(encoding="utf-8"))
    required_axes = {
        "misspelled-names",
        "hindi-and-multilingual-text",
        "unusual-spacing",
        "image-embedded-identifiers",
        "canvas-text",
        "qr-code",
        "css-background",
        "shadow-dom",
        "overlapping-elements",
    }
    assert payload["synthetic"] is True
    assert set(payload["axes"]) == required_axes
    assert {case["axis"] for case in payload["cases"]} == required_axes
    assert all(case["syntheticValues"] for case in payload["cases"])


def test_adversarial_corpus_requires_measurable_results_without_fabricating_them() -> None:
    payload = json.loads(CORPUS.read_text(encoding="utf-8"))
    required_metrics = {
        "precision",
        "recall",
        "iou",
        "excessMaskedArea",
        "latencyMs",
        "peakMemoryMb",
    }
    assert set(payload["metrics"]["required"]) == required_metrics
    assert payload["metrics"]["results"] is None
