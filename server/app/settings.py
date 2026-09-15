from __future__ import annotations

import ipaddress
import os
import re
from typing import Literal, cast
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator

LogLevel = Literal["CRITICAL", "ERROR", "WARNING", "INFO"]


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    service_name: str = "sih-privacy-reasoning-server"
    schema_version: str = "1.0"
    ollama_base_url: str = "http://127.0.0.1:11434"
    ollama_model: str = "qwen3-vl:2b-instruct"
    ollama_timeout_seconds: float = Field(default=90.0, ge=2.0, le=300.0)
    allow_remote_ollama: bool = False
    api_key: SecretStr | None = None
    cors_origins: tuple[str, ...] = (
        "http://localhost",
        "http://127.0.0.1",
    )
    max_request_bytes: int = Field(default=8_000_000, ge=100_000, le=25_000_000)
    max_image_bytes: int = Field(default=5_000_000, ge=10_000, le=20_000_000)
    max_image_pixels: int = Field(default=8_294_400, ge=1_000, le=33_177_600)
    max_elements: int = Field(default=500, ge=1, le=500)
    max_redactions: int = Field(default=1_000, ge=1, le=1_000)
    max_reasoning_jobs: int = Field(default=16, ge=1, le=128)
    max_concurrent_reasoning_jobs: int = Field(default=2, ge=1, le=8)
    reasoning_job_ttl_seconds: float = Field(default=300.0, ge=30.0, le=1_800.0)
    log_level: LogLevel = "INFO"

    @field_validator("api_key")
    @classmethod
    def validate_api_key(cls, value: SecretStr | None) -> SecretStr | None:
        if value is not None and len(value.get_secret_value()) < 16:
            raise ValueError("PRIVACY_AGENT_API_KEY must contain at least 16 characters")
        return value

    @field_validator("cors_origins")
    @classmethod
    def validate_cors_origins(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        for value in values:
            parts = urlsplit(value)
            if parts.scheme not in {"http", "https", "chrome-extension", "moz-extension"}:
                raise ValueError("CORS origins must use an explicitly supported scheme")
            if not parts.netloc or parts.path not in {"", "/"} or parts.query or parts.fragment:
                raise ValueError("CORS entries must be origins without paths, queries, or fragments")
            if "*" in value:
                raise ValueError("wildcard CORS origins are not permitted")
        return values

    @field_validator("ollama_base_url")
    @classmethod
    def validate_ollama_url(cls, value: str) -> str:
        parts = urlsplit(value)
        if parts.scheme not in {"http", "https"} or not parts.hostname:
            raise ValueError("Ollama URL must be an absolute HTTP(S) URL")
        if parts.username or parts.password or parts.query or parts.fragment:
            raise ValueError("Ollama URL cannot include credentials, query, or fragment")
        if parts.path not in {"", "/"}:
            raise ValueError("Ollama URL cannot include a path")
        return value.rstrip("/")

    def assert_runtime_safe(self) -> None:
        parts = urlsplit(self.ollama_base_url)
        host = parts.hostname or ""
        is_local = host == "localhost"
        if not is_local:
            try:
                is_local = ipaddress.ip_address(host).is_loopback
            except ValueError:
                is_local = False
        if not is_local and not self.allow_remote_ollama:
            raise ValueError("remote Ollama requires PRIVACY_AGENT_ALLOW_REMOTE_OLLAMA=true")

    def origin_allowed(self, origin: str) -> bool:
        if origin in self.cors_origins:
            return True
        if self.api_key is None:
            return False
        return bool(
            re.fullmatch(r"chrome-extension://[a-p]{32}", origin)
            or re.fullmatch(r"moz-extension://[0-9a-fA-F-]{36}", origin)
        )

    @classmethod
    def from_env(cls) -> Settings:
        origins = tuple(
            item.strip()
            for item in os.getenv("PRIVACY_AGENT_CORS_ORIGINS", "http://localhost,http://127.0.0.1").split(
                ","
            )
            if item.strip()
        )
        key = os.getenv("PRIVACY_AGENT_API_KEY")
        settings = cls(
            ollama_base_url=os.getenv("PRIVACY_AGENT_OLLAMA_BASE_URL", "http://127.0.0.1:11434"),
            ollama_model=os.getenv("PRIVACY_AGENT_OLLAMA_MODEL", "qwen3-vl:2b-instruct"),
            ollama_timeout_seconds=float(os.getenv("PRIVACY_AGENT_OLLAMA_TIMEOUT_SECONDS", "90")),
            allow_remote_ollama=_env_bool("PRIVACY_AGENT_ALLOW_REMOTE_OLLAMA"),
            api_key=SecretStr(key) if key else None,
            cors_origins=origins,
            max_request_bytes=int(os.getenv("PRIVACY_AGENT_MAX_REQUEST_BYTES", "8000000")),
            max_image_bytes=int(os.getenv("PRIVACY_AGENT_MAX_IMAGE_BYTES", "5000000")),
            max_image_pixels=int(os.getenv("PRIVACY_AGENT_MAX_IMAGE_PIXELS", "8294400")),
            max_elements=int(os.getenv("PRIVACY_AGENT_MAX_ELEMENTS", "500")),
            max_redactions=int(os.getenv("PRIVACY_AGENT_MAX_REDACTIONS", "1000")),
            max_reasoning_jobs=int(os.getenv("PRIVACY_AGENT_MAX_REASONING_JOBS", "16")),
            max_concurrent_reasoning_jobs=int(
                os.getenv("PRIVACY_AGENT_MAX_CONCURRENT_REASONING_JOBS", "2")
            ),
            reasoning_job_ttl_seconds=float(
                os.getenv("PRIVACY_AGENT_REASONING_JOB_TTL_SECONDS", "300")
            ),
            log_level=cast(LogLevel, os.getenv("PRIVACY_AGENT_LOG_LEVEL", "INFO").upper()),
        )
        settings.assert_runtime_safe()
        return settings
