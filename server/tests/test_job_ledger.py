from __future__ import annotations

from pathlib import Path

from app.job_ledger import SQLiteJobLedger
from app.schemas import BrowserAction, ReasoningResponse


def _response(snapshot: str) -> ReasoningResponse:
    return ReasoningResponse(
        schemaVersion="1.0",
        snapshotId=snapshot,
        action=BrowserAction(type="done"),
    )


def test_ledger_marks_inflight_jobs_failed_after_restart(tmp_path: Path) -> None:
    path = tmp_path / "jobs.sqlite3"
    first = SQLiteJobLedger(str(path))
    first.pending("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
    first.close()

    second = SQLiteJobLedger(str(path))
    record = second.get("11111111-1111-4111-8111-111111111111")
    second.close()
    assert record is not None
    assert record[0] == "22222222-2222-4222-8222-222222222222"
    assert record[1] == "failed"
    assert record[3] == 503
    assert record[4] == "server_restarted"


def test_ledger_persists_only_validated_action_result(tmp_path: Path) -> None:
    ledger = SQLiteJobLedger(str(tmp_path / "jobs.sqlite3"))
    job = "33333333-3333-4333-8333-333333333333"
    snapshot = "44444444-4444-4444-8444-444444444444"
    ledger.pending(job, snapshot)
    ledger.success(job, _response(snapshot))
    record = ledger.get(job)
    ledger.close()
    assert record is not None
    assert record[1] == "succeeded"
    assert record[2] is not None
    assert record[2].action.type == "done"
