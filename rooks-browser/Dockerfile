# Rooks Browser as the Docker server's `browser` add-on (docker-compose.yml). The same agent the desktop app starts,
# with the same approvals: a sensitive step waits for a yes in Workbench (Browser page, Needs you), and no answer in
# ten minutes is a no. Service mode: a token is required and localhost, the LAN and the stack's own hosts are refused.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    ROOKS_BROWSER_HOME=/data \
    ROOKS_BROWSER_HOST=0.0.0.0 \
    ROOKS_BROWSER_PORT=8100 \
    ROOKS_BROWSER_ENGINE=chromium \
    ROOKS_BROWSER_BLOCK_PRIVATE=1
WORKDIR /app
COPY pyproject.toml README.md ./
COPY rooks_browser ./rooks_browser
# libatomic1: Playwright's bundled node needs it, and the slim image no longer has it (CI, 2026-11-10).
RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir . \
 && playwright install --with-deps chromium \
 && useradd --create-home --uid 1000 agent && mkdir -p /data && chown agent /data
USER agent
VOLUME /data
EXPOSE 8100
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8100/healthz')"
CMD ["rooks-browser", "serve", "--headless"]
