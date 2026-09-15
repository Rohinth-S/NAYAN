FROM python:3.12.7-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PRIVACY_AGENT_REQUIRE_API_KEY=true

WORKDIR /service

COPY requirements.txt ./
RUN pip install --no-cache-dir --requirement requirements.txt

COPY app ./app

RUN addgroup --system privacy-agent \
    && adduser --system --ingroup privacy-agent --no-create-home privacy-agent \
    && chown -R privacy-agent:privacy-agent /service

USER privacy-agent
EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/health/live', timeout=2)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8765", "--workers", "1", "--no-access-log", "--no-proxy-headers"]
