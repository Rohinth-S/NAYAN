"""Verify dependency, model, permission, and release-signing invariants.

Development runs validate what can be checked locally and report unsigned
artifacts as an explicit state. Production mode is opt-in and fails closed
unless a model digest and detached signatures are present.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ALLOWED_PERMISSIONS = {"activeTab", "tabs", "storage", "scripting", "offscreen", "sidePanel"}
ALLOWED_HOSTS = {"http://*/*", "https://*/*"}


def verify_signature(path: Path, fingerprint: str | None) -> bool:
    """Check cryptographic validity AND an independently pinned signer identity."""
    signature = Path(f"{path}.asc")
    if not signature.is_file() or not fingerprint or not re.fullmatch(r"[A-Fa-f0-9]{40}|[A-Fa-f0-9]{64}", fingerprint):
        return False
    gpg = shutil.which("gpg")
    if not gpg:
        return False
    try:
        result = subprocess.run(
            [gpg, "--batch", "--no-auto-key-retrieve", "--status-fd", "1", "--verify", str(signature), str(path)],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    if result.returncode != 0:
        return False
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 11 and parts[:2] == ["[GNUPG:]", "VALIDSIG"]:
            # GPG reports both the signing subkey and the primary fingerprint.
            if fingerprint.upper() in {parts[2].upper(), parts[-1].upper()}:
                return True
    return False


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_lock(path: Path, base: Path, required: bool) -> tuple[int, list[str]]:
    if not path.exists():
        return (1 if required else 0), [f"missing lock: {path.relative_to(ROOT)}"]
    payload = json.loads(path.read_text(encoding="utf-8"))
    failures: list[str] = []
    candidates = [base / Path(str(artifact["path"])) for artifact in payload.get("artifacts", [])]
    if not required and candidates and not any(candidate.exists() for candidate in candidates):
        return 0, [f"optional assets not installed: {path.relative_to(ROOT)}"]
    for artifact in payload.get("artifacts", []):
        relative = Path(str(artifact["path"]))
        candidate = base / relative
        if not candidate.exists():
            failures.append(f"missing model asset: {candidate.relative_to(ROOT)}")
            continue
        if int(artifact["bytes"]) != candidate.stat().st_size or str(artifact["sha256"]) != sha256(candidate):
            failures.append(f"checksum mismatch: {candidate.relative_to(ROOT)}")
    return (1 if failures else 0), failures


def verify_manifests() -> list[str]:
    failures: list[str] = []
    for browser in ("chrome", "firefox"):
        manifest_path = ROOT / "extension" / "dist" / browser / "manifest.json"
        if not manifest_path.exists():
            failures.append(f"{browser} package manifest is missing")
            continue
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        # Chrome keeps site access in `host_permissions`; Firefox MV2 places
        # the same patterns in `permissions`. Normalize both shapes before
        # checking the least-privilege allowlist.
        declared = set(manifest.get("permissions", [])) | set(manifest.get("optional_permissions", []))
        hosts = {value for value in declared if '://' in value or value == '<all_urls>'}
        hosts |= set(manifest.get("host_permissions", []))
        hosts |= set(manifest.get("optional_host_permissions", []))
        permissions = declared - hosts
        unexpected = permissions - ALLOWED_PERMISSIONS
        if unexpected:
            failures.append(f"{browser} unexpected permissions: {sorted(unexpected)}")
        # Chrome needs <all_urls> for side-panel capture without a fresh
        # activeTab gesture. The runtime separately refuses non-HTTP(S) tabs.
        allowed_hosts = ALLOWED_HOSTS | ({"<all_urls>"} if browser == "chrome" else set())
        unexpected_hosts = hosts - allowed_hosts
        if unexpected_hosts:
            failures.append(f"{browser} unexpected host permissions: {sorted(unexpected_hosts)}")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--production", action="store_true")
    args = parser.parse_args()
    production = args.production or os.environ.get("PRIVACY_AGENT_PRODUCTION") == "1"
    failures: list[str] = []

    lock = ROOT / "extension" / "package-lock.json"
    if not lock.exists():
        failures.append("extension/package-lock.json is missing")
    else:
        json.loads(lock.read_text(encoding="utf-8"))

    code, messages = verify_lock(ROOT / "extension" / "models" / "ocr-lock.json", ROOT / "extension" / "models" / "ocr", required=False)
    if code:
        failures.extend(messages)
    code, messages = verify_lock(ROOT / "extension/models/vision-lock.json", ROOT / "extension/models", required=True)
    if code:
        failures.extend(messages)
    code, messages = verify_lock(ROOT / "extension" / "models" / "perception-lock.json", ROOT / "extension" / "models" / "perception", required=False)
    if code:
        failures.extend(messages)
    failures.extend(verify_manifests())

    metadata = ROOT / "extension" / "dist" / "RELEASE_METADATA.json"
    digest = os.environ.get("PRIVACY_AGENT_OLLAMA_MODEL_DIGEST")
    if metadata.exists():
        payload = json.loads(metadata.read_text(encoding="utf-8"))
        digest = digest or payload.get("model", {}).get("digest")
    if production and (not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest)):
        failures.append("production mode requires PRIVACY_AGENT_OLLAMA_MODEL_DIGEST=sha256:<64 hex>")

    fingerprint = os.environ.get("PRIVACY_AGENT_SIGNER_FINGERPRINT")
    if production:
        # Sign metadata and the SBOM as well as the archives so the model
        # digest and dependency declaration are covered by a trusted signer.
        for document in (metadata, ROOT / "artifacts/sbom.json"):
            if not document.is_file() or not verify_signature(document, fingerprint):
                failures.append(f"trusted signature required: {document.name}")

    archives = sorted((ROOT / "extension" / "artifacts").glob("*.zip"))
    if production and not archives:
        failures.append("production mode requires packaged extension archives")
    for archive in archives:
        checksum = Path(f"{archive}.sha256")
        signature = Path(f"{archive}.asc")
        if production and (not checksum.exists() or not verify_signature(archive, fingerprint)):
            failures.append(f"production archive lacks a valid signature from PRIVACY_AGENT_SIGNER_FINGERPRINT: {archive.name}")
        elif signature.exists() and not verify_signature(archive, fingerprint):
            failures.append(f"archive signature could not be verified: {archive.name}")
        if checksum.exists():
            parts = checksum.read_text(encoding="ascii").split()
            if not parts or parts[0].lower() != sha256(archive):
                failures.append(f"archive checksum mismatch: {archive.name}")

    status = "passed" if not failures else "failed"
    print(json.dumps({
        "status": status,
        "mode": "production" if production else "development",
        "dependencyLock": lock.exists(),
        "modelLocksChecked": True,
        "minimalPermissionsChecked": True,
        "signingRequired": production,
        "failures": failures,
    }))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
