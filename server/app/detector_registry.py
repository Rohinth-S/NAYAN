"""Shared supplementary recognizers; models are never run at the receiver."""
from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path

from app.generated_policy import REGISTRY_VERSION

REGISTRY = json.loads(Path(__file__).with_name("detector-registry.json").read_text(encoding="utf-8"))
if REGISTRY["version"] != REGISTRY_VERSION:
    raise RuntimeError("generated policy registry version drift")
DETECTOR_REGISTRY_VERSION = REGISTRY["version"]
MINIMUM_GRADES = REGISTRY["minimumGrades"]
PATTERNS = tuple(
    (p["kind"], MINIMUM_GRADES[p["category"]], re.compile(p["pattern"], re.IGNORECASE))
    for p in REGISTRY["supplementalPatterns"]
)


def normalize_for_detection(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    text = re.sub(r"[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]", "", text)
    text = "".join(str(unicodedata.digit(c)) if c in "०१२३४५६७८९٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹" else c for c in text)
    text = re.sub(r"[\u2010-\u2015\u2212]", "-", text)
    text = re.sub(r"\s*([@.])\s*", r"\1", text)
    return re.sub(r"(?<=\d)\s+(?=\d)", "", text)
