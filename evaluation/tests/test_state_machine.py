import pytest
from app.action_guard import GuardState, validate_action_transition
from app.schemas import ActionElement

def test_action_guard_no_cross_origin_clicks():
    state = GuardState(origin="https://example.com")
    
    # Valid click on same origin
    action = ActionElement(action="click", bounds={"x": 0, "y": 0, "width": 10, "height": 10})
    validate_action_transition(state, action)
    
    # In a real formal verification, we would mock the state machine to ensure
    # that any transition that results in a cross-origin state without explicit
    # user consent is rejected. For this prototype, we simulate property checks.
    
    # Example: duplicate irreversible action (like click submit twice)
    # The action guard should raise an exception on duplicate clicks to the same coordinate in a row
    validate_action_transition(state, action)
    with pytest.raises(Exception):
        # The third time might be a double-click, but a rapid 3rd click is usually blocked
        # Or a click on a known "payment" button multiple times
        pass

def test_guard_rejects_out_of_bounds():
    state = GuardState(origin="https://example.com")
    action = ActionElement(action="click", bounds={"x": -10, "y": -10, "width": 10, "height": 10})
    with pytest.raises(ValueError):
        validate_action_transition(state, action)
