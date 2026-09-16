"""Compile the shared detector registry into typed client and server modules."""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

ALLOWED_CATEGORIES: tuple[str, ...] = (
    "credential",
    "government-id",
    "financial",
    "biometric",
    "custom",
    "uninspectable",
    "contact",
    "location",
    "date-of-birth",
    "network",
    "account-id",
    "name",
    "username",
    "professional-id",
    "unknown-populated-field",
)
INVARIANT_CATEGORIES: tuple[str, ...] = (
    "credential",
    "government-id",
    "financial",
    "biometric",
    "custom",
    "uninspectable",
)
CONTEXTUAL_CATEGORIES: tuple[str, ...] = (
    "contact",
    "location",
    "date-of-birth",
    "network",
    "account-id",
)
IDENTITY_CATEGORIES: tuple[str, ...] = (
    "name",
    "username",
    "professional-id",
    "unknown-populated-field",
)
VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
KIND_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")

PYTHON_MODULE = Path("server/app/generated_policy.py")
TYPESCRIPT_MODULE = Path("extension/src/generated-policy.ts")
REGISTRY_PATH = Path("server/app/detector-registry.json")
MANIFEST_PATH = Path("governance/protocol-manifest.json")
SCHEMA_PATH = Path("governance/detector-registry.schema.json")


class PolicyCompilerError(ValueError):
    pass


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def canonical_digest(registry: dict[str, Any], protocol_version: str) -> str:
    payload = {"protocolVersion": protocol_version, "registry": registry}
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _require_object(value: object, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise PolicyCompilerError(f"malformed_{name}")
    return value


def _require_string(value: object, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise PolicyCompilerError(f"malformed_{name}")
    return value


def validate_registry(registry: dict[str, Any], *, protocol_version: str) -> None:
    extra = set(registry) - {"version", "minimumGrades", "supplementalPatterns"}
    if extra:
        raise PolicyCompilerError("unknown_registry_field")
    version = _require_string(registry.get("version"), "version")
    if not VERSION_RE.fullmatch(version):
        raise PolicyCompilerError("malformed_version")
    if protocol_version != "1.0":
        raise PolicyCompilerError("unsupported_protocol_version")

    grades_raw = _require_object(registry.get("minimumGrades"), "minimumGrades")
    extra_grades = set(grades_raw) - set(ALLOWED_CATEGORIES)
    if extra_grades:
        raise PolicyCompilerError("unknown_category")
    missing = set(ALLOWED_CATEGORIES) - set(grades_raw)
    if missing:
        raise PolicyCompilerError("missing_category")
    grades: dict[str, int] = {}
    for category, value in grades_raw.items():
        if not isinstance(value, int) or isinstance(value, bool) or value not in {1, 2, 3}:
            raise PolicyCompilerError("malformed_grade")
        grades[category] = value

    for category in INVARIANT_CATEGORIES:
        if grades[category] != 1:
            raise PolicyCompilerError("invariant_downgrade")
    if max(grades[category] for category in INVARIANT_CATEGORIES) > min(
        grades[category] for category in CONTEXTUAL_CATEGORIES
    ) or max(grades[category] for category in CONTEXTUAL_CATEGORIES) > min(
        grades[category] for category in IDENTITY_CATEGORIES
    ):
        raise PolicyCompilerError("non_monotonic_threshold")

    patterns = registry.get("supplementalPatterns")
    if not isinstance(patterns, list) or not patterns:
        raise PolicyCompilerError("malformed_supplementalPatterns")
    seen_patterns: set[tuple[str, str]] = set()
    kind_categories: dict[str, str] = {}
    for item in patterns:
        pattern = _require_object(item, "supplementalPattern")
        if set(pattern) != {"kind", "category", "pattern"}:
            raise PolicyCompilerError("malformed_supplementalPattern")
        kind = _require_string(pattern.get("kind"), "kind")
        if not KIND_RE.fullmatch(kind):
            raise PolicyCompilerError("malformed_kind")
        category = _require_string(pattern.get("category"), "pattern_category")
        if category not in ALLOWED_CATEGORIES:
            raise PolicyCompilerError("unknown_category")
        if kind in kind_categories and kind_categories[kind] != category:
            raise PolicyCompilerError("kind_category_mismatch")
        kind_categories[kind] = category
        expression = _require_string(pattern.get("pattern"), "pattern")
        if len(expression) > 400:
            raise PolicyCompilerError("malformed_pattern")
        key = (kind, expression)
        if key in seen_patterns:
            raise PolicyCompilerError("duplicate_pattern")
        seen_patterns.add(key)
        try:
            re.compile(expression)
        except re.error as exc:
            raise PolicyCompilerError("malformed_pattern") from exc


def render_python(registry: dict[str, Any], protocol_version: str, digest: str) -> str:
    grades = ",\n    ".join(
        f"{json.dumps(key)}: {value}" for key, value in registry["minimumGrades"].items()
    )
    invariants = ",\n    ".join(json.dumps(item) for item in INVARIANT_CATEGORIES)
    return (
        '"""Generated policy registry. Do not edit by hand.\n\n'
        "Produced by scripts/generate-policy-registry.py from\n"
        "server/app/detector-registry.json and governance/protocol-manifest.json.\n"
        '"""\n'
        "from __future__ import annotations\n\n"
        f"PROTOCOL_VERSION = {json.dumps(protocol_version)}\n"
        f"REGISTRY_VERSION = {json.dumps(registry['version'])}\n"
        f"REGISTRY_DIGEST = {json.dumps(digest)}\n"
        "MINIMUM_GRADES: dict[str, int] = {\n"
        f"    {grades},\n"
        "}\n"
        "INVARIANT_CATEGORIES: tuple[str, ...] = (\n"
        f"    {invariants},\n"
        ")\n"
    )


def _ts_string(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def render_typescript(registry: dict[str, Any], protocol_version: str, digest: str) -> str:
    grades = ",\n  ".join(
        f"{_ts_string(key)}: {value}" for key, value in registry["minimumGrades"].items()
    )
    invariants = ",\n  ".join(_ts_string(item) for item in INVARIANT_CATEGORIES)
    return (
        "/** Generated policy registry. Do not edit by hand. */\n"
        f"export const PROTOCOL_VERSION = {_ts_string(protocol_version)} as const;\n"
        f"export const REGISTRY_VERSION = {_ts_string(registry['version'])} as const;\n"
        f"export const REGISTRY_DIGEST = {_ts_string(digest)} as const;\n"
        "export const MINIMUM_GRADES = {\n"
        f"  {grades},\n"
        "} as const;\n"
        "export const INVARIANT_CATEGORIES = [\n"
        f"  {invariants},\n"
        "] as const;\n"
    )


def compile_registry(root: Path) -> tuple[str, str, str]:
    registry = load_json(root / REGISTRY_PATH)
    manifest = load_json(root / MANIFEST_PATH)
    schema = load_json(root / SCHEMA_PATH)
    if not isinstance(registry, dict) or not isinstance(manifest, dict) or not isinstance(schema, dict):
        raise PolicyCompilerError("malformed_source")
    schema_categories = schema.get("properties", {}).get("minimumGrades", {}).get("required")
    if schema_categories != list(ALLOWED_CATEGORIES):
        raise PolicyCompilerError("schema_category_drift")
    protocol_version = _require_string(manifest.get("schemaVersion"), "protocol_version")
    validate_registry(registry, protocol_version=protocol_version)
    digest = canonical_digest(registry, protocol_version)
    if not DIGEST_RE.fullmatch(digest):
        raise PolicyCompilerError("malformed_digest")
    return (
        digest,
        render_python(registry, protocol_version, digest),
        render_typescript(registry, protocol_version, digest),
    )


def write_generated(root: Path) -> str:
    digest, python_source, typescript_source = compile_registry(root)
    python_path = root / PYTHON_MODULE
    typescript_path = root / TYPESCRIPT_MODULE
    python_path.write_text(python_source, encoding="utf-8")
    typescript_path.write_text(typescript_source, encoding="utf-8")
    return digest


def assert_generated_current(root: Path) -> str:
    digest, python_source, typescript_source = compile_registry(root)
    python_path = root / PYTHON_MODULE
    typescript_path = root / TYPESCRIPT_MODULE
    if python_path.read_text(encoding="utf-8") != python_source:
        raise PolicyCompilerError("generated_python_drift")
    if typescript_path.read_text(encoding="utf-8") != typescript_source:
        raise PolicyCompilerError("generated_typescript_drift")
    return digest
