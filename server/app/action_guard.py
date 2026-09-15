from __future__ import annotations

import re

from app.schemas import BrowserAction, Element, ReasoningResponse, SanitizedObservation

# This is a narrow grounding layer around the model, not a second planner.
# Terms are intentionally high confidence so unrelated controls remain under
# model selection and ordinary action validation.
_TASK_TERMS = (
    "submit",
    "confirm",
    "continue",
    "proceed",
    "finish",
    "complete",
    "enroll",
    "register",
    "save",
    "apply",
)
_BUTTON_TERMS = (*_TASK_TERMS, "next")
_STRONG_TERMINAL_TASK_TERMS = ("submit", "enroll", "register", "save", "apply", "finish", "complete")
_FILL_TERMS = ("fill", "enter", "type", "write", "provide", "input")
_COMPLETION_TERMS = ("complete", "completed", "submitted", "success", "successful", "finished", "done")
_PREREQUISITE_TERMS = (
    "agree",
    "accept",
    "consent",
    "confirm",
    "acknowledge",
    "certif",
    "declaration",
    "terms",
    "privacy",
)
_WORD_RE = re.compile(r"[a-z0-9]+")
_PLACEHOLDER_RE = re.compile(r"^\[REDACTED:[A-Z0-9_-]{2,40}\]$")


def _words(value: str) -> set[str]:
    return set(_WORD_RE.findall(value.casefold()))


def _contains_term(value: str, terms: tuple[str, ...]) -> bool:
    words = _words(value)
    return any(
        term in words or (term.endswith("f") and any(word.startswith(term) for word in words))
        for term in terms
    )


def _is_commit_task(task: str) -> bool:
    return _contains_term(task, _TASK_TERMS)


def _is_fill_task(task: str) -> bool:
    return _contains_term(task, _FILL_TERMS)


def _is_strong_terminal_task(task: str) -> bool:
    return _contains_term(task, _STRONG_TERMINAL_TASK_TERMS)


def _is_completion_message(message: str | None) -> bool:
    return bool(message) and _contains_term(message, _COMPLETION_TERMS)


def _is_submit_like(element: Element) -> bool:
    return (
        element.role == "button"
        and not element.state.disabled
        and bool(element.label)
        and not _PLACEHOLDER_RE.fullmatch(element.label)
        and _contains_term(element.label, _BUTTON_TERMS)
    )


def _is_terminal_label(element: Element) -> bool:
    return (
        element.role == "button"
        and bool(element.label)
        and not _PLACEHOLDER_RE.fullmatch(element.label)
        and _contains_term(element.label, _BUTTON_TERMS)
    )


def _is_pending_prerequisite(element: Element) -> bool:
    if element.role != "checkbox" or element.state.disabled or element.state.checked:
        return False
    # `required` is the strongest signal. The semantic label fallback covers
    # custom controls that expose consent semantics but omit HTML `required`.
    return element.state.required or (
        bool(element.label)
        and not _PLACEHOLDER_RE.fullmatch(element.label)
        and _contains_term(element.label, _PREREQUISITE_TERMS)
    )


def _center_y(element: Element) -> float:
    return element.bounds.y + element.bounds.height / 2


def _preceding_pending_prerequisites(
    elements: tuple[Element, ...], target_index: int, target: Element
) -> list[Element]:
    target_center = _center_y(target)
    candidates = [
        element
        for index, element in enumerate(elements)
        if (
            index < target_index
            and _is_pending_prerequisite(element)
            and _center_y(element) <= target_center + 4
        )
    ]
    # DOM order is the primary signal. Choosing the closest preceding control
    # avoids unrelated consent boxes elsewhere on a page.
    candidates.sort(key=lambda element: elements.index(element), reverse=True)
    return candidates


def _click(element_id: str) -> BrowserAction:
    return BrowserAction(type="click", elementId=element_id)


def guard_reasoned_action(
    observation: SanitizedObservation, response: ReasoningResponse
) -> ReasoningResponse:
    """Apply a deterministic form-precondition guard to a model action.

    The model still selects the intended terminal control. This function only
    inserts a high-confidence prerequisite click before that control, or
    prevents a repeated click that would uncheck an already checked consent
    control. It never invents an element ID and never reads values or pixels.
    """

    action = response.action
    if not _is_commit_task(observation.task):
        return response

    elements = tuple(observation.elements)
    by_id = {element.id: (index, element) for index, element in enumerate(elements)}
    submit_like = [element for element in elements if _is_submit_like(element)]

    # After a successful form submission many pages leave the terminal
    # control visible but disabled. Stop safely when a strong terminal verb is
    # explicit, exactly one such control is present, and no consent
    # prerequisite remains. The message avoids claiming success; the local
    # page remains the source of truth.
    disabled_terminal = [
        element for element in elements if _is_terminal_label(element) and element.state.disabled
    ]
    if (
        action.type != "done"
        and _is_strong_terminal_task(observation.task)
        and not _is_fill_task(observation.task)
        and not submit_like
        and len(disabled_terminal) == 1
    ):
        pending = _preceding_pending_prerequisites(
            elements, elements.index(disabled_terminal[0]), disabled_terminal[0]
        )
        if pending:
            return response.model_copy(update={"action": _click(pending[0].id)})
        if any(_is_pending_prerequisite(element) for element in elements):
            return response
        return response.model_copy(
            update={
                "action": BrowserAction(
                    type="done", message="Terminal action is no longer available; inspect the page result."
                )
            }
        )

    if action.type == "click" and action.elementId:
        target_info = by_id.get(action.elementId)
        if target_info is None:
            # The ordinary action validator reports unknown IDs. Keeping this
            # unchanged ensures malformed model output remains a failure.
            return response
        target_index, target = target_info

        if _is_submit_like(target):
            pending = _preceding_pending_prerequisites(elements, target_index, target)
            if pending:
                return response.model_copy(update={"action": _click(pending[0].id)})
            return response

        # A model that tries to click an already checked consent box would
        # toggle it off. If there is exactly one unambiguous terminal control,
        # advance to it instead. Ambiguous pages preserve the model action.
        if (
            target.role == "checkbox"
            and target.state.checked
            and not target.state.disabled
            and (target.state.required or _contains_term(target.label, _PREREQUISITE_TERMS))
            and len(submit_like) == 1
        ):
            return response.model_copy(update={"action": _click(submit_like[0].id)})

        # Once a task explicitly requests a terminal form action, a unique
        # submit-like control is a safe recovery target for an unrelated model
        # click. Preserve clicks on pending consent and all fill-oriented tasks.
        if not _is_fill_task(observation.task) and len(submit_like) == 1:
            if _is_pending_prerequisite(target):
                return response
            pending = _preceding_pending_prerequisites(
                elements, elements.index(submit_like[0]), submit_like[0]
            )
            if pending:
                return response.model_copy(update={"action": _click(pending[0].id)})
            return response.model_copy(update={"action": _click(submit_like[0].id)})

    # A terse/incomplete `done` response can otherwise strand a task after a
    # model step. Only recover when there is one terminal control, the task is
    # not asking for text entry, and the model did not claim completion.
    if (
        action.type == "done"
        and not _is_fill_task(observation.task)
        and len(submit_like) == 1
        and not _is_completion_message(action.message)
    ):
        submit = submit_like[0]
        pending = _preceding_pending_prerequisites(elements, elements.index(submit), submit)
        if pending:
            return response.model_copy(update={"action": _click(pending[0].id)})
        return response.model_copy(update={"action": _click(submit.id)})
    return response


__all__ = ["guard_reasoned_action"]
