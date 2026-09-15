"""Small dependency-free release security gate for checked-in material."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SENSITIVE_PATH = re.compile(r"(?:^|/)(?:\.env(?:\.|$)|.*(?:api[-_]?key|credential|secret|private[-_]?key|profile).*)", re.I)
HIGH_CONFIDENCE_SECRET = re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}")


def main() -> int:
    paths = subprocess.check_output(["git", "ls-files"], cwd=ROOT, text=True).splitlines()
    path_findings = [path for path in paths if SENSITIVE_PATH.search(path) and not path.endswith(".env.example")]
    content_findings: list[str] = []
    for relative in paths:
        path = ROOT / relative
        if path.suffix.lower() not in {".py", ".ts", ".js", ".json", ".md", ".yml", ".yaml", ".ps1", ".toml"}:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if HIGH_CONFIDENCE_SECRET.search(text):
            content_findings.append(relative)
    if path_findings or content_findings:
        print(f"security_scan=failed sensitive_paths={path_findings} secret_files={content_findings}")
        return 1
    print(f"security_scan=passed tracked_files={len(paths)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
