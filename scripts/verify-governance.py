"""Validate the Rohinth-owned protocol, policy, evidence, and egress gates."""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def fail(message: str) -> None:
    raise SystemExit(f"governance_check=failed detail={message}")


def main() -> int:
    manifest_path = ROOT / "governance" / "protocol-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected = {
        "schemaVersion": "1.0",
        "policyVersion": "1.0",
        "allowedActions": ["click", "input", "scroll", "wait", "done"],
        "privacyGrades": [1, 2, 3],
        "singleEgressFile": "extension/src/egress.ts",
        "defaultDetectorFailure": "full-mask-or-no-request",
    }
    for key, value in expected.items():
        if manifest.get(key) != value:
            fail(f"manifest_{key}")

    protocol = (ROOT / "PROTOCOL.md").read_text(encoding="utf-8")
    privacy = (ROOT / "PRIVACY_LEVELS.md").read_text(encoding="utf-8")
    matrix = (ROOT / "EDGE_CASE_MATRIX.md").read_text(encoding="utf-8")
    migration = (ROOT / "governance" / "PROTOCOL_MIGRATIONS.md").read_text(encoding="utf-8")
    for name, text in (("protocol", protocol), ("privacy", privacy), ("matrix", matrix), ("migration", migration)):
        if "1.0" not in text:
            fail(f"{name}_version_missing")
    for grade in ("Grade 1", "Grade 2", "Grade 3"):
        if grade not in privacy:
            fail(f"privacy_{grade.replace(' ', '_').lower()}_missing")
    if "full-mask" not in protocol or "no request" not in protocol:
        fail("fail_closed_contract_missing")

    schemas = (ROOT / "server" / "app" / "schemas.py").read_text(encoding="utf-8")
    action_match = re.search(r"ActionType = Literal\[(.*?)\]", schemas, re.S)
    if not action_match:
        fail("action_type_not_found")
    actions = re.findall(r'"([a-z]+)"', action_match.group(1))
    if actions != manifest["allowedActions"]:
        fail("action_registry_drift")
    if not (ROOT / manifest["singleEgressFile"]).is_file():
        fail("single_egress_file_missing")

    try:
        files = subprocess.check_output(
            ["git", "ls-files"], cwd=ROOT, text=True, encoding="utf-8", errors="replace"
        ).splitlines()
    except (OSError, subprocess.CalledProcessError) as exc:
        fail(f"git_inventory_unavailable_{type(exc).__name__}")
    forbidden = re.compile(r"(?:api-key|\.env$|\.pem$|\.key$|\.secret$|browser-profile|raw-request)", re.I)
    tracked_forbidden = [path for path in files if forbidden.search(path)]
    if tracked_forbidden:
        fail("tracked_sensitive_paths")

    evidence_dir = ROOT / "evidence"
    forbidden_keys = {"apiKey", "password", "dataBase64", "previewDataUrl", "requestBody", "rawScreenshot", "cookies"}
    def check_keys(value: object) -> None:
        if isinstance(value, dict):
            if forbidden_keys.intersection(value):
                fail("evidence_sensitive_field")
            for child in value.values():
                check_keys(child)
        elif isinstance(value, list):
            for child in value:
                check_keys(child)

    for filename in ("extension-e2e-summary.json", "live-ollama-summary.json"):
        payload = json.loads((evidence_dir / filename).read_text(encoding="utf-8"))
        check_keys(payload)
    print("governance_check=passed protocol=1.0 policy=1.0 actions=5 grades=3 single_egress=true")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
