from __future__ import annotations

import argparse
import base64
import io
import os
import sys
import time
from pathlib import Path

import httpx
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.ollama import build_ollama_request
from app.schemas import ReasoningJobStatus, ReasoningResponse, SanitizedObservation


def sanitized_png() -> str:
    image = Image.new("RGB", (320, 180), (244, 247, 250))
    draw = ImageDraw.Draw(image)
    draw.rectangle((20, 20, 299, 69), fill=(243, 244, 246))
    draw.rectangle((22, 22, 297, 67), outline=(148, 163, 184), width=2)
    draw.text((42, 38), "[REDACTED:PII]", fill=(51, 65, 85))
    draw.rounded_rectangle((85, 112, 235, 157), radius=8, fill=(28, 99, 156))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode()


def sanitized_observation_payload() -> dict[str, object]:
    return {
        "schemaVersion": "1.0",
        "snapshotId": "44444444-4444-4444-8444-444444444444",
        "documentId": "55555555-5555-4555-8555-555555555555",
        "page": {
            "origin": "https://site-0123456789abcdef0123.invalid",
            "title": "Synthetic enrollment portal",
        },
        "task": "Click the Submit enrollment button.",
        "elements": [
            {
                "id": "e_submit_12345678901",
                "role": "button",
                "label": "Submit enrollment",
                "bounds": {"x": 85, "y": 112, "width": 151, "height": 46},
                "state": {"disabled": False, "checked": False, "editable": False},
            }
        ],
        "image": {"mime": "image/png", "dataBase64": sanitized_png(), "width": 320, "height": 180},
        "redactions": [
            {
                "kind": "pii-text",
                "source": "fallback",
                "bounds": {"x": 20, "y": 20, "width": 280, "height": 50},
            }
        ],
        "privacy": {
            "detectorBackend": "wasm",
            "visualFallback": "none",
            "rawImageRetained": False,
            "redactionMode": "semantic",
            "grade": 3,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Send a synthetic sanitized observation to the live server")
    parser.add_argument("--server", default="http://127.0.0.1:8765")
    parser.add_argument("--diagnose-ollama", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    payload = sanitized_observation_payload()
    if args.diagnose_ollama:
        observation = SanitizedObservation.model_validate(payload)
        request = build_ollama_request(observation, "qwen3-vl:2b-instruct")
        response = httpx.post(
            "http://127.0.0.1:11434/api/chat",
            json=request,
            timeout=30,
            trust_env=False,
        )
        print(f"ollama_diagnostic_status={response.status_code} body={response.text[:500]}")
        return 0 if response.is_success else 1
    headers: dict[str, str] = {}
    api_key = os.getenv("PRIVACY_AGENT_API_KEY")
    if api_key:
        headers["X-Privacy-Agent-Key"] = api_key
    headers["Prefer"] = "respond-async"
    started = time.perf_counter()
    try:
        with httpx.Client(timeout=15, trust_env=False, follow_redirects=False) as client:
            response = client.post(f"{args.server.rstrip('/')}/v1/reason", json=payload, headers=headers)
            if response.status_code == 202:
                ticket = ReasoningJobStatus.model_validate(response.json())
                deadline = time.monotonic() + 120
                status_url = f"{args.server.rstrip('/')}/v1/reason/{ticket.jobId}"
                while response.status_code == 202 and time.monotonic() < deadline:
                    time.sleep(1)
                    response = client.get(status_url, headers=headers)
                    if response.status_code == 202:
                        pending = ReasoningJobStatus.model_validate(response.json())
                        if pending.jobId != ticket.jobId or pending.snapshotId != ticket.snapshotId:
                            raise ValueError("mismatched reasoning job")
        elapsed_ms = int((time.perf_counter() - started) * 1_000)
        if not response.is_success:
            detail = response.json().get("detail", "request_failed")
            print(f"live_smoke=failed status={response.status_code} detail={detail} elapsed_ms={elapsed_ms}")
            return 1
        result = ReasoningResponse.model_validate(response.json())
        action = result.action
        print(
            f"live_smoke=passed status={response.status_code} action={action.type} "
            f"target={action.elementId or 'none'} elapsed_ms={elapsed_ms}"
        )
        return 0
    except (httpx.HTTPError, ValueError) as exc:
        print(f"live_smoke=failed error_type={type(exc).__name__}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
