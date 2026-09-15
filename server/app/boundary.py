from __future__ import annotations

import hmac
import json
import logging
import time

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.settings import Settings

LOGGER = logging.getLogger("privacy_server.access")
KNOWN_PATHS = {
    "/v1/reason",
    "/health/live",
    "/health/ready",
    "/demo",
    "/demo/",
    "/demo/api/reset",
    "/demo/api/state",
    "/demo/api/submit",
    "/demo/assets/app.js",
    "/demo/assets/app.css",
    "/demo/assets/face.svg",
}
REASONING_JOB_LOG_PATH = "/v1/reason/{jobId}"


def is_reasoning_path(path: str) -> bool:
    return path == "/v1/reason" or path.startswith("/v1/reason/")


class ReasoningBoundaryMiddleware:
    """Authenticate and bound the sole model-facing endpoint before parsing its body."""

    def __init__(self, app: ASGIApp, settings: Settings) -> None:
        self.app = app
        self.settings = settings

    async def _respond(self, send: Send, status: int, code: str) -> None:
        body = json.dumps({"detail": code}, separators=(",", ":")).encode()
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                    (b"cache-control", b"no-store"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})

    async def __call__(
        self,
        scope: Scope,
        receive: Receive,
        send: Send,
    ) -> None:
        path = scope.get("path", "")
        if scope.get("type") != "http" or not is_reasoning_path(path):
            await self.app(scope, receive, send)
            return
        if scope.get("method") == "OPTIONS":
            await self.app(scope, receive, send)
            return

        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        origin = headers.get(b"origin")
        if origin is not None and not self.settings.origin_allowed(origin.decode("ascii", errors="ignore")):
            await self._respond(send, 403, "origin_not_allowed")
            return
        configured_key = self.settings.api_key
        if configured_key is not None:
            provided = headers.get(b"x-privacy-agent-key", b"").decode("utf-8", errors="ignore")
            if not hmac.compare_digest(provided, configured_key.get_secret_value()):
                await self._respond(send, 401, "authentication_required")
                return

        method = scope.get("method")
        if (path == "/v1/reason" and method != "POST") or (
            path != "/v1/reason" and method != "GET"
        ):
            await self._respond(send, 405, "method_not_allowed")
            return

        if path != "/v1/reason":
            await self.app(scope, receive, send)
            return

        content_type = headers.get(b"content-type", b"").decode("ascii", errors="ignore")
        if not content_type.lower().startswith("application/json"):
            await self._respond(send, 415, "application_json_required")
            return

        content_length = headers.get(b"content-length")
        if content_length:
            try:
                if int(content_length) > self.settings.max_request_bytes:
                    await self._respond(send, 413, "request_too_large")
                    return
            except ValueError:
                await self._respond(send, 400, "invalid_content_length")
                return

        body = bytearray()
        more_body = True
        while more_body:
            message = await receive()
            if message.get("type") == "http.disconnect":
                return
            chunk = message.get("body", b"")
            body.extend(chunk)
            if len(body) > self.settings.max_request_bytes:
                await self._respond(send, 413, "request_too_large")
                return
            more_body = bool(message.get("more_body", False))

        delivered = False

        async def replay() -> Message:
            nonlocal delivered
            if delivered:
                return {"type": "http.request", "body": b"", "more_body": False}
            delivered = True
            return {"type": "http.request", "body": bytes(body), "more_body": False}

        await self.app(scope, replay, send)


class SecurityHeadersMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(
        self,
        scope: Scope,
        receive: Receive,
        send: Send,
    ) -> None:
        async def add_headers(message: Message) -> None:
            if message.get("type") == "http.response.start":
                headers = list(message.get("headers", []))
                headers.extend(
                    [
                        (b"x-content-type-options", b"nosniff"),
                        (b"referrer-policy", b"no-referrer"),
                        (b"permissions-policy", b"camera=(), microphone=(), geolocation=()"),
                        (
                            b"content-security-policy",
                            b"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; "
                            b"connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
                        ),
                        (b"cache-control", b"no-store"),
                    ]
                )
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, add_headers)


class SafeAccessLogMiddleware:
    """Log bounded operational metadata without request headers, query, body, or response content."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(
        self,
        scope: Scope,
        receive: Receive,
        send: Send,
    ) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        start = time.perf_counter()
        status = 500

        async def capture_status(message: Message) -> None:
            nonlocal status
            if message.get("type") == "http.response.start":
                status = int(message.get("status", 500))
            await send(message)

        try:
            await self.app(scope, receive, capture_status)
        finally:
            path = scope.get("path", "")
            if path.startswith("/v1/reason/"):
                endpoint = REASONING_JOB_LOG_PATH
            else:
                endpoint = path if path in KNOWN_PATHS else "unknown"
            LOGGER.info(
                "request method=%s endpoint=%s status=%d elapsed_ms=%d",
                scope.get("method", "UNKNOWN"),
                endpoint,
                status,
                int((time.perf_counter() - start) * 1_000),
            )
