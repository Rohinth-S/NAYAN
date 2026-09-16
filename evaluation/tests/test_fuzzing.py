import pytest
from hypothesis import given, strategies as st
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

@given(st.text(min_size=1, max_size=10000))
def test_fuzz_json_payloads(payload: str):
    # Fuzzing the JSON payload parser
    response = client.post("/api/v1/reasoning/job", content=payload, headers={"Content-Type": "application/json"})
    assert response.status_code in [400, 422, 413, 500]  # typically 422 or 400

@given(st.dictionaries(st.text(), st.text()))
def test_fuzz_json_objects(payload_dict: dict):
    # Fuzzing with valid JSON but invalid schema
    response = client.post("/api/v1/reasoning/job", json=payload_dict)
    assert response.status_code in [422, 400]

@given(st.lists(st.integers(min_value=0, max_value=255), min_size=1, max_size=1024))
def test_fuzz_png_chunks(bytes_list: list[int]):
    # Fuzzing random bytes as PNG to see if the redactor or validator crashes
    import base64
    payload = {
        "job_id": "test-123",
        "url": "https://example.com",
        "screenshot": base64.b64encode(bytes(bytes_list)).decode("utf-8"),
        "viewport": {"width": 1024, "height": 768},
        "dom": {"nodes": []},
        "grade": "unrestricted"
    }
    response = client.post("/api/v1/reasoning/job", json=payload)
    assert response.status_code in [422, 400, 500]
