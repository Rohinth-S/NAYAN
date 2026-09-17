"""Run the integrated release checks and record counts from machine reports.

Only aggregate results are exported. Command output and JUnit data remain in
ignored artifacts, and no server requests or browser data are captured here.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "artifacts" / "release-gate"
REPORT = ROOT / "evidence" / "latest-release.json"


def run(label: str, command: list[str], cwd: Path = ROOT, env: dict[str, str] | None = None) -> bool:
    print(f"release_gate={label} status=running", flush=True)
    result = subprocess.run(command, cwd=cwd, env=env, text=True, encoding="utf-8", errors="replace", capture_output=True)
    (OUTPUT / f"{label}.log").write_text(result.stdout + result.stderr, encoding="utf-8")
    print(f"release_gate={label} status={'passed' if result.returncode == 0 else 'failed'}", flush=True)
    return result.returncode == 0


def counts(path: Path) -> dict[str, int]:
    root = ET.parse(path).getroot()
    cases = root.findall(".//testcase") if root.tag != "testcase" else [root]
    return {
        "total": len(cases),
        "failed": sum(case.find("failure") is not None for case in cases),
        "errors": sum(case.find("error") is not None for case in cases),
        "skipped": sum(case.find("skipped") is not None for case in cases),
        "passed": sum(all(case.find(tag) is None for tag in ("failure", "error", "skipped")) for case in cases),
    }


def main() -> int:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if not npm:
        raise SystemExit("Node/npm is required")
    python = ROOT / "server" / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    executable = str(python) if python.exists() else sys.executable
    checks: dict[str, bool] = {}
    checks["governance"] = run("governance", [executable, "scripts/verify-governance.py"])
    checks["typecheck"] = run("typecheck", [npm, "run", "typecheck"], ROOT / "extension")
    checks["extension"] = run("extension", [npm, "test", "--", "--reporter=junit", f"--outputFile={OUTPUT / 'extension.xml'}"], ROOT / "extension")
    checks["server"] = run("server", [executable, "-m", "pytest", "-p", "no:cacheprovider", f"--junitxml={OUTPUT / 'server.xml'}"], ROOT / "server")
    checks["lint"] = run("lint", [executable, "-m", "ruff", "check", "."], ROOT / "server")
    # Evaluation tests exercise both the evaluation helpers and the first-party
    # server package. Do not rely on the caller's working directory and do not
    # expose vendored upstream checkouts to pytest collection.
    eval_pythonpath = os.pathsep.join((str(ROOT / "server"), str(ROOT / "evaluation")))
    eval_env = dict(os.environ, PYTHONPATH=eval_pythonpath)
    checks["evaluation"] = run("evaluation", [executable, "-m", "pytest", "-p", "no:cacheprovider", "evaluation/tests", "-q", f"--junitxml={OUTPUT / 'evaluation.xml'}"], env=eval_env)
    checks["packages"] = run("packages", [npm, "run", "package"], ROOT / "extension")
    checks["metadata"] = run("metadata", [npm, "run", "release-metadata"], ROOT / "extension") if checks["packages"] else False
    checks["security"] = run("security", [executable, "scripts/security-scan.py"])
    checks["sbom"] = run("sbom", [executable, "scripts/generate-sbom.py"])
    checks["supply_chain"] = run("supply_chain", [executable, "scripts/verify-supply-chain.py"])
    suites = {}
    for name in ("extension", "server", "evaluation"):
        path = OUTPUT / f"{name}.xml"
        suites[name] = counts(path) if path.exists() else {"unavailable": True}
    try:
        commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
        dirty = bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True).strip())
    except subprocess.CalledProcessError:
        commit, dirty = None, True
    metadata_path = ROOT / "extension" / "dist" / "RELEASE_METADATA.json"
    packages = []
    if checks["metadata"]:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        packages = [item for item in metadata["artifacts"] if item["path"].endswith(".zip")]
    report = {
        "reportVersion": "1.0", "recordedAtUtc": datetime.now(timezone.utc).isoformat(),
        "sourceCommit": commit, "workingTreeHasChanges": dirty,
        "protocolVersion": "1.0", "policyVersion": "1.0", "scope": "automated-contract-and-package-checks",
        "passed": all(checks.values()), "checks": checks, "testSuites": suites,
        "packages": packages,
        "signingStatus": "production-signature-required",
        "liveBrowserMatrix": "separate-evidence-required",
        "supplyChainMode": "production" if os.environ.get("PRIVACY_AGENT_PRODUCTION") == "1" else "development",
    }
    REPORT.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"release_gate={'passed' if report['passed'] else 'failed'} report=evidence/latest-release.json")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
