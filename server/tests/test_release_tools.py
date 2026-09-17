from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts' / 'verify-supply-chain.py'
SPEC = importlib.util.spec_from_file_location('supply_chain', SCRIPT)
assert SPEC and SPEC.loader
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


@pytest.mark.parametrize(('returned', 'code', 'accepted'), [('A', 0, True), ('B', 0, False), ('A', 1, False)])
def test_signature_must_be_valid_and_match_pinned_signer(tmp_path, monkeypatch, returned, code, accepted):
    archive = tmp_path / 'package.zip'
    archive.write_bytes(b'test fixture')
    Path(f'{archive}.asc').write_text('detached test fixture')
    monkeypatch.setattr(gate.shutil, 'which', lambda _: 'gpg')
    monkeypatch.setattr(gate.subprocess, 'run', lambda *a, **kw: SimpleNamespace(
        returncode=code,
        stdout=f'[GNUPG:] VALIDSIG {returned * 40} 2026-09-18 1 0 4 0 1 10 00 {returned * 40}',
    ))
    assert gate.verify_signature(archive, 'A' * 40) is accepted


def test_signature_file_alone_is_not_trust(tmp_path):
    archive = tmp_path / 'package.zip'
    Path(f'{archive}.asc').write_text('not a valid signature')
    assert gate.verify_signature(archive, None) is False
    assert gate.verify_signature(archive, 'invalid') is False


@pytest.mark.parametrize('extra', [{'permissions': ['debugger']}, {'host_permissions': ['file:///*']}])
def test_manifests_reject_unapproved_capabilities(tmp_path, monkeypatch, extra):
    monkeypatch.setattr(gate, 'ROOT', tmp_path)
    for browser in ('chrome', 'firefox'):
        target = tmp_path / 'extension' / 'dist' / browser / 'manifest.json'
        target.parent.mkdir(parents=True)
        target.write_text(json.dumps(extra if browser == 'chrome' else {'permissions': ['http://*/*']}))
    assert gate.verify_manifests()


def test_model_lock_rejects_modified_bytes(tmp_path):
    asset = tmp_path / 'model.onnx'
    asset.write_bytes(b'approved')
    lock = tmp_path / 'lock.json'
    artifact = {'path': asset.name, 'bytes': 8, 'sha256': gate.sha256(asset)}
    lock.write_text(json.dumps({'artifacts': [artifact]}))
    assert gate.verify_lock(lock, tmp_path, True)[0] == 0
    asset.write_bytes(b'tampered')
    # Paths in failures are relative to the workspace in production.
    gate_root = gate.ROOT
    try:
        gate.ROOT = tmp_path
        assert gate.verify_lock(lock, tmp_path, True)[0] == 1
    finally:
        gate.ROOT = gate_root
