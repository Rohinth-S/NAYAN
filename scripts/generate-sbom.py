"""Generate a compact, aggregate SBOM from locked project manifests."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "artifacts" / "sbom.json"


def main() -> int:
    components: list[dict[str, str]] = []
    lock = ROOT / "extension" / "package-lock.json"
    if lock.exists():
        data = json.loads(lock.read_text(encoding="utf-8"))
        for path, value in data.get("packages", {}).items():
            if not path or not path.startswith("node_modules/"):
                continue
            name = path.removeprefix("node_modules/")
            if isinstance(value, dict) and value.get("version"):
                components.append({"type": "library", "name": name, "version": str(value["version"]), "source": "npm-lock"})
    pyproject = ROOT / "server" / "pyproject.toml"
    if pyproject.exists():
        text = pyproject.read_text(encoding="utf-8")
        for match in re.finditer(r'^\s*"([A-Za-z0-9_.-]+)==([^"\s]+)"', text, re.M):
            components.append({"type": "library", "name": match.group(1), "version": match.group(2), "source": "pyproject"})
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"bomFormat": "CycloneDX", "specVersion": "1.5", "version": 1, "metadata": {"timestamp": datetime.now(timezone.utc).isoformat()}, "components": sorted(components, key=lambda item: (item["name"], item["version"]))}, indent=2) + "\n", encoding="utf-8")
    print(f"sbom=generated components={len(components)} path=artifacts/sbom.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
