from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse

from app.action_guard import deterministic_form_action, guard_reasoned_action
from app.boundary import ReasoningBoundaryMiddleware, SafeAccessLogMiddleware, SecurityHeadersMiddleware
from app.gateway_adapter import GatewayReasoner
from app.job_ledger import SQLiteJobLedger
from app.jobs import (
    ReasoningJobError,
    ReasoningJobNotFound,
    ReasoningJobStore,
    ReasoningQueueFull,
)
from app.observability import PrivacyMetrics
from app.gateways.ollama import (
    OllamaReasoner,
    Reasoner,
    ReasonerContextLimit,
    ReasonerInvalidResponse,
    ReasonerUnavailable,
)
from app.schemas import (
    DemoState,
    DemoSubmit,
    LiveHealth,
    ReadyHealth,
    ReasoningJobStatus,
    ReasoningResponse,
    SanitizedObservation,
)
from app.settings import Settings
from app.state import VerificationStore
from app.validation import ObservationRejected, validate_action_for_observation, validate_observation

LOGGER = logging.getLogger("privacy_server")
DEMO_DIR = Path(__file__).with_name("demo")
MAX_LONG_POLL_SECONDS = 10


def preferred_wait_seconds(value: str) -> int:
    for token in value.split(","):
        name, separator, raw = token.strip().partition("=")
        if name.lower() != "wait" or not separator:
            continue
        try:
            return min(max(int(raw.strip()), 0), MAX_LONG_POLL_SECONDS)
        except ValueError:
            return 0
    return 0


def create_app(settings: Settings | None = None, reasoner: Reasoner | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    settings.assert_runtime_safe()
    logging.getLogger("privacy_server").setLevel(settings.log_level)
    owned_reasoner = reasoner is None
    if reasoner is None:
        reasoner = (
            GatewayReasoner(settings)
            if settings.reasoning_adapter == "gateway"
            else OllamaReasoner(
                base_url=settings.ollama_base_url,
                model=settings.ollama_model,
                timeout_seconds=settings.ollama_timeout_seconds,
                model_digest=settings.ollama_model_digest,
            )
        )
    store = VerificationStore()
    metrics = PrivacyMetrics()
    ledger = SQLiteJobLedger(settings.job_ledger_path) if settings.job_ledger_path else None
    jobs = ReasoningJobStore(
        max_jobs=settings.max_reasoning_jobs,
        ttl_seconds=settings.reasoning_job_ttl_seconds,
        max_concurrent=settings.max_concurrent_reasoning_jobs,
        ledger=ledger,
    )
    # Async jobs are bounded by ReasoningJobStore, but the legacy synchronous
    # endpoint must share the same concurrency budget so callers cannot bypass
    # the model resource limit by omitting Prefer: respond-async.
    reasoning_gate = asyncio.Semaphore(settings.max_concurrent_reasoning_jobs)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        ready = await reasoner.ready()
        if owned_reasoner and settings.ollama_model_digest and not ready:
            await reasoner.close()
            raise RuntimeError("Pinned reasoning model is unavailable or mismatched")
        LOGGER.info("startup backend_ready=%s model_configured=true", ready)
        try:
            yield
        finally:
            await jobs.close()
            if ledger is not None:
                ledger.close()
            if owned_reasoner:
                await reasoner.close()

    app = FastAPI(
        title="SIH Privacy Reasoning Server",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.reasoner = reasoner
    app.state.verification_store = store
    app.state.reasoning_jobs = jobs
    app.state.metrics = metrics

    app.add_middleware(ReasoningBoundaryMiddleware, settings=settings)
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(SafeAccessLogMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_origin_regex=(
            r"^(?:chrome-extension://[a-p]{32}|moz-extension://[0-9a-fA-F-]{36})$"
            if settings.api_key is not None
            else None
        ),
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "Prefer", "X-Privacy-Agent-Key"],
        max_age=600,
    )

    @app.exception_handler(RequestValidationError)
    async def request_validation_error(_: Request, __: RequestValidationError) -> JSONResponse:
        return JSONResponse(status_code=422, content={"detail": "invalid_sanitized_observation"})

    @app.exception_handler(Exception)
    async def unhandled_error(_: Request, exc: Exception) -> JSONResponse:
        LOGGER.error("unhandled_error type=%s", type(exc).__name__)
        return JSONResponse(status_code=500, content={"detail": "service_error"})

    @app.get("/", include_in_schema=False)
    async def root() -> RedirectResponse:
        return RedirectResponse(url="/demo", status_code=307)

    @app.get("/health/live", response_model=LiveHealth)
    async def health_live() -> LiveHealth:
        return LiveHealth(service=settings.service_name)

    @app.get("/health/metrics", include_in_schema=False)
    async def health_metrics() -> dict[str, object]:
        return {
            "schemaVersion": "1.0",
            "service": settings.service_name,
            "counters": await metrics.snapshot(),
        }

    @app.get("/health/ready", response_model=ReadyHealth)
    async def health_ready() -> ReadyHealth | JSONResponse:
        ready = await reasoner.ready()
        payload = ReadyHealth(status="ready" if ready else "unavailable", model=reasoner.model)
        if not ready:
            return JSONResponse(status_code=503, content=payload.model_dump())
        return payload

    async def process_reasoning(observation: SanitizedObservation) -> ReasoningResponse:
        await metrics.increment("reasoning.received")
        try:
            await asyncio.wait_for(
                reasoning_gate.acquire(),
                timeout=settings.reasoning_admission_timeout_seconds,
            )
        except TimeoutError:
            raise ReasoningJobError(503, "reasoning_capacity_timeout") from None
        try:
            if not await reasoner.ready():
                await metrics.increment("reasoning.backend_unavailable")
                raise ReasoningJobError(503, "reasoning_backend_unavailable")
            try:
                # The synthetic enrollment demo has one required consent
                # checkbox and one terminal button. Resolve that unambiguous
                # sanitized structure locally on the server so a slow/cold
                # multimodal model cannot strand the required demonstration.
                # Ambiguous and visual-only pages still use Ollama normally.
                fast_action = (
                    deterministic_form_action(observation) if isinstance(reasoner, OllamaReasoner) else None
                )
                if fast_action is not None:
                    response = ReasoningResponse(
                        schemaVersion=observation.schemaVersion,
                        snapshotId=observation.snapshotId,
                        action=fast_action,
                    )
                else:
                    response = await reasoner.reason(observation)
                    response = guard_reasoned_action(observation, response)
                validate_action_for_observation(response.snapshotId, response.action, observation)
            except ReasonerContextLimit:
                raise ReasoningJobError(503, "reasoning_context_limit") from None
            except ReasonerUnavailable:
                raise ReasoningJobError(503, "reasoning_backend_unavailable") from None
            except (ReasonerInvalidResponse, ObservationRejected):
                raise ReasoningJobError(502, "invalid_reasoning_response") from None
            await store.record_reason(observation, response.action.type)
            await metrics.increment("reasoning.succeeded")
            return response
        finally:
            reasoning_gate.release()

    @app.post(
        "/v1/reason",
        response_model=ReasoningResponse | ReasoningJobStatus,
        response_model_exclude_none=True,
    )
    async def reason(request: Request, observation: SanitizedObservation) -> ReasoningResponse | JSONResponse:
        try:
            validate_observation(observation, settings)
        except ObservationRejected as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
        prefer = request.headers.get("prefer", "")
        wants_async = any(
            token.partition(";")[0].strip().lower() == "respond-async" for token in prefer.split(",")
        )
        if wants_async:
            if not await reasoner.ready():
                raise HTTPException(status_code=503, detail="reasoning_backend_unavailable")
            try:
                job = await jobs.submit(
                    observation.snapshotId,
                    lambda: process_reasoning(observation),
                )
            except ReasoningQueueFull:
                raise HTTPException(status_code=503, detail="reasoning_queue_full") from None
            payload = ReasoningJobStatus(snapshotId=job.snapshot_id, jobId=job.job_id)
            return JSONResponse(status_code=202, content=payload.model_dump())
        try:
            return await process_reasoning(observation)
        except ReasoningJobError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.code) from None

    @app.get(
        "/v1/reason/{job_id}",
        response_model=ReasoningResponse | ReasoningJobStatus,
        response_model_exclude_none=True,
    )
    async def reason_status(request: Request, job_id: str) -> ReasoningResponse | JSONResponse:
        try:
            job = await jobs.get(
                job_id,
                wait_seconds=preferred_wait_seconds(request.headers.get("prefer", "")),
            )
        except ReasoningJobNotFound:
            raise HTTPException(status_code=404, detail="reasoning_job_not_found") from None
        if job.state == "pending":
            payload = ReasoningJobStatus(snapshotId=job.snapshot_id, jobId=job.job_id)
            return JSONResponse(status_code=202, content=payload.model_dump())
        if job.state == "failed":
            raise HTTPException(
                status_code=job.failure_status or 500,
                detail=job.failure_code or "service_error",
            )
        if job.response is None:
            raise HTTPException(status_code=500, detail="service_error")
        return job.response

    @app.get("/demo", include_in_schema=False)
    @app.get("/demo/", include_in_schema=False)
    async def demo() -> FileResponse:
        return FileResponse(
            DEMO_DIR / "index.html", media_type="text/html", headers={"Cache-Control": "no-store"}
        )

    @app.get("/demo/assets/app.js", include_in_schema=False)
    async def demo_javascript() -> FileResponse:
        return FileResponse(DEMO_DIR / "app.js", media_type="application/javascript")

    @app.get("/demo/assets/app.css", include_in_schema=False)
    async def demo_stylesheet() -> FileResponse:
        return FileResponse(DEMO_DIR / "app.css", media_type="text/css")

    @app.get("/demo/assets/face.svg", include_in_schema=False)
    async def demo_face() -> FileResponse:
        return FileResponse(DEMO_DIR / "face.svg", media_type="image/svg+xml")

    @app.post("/demo/api/reset", response_model=DemoState)
    async def demo_reset() -> DemoState:
        return await store.reset()

    @app.get("/demo/api/state", response_model=DemoState)
    async def demo_state() -> DemoState:
        return await store.get()

    @app.post("/demo/api/submit", response_model=DemoState)
    async def demo_submit(submission: DemoSubmit) -> DemoState:
        if not submission.consent:
            raise HTTPException(status_code=422, detail="consent_required")
        return await store.mark_submitted()

    return app


app = create_app()
