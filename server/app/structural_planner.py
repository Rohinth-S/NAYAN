"""Deterministic structural planner used only when the VLM is unavailable.

Reuses the action-guard heuristics. It may click a unique sanitized consent or
submit control, wait for a unique disabled terminal control, or stop with done.
It never emits input, never fills a value, and never copies a redacted label
into the response.
"""

from __future__ import annotations

from app.action_guard import _is_commit_task, _is_pending_prerequisite, _is_submit_like, _is_terminal_label
from app.schemas import BrowserAction, ReasoningResponse, SanitizedObservation

AMBIGUOUS_MESSAGE = "Safe structural progress is impossible without a unique sanitized control."
WAIT_MILLISECONDS = 400


def plan_structural_action(observation: SanitizedObservation) -> BrowserAction:
    pending = [element for element in observation.elements if _is_pending_prerequisite(element)]
    submits = [element for element in observation.elements if _is_submit_like(element)]
    if len(pending) > 1 or len(submits) > 1:
        return BrowserAction(type="done", message=AMBIGUOUS_MESSAGE)
    if len(pending) == 1:
        return BrowserAction(type="click", elementId=pending[0].id)
    if len(submits) == 1:
        return BrowserAction(type="click", elementId=submits[0].id)
    disabled_terminal = [
        element for element in observation.elements if _is_terminal_label(element) and element.state.disabled
    ]
    if len(disabled_terminal) == 1:
        return BrowserAction(type="wait", milliseconds=WAIT_MILLISECONDS)
    # A long form can end below the current viewport. Keep the local fallback
    # moving toward its bounded terminal controls instead of claiming the task
    # is complete just because this capture has no visible button yet.
    if _is_commit_task(observation.task):
        return BrowserAction(type="scroll", direction="down", amount=450)
    return BrowserAction(type="done", message=AMBIGUOUS_MESSAGE)


def plan_structural_response(observation: SanitizedObservation) -> ReasoningResponse:
    action = plan_structural_action(observation)
    if action.type not in {"click", "scroll", "wait", "done"} or action.text is not None:
        raise ValueError("structural planner returned a disallowed action")
    return ReasoningResponse(
        schemaVersion="1.0",
        snapshotId=observation.snapshotId,
        action=action,
    )
