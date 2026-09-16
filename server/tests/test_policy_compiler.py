from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path

import pytest

from app.policy_compiler import (
    PolicyCompilerError,
    assert_generated_current,
    canonical_digest,
    validate_registry,
)

ROOT = Path(__file__).resolve().parents[2]


def _registry() -> dict:
    return json.loads((ROOT / "server/app/detector-registry.json").read_text(encoding="utf-8"))


def test_checked_in_generated_modules_match_the_compiler() -> None:
    digest = assert_generated_current(ROOT)
    assert digest.startswith("sha256:")
    assert len(digest) == 71


def test_unknown_category_is_rejected() -> None:
    registry = _registry()
    registry["minimumGrades"]["medical"] = 1
    with pytest.raises(PolicyCompilerError, match="unknown_category"):
        validate_registry(registry, protocol_version="1.0")


def test_malformed_registry_is_rejected() -> None:
    with pytest.raises(PolicyCompilerError, match="malformed_"):
        validate_registry({"version": "1.1.0"}, protocol_version="1.0")
    registry = _registry()
    registry["supplementalPatterns"][0]["pattern"] = "("
    with pytest.raises(PolicyCompilerError, match="malformed_pattern"):
        validate_registry(registry, protocol_version="1.0")


def test_invariant_downgrade_is_rejected() -> None:
    registry = _registry()
    registry["minimumGrades"]["credential"] = 2
    with pytest.raises(PolicyCompilerError, match="invariant_downgrade"):
        validate_registry(registry, protocol_version="1.0")


def test_non_monotonic_threshold_is_rejected() -> None:
    registry = _registry()
    registry["minimumGrades"]["name"] = 1
    with pytest.raises(PolicyCompilerError, match="non_monotonic_threshold"):
        validate_registry(registry, protocol_version="1.0")


def test_digest_changes_when_a_threshold_changes() -> None:
    original = _registry()
    mutated = deepcopy(original)
    mutated["minimumGrades"]["username"] = 2
    assert canonical_digest(original, "1.0") != canonical_digest(mutated, "1.0")
